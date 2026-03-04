# BIOS Code Visualizer — 工作紀錄 & AI Agent 交接文件

> 最後更新：2026-03-04  
> 目的：讓 IDE AI Agent 了解全貌，繼續開發完成度更高的視覺化工具

---

## 一、背景與需求

### 使用者資料
- 職稱：BIOS 韌體工程師
- 公司：ASUS（華碩）
- 作業系統：Windows 11（主力開發環境）
- 程式語言：C、C++、Assembly（ASM）混合
- Codebase 大小：數 GB

### 核心痛點
BIOS codebase 龐大複雜，工程師需要：
1. **視覺化** 整包 code 的函數呼叫關係（誰 call 了誰）
2. **視覺化** 檔案之間的相依關係（誰 include 了誰）
3. 互動式操作（點節點、篩選模組、搜尋函數）
4. 不需要每次都重新 build 才能使用

---

## 二、使用者的 Build 環境

### Build 指令
```cmd
.\mk.bat .\B1403CGA.veb -Rebuild
```

### 專案路徑
```
D:\Code\ADL\B1403CTA_SMR\
```

### Build System 架構
- **mk.bat** → 呼叫 AMI AutoMk 系統 → 最終執行 `make %makecmd%`
- Make 版本：GNU Make for Windows32（非 WSL）
- 編譯器：**WDK（Windows Driver Kit）**，路徑在 `d:\bios\AmiEfiTools\WDK_7600_16385_AMD64`
- BIOS 平台：**AMI Aptio V**（AlderLake / ADL 平台）
- Python：`d:\bios\AmiEfiTools\Python\python38-32\python.exe`（AMI 自帶）+ 系統 Python 3.11

### Build 失敗原因（已確認）
`-Rebuild` 不是標準 GNU Make 選項，make 會報 `invalid option -- u`，但前置的 AutoMk / AutoPorting 工具都有跑完。實際上 build 可能需要不同的 flag，但這不影響靜態分析工具。

### 為何不用 Bear / compiledb
- Bear 是 Linux 工具，不支援 Windows 原生 make
- WDK 的 cl.exe 很難被 Windows 上的工具攔截
- **結論：直接靜態分析 source code，不依賴 build**

---

## 三、已研究的工具選項

| 工具 | 評估結果 |
|------|---------|
| Sourcetrail | 需要 compile_commands.json，2021 停止維護，setup 複雜 |
| Doxygen + Graphviz | 可行，但 UI 老舊，互動性差 |
| Bear | Linux only，不適用 |
| compiledb | WDK cl.exe 難攔截 |
| **自製 Python + D3.js** | ✅ 最適合，不依賴 build，直接靜態分析，輸出單一 HTML |

---

## 四、已完成的工作

### 已交付核心檔案
1. **`analyze_bios.py` (V2.5)**: 負責靜態分析，輸出層級 JSON 支援跨檔呼叫解析。
2. **`server.py`**: 本地 HTTP 伺服器，提供 `/analyze` 背景任務與進度回報。
3. **`launcher.html`**: 使用者入口網頁，提供動態分析進度條與近期專案歷史。
4. **`launch.bat`**: 一鍵啟動腳本，會自動背景啟動伺服器並開啟瀏覽器。
5. **前置端模組 (`static/viz.js`, `static/viz.css`)**: 解耦原本單一 HTML，並使用 Cytoscape.js 進行高效能拓樸圖繪製。

### 使用方式
直接雙擊執行 `launch.bat`，或在命令列執行：
```cmd
cd "D:\Google AI\CodeViz"
python server.py
```
然後在瀏覽器開啟 `http://localhost:7777` 操作。

