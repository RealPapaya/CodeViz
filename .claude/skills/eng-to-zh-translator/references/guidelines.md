# Translation Guidelines: English to Traditional Chinese

This guide provides the exact terminology, tone, and formatting rules for high-quality English to Traditional Chinese (zh-TW) translation.

## 1. Terminology Mapping (Local Vocabulary)

Always use vocabulary commonly used in Taiwan's technology sector. Avoid Mainland Chinese (zh-CN) terms.

| English | Correct (zh-TW) | Incorrect (zh-CN terms to avoid) |
|---|---|---|
| Program / Software | 程式 / 軟體 | 程序 / 軟件 |
| Project | 專案 | 項目 |
| Screen | 螢幕 | 屏幕 |
| File | 檔案 | 文件 |
| Folder / Directory | 資料夾 / 目錄 | 文件夾 |
| Object | 物件 | 對象 |
| Network | 網路 | 網絡 |
| Memory | 記憶體 | 內存 |
| Default | 預設 | 默認 |
| Information | 資訊 | 信息 |
| Variable | 變數 | 變量 |
| Module | 模組 | 模塊 |

## 2. Spacing Rules (PanGu Spacing)

Always insert a half-width space between English letters/numbers and Chinese characters. 

**Correct:**
- 我們使用 `Node.js` 來建立伺服器。
- 請檢查第 5 行的程式碼。
- 它支援 Windows 和 macOS 系統。

**Incorrect:**
- 我們使用`Node.js`來建立伺服器。
- 請檢查第5行的程式碼。
- 它支援Windows和macOS系統。

## 3. Formatting & Code Blocks

- **Preserve Tags:** Do not translate variable names, JSON keys, HTML tags, or Markdown syntax.
- **Code Comments:** When translating code comments, keep the original formatting (e.g., `//`, `/* */`, `#`).
- **Links & Images:** Ensure the absolute URLs and anchor texts remain functional.

## 4. Tone and Style

- **Professional yet Casual:** The tone should read like a friendly, expert software engineer explaining concepts to a peer.
- **Clarity over Literal Translation:** Do not translate word-for-word if it sounds unnatural. Restructure the sentence to fit Chinese grammar.
  - *Awkward (Literal):* "It is required that you must install the dependencies before running." -> 它被要求你必須安裝依賴在執行之前。
  - *Natural (Fluent):* "執行之前，請先安裝相關套件。"

## 5. Common Mistakes to Avoid

| Mistake | Fix |
|---|---|
| Retaining English punctuation | Convert commas `,` to `，`, periods `.` to `。`, and colons `:` to `：`. (Except in code) |
| Translating brand names or tech stacks | Keep brand names like "React", "Apple", "Google" in English. Do not translate them to "反應", "蘋果" etc. unless requested. |
| Using overly formal language | Avoid using highly ancient or overly formal idioms. Keep it modern and tech-focused. |
