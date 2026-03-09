/**
 * i18n.js — VIZCODE Interface Strings
 *
 * HOW TO ADD A LANGUAGE:
 *   1. Copy the 'en' block, change the key (e.g. 'zh-tw').
 *   2. Translate every value string. Keys must stay identical.
 *   3. Add the new <option> to #pref-lang-select in analyze_viz.py.
 *
 * HOW TO USE IN CODE:
 *   import / reference window._i18n.t('key')
 *   e.g.  _i18n.t('extFilesOn')   → "External Files: On"
 *
 * Called automatically by _applyLang() when the page loads or language changes.
 */

window._I18N_STRINGS = {

    // ── English (default) ─────────────────────────────────────────────────────
    en: {
        // Topbar
        dashboard:              'Dashboard',

        // Toolbar — L1 Dependency Map
        extFilesOn:             'External Files: On',
        extFilesOff:            'External Files: Off',
        extFilesTooltip:        'Toggle external module files',

        // Toolbar — L2 Call Flow
        extFuncsOn:             'External Functions: On',
        extFuncsOff:            'External Functions: Off',
        extFuncsTooltip:        'Toggle external function nodes',

        // Code panel
        codePanelToggle:        'Code',
        callGraphToggle:        'Call Graph',
        prevFunc:               'Prev function (←)',
        nextFunc:               'Next function (→)',

        // Layout switcher
        layoutLabel:            'Layout',
        layoutApplying:         'Applying layout…',
        layoutCancelled:        'Cancelled',

        // Search
        searchPlaceholder:      'Search files, functions…',
        searchModeFiles:        'Files',
        searchModeCode:         'Code',
        searchMatchCase:        'Match Case (Alt+C)',
        searchMatchWord:        'Match Whole Word (Alt+W)',
        searchRegex:            'Use Regular Expression (Alt+R)',
        searchCollapseAll:      'Collapse All',
        searchExpandAll:        'Expand All',
        searchViewList:         'View as List',
        searchViewTree:         'View as Tree',
        searchInclude:          'Files to include',
        searchExclude:          'Files to exclude',
        searchFuncOnly:         'Show only function-definition matches',

        // Settings modal
        settingsTitle:          '⚙ Settings',
        settingsDone:           'Done',
        sectionAppearance:      'Appearance',
        sectionLanguage:        'Language',
        sectionBehaviour:       'Default Behaviour',
        fontLabel:              'Code Editor Font',
        themeLabel:             'Theme',
        themeOptDark:           'Dark (Default)',
        themeOptClaude:         'Claude',
        langLabel:              'Interface Language',
        langHint:               'Applies immediately. Translation strings are defined in i18n.js.',
        extFilesAlways:         'External Files always ON',
        extFilesAlwaysDesc:     'Show external module files by default in Dependency Map (L1)',
        extFuncsAlways:         'External Functions always ON',
        extFuncsAlwaysDesc:     'Show external function nodes by default in Call Flow (L2). External lines follow automatically.',

        // Loading / cancel
        loadingCancel:          '✕ Cancel',
        renderCancelled:        'Cancelled',

        // Toast / errors
        layoutNotLoaded:        'CDN script may not have loaded',
    },

    // ── 繁體中文 ──────────────────────────────────────────────────────────────
    'zh-tw': {
        // Topbar
        dashboard:              '儀表板',

        // Toolbar — L1 Dependency Map
        extFilesOn:             '外部檔案：開啟',
        extFilesOff:            '外部檔案：關閉',
        extFilesTooltip:        '切換外部模組檔案顯示',

        // Toolbar — L2 Call Flow
        extFuncsOn:             '外部函式：開啟',
        extFuncsOff:            '外部函式：關閉',
        extFuncsTooltip:        '切換外部函式節點顯示',

        // Code panel
        codePanelToggle:        '程式碼',
        callGraphToggle:        '呼叫圖',
        prevFunc:               '上一個函式 (←)',
        nextFunc:               '下一個函式 (→)',

        // Layout switcher
        layoutLabel:            '佈局',
        layoutApplying:         '套用佈局中…',
        layoutCancelled:        '已取消',

        // Search
        searchPlaceholder:      '搜尋檔案、函式…',
        searchModeFiles:        '檔案',
        searchModeCode:         '程式碼',
        searchMatchCase:        '區分大小寫 (Alt+C)',
        searchMatchWord:        '全字匹配 (Alt+W)',
        searchRegex:            '使用正則表達式 (Alt+R)',
        searchCollapseAll:      '全部收合',
        searchExpandAll:        '全部展開',
        searchViewList:         '清單檢視',
        searchViewTree:         '樹狀檢視',
        searchInclude:          '包含的檔案',
        searchExclude:          '排除的檔案',
        searchFuncOnly:         '只顯示函式定義的匹配行',

        // Settings modal
        settingsTitle:          '⚙ 設定',
        settingsDone:           '完成',
        sectionAppearance:      '外觀',
        sectionLanguage:        '語言',
        sectionBehaviour:       '預設行為',
        fontLabel:              '程式碼字型',
        themeLabel:             '佈景主題',
        themeOptDark:           '深色（預設）',
        themeOptClaude:         'Claude 風格',
        langLabel:              '介面語言',
        langHint:               '立即套用。翻譯字串定義於 i18n.js。',
        extFilesAlways:         '預設開啟外部檔案',
        extFilesAlwaysDesc:     '在相依性地圖 (L1) 中預設顯示外部模組檔案',
        extFuncsAlways:         '預設開啟外部函式',
        extFuncsAlwaysDesc:     '在呼叫流程圖 (L2) 中預設顯示外部函式節點。外部連線將自動跟隨。',

        // Loading / cancel
        loadingCancel:          '✕ 取消',
        renderCancelled:        '已取消',

        // Toast / errors
        layoutNotLoaded:        'CDN 腳本可能未載入',
    },
};

// ── Runtime accessor ──────────────────────────────────────────────────────────
window._i18n = {
    _lang: 'en',

    init(lang) {
        this._lang = (lang && window._I18N_STRINGS[lang]) ? lang : 'en';
    },

    t(key) {
        const strings = window._I18N_STRINGS[this._lang] || window._I18N_STRINGS['en'];
        return strings[key] ?? window._I18N_STRINGS['en'][key] ?? key;
    },
};
