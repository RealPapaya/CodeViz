# CodeViz .claude 說明書

這份說明書讓你一眼看懂 `.claude/` 裡面有什麼、什麼時候用、怎麼維護。**你只需要看這份，不需要直接看 skill 檔案。**

---

## 目錄結構一覽

```
.claude/
├── 📖 SkillMaker.md             ← 參考用：如何建立新 skill 的說明 (不用動)
│
├── 🎯 Skills (AI 自動觸發)
│   ├── coding-style/            ← 程式碼風格規範
│   ├── stateful-default-behaviour/  ← UI 狀態管理模式
│   ├── add-ui-theme/            ← 新增 UI 主題流程
│   ├── eng-to-zh-translator/    ← 英文翻譯成繁體中文
│   ├── debug-graph-render/      ← D3.js 圖形渲染除錯
│   ├── add-api-endpoint/        ← 新增 server.py API
│   └── update-memory-md/        ← 同步更新 memory.md
│
└── 📋 Workflows (你手動呼叫)
    ├── run-local.md             ← 啟動本地伺服器
    └── verify-analysis.md       ← 用 testproject 驗證分析結果
```

---

## Skills 說明

Skills 由 AI 自動判斷是否使用，**你不需要手動觸發**。你只需要知道它們的存在，以便維護。

| Skill | 何時自動觸發 | 核心內容 |
|-------|------------|---------|
| `coding-style` | 寫任何 Python 或 JS 程式碼時 | 命名規則、import 順序、錯誤處理、禁止 pip 依賴 |
| `stateful-default-behaviour` | 實作/除錯 UI 狀態、展開折疊、Prev/Next 導航時 | 「新鮮導航套用偏好，歷史導航還原快照」模式 |
| `add-ui-theme` | 新增主題、修改配色、調整 CSS 變數時 | 用 CSS custom properties + `[data-theme]` 選擇器 |
| `eng-to-zh-translator` | 翻譯文件、UI 字串、程式碼注釋時 | 繁體中文規範、中英間距、保留 Markdown 格式 |
| `debug-graph-render` | D3.js 圖形有視覺 bug 時 | 診斷清單、常見修法對照表 |
| `add-api-endpoint` | 在 server.py 新增 GET/POST 路由時 | Handler 架構、JOBS 執行緒模式、安全驗證 |
| `update-memory-md` | 任何架構異動（新增檔案、修改介面）後 | 什麼時候更新、怎麼更新哪個章節 |

---

## Workflows 說明

Workflows 需要你**手動觸發**，對 AI 說「執行 run-local workflow」之類的。

### `/run-local`
**用途**: 啟動 VIZCODE 本地伺服器並驗證正常運作

步驟摘要：
1. `python vizcode.py` 啟動
2. 驗證 `http://localhost:7777` 回應 200
3. 處理 port 7777 佔用問題

### `/verify-analysis`
**用途**: 用 `testproject/` 做快速 smoke test，確認修改後分析功能正常

步驟摘要：
1. 在 UI 輸入 `d:\GOOGLE\CodeViz\testproject` 並分析
2. 驗證圖形渲染、節點數量、邊正確
3. 用 PowerShell 驗證 JSON 結構

---

## 如何新增一個 Skill

1. 在 `.claude/` 下建立資料夾，例如 `.claude/my-skill/`
2. 在資料夾內建立 `SKILL.md`，最上面要有 YAML frontmatter：
   ```markdown
   ---
   name: my-skill
   description: 這個 skill 做什麼。要夠詳細讓 AI 知道何時觸發。
   ---
   
   # 正文內容...
   ```
3. 如果 skill 有大量參考內容，放進 `references/` 子目錄，SKILL.md 裡連結過去
4. 更新這份說明書的表格

**注意**: `description` 欄位決定 AI 何時自動使用這個 skill，寫得越具體越好。

---

## 如何新增一個 Workflow

1. 在 `.claude/workflows/` 下建立 `.md` 檔
2. 最上面要有 frontmatter：
   ```markdown
   ---
   description: 一句話說明這個 workflow 做什麼
   ---
   
   # 步驟...
   ```
3. 對 AI 說「執行 xxx workflow」即可觸發
4. 更新這份說明書的表格

---

## 如何修改現有 Skill

直接編輯對應資料夾內的 `SKILL.md`。改完不需要做任何其他事，AI 下次對話就會讀到新版本。

**常見修改場景**:
- 發現 AI 沒有遵守某條規範 → 在 skill 裡把規範寫得更明確
- 新的 edge type 加入 → 更新 `update-memory-md` skill 的觸發條件表
- 新的禁止事項 → 加到 `coding-style` skill

---

## 不包含在 .claude/ 的重要文件

| 文件 | 位置 | 用途 |
|------|------|------|
| `memory.md` | 專案根目錄 | AI 每次開新對話的快速上手指南，架構異動後必須更新 |
