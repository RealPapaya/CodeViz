#!/usr/bin/env python3
"""
analyze_viz.py V4 — VIZCODE Universal Code Visualizer
Supports: UEFI/BIOS (C/H/ASM/INF/DEC/DSC/FDF/SDL/CIF/MAK/VFR/HFR/UNI/ASL)
          Python (.py)
          JavaScript / TypeScript (.js/.mjs/.cjs/.jsx/.ts/.tsx)
          Go (.go)

Pluggable Parser architecture: each language has its own parser in parsers/
Project type is auto-detected and displayed during analysis.

Backward compatible: still importable as analyze_bios (server.py alias).
"""

import os, re, json, sys, argparse
from pathlib import Path
from collections import defaultdict

# ─── Pluggable parsers ────────────────────────────────────────────────────────
_PARSER_DIR = Path(__file__).parent / 'parsers'
if str(_PARSER_DIR.parent) not in sys.path:
    sys.path.insert(0, str(_PARSER_DIR.parent))

try:
    from parsers.bios_parser   import scan_bios, BIOS_EXTENSIONS as _BIOS_EXTENSIONS
    from parsers.python_parser import scan_python
    from parsers.js_parser     import scan_js, scan_ts
    from parsers.go_parser     import scan_go
    from detector              import detect_project_type, fmt_detection_banner
    _PARSERS_LOADED = True
except ImportError as _pe:
    _PARSERS_LOADED = False
    _BIOS_EXTENSIONS = set()
    print(f'[WARN] Could not load language parsers: {_pe}', file=sys.stderr)

# ─── Constants ───────────────────────────────────────────────────────────────
SKIP_DIRS  = {
    # BIOS / build
    'Build', 'build', '.git', '__pycache__', 'Conf', 'DEBUG', 'RELEASE', '.claude',
    # JavaScript / Node
    'node_modules', '.next', '.nuxt', 'dist', 'out', '.output', '.cache',
    'coverage', '.nyc_output', 'storybook-static',
    # Go
    'vendor',
    # Python
    '.venv', 'venv', 'env', '.env', '.tox', '.pytest_cache', '.mypy_cache',
    'site-packages', '__pypackages__',
    # General
    '.idea', '.vscode', '.DS_Store',
}
BUILD_DIRS = {'Build','build','DEBUG','RELEASE'}
SCAN_EXT   = {
    # ── C/C++ / ASM (BIOS) ─────────────────────────────────────────────────
    '.c','.cpp','.cc','.h','.hpp','.asm','.s','.S','.nasm',
    # ── UEFI / EDK2 build system ───────────────────────────────────────────
    '.inf', '.dec', '.dsc', '.fdf',
    # ── AMI BIOS proprietary ───────────────────────────────────────────────
    '.sdl', '.sd', '.cif', '.mak',
    # ── HII (Human Interface Infrastructure) ───────────────────────────────
    '.vfr',   # UEFI standard HII form language
    '.hfr',   # AMI extended HII Form Resource
    '.uni',   # Unicode string packages
    # ── ACPI ───────────────────────────────────────────────────────────────
    '.asl',
    # ── Python ─────────────────────────────────────────────────────────────
    '.py',
    # ── JavaScript / TypeScript ─────────────────────────────────────────────
    '.js', '.mjs', '.cjs', '.jsx',
    '.ts', '.tsx',
    # ── Go ─────────────────────────────────────────────────────────────────
    '.go',
}
SKIP_EXT   = {'.veb','.lib','.obj','.efi','.rom','.bin','.log','.map'}

# ─── File type semantic categories ───────────────────────────────────────────
FILE_TYPE_MAP = {
    # BIOS / C
    '.c': 'c_source', '.cpp': 'c_source', '.cc': 'c_source',
    '.h': 'header',   '.hpp': 'header',
    '.asm': 'assembly', '.s': 'assembly', '.S': 'assembly', '.nasm': 'assembly',
    '.inf': 'module_inf',
    '.dec': 'package_dec',
    '.dsc': 'platform_dsc',
    '.fdf': 'flash_desc',
    '.sdl': 'ami_sdl',
    '.sd':  'ami_sd',
    '.cif': 'ami_cif',
    '.mak': 'makefile',
    '.vfr': 'hii_vfr',
    '.hfr': 'hii_hfr',
    '.uni': 'hii_string',
    '.asl': 'acpi_asl',
    # Python
    '.py':  'py_source',
    # JavaScript / TypeScript
    '.js':  'js_source', '.mjs': 'js_source', '.cjs': 'js_source',
    '.jsx': 'jsx_source',
    '.ts':  'ts_source',
    '.tsx': 'tsx_source',
    # Go
    '.go':  'go_source',
}

# ─── Edge type definitions ───────────────────────────────────────────────────
# 每種 edge type 決定前端的線條樣式
EDGE_TYPES = {
    'include':       {'label': 'Include',            'color': '#c084fc', 'style': 'solid'},
    'sources':       {'label': 'Sources',     'color': '#ffd700', 'style': 'solid'},
    'package':       {'label': 'Package',     'color': '#00d4ff', 'style': 'dashed'},
    'library':       {'label': 'Library',     'color': '#a78bfa', 'style': 'dashed'},
    'elink':         {'label': 'ELINK',       'color': '#ff6b35', 'style': 'dotted'},
    'cif_own':       {'label': 'owns',        'color': '#34d399', 'style': 'solid'},
    'component':     {'label': 'Component',   'color': '#60a5fa', 'style': 'solid'},
    'depex':         {'label': 'Depex',       'color': '#f472b6', 'style': 'dotted'},
    'guid_ref':      {'label': 'GUID',        'color': '#fb923c', 'style': 'dashed'},
    'str_ref':       {'label': 'Strings',     'color': '#e879f9', 'style': 'dashed'},
    'asl_include':   {'label': 'ASL',         'color': '#818cf8', 'style': 'solid'},
    'callback_ref':  {'label': 'Callback',    'color': '#f87171', 'style': 'dotted'},
    'hii_pkg':       {'label': 'HII-Pkg',     'color': '#94a3b8', 'style': 'solid'},
    # ── Universal import edge (Python / JS / TS / Go) ──────────────────────
    'import':        {'label': 'Import',      'color': '#10b981', 'style': 'dashed'},
}

# C_KEYWORDS now lives in parsers/bios_parser.py

MODULE_COLORS = [
    '#00d4ff','#00ff9f','#ff6b35','#ffd700','#a78bfa',
    '#f472b6','#34d399','#fb923c','#60a5fa','#e879f9',
    '#4ade80','#facc15','#f87171','#38bdf8','#c084fc',
]

