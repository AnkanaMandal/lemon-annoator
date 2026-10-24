"""Thin boto3 wrapper that turns every AWS failure into an actionable S3Error."""

import hashlib
import logging
import re
import threading
from dataclasses import dataclass
from datetime import datetime, timedelta

import boto3
from botocore.client import BaseClient
from botocore.config import Config
from botocore.exceptions import (
    BotoCoreError,
    ClientError,
    ConnectTimeoutError,
    EndpointConnectionError,
    InvalidRegionError,
    NoCredentialsError,
    ParamValidationError,
    PartialCredentialsError,
    ReadTimeoutError,
)

from .errors import S3Error
from .models import VIDEO_EXTENSIONS, StorageConfig, utcnow

log = logging.getLogger(__name__)

_BOTO_CONFIG = Config(
    signature_version="s3v4",
    retries={"max_attempts": 3, "mode": "standard"},
    connect_timeout=5,
    read_timeout=20,
)

_clients: dict[str, BaseClient] = {}
_clients_lock = threading.Lock()


@dataclass
class S3Object:
    key: str
    size: int
    last_modified: datetime


def _cache_key(cfg: StorageConfig) -> str:
    raw = "|".join(
        [cfg.access_key_id, cfg.secret_access_key, cfg.session_token, cfg.region, cfg.endpoint_url,
         "dotted" if "." in cfg.bucket else ""]
    )
    return hashlib.sha256(raw.encode()).hexdigest()


def get_client(cfg: StorageConfig) -> BaseClient:
    """Cached client per credential set; boto3 clients are thread-safe."""
    key = _cache_key(cfg)
    with _clients_lock:
        client = _clients.get(key)
        if client:
            return client
        kwargs: dict = {"region_name": cfg.region or "us-east-1"}
        if cfg.access_key_id or cfg.secret_access_key:
            if not (cfg.access_key_id and cfg.secret_access_key):
                raise S3Error(
                    "Both the Access Key ID and the Secret Access Key are required.",
                    code="S3_PARTIAL_CREDENTIALS",
                    status_code=400,
                    hint="Fill in both keys, or leave both empty to use your local AWS profile.",
                )
            kwargs["aws_access_key_id"] = cfg.access_key_id
            kwargs["aws_secret_access_key"] = cfg.secret_access_key
            if cfg.session_token:
                kwargs["aws_session_token"] = cfg.session_token
        if cfg.endpoint_url:
            # S3-compatible stores (MinIO, R2, Wasabi...) generally need path-style URLs.
            kwargs["endpoint_url"] = cfg.endpoint_url
            config = _BOTO_CONFIG.merge(Config(s3={"addressing_style": "path"}))
        else:
            # Regional virtual-hosted endpoint: presigned URLs never hit a 307 redirect.
            region = cfg.region or "us-east-1"
            suffix = "amazonaws.com.cn" if region.startswith("cn-") else "amazonaws.com"  # AWS China partition
            kwargs["endpoint_url"] = f"https://s3.{region}.{suffix}"
            # Dotted bucket names break TLS with virtual-hosted URLs.
            style = "path" if "." in cfg.bucket else "virtual"
            config = _BOTO_CONFIG.merge(Config(s3={"addressing_style": style}))
        try:
            client = boto3.session.Session().client("s3", config=config, **kwargs)
        except (InvalidRegionError, ValueError) as exc:
            raise S3Error(
                f"Invalid region or endpoint: {exc}",
                code="S3_INVALID_REGION",
                status_code=400,
                hint="Use a region code such as us-east-1 or eu-west-2.",
            ) from exc
        _clients[key] = client
        return client


REGION_RE = re.compile(r"^[a-z]{2}(-[a-z]+)+-\d{1,2}$")


def _require_configured(cfg: StorageConfig) -> None:
    if not cfg.endpoint_url and not REGION_RE.match(cfg.region or ""):
        raise S3Error(
            f'"{cfg.region}" is not a valid AWS region.',
            code="S3_INVALID_REGION",
            status_code=400,
            hint="Use a region code such as us-east-1, eu-west-2 or ap-south-1.",
        )
    if not cfg.bucket:
        raise S3Error(
            "Cloud storage is not configured for this project.",
            code="S3_NOT_CONFIGURED",
            status_code=400,
            hint="Open Project Settings and enter a bucket name.",
        )


