#!/usr/bin/env python3
"""
core/engine.py — Main processing engine
"""
import os
import sys
import json
import logging
import asyncio
from typing import List, Dict, Optional, Tuple
from dataclasses import dataclass, field
from pathlib import Path

from utils.logger import setup_logger
from utils.cache import LRUCache
from core.scheduler import TaskScheduler
from core.pipeline import DataPipeline

logger = setup_logger(__name__)


@dataclass
class EngineConfig:
    max_workers: int = 4
    timeout: float = 30.0
    retry_limit: int = 3
    enable_cache: bool = True
    cache_size: int = 1024
    debug: bool = False


@dataclass
class ProcessResult:
    success: bool
    data: Dict
    errors: List[str] = field(default_factory=list)
    duration_ms: float = 0.0
    job_id: str = ""


class Engine:
    def __init__(self, config: EngineConfig):
        self.config = config
        self.cache = LRUCache(maxsize=config.cache_size)
        self.scheduler = TaskScheduler(workers=config.max_workers)
        self.pipeline = DataPipeline()
        self._running = False
        self._jobs: Dict[str, ProcessResult] = {}

    def start(self):
        """Initialize and start the engine."""
        logger.info("Starting engine with config: %s", self.config)
        self._running = True
        self.scheduler.start()
        self._register_default_handlers()

    def stop(self):
        """Gracefully shut down the engine."""
        logger.info("Stopping engine...")
        self._running = False
        self.scheduler.stop()
        self.cache.clear()

    def _register_default_handlers(self):
        self.pipeline.register("transform", self._transform_handler)
        self.pipeline.register("validate", self._validate_handler)
        self.pipeline.register("export", self._export_handler)

    def _transform_handler(self, data: Dict) -> Dict:
        result = {}
        for key, value in data.items():
            if isinstance(value, str):
                result[key] = value.strip().lower()
            elif isinstance(value, list):
                result[key] = [v for v in value if v is not None]
            else:
                result[key] = value
        return result

    def _validate_handler(self, data: Dict) -> bool:
        required_fields = ["id", "type", "payload"]
        return all(f in data for f in required_fields)

    def _export_handler(self, data: Dict) -> bytes:
        return json.dumps(data, ensure_ascii=False).encode("utf-8")

    def submit_job(self, payload: Dict) -> str:
        job_id = _generate_job_id(payload)
        if self.config.enable_cache and self.cache.has(job_id):
            logger.debug("Cache hit for job %s", job_id)
            return job_id
        self.scheduler.enqueue(job_id, payload)
        return job_id

    def get_result(self, job_id: str) -> Optional[ProcessResult]:
        return self._jobs.get(job_id)

    async def process_async(self, items: List[Dict]) -> List[ProcessResult]:
        tasks = [asyncio.create_task(self._process_one(item)) for item in items]
        return await asyncio.gather(*tasks, return_exceptions=False)

    async def _process_one(self, item: Dict) -> ProcessResult:
        import time
        start = time.monotonic()
        try:
            transformed = self._transform_handler(item)
            valid = self._validate_handler(transformed)
            if not valid:
                return ProcessResult(success=False, data={}, errors=["Validation failed"])
            exported = self._export_handler(transformed)
            duration = (time.monotonic() - start) * 1000
            return ProcessResult(success=True, data=transformed, duration_ms=duration)
        except Exception as exc:
            logger.exception("Error processing item: %s", exc)
            return ProcessResult(success=False, data={}, errors=[str(exc)])


def _generate_job_id(payload: Dict) -> str:
    import hashlib
    raw = json.dumps(payload, sort_keys=True).encode()
    return hashlib.sha256(raw).hexdigest()[:16]


def create_engine(debug: bool = False) -> Engine:
    cfg = EngineConfig(debug=debug)
    eng = Engine(cfg)
    eng.start()
    return eng