# ─── Known system / UEFI / C-runtime function categories ─────────────────────
# Maps function name → display category name.
# Used by the frontend to classify "unresolved" calls into meaningful groups
# instead of dumping everything into a single "System/Unknown" blob.
KNOWN_SYS_FUNCS: dict[str, str] = {
    # ── UEFI Boot Services (gBS->) ────────────────────────────────────────────
    'AllocatePool':                     'UEFI Boot Services',
    'FreePool':                         'UEFI Boot Services',
    'AllocatePages':                    'UEFI Boot Services',
    'FreePages':                        'UEFI Boot Services',
    'InstallProtocolInterface':         'UEFI Boot Services',
    'UninstallProtocolInterface':       'UEFI Boot Services',
    'InstallMultipleProtocolInterfaces':'UEFI Boot Services',
    'UninstallMultipleProtocolInterfaces':'UEFI Boot Services',
    'LocateProtocol':                   'UEFI Boot Services',
    'HandleProtocol':                   'UEFI Boot Services',
    'OpenProtocol':                     'UEFI Boot Services',
    'CloseProtocol':                    'UEFI Boot Services',
    'LocateHandleBuffer':               'UEFI Boot Services',
    'LocateHandle':                     'UEFI Boot Services',
    'CreateEvent':                      'UEFI Boot Services',
    'CreateEventEx':                    'UEFI Boot Services',
    'CloseEvent':                       'UEFI Boot Services',
    'SignalEvent':                      'UEFI Boot Services',
    'WaitForEvent':                     'UEFI Boot Services',
    'CheckEvent':                       'UEFI Boot Services',
    'SetTimer':                         'UEFI Boot Services',
    'RaiseTPL':                         'UEFI Boot Services',
    'RestoreTPL':                       'UEFI Boot Services',
    'ExitBootServices':                 'UEFI Boot Services',
    'GetMemoryMap':                     'UEFI Boot Services',
    'SetWatchdogTimer':                 'UEFI Boot Services',
    'Stall':                            'UEFI Boot Services',
    'ConnectController':                'UEFI Boot Services',
    'DisconnectController':             'UEFI Boot Services',
    'RegisterProtocolNotify':           'UEFI Boot Services',
    'ReinstallProtocolInterface':       'UEFI Boot Services',
    'LoadImage':                        'UEFI Boot Services',
    'StartImage':                       'UEFI Boot Services',
    'Exit':                             'UEFI Boot Services',
    'UnloadImage':                      'UEFI Boot Services',
    'GetNextMonotonicCount':            'UEFI Boot Services',
    'InstallConfigurationTable':        'UEFI Boot Services',
    'ProtocolsPerHandle':               'UEFI Boot Services',
    'OpenProtocolInformation':          'UEFI Boot Services',

    # ── UEFI Runtime Services (gRT->) ─────────────────────────────────────────
    'GetVariable':                      'UEFI Runtime Services',
    'SetVariable':                      'UEFI Runtime Services',
    'GetNextVariableName':              'UEFI Runtime Services',
    'QueryVariableInfo':                'UEFI Runtime Services',
    'GetTime':                          'UEFI Runtime Services',
    'SetTime':                          'UEFI Runtime Services',
    'GetWakeupTime':                    'UEFI Runtime Services',
    'SetWakeupTime':                    'UEFI Runtime Services',
    'SetVirtualAddressMap':             'UEFI Runtime Services',
    'ConvertPointer':                   'UEFI Runtime Services',
    'GetNextHighMonotonicCount':        'UEFI Runtime Services',
    'ResetSystem':                      'UEFI Runtime Services',
    'UpdateCapsule':                    'UEFI Runtime Services',
    'QueryCapsuleCapabilities':         'UEFI Runtime Services',

    # ── EDK2 MemoryLib ────────────────────────────────────────────────────────
    'CopyMem':          'EDK2 MemoryLib',
    'SetMem':           'EDK2 MemoryLib',
    'SetMem8':          'EDK2 MemoryLib',
    'SetMem16':         'EDK2 MemoryLib',
    'SetMem32':         'EDK2 MemoryLib',
    'SetMem64':         'EDK2 MemoryLib',
    'ZeroMem':          'EDK2 MemoryLib',
    'CompareMem':       'EDK2 MemoryLib',
    'ScanMem8':         'EDK2 MemoryLib',
    'ScanMem16':        'EDK2 MemoryLib',
    'ScanMem32':        'EDK2 MemoryLib',
    'ScanMem64':        'EDK2 MemoryLib',
    'CopyMemS':         'EDK2 MemoryLib',
    'SetMemS':          'EDK2 MemoryLib',

    # ── EDK2 BaseLib / String ─────────────────────────────────────────────────
    'StrLen':           'EDK2 BaseLib',
    'StrnLen':          'EDK2 BaseLib',
    'StrSize':          'EDK2 BaseLib',
    'StrCmp':           'EDK2 BaseLib',
    'StrnCmp':          'EDK2 BaseLib',
    'StrCpy':           'EDK2 BaseLib',
    'StrnCpy':          'EDK2 BaseLib',
    'StrCat':           'EDK2 BaseLib',
    'StrnCat':          'EDK2 BaseLib',
    'StrStr':           'EDK2 BaseLib',
    'StrDecimalToUintn':'EDK2 BaseLib',
    'StrDecimalToUint64':'EDK2 BaseLib',
    'StrHexToUintn':    'EDK2 BaseLib',
    'StrHexToUint64':   'EDK2 BaseLib',
    'UnicodeStrToAsciiStr':'EDK2 BaseLib',
    'AsciiStrToUnicodeStr':'EDK2 BaseLib',
    'AsciiStrLen':      'EDK2 BaseLib',
    'AsciiStrnLen':     'EDK2 BaseLib',
    'AsciiStrSize':     'EDK2 BaseLib',
    'AsciiStrCmp':      'EDK2 BaseLib',
    'AsciiStrnCmp':     'EDK2 BaseLib',
    'AsciiStrCpy':      'EDK2 BaseLib',
    'AsciiStrnCpy':     'EDK2 BaseLib',
    'AsciiStrCat':      'EDK2 BaseLib',
    'AsciiStrnCat':     'EDK2 BaseLib',
    'AsciiStrStr':      'EDK2 BaseLib',
    'AsciiStrDecimalToUintn':'EDK2 BaseLib',
    'AsciiStrHexToUintn':'EDK2 BaseLib',
    'UnicodeStrToAsciiStrS':'EDK2 BaseLib',
    'AsciiStrToUnicodeStrS':'EDK2 BaseLib',
    'StrCpyS':          'EDK2 BaseLib',
    'StrnCpyS':         'EDK2 BaseLib',
    'StrCatS':          'EDK2 BaseLib',
    'StrnCatS':         'EDK2 BaseLib',
    'AsciiStrCpyS':     'EDK2 BaseLib',
    'AsciiStrnCpyS':    'EDK2 BaseLib',
    'AsciiStrCatS':     'EDK2 BaseLib',
    'AsciiStrnCatS':    'EDK2 BaseLib',
    'UnicodeSPrint':    'EDK2 BaseLib',
    'UnicodeSPrintAsciiFormat':'EDK2 BaseLib',
    'AsciiSPrint':      'EDK2 BaseLib',
    'AsciiSPrintUnicodeFormat':'EDK2 BaseLib',
    'UnicodeVSPrint':   'EDK2 BaseLib',
    'AsciiVSPrint':     'EDK2 BaseLib',
    'SwapBytes16':      'EDK2 BaseLib',
    'SwapBytes32':      'EDK2 BaseLib',
    'SwapBytes64':      'EDK2 BaseLib',
    'LShiftU64':        'EDK2 BaseLib',
    'RShiftU64':        'EDK2 BaseLib',
    'ARShiftU64':       'EDK2 BaseLib',
    'MultU64x32':       'EDK2 BaseLib',
    'MultU64x64':       'EDK2 BaseLib',
    'DivU64x32':        'EDK2 BaseLib',
    'DivU64x64Remainder':'EDK2 BaseLib',
    'ModU64x32':        'EDK2 BaseLib',
    'GetPowerOfTwo32':  'EDK2 BaseLib',
    'GetPowerOfTwo64':  'EDK2 BaseLib',
    'HighBitSet32':     'EDK2 BaseLib',
    'HighBitSet64':     'EDK2 BaseLib',
    'LowBitSet32':      'EDK2 BaseLib',
    'LowBitSet64':      'EDK2 BaseLib',
    'CalculateCrc32':   'EDK2 BaseLib',

    # ── EDK2 DebugLib ─────────────────────────────────────────────────────────
    'DEBUG':                'EDK2 DebugLib',
    'ASSERT':               'EDK2 DebugLib',
    'ASSERT_EFI_ERROR':     'EDK2 DebugLib',
    'ASSERT_PROTOCOL_ALREADY_INSTALLED': 'EDK2 DebugLib',
    'DebugPrint':           'EDK2 DebugLib',
    'DebugAssert':          'EDK2 DebugLib',
    'DebugClearMemory':     'EDK2 DebugLib',
    'DebugAssertEnabled':   'EDK2 DebugLib',
    'DebugPrintEnabled':    'EDK2 DebugLib',
    'DebugCodeEnabled':     'EDK2 DebugLib',
    'DeadLoop':             'EDK2 DebugLib',

    # ── EDK2 PrintLib ─────────────────────────────────────────────────────────
    'Print':            'EDK2 PrintLib',
    'AsciiPrint':       'EDK2 PrintLib',

    # ── EDK2 MemoryAllocationLib ──────────────────────────────────────────────
    'AllocateZeroPool':         'EDK2 MemAlloc',
    'AllocateCopyPool':         'EDK2 MemAlloc',
    'AllocatePool':             'EDK2 MemAlloc',
    'AllocateRuntimePool':      'EDK2 MemAlloc',
    'AllocateReservedPool':     'EDK2 MemAlloc',
    'AllocateRuntimeZeroPool':  'EDK2 MemAlloc',
    'FreePool':                 'EDK2 MemAlloc',
    'ReallocatePool':           'EDK2 MemAlloc',
    'AllocateAlignedPool':      'EDK2 MemAlloc',
    'AllocateAlignedZeroPool':  'EDK2 MemAlloc',
    'FreeAlignedPool':          'EDK2 MemAlloc',

    # ── EDK2 PeiServicesLib ───────────────────────────────────────────────────
    'PeiServicesInstallPpi':            'PEI Services',
    'PeiServicesReInstallPpi':          'PEI Services',
    'PeiServicesLocatePpi':             'PEI Services',
    'PeiServicesNotifyPpi':             'PEI Services',
    'PeiServicesGetBootMode':           'PEI Services',
    'PeiServicesSetBootMode':           'PEI Services',
    'PeiServicesGetHobList':            'PEI Services',
    'PeiServicesCreateHob':             'PEI Services',
    'PeiServicesFfsFindNextVolume':     'PEI Services',
    'PeiServicesFfsFindNextFile':       'PEI Services',
    'PeiServicesFfsFindSectionData':    'PEI Services',
    'PeiServicesInstallPeiMemory':      'PEI Services',
    'PeiServicesAllocatePages':         'PEI Services',
    'PeiServicesAllocatePool':          'PEI Services',
    'PeiServicesCopyMem':               'PEI Services',
    'PeiServicesSetMem':                'PEI Services',
    'PeiServicesReportStatusCode':      'PEI Services',
    'PeiServicesResetSystem':           'PEI Services',

    # ── EDK2 HobLib ───────────────────────────────────────────────────────────
    'GetHobList':           'EDK2 HobLib',
    'GetNextHob':           'EDK2 HobLib',
    'GetFirstHob':          'EDK2 HobLib',
    'GetNextGuidHob':       'EDK2 HobLib',
    'GetFirstGuidHob':      'EDK2 HobLib',
    'BuildHob':             'EDK2 HobLib',
    'BuildModuleHob':       'EDK2 HobLib',
    'BuildResourceDescriptorHob':'EDK2 HobLib',
    'BuildGuidHob':         'EDK2 HobLib',
    'BuildGuidDataHob':     'EDK2 HobLib',
    'BuildFvHob':           'EDK2 HobLib',
    'BuildCpuHob':          'EDK2 HobLib',
    'BuildMemoryAllocationHob':'EDK2 HobLib',
    'BuildStackHob':        'EDK2 HobLib',
    'BuildBspStoreHob':     'EDK2 HobLib',
    'GetBootModeHob':       'EDK2 HobLib',

    # ── EDK2 UefiLib / DevicePath ─────────────────────────────────────────────
    'EfiCreateEventReadyToBootEx':  'EDK2 UefiLib',
    'EfiNamedEventListen':          'EDK2 UefiLib',
    'EfiNamedEventSignal':          'EDK2 UefiLib',
    'EfiEventEmptyFunction':        'EDK2 UefiLib',
    'GetGlyphWidth':                'EDK2 UefiLib',
    'EfiGetSystemConfigurationTable':'EDK2 UefiLib',
    'EfiLibInstallDriverBinding':   'EDK2 UefiLib',
    'EfiLibInstallAllDriverProtocols2':'EDK2 UefiLib',
    'GetVariable2':                 'EDK2 UefiLib',
    'GetEfiGlobalVariable2':        'EDK2 UefiLib',
    'DevicePathToStr':              'EDK2 UefiLib',
    'DevicePathFromHandle':         'EDK2 DevicePath',
    'AppendDevicePath':             'EDK2 DevicePath',
    'AppendDevicePathNode':         'EDK2 DevicePath',
    'AppendDevicePathInstance':     'EDK2 DevicePath',
    'DuplicateDevicePath':          'EDK2 DevicePath',
    'IsDevicePathEnd':              'EDK2 DevicePath',
    'IsDevicePathEndType':          'EDK2 DevicePath',
    'IsDevicePathEndInstance':      'EDK2 DevicePath',
    'NextDevicePathNode':           'EDK2 DevicePath',
    'DevicePathType':               'EDK2 DevicePath',
    'DevicePathSubType':            'EDK2 DevicePath',
    'DevicePathNodeLength':         'EDK2 DevicePath',
    'SetDevicePathNodeLength':      'EDK2 DevicePath',
    'SetDevicePathEndNode':         'EDK2 DevicePath',
    'GetDevicePathSize':            'EDK2 DevicePath',
    'ConvertDevicePathToText':      'EDK2 DevicePath',

    # ── C Standard Library ────────────────────────────────────────────────────
    'memcpy':   'C Runtime',  'memmove':  'C Runtime',
    'memset':   'C Runtime',  'memcmp':   'C Runtime',
    'memchr':   'C Runtime',  'strlen':   'C Runtime',
    'strcmp':   'C Runtime',  'strncmp':  'C Runtime',
    'strcpy':   'C Runtime',  'strncpy':  'C Runtime',
    'strcat':   'C Runtime',  'strncat':  'C Runtime',
    'strchr':   'C Runtime',  'strrchr':  'C Runtime',
    'strstr':   'C Runtime',  'strtol':   'C Runtime',
    'strtoul':  'C Runtime',  'strtoll':  'C Runtime',
    'strtoull': 'C Runtime',  'strtod':   'C Runtime',
    'atoi':     'C Runtime',  'atol':     'C Runtime',
    'atoll':    'C Runtime',  'atof':     'C Runtime',
    'sprintf':  'C Runtime',  'snprintf': 'C Runtime',
    'sscanf':   'C Runtime',  'printf':   'C Runtime',
    'fprintf':  'C Runtime',  'vprintf':  'C Runtime',
    'vsprintf': 'C Runtime',  'vsnprintf':'C Runtime',
    'malloc':   'C Runtime',  'calloc':   'C Runtime',
    'realloc':  'C Runtime',  'free':     'C Runtime',
    'abs':      'C Runtime',  'labs':     'C Runtime',
    'llabs':    'C Runtime',  'div':      'C Runtime',
    'ldiv':     'C Runtime',  'lldiv':    'C Runtime',
    'rand':     'C Runtime',  'srand':    'C Runtime',
    'qsort':    'C Runtime',  'bsearch':  'C Runtime',

    # ── AMI BIOS SDK ──────────────────────────────────────────────────────────
    'Malloc':               'AMI SDK',
    'MallocZ':              'AMI SDK',
    'Free':                 'AMI SDK',
    'MemSet':               'AMI SDK',
    'MemCpy':               'AMI SDK',
    'MemCmp':               'AMI SDK',
    'Strlen':               'AMI SDK',
    'Strcmp':               'AMI SDK',
    'Strcpy':               'AMI SDK',
    'Strcat':               'AMI SDK',
    'Sprintf':              'AMI SDK',
    'Swprintf':             'AMI SDK',
    'AmiInstallProtocol':   'AMI SDK',
    'AmiLocateProtocol':    'AMI SDK',
    'TRACE':                'AMI SDK',
    'PROGRESS_CODE':        'AMI SDK',
    'ERROR_CODE':           'AMI SDK',
    'AmiGetSystemVariable': 'AMI SDK',
    'AmiSetSystemVariable': 'AMI SDK',

    # ── IO / CPU / MSR ────────────────────────────────────────────────────────
    'IoRead8':      'CPU/IO Lib',  'IoWrite8':     'CPU/IO Lib',
    'IoRead16':     'CPU/IO Lib',  'IoWrite16':    'CPU/IO Lib',
    'IoRead32':     'CPU/IO Lib',  'IoWrite32':    'CPU/IO Lib',
    'MmioRead8':    'CPU/IO Lib',  'MmioWrite8':   'CPU/IO Lib',
    'MmioRead16':   'CPU/IO Lib',  'MmioWrite16':  'CPU/IO Lib',
    'MmioRead32':   'CPU/IO Lib',  'MmioWrite32':  'CPU/IO Lib',
    'MmioRead64':   'CPU/IO Lib',  'MmioWrite64':  'CPU/IO Lib',
    'MmioAndThenOr8':  'CPU/IO Lib', 'MmioAndThenOr16': 'CPU/IO Lib',
    'MmioAndThenOr32': 'CPU/IO Lib', 'MmioAndThenOr64': 'CPU/IO Lib',
    'MmioOr8':      'CPU/IO Lib',  'MmioOr16':     'CPU/IO Lib',
    'MmioOr32':     'CPU/IO Lib',  'MmioOr64':     'CPU/IO Lib',
    'MmioAnd8':     'CPU/IO Lib',  'MmioAnd16':    'CPU/IO Lib',
    'MmioAnd32':    'CPU/IO Lib',  'MmioAnd64':    'CPU/IO Lib',
    'AsmReadMsr64': 'CPU/IO Lib',  'AsmWriteMsr64':'CPU/IO Lib',
    'AsmReadMsr32': 'CPU/IO Lib',  'AsmWriteMsr32':'CPU/IO Lib',
    'AsmCpuid':     'CPU/IO Lib',  'AsmCpuidEx':   'CPU/IO Lib',
    'AsmReadCr0':   'CPU/IO Lib',  'AsmWriteCr0':  'CPU/IO Lib',
    'AsmReadCr2':   'CPU/IO Lib',  'AsmReadCr3':   'CPU/IO Lib',
    'AsmWriteCr3':  'CPU/IO Lib',  'AsmReadCr4':   'CPU/IO Lib',
    'AsmWriteCr4':  'CPU/IO Lib',  'AsmReadIdtr':  'CPU/IO Lib',
    'AsmWriteIdtr': 'CPU/IO Lib',  'AsmReadGdtr':  'CPU/IO Lib',
    'AsmWriteGdtr': 'CPU/IO Lib',  'AsmDisableInterrupts':'CPU/IO Lib',
    'AsmEnableInterrupts':  'CPU/IO Lib',
    'AsmWbinvd':    'CPU/IO Lib',  'AsmInvd':      'CPU/IO Lib',
    'AsmFlushCacheLine': 'CPU/IO Lib',
    'AsmNop':       'CPU/IO Lib',  'AsmPause':     'CPU/IO Lib',

    # ── UEFI ReportStatusCode ─────────────────────────────────────────────────
    'REPORT_STATUS_CODE':           'Status Code',
    'REPORT_STATUS_CODE_WITH_DEVICE_PATH': 'Status Code',
    'REPORT_STATUS_CODE_WITH_EXTENDED_DATA': 'Status Code',
    'ReportStatusCode':             'Status Code',
    'ReportStatusCodeWithDevicePath': 'Status Code',
    'LibReportStatusCode':          'Status Code',
}

