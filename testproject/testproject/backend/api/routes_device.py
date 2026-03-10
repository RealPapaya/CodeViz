#!/usr/bin/env python3
"""
Device API Routes — CRUD + streaming for IoT devices.
"""

from typing import List, Optional
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks, WebSocket
from sqlalchemy.ext.asyncio import AsyncSession
from pydantic import BaseModel, Field

from backend.models.device import Device, DeviceStatus
from backend.models.sensor import SensorReading
from backend.utils.db_pool import get_session
from backend.utils.pagination import Paginator
from backend.utils.event_bus import EventBus
from services.cache.redis_client import RedisClient
from services.auth.jwt_manager import JWTManager, TokenPayload

router = APIRouter(tags=["devices"])


class DeviceCreateRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=128)
    device_type: str
    location: Optional[str] = None
    firmware_version: str = "1.0.0"
    metadata: dict = {}


class DeviceUpdateRequest(BaseModel):
    name: Optional[str] = None
    location: Optional[str] = None
    status: Optional[DeviceStatus] = None


async def _broadcast_device_event(device_id: str, event_type: str, payload: dict):
    """Internal: push event to websocket subscribers."""
    await EventBus.publish(f"device:{device_id}", {
        "type": event_type,
        "timestamp": datetime.utcnow().isoformat(),
        "payload": payload,
    })


@router.get("/", response_model=List[dict])
async def list_devices(
    page: int = 1,
    limit: int = 20,
    status: Optional[DeviceStatus] = None,
    session: AsyncSession = Depends(get_session),
    current_user: TokenPayload = Depends(JWTManager.verify_token),
):
    cache_key = f"devices:{current_user.user_id}:{page}:{limit}:{status}"
    cached = await RedisClient.get(cache_key)
    if cached:
        return cached

    paginator = Paginator(page=page, limit=limit)
    devices = await Device.list_by_owner(
        session,
        owner_id=current_user.user_id,
        status=status,
        offset=paginator.offset,
        limit=paginator.limit,
    )
    result = [d.to_dict() for d in devices]
    await RedisClient.set(cache_key, result, ttl=30)
    return result


@router.post("/", response_model=dict, status_code=201)
async def create_device(
    body: DeviceCreateRequest,
    bg: BackgroundTasks,
    session: AsyncSession = Depends(get_session),
    current_user: TokenPayload = Depends(JWTManager.verify_token),
):
    device = Device.create(
        name=body.name,
        device_type=body.device_type,
        location=body.location,
        owner_id=current_user.user_id,
        firmware_version=body.firmware_version,
        metadata=body.metadata,
    )
    await session.add(device)
    await session.commit()
    bg.add_task(_broadcast_device_event, device.id, "device_created", device.to_dict())
    await RedisClient.invalidate_pattern(f"devices:{current_user.user_id}:*")
    return device.to_dict()


@router.get("/{device_id}", response_model=dict)
async def get_device(
    device_id: str,
    session: AsyncSession = Depends(get_session),
    current_user: TokenPayload = Depends(JWTManager.verify_token),
):
    device = await Device.get_by_id(session, device_id)
    if not device:
        raise HTTPException(status_code=404, detail="Device not found")
    if device.owner_id != current_user.user_id:
        raise HTTPException(status_code=403, detail="Access denied")
    return device.to_dict()


@router.patch("/{device_id}", response_model=dict)
async def update_device(
    device_id: str,
    body: DeviceUpdateRequest,
    bg: BackgroundTasks,
    session: AsyncSession = Depends(get_session),
    current_user: TokenPayload = Depends(JWTManager.verify_token),
):
    device = await Device.get_by_id(session, device_id)
    if not device or device.owner_id != current_user.user_id:
        raise HTTPException(status_code=404, detail="Device not found")
    device.update(**body.dict(exclude_none=True))
    await session.commit()
    bg.add_task(_broadcast_device_event, device_id, "device_updated", device.to_dict())
    await RedisClient.delete(f"device:{device_id}")
    return device.to_dict()


@router.delete("/{device_id}", status_code=204)
async def delete_device(
    device_id: str,
    session: AsyncSession = Depends(get_session),
    current_user: TokenPayload = Depends(JWTManager.verify_token),
):
    device = await Device.get_by_id(session, device_id)
    if not device or device.owner_id != current_user.user_id:
        raise HTTPException(status_code=404, detail="Device not found")
    await device.soft_delete(session)
    await session.commit()
    await RedisClient.delete(f"device:{device_id}")


@router.get("/{device_id}/readings", response_model=List[dict])
async def get_sensor_readings(
    device_id: str,
    limit: int = 100,
    from_ts: Optional[datetime] = None,
    to_ts: Optional[datetime] = None,
    session: AsyncSession = Depends(get_session),
    current_user: TokenPayload = Depends(JWTManager.verify_token),
):
    readings = await SensorReading.get_for_device(
        session, device_id=device_id,
        from_ts=from_ts, to_ts=to_ts, limit=limit,
    )
    return [r.to_dict() for r in readings]


@router.websocket("/{device_id}/stream")
async def stream_device(
    device_id: str,
    ws: WebSocket,
):
    await ws.accept()
    async for event in EventBus.subscribe(f"device:{device_id}"):
        await ws.send_json(event)