def translate(exc: Exception, cfg: StorageConfig) -> S3Error:
    bucket = cfg.bucket
    if isinstance(exc, S3Error):
        return exc
    if isinstance(exc, NoCredentialsError):
        return S3Error(
            "No AWS credentials were found.",
            code="S3_NO_CREDENTIALS",
            status_code=400,
            hint="Enter an Access Key ID and Secret Access Key, or configure a local AWS profile.",
        )
    if isinstance(exc, PartialCredentialsError):
        return S3Error(
            f"Incomplete AWS credentials: {exc}",
            code="S3_PARTIAL_CREDENTIALS",
            status_code=400,
        )
    if isinstance(exc, (EndpointConnectionError, ConnectTimeoutError)):
        return S3Error(
            "Could not connect to S3.",
            code="S3_UNREACHABLE",
            status_code=503,
            hint="Check your internet connection, the region, and any custom endpoint URL.",
        )
    if isinstance(exc, ReadTimeoutError):
        return S3Error("S3 took too long to respond.", code="S3_TIMEOUT", status_code=504,
                       hint="Try again in a moment.")
    if isinstance(exc, ParamValidationError):
        text = str(exc)
        if "bucket name" in text.lower():
            return S3Error(f'"{bucket}" is not a valid bucket name.', code="S3_INVALID_BUCKET", status_code=400,
                           hint="Use only the bucket name: lowercase letters, numbers, dots and hyphens.")
        return S3Error(f"Invalid S3 parameters: {text.splitlines()[-1]}", code="S3_INVALID_PARAMS",
                       status_code=400)
    if isinstance(exc, ClientError):
        err = exc.response.get("Error", {})
        code = str(err.get("Code", ""))
        message = err.get("Message") or str(exc)
        headers = exc.response.get("ResponseMetadata", {}).get("HTTPHeaders", {}) or {}
        actual_region = headers.get("x-amz-bucket-region") or err.get("Region")

        if code in {"InvalidAccessKeyId"}:
            return S3Error("The AWS Access Key ID is not recognized.", code="S3_INVALID_ACCESS_KEY",
                           status_code=401, hint="Double-check the Access Key ID, or create a new key in IAM.")
        if code in {"SignatureDoesNotMatch"}:
            return S3Error("The AWS Secret Access Key is incorrect.", code="S3_INVALID_SECRET",
                           status_code=401, hint="Re-enter the Secret Access Key (watch for spaces).")
        if code in {"ExpiredToken", "TokenRefreshRequired", "InvalidToken", "ExpiredTokenException"}:
            return S3Error("The AWS session token has expired or is invalid.", code="S3_TOKEN_EXPIRED",
                           status_code=401, hint="Refresh your temporary credentials.")
        if code in {"RequestTimeTooSkewed"}:
            return S3Error("Your computer clock is out of sync with AWS.", code="S3_CLOCK_SKEW",
                           status_code=400, hint="Enable automatic time sync in your OS settings.")
        if code in {"NoSuchBucket", "404", "NotFound"} and "Key" not in err:
            return S3Error(f'Bucket "{bucket}" does not exist.', code="S3_BUCKET_NOT_FOUND",
                           status_code=404, hint="Check the bucket name spelling.")
        if code in {"NoSuchKey"}:
            return S3Error("The video no longer exists in the bucket.", code="S3_KEY_NOT_FOUND",
                           status_code=404)
        if code in {"PermanentRedirect", "AuthorizationHeaderMalformed", "IllegalLocationConstraintException",
                    "301", "400"} and actual_region and actual_region != cfg.region:
            return S3Error(
                f'Bucket "{bucket}" is in region {actual_region}, not {cfg.region}.',
                code="S3_WRONG_REGION",
                status_code=400,
                hint=f"Change the region to {actual_region}.",
                details={"detected_region": actual_region},
            )
        if code in {"AccessDenied", "403", "AllAccessDisabled", "AccountProblem"}:
            prefix = cfg.normalized_prefix
            return S3Error(
                f'Access denied to bucket "{bucket}".',
                code="S3_ACCESS_DENIED",
                status_code=403,
                hint=(
                    f"The IAM identity needs s3:ListBucket on arn:aws:s3:::{bucket} and "
                    f"s3:GetObject on arn:aws:s3:::{bucket}/{prefix}*"
                ),
            )
        if code in {"InvalidBucketName"}:
            return S3Error(f'"{bucket}" is not a valid bucket name.', code="S3_INVALID_BUCKET",
                           status_code=400, hint="Use only the bucket name, without s3:// or a path.")
        log.warning("Unhandled S3 ClientError %s: %s", code, message)
        return S3Error(f"S3 error ({code}): {message}", code="S3_ERROR", status_code=502)
    if isinstance(exc, BotoCoreError):
        return S3Error(f"AWS SDK error: {exc}", code="S3_SDK_ERROR", status_code=502)
    log.exception("Unexpected S3 failure", exc_info=exc)
    return S3Error(f"Unexpected error talking to S3: {exc}", code="S3_ERROR", status_code=502)


def is_video_key(key: str) -> bool:
    return not key.endswith("/") and key.lower().endswith(VIDEO_EXTENSIONS)