# ─── All BIOS/UEFI/AMI/C parsers → parsers/bios_parser.py ──────────────────────

# ─── scan_file ────────────────────────────────────────────────────────────────
def scan_file(filepath: str, root: str):
    """
    Returns (includes_or_refs, funcdefs, funccalls, bios_extra_dict, func_calls_by_func)
    bios_extra_dict varies by file type; None for C/H/ASM.
    """
    try:
        src = Path(filepath).read_text(encoding='utf-8', errors='replace')
    except Exception:
        return [], [], [], None, []

    ext = Path(filepath).suffix.lower()

    # ── BIOS / UEFI / AMI / C / ASM ──────────────────────────────────────────
    if ext in _BIOS_EXTENSIONS and _PARSERS_LOADED:
        return scan_bios(src, ext)

    # ── Python ───────────────────────────────────────────────────────────────
    if ext == '.py' and _PARSERS_LOADED:
        imports, funcdefs, calls, extra, fcbf = scan_python(src)
        return imports, funcdefs, calls, extra, fcbf

    # ── JavaScript / TypeScript ───────────────────────────────────────────────
    if ext in ('.js', '.mjs', '.cjs', '.jsx') and _PARSERS_LOADED:
        imports, funcdefs, calls, extra, fcbf = scan_js(src)
        return imports, funcdefs, calls, extra, fcbf

    if ext in ('.ts', '.tsx') and _PARSERS_LOADED:
        imports, funcdefs, calls, extra, fcbf = scan_ts(src)
        return imports, funcdefs, calls, extra, fcbf

    # ── Go ────────────────────────────────────────────────────────────────────
    if ext == '.go' and _PARSERS_LOADED:
        imports, funcdefs, calls, extra, fcbf = scan_go(src)
        return imports, funcdefs, calls, extra, fcbf

    # Remaining: .c, .cpp, .h, .hpp → C-like analysis
    clean = strip_comments(src)
    masked = mask_string_literals(clean)
    includes = RE_INCLUDE.findall(clean)

    funcdefs, funccalls, func_calls_by_func = [], [], []
    for m in RE_FUNCDEF.finditer(clean):
        is_efiapi = bool(m.group(1))
        name = m.group(2)
        if name in C_KEYWORDS or len(name) < 2:
            continue
        line_before = clean[:m.start()].rstrip()
        is_static = bool(RE_STATIC.search(line_before.split('\n')[-1] if '\n' in line_before else line_before))
        funcdefs.append({'label': name, 'is_efiapi': is_efiapi, 'is_static': is_static})

        open_idx = m.end() - 1  # regex ends at '{'
        close_idx = find_matching_brace(masked, open_idx)
        body = masked[open_idx + 1:close_idx] if close_idx > open_idx else ''
        calls = []
        if body:
            for cm in RE_FUNCCALL.finditer(body):
                cname = cm.group(1)
                if cname not in C_KEYWORDS and len(cname) >= 2:
                    calls.append(cname)
        func_calls_by_func.append(calls)

    for m in RE_FUNCCALL.finditer(clean):
        name = m.group(1)
        if name not in C_KEYWORDS and len(name) >= 2:
            funccalls.append(name)

    return includes, funcdefs, funccalls, None, func_calls_by_func


