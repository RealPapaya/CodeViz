#!/usr/bin/env python3
"""
core/pipeline.py — Data transformation pipeline
"""
import time
import logging
from typing import Any, Callable, Dict, List, Optional

logger = logging.getLogger(__name__)


class PipelineStage:
    def __init__(self, name: str, handler: Callable, skip_on_error: bool = False):
        self.name = name
        self.handler = handler
        self.skip_on_error = skip_on_error
        self.call_count = 0
        self.error_count = 0
        self.total_ms = 0.0

    def execute(self, data: Any) -> Any:
        start = time.monotonic()
        try:
            result = self.handler(data)
            self.call_count += 1
            return result
        except Exception as exc:
            self.error_count += 1
            if self.skip_on_error:
                logger.warning("Stage %s error (skipped): %s", self.name, exc)
                return data
            raise
        finally:
            self.total_ms += (time.monotonic() - start) * 1000

    def stats(self) -> Dict:
        avg = self.total_ms / max(self.call_count, 1)
        return {
            "name": self.name,
            "calls": self.call_count,
            "errors": self.error_count,
            "avg_ms": round(avg, 2),
        }


class DataPipeline:
    def __init__(self):
        self._stages: List[PipelineStage] = []
        self._stage_map: Dict[str, PipelineStage] = {}

    def register(self, name: str, handler: Callable, skip_on_error: bool = False):
        stage = PipelineStage(name, handler, skip_on_error)
        self._stages.append(stage)
        self._stage_map[name] = stage
        logger.debug("Registered pipeline stage: %s", name)

    def remove(self, name: str):
        self._stages = [s for s in self._stages if s.name != name]
        self._stage_map.pop(name, None)

    def run(self, data: Any) -> Any:
        current = data
        for stage in self._stages:
            logger.debug("Running pipeline stage: %s", stage.name)
            current = stage.execute(current)
        return current

    def run_until(self, data: Any, stop_stage: str) -> Any:
        current = data
        for stage in self._stages:
            current = stage.execute(current)
            if stage.name == stop_stage:
                break
        return current

    def get_stats(self) -> List[Dict]:
        return [s.stats() for s in self._stages]

    def reset_stats(self):
        for stage in self._stages:
            stage.call_count = 0
            stage.error_count = 0
            stage.total_ms = 0.0

    def __len__(self) -> int:
        return len(self._stages)

    def __repr__(self) -> str:
        names = " → ".join(s.name for s in self._stages)
        return f"<DataPipeline [{names}]>"