def list_videos(cfg: StorageConfig, max_keys: int) -> tuple[list[S3Object], bool]:
    """Return every .mp4 / .mov object under the prefix, sorted by key."""
    _require_configured(cfg)
    found: list[S3Object] = []
    scanned = 0
    truncated = False
    try:
        client = get_client(cfg)
        paginator = client.get_paginator("list_objects_v2")
        pages = paginator.paginate(
            Bucket=cfg.bucket, Prefix=cfg.normalized_prefix, PaginationConfig={"PageSize": min(1000, max_keys)}
        )
        for page in pages:
            for obj in page.get("Contents", []) or []:
                scanned += 1
                key = obj["Key"]
                if not is_video_key(key):
                    continue
                found.append(S3Object(key=key, size=obj.get("Size", 0), last_modified=obj["LastModified"]))
            if scanned >= max_keys:
                truncated = bool(page.get("IsTruncated"))
                break
    except Exception as exc:
        raise translate(exc, cfg) from exc
    found.sort(key=lambda o: o.key.lower())
    return found, truncated


def presign(cfg: StorageConfig, key: str, expires_in: int) -> tuple[str, datetime]:
    _require_configured(cfg)
    try:
        client = get_client(cfg)
        url = client.generate_presigned_url(
            "get_object",
            Params={
                "Bucket": cfg.bucket,
                "Key": key,
                # MOV and MP4 share the ISO-BMFF container. Forcing video/mp4 lets Firefox play .mov
                # and fixes objects uploaded as binary/octet-stream (common with CLI uploads).
                "ResponseContentType": "video/mp4",
            },
            ExpiresIn=expires_in,
        )
    except Exception as exc:
        raise translate(exc, cfg) from exc
    return url, utcnow() + timedelta(seconds=expires_in)


def _region_header(response: dict) -> str | None:
    headers = response.get("ResponseMetadata", {}).get("HTTPHeaders", {}) or {}
    return headers.get("x-amz-bucket-region")


def _wrong_region(cfg: StorageConfig, actual: str) -> S3Error:
    return S3Error(
        f'Bucket "{cfg.bucket}" is in region {actual}, not {cfg.region}.',
        code="S3_WRONG_REGION",
        status_code=400,
        hint=f"Change the region to {actual} in Project Settings.",
        details={"detected_region": actual},
    )


def head_video(cfg: StorageConfig, key: str) -> dict:
    """Verify a key is readable (surfaces permission problems before the <video> tag does).
    Returns the HEAD response: size, content type, user metadata..."""
    _require_configured(cfg)
    try:
        resp = get_client(cfg).head_object(Bucket=cfg.bucket, Key=key)
    except ClientError as exc:
        actual = _region_header(exc.response)
        if not cfg.endpoint_url and actual and actual != cfg.region:
            raise _wrong_region(cfg, actual) from exc
        code = str(exc.response.get("Error", {}).get("Code", ""))
        if code in {"404", "NoSuchKey", "NotFound"}:
            raise S3Error(f'"{key}" was not found in the bucket.', code="S3_KEY_NOT_FOUND",
                          status_code=404, hint="Refresh the queue — it may have been moved or deleted.") from exc
        if code == "403":
            _diagnose_forbidden(cfg)
        raise translate(exc, cfg) from exc
    except Exception as exc:
        raise translate(exc, cfg) from exc
    # botocore silently follows region redirects for API calls, but presigned URLs
    # are signed for the configured region and would fail in the browser.
    actual = _region_header(resp)
    if not cfg.endpoint_url and actual and actual != cfg.region:
        raise _wrong_region(cfg, actual)
    return resp


def _diagnose_forbidden(cfg: StorageConfig) -> None:
    """HEAD responses have no body, so a 403 hides *why*. A tiny LIST reveals the real
    error code (bad key id, bad secret, expired token...). Raises if it finds one."""
    try:
        get_client(cfg).list_objects_v2(Bucket=cfg.bucket, Prefix=cfg.normalized_prefix, MaxKeys=1)
    except ClientError as exc:
        raise translate(exc, cfg) from exc
    except Exception:
        return


def test_connection(cfg: StorageConfig, max_keys: int) -> dict:
    _require_configured(cfg)
    try:
        resp = get_client(cfg).head_bucket(Bucket=cfg.bucket)
    except ClientError as exc:
        actual = _region_header(exc.response)
        if not cfg.endpoint_url and actual and actual != cfg.region:
            raise _wrong_region(cfg, actual) from exc
        if str(exc.response.get("Error", {}).get("Code", "")) == "403":
            _diagnose_forbidden(cfg)
        raise translate(exc, cfg) from exc
    except Exception as exc:
        raise translate(exc, cfg) from exc

    actual = _region_header(resp)
    if not cfg.endpoint_url and actual and actual != cfg.region:
        raise _wrong_region(cfg, actual)

    videos, truncated = list_videos(cfg, max_keys)
    return {
        "ok": True,
        "bucket": cfg.bucket,
        "region": cfg.region,
        "prefix": cfg.normalized_prefix,
        "video_count": len(videos),
        "sample_keys": [v.key for v in videos[:5]],
        "truncated": truncated,
    }
