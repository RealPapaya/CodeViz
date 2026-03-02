# BIOS Code Visualizer — 工作紀錄 & AI Agent 交接文件

> 最後更新：2026-03-02  
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

### 已交付檔案：`analyze_bios.py`

一個 Python 腳本，功能：
1. 遞迴掃描指定目錄下所有 `.c`, `.cpp`, `.cc`, `.h`, `.hpp` 檔案
2. 用 regex 提取：
   - `#include` 相依關係（檔案層級）
   - 函數定義（`RE_FUNCDEF`）
   - 函數呼叫（`RE_FUNCCALL`）
3. 過濾 C 關鍵字和 EDK2/AMI 常用 macro（避免誤判）
4. 輸出一個**自包含的單一 HTML 檔案**（所有資料 inline 在 `<script>` 裡）

### 使用方式
```cmd
cd D:\Code\ADL\B1403CTA_SMR
python analyze_bios.py . -o bios_viz.html
```
然後用 Chrome / Edge 開啟 `bios_viz.html`。

### 已實作的 HTML 視覺化功能
- D3.js v7 Force-directed graph
- **File Dependencies** 模式：檔案 `#include` 相依圖
- **Call Graph** 模式：函數呼叫關係圖
- 顏色按模組（頂層資料夾）區分
- 點節點 → 側邊欄顯示 caller / callee 清單
- 搜尋框：即時過濾節點
- 左側 Module 列表：點選只看特定模組
- Zoom / Pan / 拖曳節點
- Tooltip on hover
- 大檔案自動取樣（超過 800 節點時取連通性最高的節點）

### 已知限制（需改進）
見下方第五節。

---

## 五、需要 AI Agent 繼續完成的項目

### 🔴 高優先度（功能缺失）

**1. ASM 檔案支援**
- 副檔名：`.asm`, `.s`, `.S`, `.nasm`
- 目前：完全忽略
- 需要：至少能顯示 ASM 檔案節點，並分析 `%include` / `EXTERN` 指令

**2. 函數跨檔案 Call 的準確性**
- 目前做法：只看同一個 `.c` 檔裡的函數定義和呼叫，判斷「這個檔案裡的函數 A 呼叫了函數 B」
- 問題：如果函數 B 定義在別的 `.c` 檔，仍然能正確連結（因為有 `all_funcdefs` 全域表）
- 但：header-only 的 `static inline` 函數沒有被正確計入函數定義
- 需要：改進 `RE_FUNCDEF` regex，支援 `static inline` 和 `EFIAPI` 呼叫慣例

**3. 大型圖的效能問題**
- 目前：超過 800 nodes 會取樣，可能漏掉重要節點
- 需要：實作 hierarchical clustering 或 level-of-detail rendering
- 建議：用 WebGL 渲染（如 `sigma.js` 或 `cytoscape.js` 配合 canvas renderer）

**4. 節點之間的連線被遮住**
- Force layout 對大圖效果差，邊線交叉嚴重
- 建議：加入 Dagre（有向圖 hierarchical layout）作為第二種 layout 選項

**5. 路徑過濾**
- 目前：`SKIP_DIRS = {'Build', 'build', '.git', '__pycache__', 'Conf', 'DEBUG', 'RELEASE'}`
- ASUS AMI 的 build 輸出在 `Build/` 資料夾，應該確認這個有被跳過
- 需要：讓使用者在 HTML 介面裡可以動態調整要不要顯示某些目錄

---

### 🟡 中優先度（體驗改進）

**6. 右鍵選單**
- 右鍵節點 → 選單：「Open in VS Code」、「Copy path」、「Show only this module」、「Pin this node」

**7. 多層展開**
- 點節點時，可以設定展開幾層（1層、2層、3層、全部）
- 目前只顯示直接鄰居

**8. 路徑追蹤**
- 輸入函數 A 和函數 B，找出 A → B 的呼叫路徑
- Highlight 最短路徑

**9. 統計 Dashboard**
- 顯示：最多被 include 的 header TOP 10、最多 caller 的函數 TOP 10、最大的模組（by file count）
- 建議：左側 sidebar 加一個 Stats tab

**10. 儲存 / 載入 Layout**
- 讓使用者可以把節點位置存起來，下次開啟時恢復
- 建議：用 `localStorage` 存 JSON

**11. 篩選條件**
- 只看 `.c` 檔（不看 `.h`）
- 只看某個副檔名
- 只看有超過 N 個連結的節點（過濾孤立節點）

---

### 🟢 低優先度（進階功能）

**12. diff 模式**
- 比較兩個版本的 code，highlight 新增 / 刪除 / 修改的相依關係

**13. Export**
- 匯出當前視圖為 SVG 或 PNG
- 匯出節點清單為 CSV

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

1. **先跑 `analyze_bios.py` 確認能正常產生 HTML**（使用者尚未實際跑過）
2. **改良 Python 分析腳本**：支援 ASM，改進 static inline 偵測
3. **替換渲染引擎**：考慮從 D3.js force layout 改為 `cytoscape.js`（效能更好、支援多種 layout）
4. **加入 Dagre layout**：讓有向圖更易讀
5. **加入右鍵選單和多層展開**
6. **加入統計 Dashboard**

### 建議的技術棧
```
後端（分析）: Python 3.x，只用標準函式庫（re, os, json, pathlib）
前端（視覺化）: 單一 HTML 檔案，自包含
  - 渲染引擎: cytoscape.js（比 D3 force layout 更適合大圖）
  - Layout: cytoscape-dagre（有向圖）+ cola（force directed）
  - UI framework: 純 HTML/CSS/JS（不用 React，保持單檔輸出）
  - CDN: cdnjs.cloudflare.com
```

### cytoscape.js CDN 範例
```html
<script src="https://cdnjs.cloudflare.com/ajax/libs/cytoscape/3.28.1/cytoscape.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/dagre/0.8.5/dagre.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/cytoscape-dagre@2.5.0/cytoscape-dagre.js"></script>
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
