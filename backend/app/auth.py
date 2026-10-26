"""Supabase sign-in: every API request except /api/health must carry the user's access token
(`Authorization: Bearer <jwt>`), which is verified here."""

from dataclasses import dataclass
from functools import lru_cache

import jwt
from fastapi import Request

from .config import Settings, get_settings
from .errors import AppError

ASYMMETRIC_ALGS = {"ES256", "RS256", "EdDSA"}


@dataclass(frozen=True)
class User:
    id: str
    email: str
    name: str


class AuthError(AppError):
    status_code = 401
    code = "UNAUTHORIZED"


@lru_cache
def _jwks_client(supabase_url: str) -> jwt.PyJWKClient:
    return jwt.PyJWKClient(f"{supabase_url}/auth/v1/.well-known/jwks.json", cache_jwk_set=True, lifespan=600)


def _decode(token: str, settings: Settings) -> dict:
    try:
        alg = jwt.get_unverified_header(token).get("alg")
    except jwt.PyJWTError as exc:
        raise AuthError("Your sign-in token is invalid.", hint="Sign in again.") from exc
    supabase_url = settings.supabase_url.strip().rstrip("/")
    try:
        if alg == "HS256":
            if not settings.supabase_jwt_secret:
                raise AppError(
                    "This Supabase project signs tokens with the legacy JWT secret, which the API doesn't have.",
                    code="AUTH_NOT_CONFIGURED",
                    hint="Set LEMON_SUPABASE_JWT_SECRET, or switch the project to JWT signing keys in Supabase.",
                )
            key = settings.supabase_jwt_secret
        elif alg in ASYMMETRIC_ALGS:
            if not supabase_url:
                raise AppError("LEMON_SUPABASE_URL is not set.", code="AUTH_NOT_CONFIGURED",
                               hint="Set it to https://<project-ref>.supabase.co on the API server.")
            key = _jwks_client(supabase_url).get_signing_key_from_jwt(token).key
        else:
            raise AuthError("Your sign-in token is invalid.", hint="Sign in again.")
        return jwt.decode(
            token,
            key,
            algorithms=[alg],
            audience="authenticated",
            issuer=f"{supabase_url}/auth/v1" if supabase_url else None,
            options={"require": ["exp", "sub"]},
        )
    except jwt.ExpiredSignatureError as exc:
        raise AuthError("Your sign-in has expired.", hint="Sign in again.") from exc
    except jwt.PyJWKClientError as exc:
        raise AppError("Could not load Supabase's signing keys.", code="AUTH_UNAVAILABLE", status_code=503,
                       hint="Check LEMON_SUPABASE_URL and the API server's internet access.") from exc
    except jwt.PyJWTError as exc:
        raise AuthError("Your sign-in token is invalid.", hint="Sign in again.") from exc


def current_user(request: Request) -> User:
    """FastAPI dependency: the signed-in user, or a 401/403 error."""
    scheme, _, token = request.headers.get("authorization", "").partition(" ")
    if scheme.lower() != "bearer" or not token.strip():
        raise AuthError("Sign in to use Lemon.")
    settings = get_settings()
    claims = _decode(token.strip(), settings)
    email = str(claims.get("email") or "").lower()
    allowed = settings.allowed_email_set
    if allowed and email not in allowed:
        raise AppError(f"{email or 'This account'} is not allowed to use this Lemon.", code="FORBIDDEN",
                       status_code=403, hint="Ask the owner to add your email to LEMON_ALLOWED_EMAILS.")
    meta = claims.get("user_metadata") or {}
    name = meta.get("full_name") or meta.get("name") or email.split("@")[0] or "Someone"
    return User(id=str(claims["sub"]), email=email, name=str(name))
