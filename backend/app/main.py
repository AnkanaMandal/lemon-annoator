import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from . import __version__
from .config import get_settings
from .deps import get_store
from .errors import AppError
from .routers import export, projects, videos

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
log = logging.getLogger("lemon")

settings = get_settings()



@asynccontextmanager
async def lifespan(_: FastAPI):
    log.info("Data directory: %s", get_store().root)
    yield


app = FastAPI(title="Lemon API", version=__version__, lifespan=lifespan)

def _hostname(host: str) -> str:
    host = host.strip().lower()
    if host.startswith("["):  # [::1]:8000
        return host[1 : host.find("]")]
    return host.split(":")[0]


@app.middleware("http")
async def only_local_hosts(request: Request, call_next):
    """Reject requests whose Host header isn't this machine, so a malicious web page can't reach the
    API through DNS rebinding."""
    if _hostname(request.headers.get("host", "")) not in get_settings().allowed_host_set:
        return JSONResponse(
            status_code=403,
            content={"error": {"code": "FORBIDDEN_HOST", "message": "Lemon only accepts requests from this computer.",
                               "hint": "Set LEMON_ALLOWED_HOSTS if you really need another host name.", "details": {}}},
        )
    return await call_next(request)


app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(AppError)
async def app_error_handler(_: Request, exc: AppError):
    if exc.status_code >= 500:
        log.error("%s: %s", exc.code, exc.message)
    return JSONResponse(status_code=exc.status_code, content={"error": exc.to_dict()})


@app.exception_handler(RequestValidationError)
async def validation_error_handler(_: Request, exc: RequestValidationError):
    errors = exc.errors()
    first = errors[0] if errors else {}
    location = ".".join(str(p) for p in first.get("loc", []) if p != "body")
    message = first.get("msg", "Invalid request").removeprefix("Value error, ")
    return JSONResponse(
        status_code=422,
        content={
            "error": {
                "code": "VALIDATION_ERROR",
                "message": f"{location}: {message}" if location else message,
                "hint": None,
                "details": {"errors": [{"loc": e.get("loc"), "msg": e.get("msg")} for e in errors]},
            }
        },
    )


@app.exception_handler(Exception)
async def unhandled_error_handler(_: Request, exc: Exception):
    log.exception("Unhandled error", exc_info=exc)
    return JSONResponse(
        status_code=500,
        content={"error": {"code": "INTERNAL_ERROR", "message": str(exc) or "Internal server error",
                           "hint": "See the API terminal for the stack trace.", "details": {}}},
    )


@app.get("/api/health")
def health():
    return {"ok": True, "version": __version__, "data_dir": str(get_store().root)}


app.include_router(projects.router)
app.include_router(videos.router)
app.include_router(export.router)