# ─── get_module ───────────────────────────────────────────────────────────────
def get_module(rel_path: str) -> str:
    parts = rel_path.replace('\\', '/').split('/')
    return parts[0] if len(parts) > 1 else '_root'


# ─── build_graph ─────────────────────────────────────────────────────────────
def build_graph(root_dir: str, progress_cb=None, include_build=False, include_dirs=None) -> dict:
    def _cb(pct, msg, **kwargs):
        print(f'[{pct:3d}%] {msg}', end='\r')
        if progress_cb: progress_cb(pct, msg, **kwargs)

    root = os.path.abspath(root_dir)
    all_files = []

    _cb(0, 'Scanning files...')
    skip_dirs = set(SKIP_DIRS)
    if include_build:
        skip_dirs -= BUILD_DIRS
    if include_dirs:
        skip_dirs -= set(include_dirs)
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in skip_dirs]
        for fname in filenames:
            ext = Path(fname).suffix.lower()
            if ext in SCAN_EXT and ext not in SKIP_EXT:
                all_files.append(os.path.join(dirpath, fname))

    total = len(all_files)
    _cb(0, f'Found {total} files, analyzing...')

    # ── Project type detection ────────────────────────────────────────────────
    ext_counts: dict = defaultdict(int)
    for fp in all_files:
        ext_counts[Path(fp).suffix.lower()] += 1

    project_type = {'key': 'c_cpp', 'name': 'C / C++', 'emoji': '⚙️', 'badge_color': '#3b82f6', 'accent': '#60a5fa'}
    if _PARSERS_LOADED:
        project_type = detect_project_type(dict(ext_counts))
        banner = fmt_detection_banner(project_type)
        for line in banner:
            print(line)
        _cb(1, f'{project_type["emoji"]}  Detected: {project_type["name"]} project', project_type=project_type)

    file_meta   = {}  # rel_path → {label, ext, size, module, file_type, bios_meta}
    file_incs   = {}  # rel_path → [ref strings]
    file_defs   = {}  # rel_path → [{label, is_efiapi, is_static}]
    file_calls  = {}  # rel_path → [call names]
    file_extra  = {}  # rel_path → bios_extra dict (for .inf/.sdl/.cif etc.)

    file_func_calls = {}

    for i, fp in enumerate(all_files):
        if (i + 1) % 50 == 0 or (i + 1) == total:
            pct = int((i + 1) / total * 60) if total else 0
            if progress_cb:
                progress_cb(pct, f'{i + 1}/{total} files analyzed')
            print(f'[{pct:3d}%] {i + 1}/{total} files analyzed', end='\r')
        rel = os.path.relpath(fp, root).replace('\\', '/')
        inc, defs, calls, extra, func_calls_by_func = scan_file(fp, root)
        ext = Path(fp).suffix.lower()
        bios_meta = {}
        if extra and 'meta' in extra:
            bios_meta = extra['meta']

        file_meta[rel] = {
            'label':     os.path.basename(fp),
            'ext':       ext,
            'size':      os.path.getsize(fp),
            'module':    get_module(rel),
            'file_type': FILE_TYPE_MAP.get(ext, 'other'),
            'bios_meta': bios_meta,
        }
        file_incs[rel]  = inc
        file_defs[rel]  = defs
        file_calls[rel] = calls
        file_func_calls[rel] = func_calls_by_func
        file_extra[rel] = extra

    # ── Phase X: Collect ALL other files + count skipped dirs + total dirs ───────
    # Other files are not analysed for deps but shown in UI for full codebase picture.
    _cb(59, 'Scanning other files...')
    other_files_all: dict = {}
    _oth_idx = len(file_meta)

    total_dirs_scanned   = 0   # all subdirectory count (excluding skipped)
    total_dirs_skipped   = 0   # directories we skip entirely
    total_files_skipped  = 0   # files inside skipped directories

    # First count what's hidden inside SKIP_DIRS
    for _skip_name in sorted(skip_dirs):
        _skip_path = os.path.join(root, _skip_name)
        if not os.path.isdir(_skip_path):
            continue
        total_dirs_skipped += 1
        for _sdp, _sdn, _sfn in os.walk(_skip_path):
            total_dirs_skipped += len(_sdn)  # count sub-dirs inside skip dir
            total_files_skipped += len(_sfn)

    # Now scan the non-skipped tree for other files + count dirs
    for _dp, _dns, _fns in os.walk(root):
        _dns[:] = [d for d in _dns if d not in skip_dirs]
        total_dirs_scanned += len(_dns)
        for _fn in _fns:
            _fp  = os.path.join(_dp, _fn)
            _rel = os.path.relpath(_fp, root).replace('\\', '/')
            if _rel in file_meta:
                continue
            _ext = Path(_fn).suffix.lower()
            try:
                _sz = os.path.getsize(_fp)
            except OSError:
                _sz = 0
            _ft = 'binary' if _ext in SKIP_EXT else 'other'
            other_files_all[_rel] = {
                'id':        _oth_idx,
                'label':     _fn,
                'path':      _rel,
                'ext':       _ext,
                'size':      _sz,
                'module':    get_module(_rel),
                'file_type': _ft,
            }
            _oth_idx += 1

    # Group by module
    other_files_by_module: dict = defaultdict(list)
    for _rel, _meta in other_files_all.items():
        other_files_by_module[_meta['module']].append({
            k: _meta[k] for k in ('id','label','path','ext','size','file_type')
        })

    _cb(60, 'Building module index...')

    all_modules = sorted(set(m['module'] for m in file_meta.values()))
    module_color = {}
    fixed = {'AmiPkg':'#00d4ff','AsusModulePkg':'#00ff9f',
             'AsusProjectPkg':'#ff6b35','AmiChipsetPkg':'#ffd700'}
    color_idx = 0
    for mod in all_modules:
        if mod in fixed:
            module_color[mod] = fixed[mod]
        else:
            module_color[mod] = MODULE_COLORS[color_idx % len(MODULE_COLORS)]
            color_idx += 1

    # Build name-to-path index (basename, full rel path, and path stem)
    _cb(65, 'Building file index...')
    label_to_paths  = defaultdict(list)  # basename → [rel_path]
    stem_to_paths   = defaultdict(list)  # stem (no ext) → [rel_path]
    for rel in file_meta:
        label_to_paths[os.path.basename(rel)].append(rel)
        stem = Path(rel).stem.lower()
        stem_to_paths[stem].append(rel)

    rel_to_id = {rel: i for i, rel in enumerate(file_meta)}

    def resolve_ref(ref: str, src_dir: str = '') -> list:
        """Try to resolve a reference string to known rel_paths."""
        # Try exact basename first
        base = os.path.basename(ref)
        if base in label_to_paths:
            return label_to_paths[base]
        # Try stem match (for library class names like "AmiSbMiscLib")
        stem = Path(ref).stem.lower()
        if stem in stem_to_paths:
            return stem_to_paths[stem]
        return []

    # ── Phase B: Build GUID name → .dec file index ───────────────────────────
    # .dec files declare: gXxxGuid  =  { ... }   under [Guids]/[Ppis]/[Protocols]
    # We parse these names so .inf [Guids/Ppis] references can link to their .dec
    _cb(66, 'Building GUID index...')
    guid_name_to_dec = defaultdict(list)   # guid_var_name (lower) → [dec_rel_path]

    RE_GUID_DECL = re.compile(r'\b(g[A-Za-z_]\w+Guid|g[A-Za-z_]\w+Ppi|g[A-Za-z_]\w+Protocol)\b')

    for rel, extra in file_extra.items():
        if file_meta[rel]['ext'] != '.dec' or extra is None:
            continue
        src_text = ''
        try:
            src_text = Path(os.path.join(root, rel)).read_text(encoding='utf-8', errors='replace')
        except Exception:
            pass
        for m in RE_GUID_DECL.finditer(src_text):
            name_lower = m.group(1).lower()
            if rel not in guid_name_to_dec[name_lower]:
                guid_name_to_dec[name_lower].append(rel)
        # Also use names from the already-parsed extra data
        for name in extra.get('guids', []) + extra.get('ppis', []) + extra.get('protocols', []):
            name_lower = name.strip().lower()
            if name_lower and rel not in guid_name_to_dec[name_lower]:
                guid_name_to_dec[name_lower].append(rel)

    # Build per-module file lists + typed edges
    files_by_module      = defaultdict(list)
    file_edges_by_module = defaultdict(list)

    for rel, meta in file_meta.items():
        fid  = rel_to_id[rel]
        mod  = meta['module']
        files_by_module[mod].append({
            'id':         fid,
            'label':      meta['label'],
            'path':       rel,
            'ext':        meta['ext'],
            'size':       meta['size'],
            'func_count': len(file_defs.get(rel, [])),
            'file_type':  meta['file_type'],
            'bios_meta':  meta['bios_meta'],
        })

    _cb(70, 'Resolving file edges...')
    module_edge_counts = defaultdict(int)
    seen_file_edges    = set()

    def add_edge(src_rel, tgt_rel, edge_type):
        src_id  = rel_to_id[src_rel]
        tgt_id  = rel_to_id[tgt_rel]
        src_mod = file_meta[src_rel]['module']
        tgt_mod = file_meta[tgt_rel]['module']
        if src_id == tgt_id:
            return
        if src_mod != tgt_mod:
            key = (min(src_mod, tgt_mod), max(src_mod, tgt_mod))
            module_edge_counts[key] += 1
        ekey = (src_id, tgt_id, edge_type)
        if ekey not in seen_file_edges:
            seen_file_edges.add(ekey)
            file_edges_by_module[src_mod].append({'s': src_id, 't': tgt_id, 'type': edge_type})

    for src_rel, extra in file_extra.items():
        ext = file_meta[src_rel]['ext']
        src_dir = str(Path(src_rel).parent)

        if ext in ('.c', '.cpp', '.cc', '.h', '.hpp', '.vfr', '.asl'):
            # Standard #include edges
            for inc in file_incs.get(src_rel, []):
                for tgt in resolve_ref(inc, src_dir):
                    add_edge(src_rel, tgt, 'include')

        elif ext == '.asm' or ext in ('.s', '.S', '.nasm'):
            for inc in file_incs.get(src_rel, []):
                for tgt in resolve_ref(inc, src_dir):
                    add_edge(src_rel, tgt, 'include')

        # ── Universal import edges (Python / JS / TS / Go) ─────────────────
        elif ext in ('.py', '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.go'):
            for imp in file_incs.get(src_rel, []):
                for tgt in resolve_ref(imp, src_dir):
                    if tgt != src_rel:
                        add_edge(src_rel, tgt, 'import')

        elif ext == '.inf' and extra:
            # [Sources] → .c files
            for src_f in extra.get('sources', []):
                for tgt in resolve_ref(src_f, src_dir):
                    add_edge(src_rel, tgt, 'sources')
            # [Packages] → .dec files
            for pkg in extra.get('packages', []):
                for tgt in resolve_ref(pkg, src_dir):
                    add_edge(src_rel, tgt, 'package')
            # [LibraryClasses] → other .inf (by stem)
            for lib in extra.get('libraries', []):
                for tgt in resolve_ref(lib, src_dir):
                    if tgt != src_rel:
                        add_edge(src_rel, tgt, 'library')
            # [Guids/Ppis/Protocols] → .dec that declares them (Phase B)
            all_symbols = extra.get('guids', []) + extra.get('ppis', []) + extra.get('protocols', [])
            seen_dec = set()
            for sym in all_symbols:
                sym_lower = sym.strip().lower()
                for dec_rel in guid_name_to_dec.get(sym_lower, []):
                    if dec_rel not in seen_dec and dec_rel != src_rel:
                        seen_dec.add(dec_rel)
                        add_edge(src_rel, dec_rel, 'guid_ref')

        elif ext == '.dsc' and extra:
            for comp in extra.get('components', []):
                for tgt in resolve_ref(comp, src_dir):
                    add_edge(src_rel, tgt, 'component')

        elif ext == '.fdf' and extra:
            for inf_f in extra.get('infs', []):
                for tgt in resolve_ref(inf_f, src_dir):
                    add_edge(src_rel, tgt, 'component')

        elif ext == '.sdl' and extra:
            # INFComponent → .inf files
            for inf_f in extra.get('inf_components', []):
                for tgt in resolve_ref(inf_f, src_dir):
                    add_edge(src_rel, tgt, 'component')
            # LibraryMapping → .inf by Instance "Pkg.LibClass" → stem is LibClass
            for inst in extra.get('lib_mappings', []):
                stem = inst.split('.')[-1] if '.' in inst else inst
                for tgt in resolve_ref(stem, src_dir):
                    if tgt != src_rel:
                        add_edge(src_rel, tgt, 'library')
            # Phase C: ELINK parent chain — each ELINK parent points to a .sdl that owns it
            for parent in extra.get('elink_parents', []):
                for tgt in resolve_ref(parent, src_dir):
                    if tgt != src_rel:
                        add_edge(src_rel, tgt, 'elink')

        elif ext == '.cif' and extra:
            # [INF] section → .inf files
            for inf_f in extra.get('infs', []):
                for tgt in resolve_ref(inf_f, src_dir):
                    add_edge(src_rel, tgt, 'cif_own')
            # [files] section → any file
            for f in extra.get('files', []):
                for tgt in resolve_ref(f, src_dir):
                    add_edge(src_rel, tgt, 'cif_own')

        # Phase D: VFR → UNI (str_ref) / HFR (include) edges
        elif ext == '.vfr' and extra:
            # .uni string packages → str_ref (this VFR depends on that UNI for string tokens)
            for uni_f in extra.get('uni_includes', []):
                for tgt in resolve_ref(uni_f, src_dir):
                    add_edge(src_rel, tgt, 'str_ref')
            # .hfr sub-forms → include (this VFR includes that HFR form fragment)
            for hfr_f in extra.get('hfr_includes', []):
                for tgt in resolve_ref(hfr_f, src_dir):
                    add_edge(src_rel, tgt, 'include')
            # Other #include (e.g. .h header defines)
            for inc in extra.get('includes', []):
                ext_i = Path(inc).suffix.lower()
                if ext_i not in ('.uni', '.hfr'):  # already handled above
                    for tgt in resolve_ref(inc, src_dir):
                        add_edge(src_rel, tgt, 'include')

        # Phase D: HFR (AMI HII Form Resource) — same pattern as VFR
        elif ext == '.hfr' and extra:
            for uni_f in extra.get('uni_includes', []):
                for tgt in resolve_ref(uni_f, src_dir):
                    add_edge(src_rel, tgt, 'str_ref')
            for hfr_f in extra.get('hfr_includes', []):
                for tgt in resolve_ref(hfr_f, src_dir):
                    add_edge(src_rel, tgt, 'include')
            for inc in extra.get('includes', []):
                ext_i = Path(inc).suffix.lower()
                if ext_i not in ('.uni', '.hfr'):
                    for tgt in resolve_ref(inc, src_dir):
                        add_edge(src_rel, tgt, 'include')

        # Phase C: ASL → Include edges
        elif ext == '.asl' and extra:
            for inc in extra.get('includes', []):
                for tgt in resolve_ref(inc, src_dir):
                    add_edge(src_rel, tgt, 'asl_include')

    _cb(80, 'Building function index...')
    func_name_to_files = defaultdict(list)  # name → [rel_path, ...]
    for rel, defs in file_defs.items():
        for d in defs:
            func_name_to_files[d['label']].append(rel)

    func_name_to_file = {name: files[0] for name, files in func_name_to_files.items()}
    func_name_ambiguous = sorted(name for name, files in func_name_to_files.items() if len(files) > 1)

    funcs_by_file       = {}
    func_edges_by_file  = {}
    func_calls_by_file  = {}

    _cb(85, 'Resolving call edges...')
    for rel, defs in file_defs.items():
        if not defs:
            continue
        fid_map = {d['label']: i for i, d in enumerate(defs)}
        funcs_by_file[rel] = [
            {
                'id':        i,
                'label':     d['label'],
                'is_public': not d['is_static'],
                'is_efiapi': d['is_efiapi'],
            }
            for i, d in enumerate(defs)
        ]
        calls_by_func = file_func_calls.get(rel, [])
        if len(calls_by_func) < len(defs):
            calls_by_func = calls_by_func + ([[]] * (len(defs) - len(calls_by_func)))
        elif len(calls_by_func) > len(defs):
            calls_by_func = calls_by_func[:len(defs)]
        func_calls_by_file[rel] = calls_by_func

        edges = []
        seen_edge = set()
        for caller_idx, d in enumerate(defs):
            for callee in calls_by_func[caller_idx]:
                callee_idx = fid_map.get(callee)
                if callee_idx is None:
                    continue
                if callee_idx == caller_idx:
                    continue
                key = (caller_idx, callee_idx)
                if key not in seen_edge:
                    seen_edge.add(key)
                    edges.append({'s': caller_idx, 't': callee_idx,
                                  'p': int(d['is_static'])})
        func_edges_by_file[rel] = edges

    _cb(95, 'Assembling output...')
    modules = [
        {
            'id':          mod,
            'label':       mod,
            'color':       module_color[mod],
            'file_count':  len(files_by_module[mod]),
            'func_count':  sum(len(file_defs.get(f['path'], []))
                               for f in files_by_module[mod]),
            'other_count': len(other_files_by_module.get(mod, [])),
        }
        for mod in all_modules
    ]
    module_edges = [
        {'s': a, 't': b, 'weight': w}
        for (a, b), w in module_edge_counts.items()
    ]

    total_funcs = sum(len(v) for v in file_defs.values())
    total_calls = sum(len(v) for v in file_calls.values())

    total_other  = len(other_files_all)
    total_binary = sum(1 for m in other_files_all.values() if m['file_type'] == 'binary')

    # Total visible files = analysed + other (excludes skipped dirs content)
    total_visible_files = total + total_other
    # Grand total including skipped dirs
    total_all_files = total_visible_files + total_files_skipped

    # Count by file type for stats
    type_counts = defaultdict(int)
    for meta in file_meta.values():
        type_counts[meta['file_type']] += 1

    file_to_module = {rel: meta['module'] for rel, meta in file_meta.items()}

    _cb(100, 'Done!')
    print()
    return {
        'modules':              modules,
        'module_edges':         module_edges,
        'files_by_module':      dict(files_by_module),
        'file_edges_by_module': dict(file_edges_by_module),
        'other_files_by_module': dict(other_files_by_module),
        'funcs_by_file':        funcs_by_file,
        'func_edges_by_file':   func_edges_by_file,
        'func_calls_by_file':   func_calls_by_file,
        'func_name_to_file':    func_name_to_file,
        'func_name_to_files':   {k: v for k, v in func_name_to_files.items() if len(v) > 1},
        'func_name_ambiguous':  sorted(func_name_ambiguous),
        'file_to_module':       file_to_module,
        'func_known_categories': KNOWN_SYS_FUNCS,
        'edge_types':           EDGE_TYPES,
        'project_type':         project_type,
        'stats': {
            # ── Analysed (shown in graph) ──
            'files':              total,          # SCAN_EXT files actually analysed
            'modules':            len(modules),   # top-level dirs = "modules"
            'functions':          total_funcs,
            'calls':              total_calls,
            # ── Visibility breakdown ──
            'other_files':        total_other,    # non-SCAN_EXT, non-skipped files shown as grey nodes
            'binary_files':       total_binary,   # subset of other_files that are binary
            # ── Full codebase counts (matches Windows Properties) ──
            'total_visible_files':total_visible_files,  # analysed + other (no skip dirs)
            'total_all_files':    total_all_files,      # includes skipped dirs
            'total_dirs':         total_dirs_scanned,   # non-skipped subdirectory count
            'total_dirs_skipped': total_dirs_skipped,   # dirs completely ignored
            'skipped_files':      total_files_skipped,  # files inside skipped dirs
            'skipped_dir_names':  sorted(skip_dirs),    # which dirs were skipped
            'type_counts':        dict(type_counts),
            'root':               root.replace('\\', '/'),
            'project_type':       project_type,
        }
    }


