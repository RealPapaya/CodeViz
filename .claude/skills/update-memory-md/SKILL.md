---
name: update-memory-md
description: Update memory.md after any significant architectural change to the CodeViz project. Use this skill whenever you add new files, change the data flow, modify the parser interface, add new edge types, rename modules, or make any change that future AI agents need to know about to understand the codebase.
---

# SKILL: Update memory.md

`memory.md` is the project's institutional memory. It's the first file any future AI agent should read to understand VIZCODE. Keeping it accurate is mandatory after any significant change.

## When to Update

Trigger this skill after any of the following:

| Change Type | Section to Update |
|------------|-------------------|
| New file added | 📂 核心檔案地圖 |
| File deleted or renamed | 📂 核心檔案地圖 |
| Data flow changed | 🔄 系統核心資料流 |
| New parser added | 📂 核心檔案地圖 → parsers section; 🛠️ extensibility guide |
| New edge type added | 📜 BIOS Edge Type (or create new section) |
| Parser interface changed | 💡 統一的 Parser 介面規範 |
| New API endpoint | 🛠️ 擴充與修改指南 → 情境 4 |
| Startup flow changed | 🚀 系統概覽 |

## How to Update

1. Read the current `memory.md` first
2. Identify which sections are stale
3. Make surgical edits — don't rewrite sections that are still accurate
4. Keep entries concise: one bullet per file, one sentence per role
5. Preserve the existing format (emoji headings, code blocks, table layout)

## Format Rules

**File entry format:**
```markdown
- 🔤 **`filename.py`** (後端)
  - **用途**: 一句話說清楚這個檔案做什麼。
  - **👉 觸發**: 說明是誰呼叫它，或它觸發誰。
```

**Data flow step format:**
```markdown
N. **Phase Name**: 簡短說明這個步驟做什麼，涉及哪些函式或模組。
```

**Edge type format (for BIOS section):**
```markdown
- EdgeTypeName (`edge_key`): `#hexcolor` (顏色名稱) — 用途描述
```

## What NOT to Change

- Don't change the emoji heading structure
- Don't remove the warning banner at the top (⚠️ AI 注意)
- Don't add excessive detail — each file entry should be ≤ 3 bullet points
- Don't add entries for temporary or test files

## Quick Sanity Check

After updating, verify:
- [ ] Every file in the core system has a corresponding entry
- [ ] The startup flow (launch.bat → vizcode.py → server.py) is accurate
- [ ] The parser interface tuple format matches what parsers actually return
- [ ] Edge color values match `EDGE_TYPES` in `analyze_viz.py`