### 已實作的進階分析與 UI 功能
- **動態雙擊載入 (Lazy Loading)**: 在 L2 Call Graph 中雙擊外部函數，即時爬梳並擴充節點，支援深度追蹤 (Deep Drill-down)。
- **精準備案分析 (Unknown Resolution)**: 解析 Unknown 節點，實現跨檔 function calls 的正確連線，搭配以距離為基礎的上色演算法。
- **高效能渲染與 Layout**: 從 D3.js 移植至 Cytoscape.js，採用 Dagre (有向圖) 確保呼叫鏈清晰不打結。
- **介面與使用者體驗**:
  - 彈性的左右面板 (Sidebar & Code Editor) 支援雙向拖曳調整寬度。
  - 字型偏好設定系統 (預設 JetBrains Mono) 與下拉選單視覺化預覽。
  - 方向性相依高亮：入邊標綠、出邊標桔，附帶連線數量指標以降低視覺混亂。
- **特定節點特化 (FILE_TYPE_SHAPE)**: 針對 BIOS 特有的檔案（.dec, .inf, .dsc, .cif）給予特定形狀，並修正了 include 與 HII-Pkg 的邊線顏色（Include=灰色, HII-Pkg=橘紅色）。
- **工具提示 (Tooltips)**: 改善 Hover 彈出視窗使其更準備顯示不同 Dependency 的專屬屬性與真實資料。

---

## 五、待辦與未來優化項目 (需 AI Agent 繼續協助)

### 🔴 高優先度（功能缺失）

**1. ASM 檔案支援**
- 副檔名：`.asm`, `.s`, `.S`, `.nasm`
- 需求：目前尚未解析 ASM，希望能顯示 ASM 檔案節點，並分析 `%include` / `EXTERN` 指令。

**2. 函數跨檔案 Call 的準確性 (持續優化中)**
- 狀態：已能解析多檔同名引用與 Unknown 節點，並實作 Lazy loading 追蹤外部 call。
- 剩餘需求：進一步改良 `RE_FUNCDEF` RegExp，完全涵蓋 `static inline` 和複雜 `EFIAPI` 等 MACRO 宣告，減少被遺漏的定義。

### 🟡 中優先度（體驗改進）

**3. 右鍵選單 (Context Menu)**
- 需求：右鍵節點 → 選單：「Open in VS Code」、「Copy path」、「Pin this node」。

**4. 統計 Dashboard**
- 需求：顯示最多被 include 的 header TOP 10、最多 caller 的函數 TOP 10。

**5. 儲存 / 載入 Layout**
- 需求：讓使用者可以把節點位置存起來，下次開啟時恢復（可存入 `localStorage` 或 JSON 檔）。

### 🟢 低優先度（進階功能）

**6. diff 模式**
- 需求：比較兩個版本的 code，highlight 新增 / 刪除 / 修改的相依關係。

**7. 匯出視圖 (Export)**
- 需求：將當前 Cytoscape 視圖匯出為 PNG / SVG，匯出節點清單為 CSV。

**14. 模組層級圖**
- 除了檔案層級，加一個「模組層級」視圖（把同一個頂層資料夾的所有檔案收合成一個節點）

**15. 與 VS Code 整合**
- 透過 VS Code Extension API 或 `vscode://file/` URI，讓點節點可以直接開啟對應檔案

---

## 六、程式碼架構說明

### `analyze_bios.py` 結構
```
analyze_bios.py
├── 常數設定（EXTENSIONS, SKIP_DIRS, MAX_FILES）
├── Regex 定義（RE_INCLUDE, RE_FUNCDEF, RE_FUNCCALL 等）
├── strip_comments(src)       → 移除註解和字串，防止誤判
├── scan_file(filepath, root) → 分析單一檔案，回傳 includes/funcdefs/funcalls
├── build_graph(root_dir)     → 掃描整個目錄，建立 graph 資料結構
├── HTML_TEMPLATE             → 內嵌完整 HTML/CSS/JS（D3.js）
├── inject_data(html, data)   → 把 JSON 資料注入 HTML
└── main()                    → CLI entry point
```