# ─── HTML Skeleton (CSS/JS loaded from static/) ───────────────────────────────
HTML_SKELETON = """\
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>VIZCODE — {root_name}</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/cytoscape/3.28.1/cytoscape.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/dagre/0.8.5/dagre.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/cytoscape-dagre@2.5.0/cytoscape-dagre.js"></script>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&family=Fira+Code:wght@400;500;600&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css">
<script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/languages/c.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/languages/cpp.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/languages/x86asm.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/languages/xml.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/languages/python.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/languages/javascript.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/languages/typescript.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/languages/go.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/languages/bash.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/languages/json.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/languages/yaml.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/languages/markdown.min.js"></script>
<style>{CSS}</style>
</head>
<body>

<script>window.JOB_ID = {JOB_ID_JSON}; window.PROJECT_TYPE = {PT_JSON};</script>

<div id="topbar">
  <div class="logo">VIZCODE</div>
  <button id="dashboard-btn" title="Open Analytics Dashboard" onclick="openDashboard()" style="display:flex;align-items:center;gap:6px;background:transparent;border:1px solid var(--border);color:var(--muted);cursor:pointer;font-size:12px;font-weight:600;letter-spacing:0.05em;padding:5px 10px;border-radius:6px;transition:all 0.2s;white-space:nowrap;" onmouseenter="this.style.borderColor='var(--accent)';this.style.color='var(--accent)'" onmouseleave="this.style.borderColor='var(--border)';this.style.color='var(--muted)'"><span style="font-size:14px">📊</span> Dashboard</button>
  <div id="project-type-badge" style="display:none;align-items:center;gap:6px;padding:4px 10px;border-radius:6px;font-size:11px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;white-space:nowrap;"></div>
  <div class="stats-bar">
    <div class="stat">Files <strong id="st-files">0</strong></div>
    <div class="stat">Modules <strong id="st-mods">0</strong></div>
    <div class="stat">Functions <strong id="st-funcs">0</strong></div>
  </div>
  <div style="flex:1"></div>
    <div id="search-wrap">
      <div id="sr-modes">
      <button class="sr-mode active" data-mode="files" id="srm-files" title="Search file names and paths" aria-label="Files">
        <svg class="sr-mode-icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
          <path fill="currentColor" d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/>
        </svg>
      </button>
      <button class="sr-mode" data-mode="code" id="srm-code" title="Search inside code content" aria-label="Code">
        <svg class="sr-mode-icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
          <path fill="currentColor" d="M9.5 7.5L6 12l3.5 4.5 1.3-1L8.1 12l2.7-3.5-1.3-1zM14.5 7.5l-1.3 1L15.9 12l-2.7 3.5 1.3 1L18 12l-3.5-4.5z"/>
        </svg>
      </button>
      </div>
    <div id="sr-input-row">
      <span id="sr-icon">⌕</span>
      <input id="search" type="text" placeholder="Search files… ( / )" autocomplete="off" spellcheck="false">
      <div id="sr-toggles">
        <button class="sr-toggle" id="srt-case"  title="Match Case (Alt+C)">Aa</button>
        <button class="sr-toggle" id="srt-word"  title="Match Whole Word (Alt+W)">ab</button>
        <button class="sr-toggle" id="srt-regex" title="Use Regular Expression (Alt+R)">.*</button>
      </div>
      <span id="sr-count"></span>
    </div>
    <div id="sr-panel">
      <div id="sr-filters">
        <div class="sr-filter-row">
          <span class="sr-filter-label">files to include</span>
          <input class="sr-filter-input" id="sr-include" type="text" placeholder="e.g. *.c, *.h" autocomplete="off" spellcheck="false">
        </div>
        <div class="sr-filter-row">
          <span class="sr-filter-label">files to exclude</span>
          <input class="sr-filter-input" id="sr-exclude" type="text" placeholder="e.g. Build/*, *.obj" autocomplete="off" spellcheck="false">
        </div>
      </div>
      <div id="sr-results"></div>
    </div>
  </div>
  <button id="pref-btn" title="Preferences" style="background:transparent;border:none;color:var(--muted);cursor:pointer;font-size:18px;margin-left:4px;padding:4px;transition:color 0.2s;flex-shrink:0;">⚙</button>
</div>

<div id="breadcrumb">
  <span id="bc-items" style="display:flex;align-items:center;gap:8px;flex:1;min-width:0;overflow:hidden"></span>
  <button id="back-btn" onclick="goBack()">← Back</button>
  <button id="graph-toggle-btn" title="View Call Graph for Selected File">⬡ Call Graph</button>
  <button id="code-toggle-btn" title="Toggle Code Panel (C)">&#60;&#47;&#62; Code</button>
</div>

<div id="layout">
  <div id="sidebar">
    <div id="ft-filter"></div>
    <div id="sidebar-title" data-collapsible="true" style="cursor: pointer; display: flex; justify-content: space-between; align-items: center;"><span>File System</span><span class="legend-toggle" style="font-size: 13px; transition: transform 0.2s;">▾</span></div>
    <div id="module-list" style="display: block;"></div>
  </div>
  <div id="sidebar-resizer"></div>
  <div id="graph-wrap">
    <div id="l1-toolbar" class="l2-toolbar hidden">
      <div class="l2-left">
        <div class="l2-title">Dependency Map</div>
        <div class="l2-sub" id="l1-mod-label">No module</div>
      </div>
        <div class="l2-actions">
          <button id="l1-prev" class="l2-btn" disabled>&#x21A9;</button>
          <button id="l1-next" class="l2-btn" disabled>&#x21AA;</button>
          <button id="l1-expand-all-ext" class="l2-btn" style="display:none">Expand All</button>
          <button id="l1-collapse-all-ext" class="l2-btn" style="display:none">Collapse All</button>
          <button id="l1-toggle-ext" class="l2-btn">External Files: On</button>
          <span id="l1-stats" class="l2-stats"></span>
        </div>
    </div>
    <div id="l2-toolbar" class="l2-toolbar hidden">
      <div class="l2-left">
        <div class="l2-title">Call Flow</div>
        <div class="l2-sub" id="l2-file-label">No file</div>
      </div>
        <div class="l2-actions">
          <button id="l2-prev" class="l2-btn">&#x21A9;</button>
          <button id="l2-next" class="l2-btn">&#x21AA;</button>
          <button id="l2-expand-all" class="l2-btn">Expand All</button>
          <button id="l2-collapse-all" class="l2-btn">Collapse All</button>
          <button id="l2-toggle-ext-funcs" class="l2-btn">External Functions: Off</button>
          <span id="l2-stats" class="l2-stats"></span>
        </div>
    </div>
    <button id="l2-toggle-ext-lines" class="l2-btn" style="position: absolute; bottom: 16px; left: 16px; z-index: 50; display: none; box-shadow: 0 4px 12px rgba(0,0,0,0.5); border: 1px solid var(--border); background: var(--panel2);">External Lines: On</button>
    <div id="cy"></div>
    <div id="func-view"></div>
    <div id="loading"><div class="spinner"></div><span id="loading-msg">Loading...</span><button id="loading-cancel-btn" onclick="cancelRender()">✕ Cancel</button></div>
  </div>
  <!-- Resizer handle -->
  <div id="resizer" style="display:none"></div>
  <!-- Code Panel (Sourcetrail-style) -->
  <div id="code-panel">
    <div id="cp-header">
      <div id="cp-file-bar">
        <span id="cp-ext-badge">.C</span>
        <span id="cp-filename">No file selected</span>
        <button id="cp-close" title="Close">✕</button>
      </div>
      <div id="cp-func-bar">
        <span id="cp-func-name"></span>
        <span id="cp-func-badge" class="cp-func-badge cp-func-public">PUBLIC</span>
        <div id="cp-func-nav">
          <button class="cp-nav-btn" id="cp-prev-func" title="Prev function (←)">‹</button>
          <button class="cp-nav-btn" id="cp-next-func" title="Next function (→)">›</button>
        </div>
      </div>
    </div>
    <div id="cp-body">
      <div id="cp-loading">
        <div class="spinner"></div>
        <span style="font-size:12px;color:var(--muted)">Loading source...</span>
      </div>
      <div id="cp-empty" style="display:none">
        <div class="cp-empty-icon">📁</div>
        <p>Click a file node to view source</p>
        <small>Single-click → preview · Double-click → drill in</small>
      </div>
      <div id="cp-code-wrap" style="display:none"></div>
    </div>
  </div>
</div>

<!-- Old info-panel (hidden, kept for JS compat) -->
<div id="info-panel" style="display:none">
  <div id="info-inner"><div id="info-title"></div><div id="info-sub"></div></div>
</div>

<div id="ctx-menu">
  <div class="ctx-item" id="ctx-copy">📋 Copy path</div>
  <div class="ctx-item" id="ctx-open-code">📄 View source</div>
  <div class="ctx-item" id="ctx-vscode">↗ Open in VS Code</div>
  <div class="ctx-sep"></div>
  <div class="ctx-item" id="ctx-module-only">🔍 Only this module</div>
  <div class="ctx-item" id="ctx-pin">📌 Pin node</div>
</div>
<div id="tooltip"></div>

<!-- Preferences Modal -->
<div id="pref-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:999;align-items:center;justify-content:center;backdrop-filter:blur(2px);">
  <div style="background:var(--panel);border:1px solid var(--border);border-radius:8px;width:320px;box-shadow:0 10px 30px rgba(0,0,0,0.7);display:flex;flex-direction:column;overflow:hidden;animation:flip-in-x 0.2s ease-out;">
    <div style="background:var(--panel2);padding:12px 16px;border-bottom:1px solid var(--border);font-weight:600;display:flex;justify-content:space-between;align-items:center;">
      <span>Preferences</span>
      <button id="pref-close-x" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:16px;">✕</button>
    </div>
    <div style="padding:20px 16px;display:flex;flex-direction:column;gap:12px;">
      <div style="display:flex;flex-direction:column;gap:6px;">
        <label for="font-select" style="font-size:12px;color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">Code Editor Font</label>
        <select id="font-select" style="background:var(--panel2);border:1px solid var(--border);color:var(--text);padding:8px 12px;border-radius:6px;font-size:14px;outline:none;cursor:pointer;font-family:inherit;">
          <option value="'JetBrains Mono', monospace" style="font-family:'JetBrains Mono', monospace;font-size:14px;">JetBrains Mono</option>
          <option value="'Fira Code', monospace" style="font-family:'Fira Code', monospace;font-size:14px;">Fira Code</option>
          <option value="'Cascadia Code', monospace" style="font-family:'Cascadia Code', monospace;font-size:14px;">Cascadia Code</option>
          <option value="Consolas, monospace" style="font-family:Consolas, monospace;font-size:14px;">Consolas</option>
          <option value="'Space Mono', monospace" style="font-family:'Space Mono', monospace;font-size:14px;">Space Mono</option>
        </select>
      </div>
    </div>
    <div style="padding:12px 16px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;">
      <button id="pref-close-btn" style="background:var(--accent);color:#000;border:none;padding:6px 16px;border-radius:6px;font-weight:600;font-size:13px;cursor:pointer;">Done</button>
    </div>
  </div>
</div>

<!-- Data embedded as JSON text — parsed by JSON.parse(), not JS engine (10x faster) -->
<script type="application/json" id="viz-data">{DATA}</script>
<script>(function(){{
  var l=document.getElementById('loading');
  var m=document.getElementById('loading-msg');
  if(l){{l.className='show';}}
  if(m){{m.textContent='⏳ Parsing graph data...';}}
  document.getElementById('cp-loading').classList.add('hidden');
  document.getElementById('cp-empty').style.display='';
  // Project type badge
  var pt = window.PROJECT_TYPE || {{}};
  if(pt && pt.name && pt.emoji) {{
    var badge = document.getElementById('project-type-badge');
    if(badge) {{
      badge.style.display = 'flex';
      badge.style.background = (pt.badge_color||'#444') + '22';
      badge.style.border = '1px solid ' + (pt.badge_color||'#888') + '55';
      badge.style.color = pt.badge_color || '#ccc';
      badge.innerHTML = '<span style="font-size:15px">' + pt.emoji + '</span><span>' + pt.name.toUpperCase() + '</span>';
      badge.title = pt.description || '';
    }}
  }}
}})();</script>
<script>{JS}</script>
</body>
</html>"""

