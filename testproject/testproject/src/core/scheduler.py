#!/usr/bin/env python3
"""
core/scheduler.py — Task scheduling and worker pool management
"""
import queue
import threading
import time
import logging
from typing import Callable, Dict, Any, Optional
from concurrent.futures import ThreadPoolExecutor, Future

from utils.metrics import MetricsCollector

logger = logging.getLogger(__name__)

_DEFAULT_QUEUE_SIZE = 512
_WORKER_IDLE_TIMEOUT = 60


class TaskScheduler:
    def __init__(self, workers: int = 4, queue_size: int = _DEFAULT_QUEUE_SIZE):
        self.workers = workers
        self.queue_size = queue_size
        self._task_queue: queue.Queue = queue.Queue(maxsize=queue_size)
        self._executor: Optional[ThreadPoolExecutor] = None
        self._handlers: Dict[str, Callable] = {}
        self._metrics = MetricsCollector("scheduler")
        self._shutdown_event = threading.Event()

    def start(self):
        self._executor = ThreadPoolExecutor(
            max_workers=self.workers,
            thread_name_prefix="scheduler-worker",
        )
        self._dispatcher = threading.Thread(target=self._dispatch_loop, daemon=True)
        self._dispatcher.start()
        logger.info("TaskScheduler started with %d workers", self.workers)

    def stop(self):
        self._shutdown_event.set()
        if self._executor:
            self._executor.shutdown(wait=True, cancel_futures=False)
        logger.info("TaskScheduler stopped")

    def register_handler(self, task_type: str, handler: Callable):
        self._handlers[task_type] = handler
        logger.debug("Registered handler for task type: %s", task_type)

    def enqueue(self, job_id: str, payload: Dict[str, Any], priority: int = 0):
        task = {"job_id": job_id, "payload": payload, "priority": priority, "enqueued_at": time.time()}
        try:
            self._task_queue.put_nowait(task)
            self._metrics.increment("tasks_enqueued")
        except queue.Full:
            logger.warning("Task queue full, dropping job %s", job_id)
            self._metrics.increment("tasks_dropped")

    def _dispatch_loop(self):
        while not self._shutdown_event.is_set():
            try:
                task = self._task_queue.get(timeout=1.0)
                self._executor.submit(self._execute_task, task)
                self._metrics.increment("tasks_dispatched")
            except queue.Empty:
                continue
            except Exception as exc:
                logger.exception("Dispatch error: %s", exc)

    def _execute_task(self, task: Dict):
        job_id = task["job_id"]
        payload = task["payload"]
        task_type = payload.get("type", "default")
        handler = self._handlers.get(task_type, self._default_handler)
        start = time.monotonic()
        try:
            result = handler(payload)
            elapsed = (time.monotonic() - start) * 1000
            self._metrics.record("task_duration_ms", elapsed)
            logger.debug("Job %s completed in %.1fms", job_id, elapsed)
            return result
        except Exception as exc:
            self._metrics.increment("tasks_failed")
            logger.error("Job %s failed: %s", job_id, exc)
            raise

    def _default_handler(self, payload: Dict) -> Dict:
        logger.debug("Using default handler for payload keys: %s", list(payload.keys()))
        return {"status": "ok", "echo": payload}

    def queue_depth(self) -> int:
        return self._task_queue.qsize()

    def is_healthy(self) -> bool:
        return (
            not self._shutdown_event.is_set()
            and self._executor is not None
            and self.queue_depth() < self.queue_size * 0.9
        )
