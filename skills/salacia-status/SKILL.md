---
name: salacia-status
description: "Show current Salacia scope contract and drift status. Use when checking what files are in scope, current drift score, or reviewing the contract. Triggers on: 'salacia status', 'scope status', 'drift status', 'guard status'."
user-invocable: true
---

# Salacia Status

Show the current scope enforcement status.

## What to do

1. Read `.salacia/contract.json` — if missing, tell user to run `/salacia-init`
2. Read `.salacia/drift.json` — show current drift score
3. Read `.salacia/config.json` — show if enabled and threshold

Display a summary like:

```
┌─── Salacia Guard Status ───────────────────────┐
│ Task: fix-scheduler-bug                        │
│ Enabled: ✅  Threshold: 30                      │
├─── Contract ───────────────────────────────────┤
│ Allowed: packages/core/src/execution/**        │
│          packages/core/test/**                  │
│ Soft:    packages/core/src/config.ts           │
│          packages/core/src/taskSolver.ts       │
│ Protected: .env, *.pem, *.key                  │
│ Max files: 10                                   │
├─── Drift ──────────────────────────────────────┤
│ Score: 5/30                                     │
│ In-scope: 3 files                               │
│ Soft-scope: 1 file (config.ts)                 │
│ Out-of-scope: 1 file (README.md) [+5]          │
│ Protected violations: 0                         │
└─────────────────────────────────────────────────┘
```

4. If drift score is near threshold, warn
5. If no contract exists, suggest initializing one
