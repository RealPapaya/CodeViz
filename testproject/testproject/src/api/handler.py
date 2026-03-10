#!/usr/bin/env python3
"""
api/handler.py — REST API request handlers
"""
import json
import time
import hashlib
import logging
from typing import Any, Dict, Optional, Callable
from http import HTTPStatus
from urllib.parse import parse_qs, urlparse

from core.engine import Engine, ProcessResult
from utils.cache import TTLCache
from utils.metrics import MetricsCollector

logger = logging.getLogger(__name__)

_RATE_LIMIT_WINDOW = 60   # seconds
_RATE_LIMIT_MAX = 100     # requests per window


class Request:
    def __init__(self, method: str, path: str, body: bytes = b"", headers: Dict = None):
        self.method = method.upper()
        self.path = path
        self.body = body
        self.headers = headers or {}
        self._parsed = urlparse(path)
        self.query = parse_qs(self._parsed.query)

    def json(self) -> Any:
        return json.loads(self.body) if self.body else {}

    def param(self, key: str, default: str = "") -> str:
        vals = self.query.get(key, [default])
        return vals[0] if vals else default

    @property
    def client_ip(self) -> str:
        return self.headers.get("X-Forwarded-For", "").split(",")[0].strip() or "127.0.0.1"


class Response:
    def __init__(self, status: int = 200, body: Any = None):
        self.status = status
        self.body = body
        self.headers: Dict[str, str] = {"Content-Type": "application/json"}

    def to_bytes(self) -> bytes:
        payload = json.dumps(self.body, ensure_ascii=False, indent=2) if self.body is not None else ""
        return payload.encode("utf-8")

    @classmethod
    def ok(cls, data: Any) -> "Response":
        return cls(200, {"ok": True, "data": data})

    @classmethod
    def error(cls, message: str, status: int = 400) -> "Response":
        return cls(status, {"ok": False, "error": message})

    @classmethod
    def not_found(cls, resource: str = "") -> "Response":
        return cls(404, {"ok": False, "error": f"Not found: {resource}"})


class RateLimiter:
    def __init__(self, window: int = _RATE_LIMIT_WINDOW, limit: int = _RATE_LIMIT_MAX):
        self.window = window
        self.limit = limit
        self._buckets: Dict[str, list] = {}

    def is_allowed(self, key: str) -> bool:
        now = time.time()
        timestamps = self._buckets.setdefault(key, [])
        # Evict old entries
        self._buckets[key] = [t for t in timestamps if now - t < self.window]
        if len(self._buckets[key]) >= self.limit:
            return False
        self._buckets[key].append(now)
        return True


class ApiHandler:
    def __init__(self, engine: Engine):
        self.engine = engine
        self._cache = TTLCache(maxsize=512, ttl=60.0)
        self._rate_limiter = RateLimiter()
        self._metrics = MetricsCollector("api")
        self._routes: Dict[str, Dict[str, Callable]] = {}
        self._register_routes()

    def _register_routes(self):
        self.route("GET", "/health", self._handle_health)
        self.route("GET", "/metrics", self._handle_metrics)
        self.route("POST", "/jobs", self._handle_submit_job)
        self.route("GET", "/jobs/{id}", self._handle_get_job)
        self.route("DELETE", "/jobs/{id}", self._handle_delete_job)

    def route(self, method: str, path: str, handler: Callable):
        self._routes.setdefault(method, {})[path] = handler

    def handle(self, req: Request) -> Response:
        self._metrics.increment("requests_total")
        if not self._rate_limiter.is_allowed(req.client_ip):
            self._metrics.increment("rate_limited")
            return Response.error("Rate limit exceeded", 429)
        handler = self._resolve_route(req.method, req.path)
        if handler is None:
            return Response.not_found(req.path)
        try:
            start = time.monotonic()
            resp = handler(req)
            elapsed = (time.monotonic() - start) * 1000
            self._metrics.record("request_ms", elapsed)
            return resp
        except Exception as exc:
            logger.exception("Handler error: %s", exc)
            self._metrics.increment("errors")
            return Response.error("Internal server error", 500)

    def _resolve_route(self, method: str, path: str) -> Optional[Callable]:
        routes = self._routes.get(method, {})
        if path in routes:
            return routes[path]
        for pattern, handler in routes.items():
            if _match_path(pattern, path):
                return handler
        return None

    def _handle_health(self, req: Request) -> Response:
        return Response.ok({"status": "healthy", "engine_running": self.engine._running})

    def _handle_metrics(self, req: Request) -> Response:
        return Response.ok(self.engine.scheduler._metrics.snapshot())

    def _handle_submit_job(self, req: Request) -> Response:
        payload = req.json()
        if not payload:
            return Response.error("Empty request body")
        job_id = self.engine.submit_job(payload)
        return Response.ok({"job_id": job_id})

    def _handle_get_job(self, req: Request) -> Response:
        job_id = req.path.split("/")[-1]
        result = self.engine.get_result(job_id)
        if result is None:
            return Response.not_found(f"job/{job_id}")
        return Response.ok({"job_id": job_id, "success": result.success, "data": result.data})

    def _handle_delete_job(self, req: Request) -> Response:
        job_id = req.path.split("/")[-1]
        if job_id in self.engine._jobs:
            del self.engine._jobs[job_id]
            return Response.ok({"deleted": job_id})
        return Response.not_found(f"job/{job_id}")


def _match_path(pattern: str, path: str) -> bool:
    p_parts = pattern.split("/")
    r_parts = path.split("/")
    if len(p_parts) != len(r_parts):
        return False
    return all(pp.startswith("{") or pp == rp for pp, rp in zip(p_parts, r_parts))
