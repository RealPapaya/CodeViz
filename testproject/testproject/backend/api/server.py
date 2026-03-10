#!/usr/bin/env python3
"""
SmartHome Platform — Main API Server
Entry point for the FastAPI application.
"""

import os
import sys
import asyncio
import logging
from typing import Optional

import fastapi
import uvicorn
from fastapi import FastAPI, Depends, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware

from backend.api import routes_device, routes_user, routes_sensor
from backend.middleware.auth_guard import AuthGuard
from backend.middleware.rate_limiter import RateLimiter
from backend.utils.config_loader import load_config
from backend.utils.db_pool import init_db, close_db
from services.cache.redis_client import RedisClient
from services.auth.jwt_manager import JWTManager

log = logging.getLogger(__name__)

app = FastAPI(
    title="SmartHome API",
    version="2.4.1",
    docs_url="/api/docs",
)

app.add_middleware(CORSMiddleware, allow_origins=["*"])
app.add_middleware(GZipMiddleware, minimum_size=1000)
app.add_middleware(AuthGuard)
app.add_middleware(RateLimiter, max_requests=100, window=60)


@app.on_event("startup")
async def startup():
    cfg = load_config()
    await init_db(cfg.DATABASE_URL)
    await RedisClient.connect(cfg.REDIS_URL)
    JWTManager.init(cfg.JWT_SECRET)
    log.info("Server started on port %s", cfg.PORT)


@app.on_event("shutdown")
async def shutdown():
    await close_db()
    await RedisClient.disconnect()


@app.get("/health")
async def health_check():
    return {"status": "ok", "version": app.version}


@app.get("/metrics")
async def metrics(token: str = Depends(JWTManager.verify_admin)):
    from backend.utils.metrics_collector import collect_all
    return await collect_all()


app.include_router(routes_device.router, prefix="/api/v1/devices")
app.include_router(routes_user.router, prefix="/api/v1/users")
app.include_router(routes_sensor.router, prefix="/api/v1/sensors")


if __name__ == "__main__":
    uvicorn.run("server:app", host="0.0.0.0", port=8080, reload=True)
