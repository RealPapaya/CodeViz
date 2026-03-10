#!/usr/bin/env python3
"""
tests/test_engine.py — Unit tests for the core engine
"""
import asyncio
import pytest
from unittest.mock import MagicMock, patch, AsyncMock

from core.engine import Engine, EngineConfig, ProcessResult, _generate_job_id, create_engine
from core.pipeline import DataPipeline
from utils.cache import LRUCache


@pytest.fixture
def config():
    return EngineConfig(max_workers=2, cache_size=16, debug=True)


@pytest.fixture
def engine(config):
    eng = Engine(config)
    eng.start()
    yield eng
    eng.stop()


class TestEngineConfig:
    def test_defaults(self):
        cfg = EngineConfig()
        assert cfg.max_workers == 4
        assert cfg.timeout == 30.0
        assert cfg.enable_cache is True

    def test_custom_values(self):
        cfg = EngineConfig(max_workers=8, debug=True)
        assert cfg.max_workers == 8
        assert cfg.debug is True


class TestEngine:
    def test_start_stop(self, config):
        eng = Engine(config)
        eng.start()
        assert eng._running is True
        eng.stop()
        assert eng._running is False

    def test_transform_handler_strips_strings(self, engine):
        data = {"key": "  hello  ", "num": 42}
        result = engine._transform_handler(data)
        assert result["key"] == "hello"
        assert result["num"] == 42

    def test_transform_handler_filters_none(self, engine):
        data = {"items": [1, None, 2, None, 3]}
        result = engine._transform_handler(data)
        assert result["items"] == [1, 2, 3]

    def test_validate_passes_with_required_fields(self, engine):
        data = {"id": "x", "type": "test", "payload": {}}
        assert engine._validate_handler(data) is True

    def test_validate_fails_missing_fields(self, engine):
        assert engine._validate_handler({"id": "x"}) is False

    def test_submit_job_returns_string(self, engine):
        job_id = engine.submit_job({"id": "1", "type": "test", "payload": "data"})
        assert isinstance(job_id, str)
        assert len(job_id) == 16

    def test_submit_job_cache_dedup(self, engine):
        payload = {"id": "1", "type": "test", "payload": "same"}
        id1 = engine.submit_job(payload)
        id2 = engine.submit_job(payload)
        assert id1 == id2

    def test_get_result_missing(self, engine):
        assert engine.get_result("nonexistent") is None


class TestAsyncProcessing:
    @pytest.mark.asyncio
    async def test_process_async_success(self, engine):
        items = [
            {"id": str(i), "type": "echo", "payload": f"item{i}"}
            for i in range(5)
        ]
        results = await engine.process_async(items)
        assert len(results) == 5
        assert all(r.success for r in results)

    @pytest.mark.asyncio
    async def test_process_async_validation_failure(self, engine):
        items = [{"bad": "data"}]
        results = await engine.process_async(items)
        assert not results[0].success
        assert "Validation failed" in results[0].errors[0]


class TestGenerateJobId:
    def test_deterministic(self):
        p = {"a": 1, "b": 2}
        assert _generate_job_id(p) == _generate_job_id(p)

    def test_different_payloads(self):
        assert _generate_job_id({"a": 1}) != _generate_job_id({"a": 2})

    def test_length(self):
        assert len(_generate_job_id({})) == 16


class TestLRUCache:
    def test_basic_set_get(self):
        c = LRUCache(maxsize=8)
        c.set("k", "v")
        assert c.get("k") == "v"

    def test_eviction(self):
        c = LRUCache(maxsize=2)
        c.set("a", 1)
        c.set("b", 2)
        c.set("c", 3)
        assert c.get("a") is None  # evicted

    def test_hit_rate_tracking(self):
        c = LRUCache(maxsize=8)
        c.set("x", 42)
        c.get("x")
        c.get("missing")
        stats = c.stats()
        assert stats["hits"] == 1
        assert stats["misses"] == 1
