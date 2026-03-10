#!/usr/bin/env python3
"""
utils/cache.py — LRU Cache and TTL cache implementations
"""
import time
import threading
from collections import OrderedDict
from typing import Any, Optional


class LRUCache:
    def __init__(self, maxsize: int = 256):
        self.maxsize = maxsize
        self._cache: OrderedDict = OrderedDict()
        self._lock = threading.Lock()
        self._hits = 0
        self._misses = 0

    def get(self, key: str) -> Optional[Any]:
        with self._lock:
            if key not in self._cache:
                self._misses += 1
                return None
            self._cache.move_to_end(key)
            self._hits += 1
            return self._cache[key]

    def set(self, key: str, value: Any):
        with self._lock:
            if key in self._cache:
                self._cache.move_to_end(key)
            self._cache[key] = value
            if len(self._cache) > self.maxsize:
                self._cache.popitem(last=False)

    def has(self, key: str) -> bool:
        return key in self._cache

    def delete(self, key: str):
        with self._lock:
            self._cache.pop(key, None)

    def clear(self):
        with self._lock:
            self._cache.clear()
            self._hits = 0
            self._misses = 0

    def stats(self) -> dict:
        total = self._hits + self._misses
        rate = self._hits / total if total else 0.0
        return {"size": len(self._cache), "hits": self._hits, "misses": self._misses, "hit_rate": round(rate, 3)}


class TTLCache:
    def __init__(self, maxsize: int = 256, ttl: float = 300.0):
        self.maxsize = maxsize
        self.ttl = ttl
        self._store: dict = {}
        self._expiry: dict = {}
        self._lock = threading.Lock()

    def get(self, key: str) -> Optional[Any]:
        with self._lock:
            if key not in self._store:
                return None
            if time.monotonic() > self._expiry[key]:
                del self._store[key]
                del self._expiry[key]
                return None
            return self._store[key]

    def set(self, key: str, value: Any, ttl: Optional[float] = None):
        with self._lock:
            self._evict_expired()
            self._store[key] = value
            self._expiry[key] = time.monotonic() + (ttl or self.ttl)

    def _evict_expired(self):
        now = time.monotonic()
        expired = [k for k, exp in self._expiry.items() if now > exp]
        for k in expired:
            del self._store[k]
            del self._expiry[k]

    def clear(self):
        with self._lock:
            self._store.clear()
            self._expiry.clear()
