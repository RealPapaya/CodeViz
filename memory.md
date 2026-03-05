# VIZCODE — AI Working Memory
> 每次修改後更新此文件。這是給下一位 AI 的完整工作紀錄。

---

## 專案概覽

| 項目 | 內容 |
|------|------|
| 名稱 | VIZCODE V4 |
| 用途 | 本地 code 視覺化工具，分析 codebase 並產生互動式 HTML graph |
| 啟動 | `launch.bat` → 開 Chrome `http://localhost:7777` |
| 核心入口 | `analyze_viz.py` |

---

## 檔案地圖

```
VIZCODE_V4/
├── analyze_viz.py          主分析引擎。掃描檔案、建圖、產出 JSON + HTML（無語言細節）
├── detector.py             偵測專案類型（BIOS / Python / JS / Go / 混合）
├── server.py               HTTP 伺服器（port 7777），接收 /analyze POST，串流進度
├── launcher.html           瀏覽器前端 UI（輸入路徑、顯示進度、開啟結果）
├── launch.bat              Windows 啟動腳本
│
├── parsers/                ★ 可插拔語言 parser（所有語言平等）
│   ├── __init__.py
│   ├── bios_parser.py      ★ BIOS/UEFI/AMI/C/ASM → 所有 BIOS 邏輯都在這
│   ├── python_parser.py    .py → imports / funcdefs / call graph
│   ├── js_parser.py        .js/.mjs/.jsx/.ts/.tsx → ES6 import + function
│   └── go_parser.py        .go → import path + func（大寫=public）
│
└── static/                 前端資源（server.py 從這裡 serve）
    ├── viz.js              圖形渲染、側邊欄、圖例、節點樣式、過濾器
    └── viz.css             全部樣式
```

---

## 修 BIOS 需要的檔案

**只需要丟這些給 AI：**

| 檔案 | 原因 |
|------|------|
| `parsers/bios_parser.py` | **所有 BIOS parser 都在這裡**（scan_inf / scan_sdl / scan_cif / scan_vfr / scan_c ...） |
| `static/viz.js` | BIOS 節點形狀、邊顏色、圖例都在這 |

> `analyze_viz.py`、`detector.py`、其他 parsers 都不需要動。

---

## 架構重點（給 AI 讀）

### analyze_viz.py 主流程
```
build_graph(root_dir)
  ├── 掃描所有符合 SCAN_EXT 的檔案
  ├── detector.py → 偵測專案類型，印 banner
  ├── scan_file(filepath) → 依副檔名 dispatch 到對應 parser
  │     BIOS/C/ASM: parsers/bios_parser.scan_bios(src, ext)
  │     Python:     parsers/python_parser.scan_python()
  │     JS/TS:      parsers/js_parser.scan_js() / scan_ts()
  │     Go:         parsers/go_parser.scan_go()
  ├── 建立 file_meta / file_incs / file_defs / file_calls
  ├── resolve_ref() → 把字串 ref 解析成實際 rel_path
  ├── add_edge() → 根據 ext 決定 edge type
  └── 回傳 dict → build_html() 嵌入 JSON → 瀏覽器渲染
```

### scan_file() 回傳格式（所有 parser 統一）
```python
return (
    imports_or_refs,      # list[str]  — 這個檔案依賴什麼
    funcdefs,             # list[dict] — {label, is_efiapi, is_static}
    funccalls,            # list[str]  — 所有 call site 名稱
    extra_dict,           # dict | None — 額外 metadata（BIOS 用）
    func_calls_by_func,   # list[list[str]] — 每個 funcdef 對應的 call list
)
```

### 新增語言的步驟（4 個地方）
1. `parsers/` → 新建 `xxx_parser.py`，實作 `scan_xxx()` 回傳上面格式
2. `analyze_viz.py` → `scan_file()` 加 dispatch，`SCAN_EXT` 加副檔名，`FILE_TYPE_MAP` 登記 file_type key
3. `detector.py` → `PROJECT_TYPES` 登記，`detect_project_type()` 加 score 邏輯
4. `static/viz.js` → `extColor()` 加顏色，`FILE_TYPE_SHAPE` 加節點形狀，`FT_GROUPS` 加 filter chip，`LEGEND_NODES` 加圖例

> **修 BIOS parser 邏輯** → 只需動 `parsers/bios_parser.py`，其他檔案完全不用碰

---

## BIOS 支援的檔案類型

| 副檔名 | file_type key | 說明 |
|--------|--------------|------|
| `.c/.cpp/.cc` | `c_source` | C/C++ 原始碼 |
| `.h/.hpp` | `header` | 標頭檔 |
| `.asm/.s/.S/.nasm` | `assembly` | 組合語言 |
| `.inf` | `module_inf` | EDK2 模組描述（Sources/Packages/LibraryClasses）|
| `.dec` | `package_dec` | EDK2 package 宣告（GUID/Protocol/PPI）|
| `.dsc` | `platform_dsc` | 平台描述（Components 列表）|
| `.fdf` | `flash_desc` | Flash 描述（FV 區段）|
| `.sdl` | `ami_sdl` | AMI 模組清單（INFComponent/LibraryMapping/ELINK）|
| `.sd` | `ami_sd` | AMI Setup Data（C struct + VFR 混合）|
| `.cif` | `ami_cif` | AMI Component Index（[INF]/[files]/[parts]）|
| `.mak` | `makefile` | Makefile |
| `.vfr` | `hii_vfr` | UEFI 標準 HII 表單 |
| `.hfr` | `hii_hfr` | AMI 擴充 HII Form Resource |
| `.uni` | `hii_string` | Unicode 字串包 |
| `.asl` | `acpi_asl` | ACPI Source Language |

## BIOS Edge 類型

| Edge | 顏色 | 觸發條件 |
|------|------|---------|
| `include` | 紫 `#c084fc` | `#include` / VFR include |
| `sources` | 金 `#ffd700` | INF `[Sources]` |
| `package` | 青 `#00d4ff` | INF `[Packages]` |
| `library` | 紫 `#a78bfa` | INF/SDL LibraryClasses |
| `component` | 藍 `#60a5fa` | DSC/FDF/SDL INFComponent |
| `elink` | 橙 `#ff6b35` | SDL ELINK Parent |
| `guid_ref` | 橙 `#fb923c` | INF Guids/Ppis/Protocols |
| `cif_own` | 綠 `#34d399` | CIF [INF]/[files] |
| `str_ref` | 粉 `#e879f9` | VFR/HFR → .uni |
| `asl_include` | 靛 `#818cf8` | ASL Include() |
| `callback_ref` | 紅 `#f87171` | VFR/HFR callback key |
| `depex` | 粉 `#f472b6` | INF [Depex] |

---

## 已知限制 / 待改進

- [ ] Python parser 用縮排推斷函式邊界，巢狀 class 不保證 100% 正確
- [ ] JS parser 不解析動態 `import()` 或 `require` 在 if/switch 內
- [ ] Go parser 不追蹤 interface 實作關係
- [ ] BIOS `resolve_ref()` 只做 basename / stem 比對，同名檔案可能 ambiguous
- [ ] node_modules 完全跳過（設計如此），不顯示第三方依賴

---

## 版本歷史

| 版本 | 日期 | 內容 |
|------|------|------|
| V3 | — | 原始 BIOS 專用版（analyze_bios.py）|
| V4 | 2025-03-05 | 架構重構：Pluggable Parsers + Python/JS/TS/Go 支援 + 專案類型偵測 |
| V4.1 | 2026-03-05 | BIOS 邏輯移入 parsers/bios_parser.py，架構完全對稱，analyze_viz.py 減少 544 行 |