# Keep HTML_TEMPLATE as alias for backward compat (server.py uses it)
HTML_TEMPLATE = HTML_SKELETON


# ─── build_html ───────────────────────────────────────────────────────────────
def build_html(data: dict, job_id: str = None) -> str:
    """Read static/viz.{css,js} and embed them inline into the HTML skeleton."""
    base  = Path(__file__).parent / 'static'
    css_p = base / 'viz.css'
    js_p  = base / 'viz.js'

    if not css_p.exists() or not js_p.exists():
        raise FileNotFoundError(
            f'Missing static files. Expected:\n  {css_p}\n  {js_p}')

    css = css_p.read_text(encoding='utf-8')
    js  = js_p.read_text(encoding='utf-8')

    def _json_default(o):
        if isinstance(o, (set, frozenset)): return sorted(o)
        raise TypeError(f'Not serialisable: {type(o)}')
    json_str     = json.dumps(data, ensure_ascii=False, separators=(',', ':'), default=_json_default)
    root_name    = Path(data['stats']['root']).name or 'VIZCODE'
    job_id_json  = json.dumps(job_id)   # "null" or '"abc1234"'
    pt           = data.get('project_type', {})
    pt_json      = json.dumps(pt, default=_json_default)

    return HTML_SKELETON.format(
        CSS=css, JS=js,
        DATA=json_str,
        root_name=root_name,
        JOB_ID_JSON=job_id_json,
        PT_JSON=pt_json,
    )


