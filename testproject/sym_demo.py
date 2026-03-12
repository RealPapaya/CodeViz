"""
sym_demo.py — Symbol View 完整測試檔案
測試所有 Symbol 類型：class、method、function、inheritance、call edges
"""

import os
import json
from typing import Optional


# ── 基礎類別（用於測試 inheritance edge）────────────────────────────────────

class Animal:
    """基礎類別，測試繼承鏈。"""

    species = "unknown"          # class field

    def __init__(self, name: str, age: int):
        self.name = name         # public field
        self._age = age          # private field
        self._sound = ""

    def speak(self) -> str:
        return f"{self.name} says {self._sound}"

    def describe(self) -> str:
        return f"{self.name} is {self._age} years old"

    def _internal_check(self) -> bool:
        return self._age > 0


class Pet(Animal):
    """繼承 Animal，測試 inheritance edge + override。"""

    def __init__(self, name: str, age: int, owner: str):
        super().__init__(name, age)
        self.owner = owner       # public field
        self._vaccinated = False

    def speak(self) -> str:
        result = super().speak()
        return f"{result} (owned by {self.owner})"

    def vaccinate(self):
        self._vaccinated = True

    def _check_health(self) -> bool:
        return self._internal_check() and self._vaccinated


class Dog(Pet):
    """三層繼承，測試深層繼承鏈。"""

    def __init__(self, name: str, age: int, owner: str, breed: str):
        super().__init__(name, age, owner)
        self.breed = breed
        self._tricks = []

    def learn_trick(self, trick: str):
        self._tricks.append(trick)

    def perform(self) -> str:
        if not self._tricks:
            return f"{self.name} doesn't know any tricks"
        return f"{self.name} performs: {', '.join(self._tricks)}"

    def speak(self) -> str:
        return f"{self.name} barks!"


# ── 獨立的工具類別（測試 cross-class call edges）────────────────────────────

class AnimalRegistry:
    """動物登記系統，呼叫 Animal / Dog 的方法。"""

    def __init__(self):
        self._registry = {}
        self._count = 0

    def register(self, animal: Animal) -> str:
        animal_id = f"#{self._count:04d}"
        self._registry[animal_id] = animal
        self._count += 1
        return animal_id

    def get_report(self, animal_id: str) -> str:
        animal = self._registry.get(animal_id)
        if not animal:
            return "Not found"
        # Calls Animal.describe and Animal.speak → cross-class call edges
        return f"{animal.describe()} | {animal.speak()}"

    def list_all(self) -> list:
        return [a.name for a in self._registry.values()]

    def _find_by_name(self, name: str) -> Optional[Animal]:
        for animal in self._registry.values():
            if animal.name == name:
                return animal
        return None


class Statistics:
    """統計類別，與 AnimalRegistry 互動。"""

    def __init__(self, registry: AnimalRegistry):
        self._registry = registry
        self._cache = {}

    def total_count(self) -> int:
        return len(self._registry.list_all())

    def generate_report(self) -> dict:
        names = self._registry.list_all()  # cross-class call
        return {
            "total": len(names),
            "names": names,
        }

    def _invalidate_cache(self):
        self._cache.clear()


# ── 獨立函式（測試 function → method call edges）────────────────────────────

def create_dog(name: str, breed: str, owner: str) -> Dog:
    """建立 Dog 並登記。"""
    dog = Dog(name, 3, owner, breed)
    dog.learn_trick("sit")
    dog.learn_trick("shake")
    return dog


def run_demo():
    """主要示範函式，呼叫所有類別。"""
    registry = AnimalRegistry()
    stats = Statistics(registry)

    # 建立動物
    fido = create_dog("Fido", "Labrador", "Alice")
    buddy = create_dog("Buddy", "Poodle", "Bob")
    generic = Animal("Cat", 5)

    # 登記
    id1 = registry.register(fido)
    id2 = registry.register(buddy)
    registry.register(generic)

    # 取得報告
    report1 = registry.get_report(id1)
    report2 = registry.get_report(id2)

    # 統計
    total = stats.total_count()
    full_report = stats.generate_report()

    # 輸出
    results = {
        "report1": report1,
        "report2": report2,
        "total": total,
        "full": full_report,
    }
    print(json.dumps(results, indent=2, ensure_ascii=False))
    return results


def load_config(path: str) -> dict:
    """載入設定檔，測試獨立函式。"""
    if not os.path.exists(path):
        return {}
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def _internal_helper(data: dict) -> bool:
    """私有工具函式（以 _ 開頭）。"""
    return bool(data)


if __name__ == "__main__":
    run_demo()