### 輸出的 JSON 資料結構
```json
{
  "file_nodes": [
    {
      "id": 0,
      "label": "Main.c",
      "path": "AmiPkg/Core/Main.c",
      "module": "AmiPkg",
      "ext": ".c",
      "size": 12345,
      "funcs": ["AmiEntryPoint", "AmiInit"]
    }
  ],
  "file_edges": [
    { "s": 0, "t": 5 }
  ],
  "func_nodes": [
    {
      "id": 0,
      "label": "AmiEntryPoint",
      "file": "AmiPkg/Core/Main.c",
      "module": "AmiPkg"
    }
  ],
  "func_edges": [
    { "s": 0, "t": 3 }
  ],
  "stats": {
    "files": 3421,
    "file_deps": 12834,
    "functions": 8923,
    "calls": 34211,
    "root": "D:/Code/ADL/B1403CTA_SMR"
  }
}
```

---

## 七、建議的下一步開發策略

給 AI Agent 的建議順序：

1. **ASM 支援與正則優化**：處理 `.asm` 相依性以及 header `static inline` 解析，提升靜態分析準確度。
2. **加入右鍵選單**：實作快捷啟動 VS Code 等功能 (可透過 `vscode://file/` URI scheme)。
3. **優化資料載入效能**：測試 5,000+ 檔案的真實大型 BIOS 專案，確保能以低於 50MB 的記憶體在前端順利載入 JSON。
4. **加入匯出功能 (PNG/SVG)**：協助工程師將流程圖放入除錯或架構紀錄報告中。

### 目前技術棧 (已定型並上線)
```
後端（分析）: Python 3.x，內建標準函式庫處理分析 + Server 提供 HTTP API。
前端（視覺化）: Cytoscape.js (強悍的 WebGL 渲染支援) + Dagre (有向圖 Layout 解決節點交錯)。
入口與架構: 本地分析與 Web UI 解耦 (`server.py`, `launcher.html`, `static/viz.js`, `static/viz.css`)。
啟動方式: `launch.bat` 提供給使用者的一鍵免安裝啟動體驗。
```

---

## 八、ASUS AMI Aptio V 的特殊注意事項

給 AI Agent 參考的 BIOS 專案特殊知識：

1. **模組目錄命名規則**：`AmiPkg`、`AsusModulePkg`、`AsusProjectPkg`、`AmiChipsetPkg` 等
2. **常見 UEFI/AMI macro 需加入 C_KEYWORDS 過濾清單**：
   `EFIAPI`, `EFI_STATUS`, `IN`, `OUT`, `OPTIONAL`, `PEI_SERVICES`, `EFI_BOOT_SERVICES` 等
3. **`.veb` 檔案**：AMI SDL（System Description Language）的 binary 版本，定義 token 和模組設定，不是 C code，分析腳本應跳過
4. **`.sdl` 檔案**：AMI 的模組描述文件（文字格式），可考慮解析來了解模組依賴關係
5. **`Build/` 資料夾**：build 產物，一定要跳過（已在 SKIP_DIRS）
6. **AutoGen 檔案**：`Build/` 下會有 AMI 自動生成的 C 檔，跳過即可

---

## 九、對話摘要（給 AI Agent 的完整上下文）

這份文件是從以下對話中整理出來的重點：

- 使用者是 ASUS BIOS 工程師，想要視覺化數 GB 的 BIOS code
- 評估過 Sourcetrail（太複雜）、Doxygen（UI 差）等工具
- 最終決定：寫一個 Python 靜態分析腳本 + D3.js 互動 HTML
- 已交付 `analyze_bios.py`，功能基本可用但有很多改進空間
- 使用者希望 AI Agent 繼續開發，做出完成度更高的版本

**使用者的核心需求優先級：**
1. 能看到誰 call 了誰（函數層級）
2. 能看到檔案相依（include 關係）
3. 互動式（點、搜尋、篩選）
4. 不需要 build，直接跑 Python 就能出圖
5. 大 codebase 也能順暢操作

---

*文件結束 — 由 Claude (Anthropic) 於 2026-03-02 生成*