# ─── inject_data (legacy, used by server.py) ─────────────────────────────────
def inject_data(html: str, data: dict) -> str:
    """Legacy helper — now calls build_html() directly."""
    return build_html(data, job_id=None)


# ─── main ─────────────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(description='VIZCODE V4 — Universal Code Visualizer')
    parser.add_argument('root', help='Root directory of codebase (BIOS, Python, JS, Go, ...)')
    parser.add_argument('-o', '--output', default='viz_output.html',
                        help='Output HTML file (default: viz_output.html)')
    parser.add_argument('--include-build', action='store_true',
                        help='Include build output directories (Build/build/DEBUG/RELEASE)')
    parser.add_argument('--include-dir', action='append', default=[],
                        help='Directory name to include even if normally skipped (repeatable)')
    args = parser.parse_args()

    if not os.path.isdir(args.root):
        print(f'Error: "{args.root}" is not a directory', file=sys.stderr)
        sys.exit(1)

    print(f'VIZCODE V4 — analyzing: {args.root}')
    data = build_graph(args.root, include_build=args.include_build, include_dirs=args.include_dir)

    pt = data.get('project_type', {})
    s = data['stats']
    print(f'\nAnalysis complete ({pt.get("emoji","")}{pt.get("name",""):}):')
    print(f'  Modules:   {s["modules"]}')
    print(f'  Files:     {s["files"]}')
    print(f'  Functions: {s["functions"]}')
    print(f'  Calls:     {s["calls"]}')
    if s.get('type_counts'):
        print(f'\n  File types:')
        for ft, cnt in sorted(s['type_counts'].items(), key=lambda x: -x[1]):
            print(f'    {ft:20s} {cnt}')

    try:
        html = build_html(data)
    except FileNotFoundError as e:
        print(f'\nWarning: {e}')
        def _json_default(o):
            if isinstance(o, (set, frozenset)): return sorted(o)
            raise TypeError(f'Not serialisable: {type(o)}')
        json_str = json.dumps(data, ensure_ascii=False, separators=(',', ':'), default=_json_default)
        pt_json  = json.dumps(pt, default=_json_default)
        root_name = Path(data['stats']['root']).name or 'VIZCODE'
        html = HTML_SKELETON\
            .replace('{DATA}', json_str)\
            .replace('{CSS}', '')\
            .replace('{JS}', '')\
            .replace('{root_name}', root_name)\
            .replace('{JOB_ID_JSON}', 'null')\
            .replace('{PT_JSON}', pt_json)

    out = args.output
    Path(out).write_text(html, encoding='utf-8')
    size = Path(out).stat().st_size
    print(f'\nOutput: {out} ({size/1024:.0f} KB)')
    print(f'Open in Chrome: file:///{Path(out).absolute().as_posix()}')


if __name__ == '__main__':
    main()
