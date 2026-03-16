---
name: salacia-init
description: "Initialize Salacia scope contract for the current task. Use when starting a new coding task to define which files the agent is allowed to modify. Triggers on: 'salacia init', 'scope contract', 'init salacia', 'guard scope'."
user-invocable: true
---

# Salacia Init

Generate a scope contract for the current task.

## What to do

1. Ask the user what task they're working on (or read from git branch name / recent context)
2. Analyze the task description to extract:
   - Keywords → map to file paths (use project structure)
   - Quoted file paths in the description
   - Conventional commit prefix (feat/fix/docs/chore) → scope width
3. **Check `.salacia/memory.json` for historical patterns.** If it exists, read the pattern matching the detected task type (feat/fix/etc.). Pre-fill `softAllowedPaths` with entries where `weight >= 0.5`. This lets the contract benefit from past session learning.

4. Generate `.salacia/contract.json`:

```json
{
  "taskId": "<from branch or user input>",
  "allowedPaths": ["<extracted paths>"],
  "softAllowedPaths": ["<sibling dirs, co-change companions>"],
  "excludedPaths": ["node_modules/**", ".git/**", "dist/**"],
  "protectedPaths": [".env", ".env.*", "*.pem", "*.key", "*.cert", "package-lock.json", "bun.lockb"],
  "maxFilesChanged": 10,
  "generatedAt": "<timestamp>",
  "generatedBy": "heuristic"
}
```

5. Also create `.salacia/config.json` if it doesn't exist:

```json
{
  "enabled": true,
  "driftThreshold": 30
}
```

6. Reset `.salacia/drift.json` to zero state:

```json
{
  "score": 0,
  "files": [],
  "softFiles": [],
  "outOfScope": [],
  "protected": []
}
```

7. Report the contract summary to the user (include any memory-derived soft paths)

## Scope width heuristics

- **fix:** narrow — only files mentioned + their test files
- **feat:** medium — mentioned files + sibling directory + tests
- **refactor:** wide — entire package the files belong to
- **docs:** docs/** + README.md only
- **chore:** wide — config files + root files allowed

## Notes

- Contract is stored in `.salacia/` (gitignored)
- The guard hook (PreToolUse/PostToolUse) reads this contract automatically
- Zero token cost for enforcement — hooks run as shell commands
- To disable: set `enabled: false` in `.salacia/config.json`
