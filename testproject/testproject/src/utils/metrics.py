#!/usr/bin/env python3
"""
utils/metrics.py — Lightweight metrics collection
"""
import time
import threading
from typing import Dict, List
from collections import defaultdict


class MetricsCollector:
    def __init__(self, namespace: str = ""):
        self.namespace = namespace
        self._counters: Dict[str, int] = defaultdict(int)
        self._gauges: Dict[str, float] = {}
        self._histograms: Dict[str, List[float]] = defaultdict(list)
        self._lock = threading.Lock()

    def _key(self, name: str) -> str:
        return f"{self.namespace}.{name}" if self.namespace else name

    def increment(self, name: str, amount: int = 1):
        with self._lock:
            self._counters[self._key(name)] += amount

    def decrement(self, name: str, amount: int = 1):
        self.increment(name, -amount)

    def gauge(self, name: str, value: float):
        with self._lock:
            self._gauges[self._key(name)] = value

    def record(self, name: str, value: float):
        with self._lock:
            self._histograms[self._key(name)].append(value)

    def counter(self, name: str) -> int:
        return self._counters.get(self._key(name), 0)

    def summary(self, name: str) -> Dict:
        data = self._histograms.get(self._key(name), [])
        if not data:
            return {}
        sorted_data = sorted(data)
        n = len(sorted_data)
        return {
            "count": n,
            "min": sorted_data[0],
            "max": sorted_data[-1],
            "mean": sum(sorted_data) / n,
            "p50": sorted_data[int(n * 0.50)],
            "p95": sorted_data[int(n * 0.95)],
            "p99": sorted_data[int(n * 0.99)],
        }

    def snapshot(self) -> Dict:
        with self._lock:
            return {
                "counters": dict(self._counters),
                "gauges": dict(self._gauges),
                "histogram_counts": {k: len(v) for k, v in self._histograms.items()},
            }

    def reset(self):
        with self._lock:
            self._counters.clear()
            self._gauges.clear()
            self._histograms.clear()
