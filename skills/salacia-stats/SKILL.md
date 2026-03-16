---
name: salacia-stats
description: "Show Salacia audit statistics — event counts, top drifted files, learned promotions. Triggers on: 'salacia stats', 'scope stats', 'drift stats', 'guard stats', 'salacia report'."
user-invocable: true
---

# Salacia Stats

Show audit statistics and learning progress.

## What to do

1. Run the stats command:
```bash
echo '{"cwd":"'$(pwd)'"}' | node "${CLAUDE_PLUGIN_ROOT}/scripts/guard.mjs" stats
```

2. Display the output to the user

3. Optionally, read `.salacia/audit.jsonl` for detailed timeline if user asks for more detail

4. If no audit data exists, suggest running `/salacia-init` first
