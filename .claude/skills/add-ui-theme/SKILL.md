---
name: add-ui-theme
description: Add a new UI theme to the visualizer application. Use this skill whenever the user asks to create a new visual theme, change the color scheme, or adjust global CSS appearance variables like dark mode or specific color palettes.
---

# SKILL: Add UI Theme

This skill defines the process for safely introducing a new UI theme into the application.

## When to Apply This Pattern

Use this skill whenever:
- **Adding a new color palette** (e.g. "Create a light theme", "Make a hacker theme").
- **Modifying global theme variables**.
- **Updating theme toggles** in the UI.

## Core Design Rule

> **Never hardcode hex colors directly into element classes.**  
> **Always use CSS custom properties (`--var-name`) tied to a `[data-theme="my-theme"]` selector.**

## Detailed Implementation

To keep this skill lean and adhere to **Progressive Disclosure**, detailed CSS variable references, file modification steps, and JavaScript integration are stored in an external reference.

**Before adding a new theme**, you must read the detailed implementation guide:
👉 **Read `references/implementation.md`**
