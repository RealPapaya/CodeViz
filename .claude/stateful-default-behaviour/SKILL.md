---
name: stateful-default-behaviour
description: Implement stateful UI default-behaviours with preference overrides. Make sure to use this skill whenever you are implementing, debugging, or refactoring visualizers, graph UIs, toggleable visibility of nodes/levels, expand/collapse all actions, or restoring view state via history navigation (Prev/Next). It ensures fresh navigation applies user preferences while history navigation perfectly restores the snapshot.
---

# SKILL: Stateful UI Default-Behaviour with Preference Overrides

This skill defines the pattern for handling default UI states (like expanding/collapsing all nodes or showing/hiding external files) in complex visualizers while respecting user preferences and history caching.

## When to Apply This Pattern

Use this pattern whenever a visualizer or graph UI has:
- **Toggleable visibility** of a node/edge class (e.g. "External Functions", "External Files")
- **Expand/Collapse All** actions on groups of nodes
- **Navigation history** (Prev / Next buttons) that the user expects to restore their prior view

## Core Design Rule

> **Fresh navigation → apply user's preference.**  
> **History navigation → restore snapshot.**

The two cases must be mutually exclusive. **Never** apply default-behaviour when restoring a history slot. Explain this reasoning to the user if they ask about bugs related to state restoration.

## Mental Model Summary

```
User opens file/module
       │
       ├─ Via Prev/Next history?
       │       YES → _applyL2Snapshot() sets expandedModules from history
       │             _expandInitialized = true (prevents default overwrite)
       │             render() → default block skipped ✓
       │
       └─ Fresh navigation?
               _expandInitialized = false (set in reset/drillTo)
               render() runs → default block fires:
                   apply preferences (expand/collapse/visibility)
               _expandInitialized = true (blocks future re-renders from resetting)
```

## Detailed Implementation

To keep this skill lean and adhere to **Progressive Disclosure**, the detailed implementation steps and code examples are stored in external reference files.

**Before implementing or debugging this pattern**, you must read the detailed implementation guide:
👉 **Read `references/implementation.md`**

It contains:
- How to set up the Preference Registry
- Managing Initialization Flags
- History Bypass logic
- Common Mistakes to Avoid
