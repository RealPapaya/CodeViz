---
name: eng-to-zh-translator
description: Translate English text, UI elements, documents, or code comments into fluent Traditional Chinese (zh-TW). Make sure to use this skill whenever the user asks for translation to Chinese, requests localization of a file, or needs to rewrite English content into natural-sounding Traditional Chinese.
---

# SKILL: English to Traditional Chinese Translator

This skill defines the standard for translating English content into high-quality Traditional Chinese (zh-TW), ensuring technical accuracy, natural tone, and proper localization conventions.

## When to Apply This Pattern

Use this skill whenever:
- **Translating** UI strings, markdown documents, or code comments.
- **Localizing** applications for a Taiwanese audience.
- **Refining** clunky machine-translated text into fluent, human-like responses.

## Core Translation Rules

> **Accuracy → Preserve technical meaning without literal, word-for-word stiffness.**
> **Fluency → Use natural phrasing commonly found in Taiwan's tech community.**

- **Target Locale:** ALWAYS use Traditional Chinese (zh-TW). Avoid Simplified Chinese vocabulary (e.g., use 螢幕 instead of 屏幕, 程式 instead of 程序).
- **Whitespace:** ALWAYS add a half-width space between English words/numbers and Chinese characters (e.g., `使用 React 開發` instead of `使用React開發`).
- **Formatting:** Preserve all Markdown, HTML tags, and code blocks exactly as they are.

## Detailed Guidelines

To keep this skill lean and adhere to **Progressive Disclosure**, detailed terminology mappings, tone settings, and examples are stored in an external reference.

**Before starting a translation task**, you must read the detailed guidelines:
👉 **Read `references/guidelines.md`**
