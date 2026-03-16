---
name: salacia-gc
description: "Run Salacia garbage collection — analyze drift patterns, rotate audit logs, merge learned patterns into memory. Use when: 'salacia gc', 'clean salacia', 'salacia refine', 'optimize scope', 'salacia learn'."
user-invocable: true
---

# Salacia GC

Run garbage collection on the Salacia scope enforcement system.

## What to do

Run these three steps in order, reporting results to the user after each:

### 1. Refine — Analyze drift patterns

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gc.mjs" refine
```

Parse the output JSON. Present suggestions in a readable format:

- **overScoped**: Paths in the contract that were never touched → suggest removing
- **underScoped**: Files repeatedly edited out of scope → suggest adding to softAllowedPaths
- **shouldPromote**: Learned overrides ready for promotion → suggest promoting

### 2. Rotate — Clean audit logs

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gc.mjs" rotate
```

Report how many events were archived vs retained.

### 3. Learn — Merge patterns into memory

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gc.mjs" learn
```

Report what task type was detected and how many patterns were merged.

### 4. Ask the user

After presenting all results, ask the user:
- "Apply the refine suggestions to contract.json?" (if any suggestions exist)
- If yes, update `.salacia/contract.json` accordingly:
  - Remove overScoped paths from `allowedPaths`
  - Add underScoped files to `softAllowedPaths`
  - Add shouldPromote files to `softAllowedPaths` (and update learned.json)

## Notes

- GC `auto` mode runs automatically on every SessionStart via hooks
- Manual `/salacia-gc` runs refine + rotate + learn for a full cleanup
- memory.json uses exponential decay (0.9x per GC pass) — old patterns fade naturally
- audit-summary.json aggregates rotated data for long-term analysis
