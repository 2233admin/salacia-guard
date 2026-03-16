# salacia-guard

Zero-token scope enforcement for AI coding agents.

A Claude Code plugin that intercepts file edits in real-time, blocking out-of-scope changes **without consuming any LLM tokens**. The interception runs as a Node.js shell process — completely outside the model context.

## The Problem

AI coding agents (Claude Code, Codex, Cursor, etc.) are bad at staying in scope. You ask it to fix the scheduler, it "helpfully" refactors config, updates README, and touches .env. On [SWE-bench](https://swe-bench.github.io/), scope drift is a leading cause of agent failure.

Current solutions:
- **Plan mode**: Ask the model to plan first. But the model still decides scope — garbage in, garbage out.
- **Post-hoc review**: Human reviews the diff. Doesn't scale for autonomous agents.
- **Harness systems** (Salacia paper, Agentless, etc.): Pre-compute scope, inject into prompt. Works, but costs tokens and doesn't enforce.

**salacia-guard takes a different approach: enforce scope at the tool level, not the prompt level.** The model can "think" whatever it wants — if it tries to edit a protected file, the edit is blocked before it happens. Zero tokens spent on enforcement.

## How It Works

```
Agent receives task
    │
    ├─ /salacia-init generates .salacia/contract.json
    │   (which files are allowed, soft-allowed, protected)
    │
    ├─ Agent works normally...
    │
    ├─ Agent calls Edit("packages/core/src/scheduler.ts")
    │   └─ PreToolUse hook → guard.mjs → in scope → ✅ allow (silent)
    │
    ├─ Agent calls Edit(".env")
    │   └─ PreToolUse hook → guard.mjs → protected → 🛡️ BLOCK
    │   └─ Agent sees: "Salacia: BLOCKED — .env is a protected path"
    │
    ├─ Agent calls Edit("README.md")
    │   └─ PostToolUse hook → guard.mjs → out of scope → tracked
    │   └─ drift score += 5, warn if threshold exceeded
    │
    └─ /salacia-status shows drift report
```

**Key insight: hooks run as shell commands, not LLM calls. Interception is free.**

## Research Background

This plugin draws from several research projects and papers. We didn't invent the ideas — we made them practical for everyday use.

### Papers

| Paper | What we took | What we didn't |
|-------|-------------|----------------|
| **[Salacia](https://github.com/StartripAI/Salacia)** (StartripAI, 2025) | Contract concept: define allowed paths before execution. Drift scoring formula (out-of-scope=+5, protected=+40). | Their pre-pass layers (fault localization, repo map, intent IR). Their system is a SWE-bench harness; ours is a runtime guard. |
| **[AgentFL](https://arxiv.org/abs/2403.16362)** (2024) | Three-step navigation idea (understand→navigate→confirm) validated that fault localization helps agents. $0.074/bug is the bar. | Their multi-agent architecture. We're simpler — single hook script. |
| **[ContextCov](https://arxiv.org/abs/2603.00822)** (2025) | Agent instructions → executable constraints. Confirmed that scope can be derived from task description. | Their formal constraint language. We use glob patterns — good enough. |

### Open-Source Projects

| Project | What we took | Link |
|---------|-------------|------|
| **commit-prophet** | Co-change coupling algorithm: `coupling(A,B) = co_changes(A,B) / max(changes(A), changes(B))`. We ported the core ~50 lines. | [GitHub](https://github.com/LakshmiSravyaVedantham/commit-prophet) |
| **Axon** | Coupling threshold ≥0.3 as the default for "related files". Validated by their Tree-sitter knowledge graph. | [GitHub](https://github.com/harshkedia177/axon) |
| **CodeScene** | Commercial validation that temporal coupling works. Their "change coupling" feature proved the concept at scale. | [codescene.com](https://codescene.com) |

### Our Contributions

What's original in salacia-guard:

1. **Zero-token enforcement via hooks**. Everyone else injects scope into the prompt (costs tokens, model can ignore it). We enforce at the tool call level. The model literally cannot edit a protected file.

2. **Soft/hard two-layer scope**. Prior work treats scope as binary (in/out). We add a "soft allowed" zone for co-change companions — files that are related but not explicitly in scope. They don't trigger drift penalties but are tracked. This alone cut our false-positive rate from 67% to 27%.

3. **Sibling directory inference**. If the contract allows `execution/scheduler.ts`, we automatically soft-allow `execution/**`. Simple heuristic, massive impact — 21 files saved from false-positive in our test suite.

4. **Mid-pattern glob matching**. Sounds trivial, but `config*.ts` matching `config.ts` and `configReader.ts` is not handled by naive glob implementations. We added regex fallback for `*` in filename position.

## Design Philosophy

### Why not a full harness?

The Salacia paper (StartripAI) implements 5 layers: fault localization → repo map → intent IR → contract → verify & retry. That's a SWE-bench harness — it wraps the entire agent execution.

We only implement layer 4 (contract) and part of layer 5 (verify). Why?

- **Layers 1-3 cost tokens**. Fault localization results, repo maps, and intent IRs all get injected into the prompt. For a 10-file task, that's 2-5K tokens of context. Our enforcement costs zero.
- **Layers 1-3 are pre-pass**. They help the model find the right files. But in orchestrated systems (FSC, OMC, Devin), task decomposition already tells the agent which files to touch. Pre-pass is redundant.
- **Layer 4 is the only one that enforces**. The others suggest. The model can ignore suggestions. It cannot ignore a blocked tool call.

We'll add fault localization as an optional skill (`/salacia-locate`) for users who want it. But the core value is enforcement, not suggestion.

### Layer 3: Garbage Collection (v1.0)

The GC layer keeps the harness environment clean and evolving. Five modes:

| Mode | Trigger | What it does |
|------|---------|-------------|
| `auto` | SessionStart hook | Quick check: audit size + contract staleness |
| `rotate` | auto or manual | Retains 7 days of audit, aggregates older events to `audit-summary.json` |
| `refine` | `/salacia-gc` | Analyzes drift patterns → suggests overScoped/underScoped/shouldPromote |
| `learn` | `/salacia-gc` | Merges session patterns into `memory.json` with exponential decay (0.9x) |
| `stale` | auto | Checks contract vs current branch and file existence |

**memory.json** stores learned patterns per task type. When you run `/salacia-init`, it pre-fills `softAllowedPaths` from memory (entries with weight ≥ 0.5). Old patterns decay naturally — no manual cleanup needed.

```
SessionStart → gc auto → {rotate if audit > 1MB, stale check} → guard session check
                                    ↓
                            /salacia-gc (manual)
                            → refine (suggestions)
                            → rotate (cleanup)
                            → learn (memory merge)
```

### Why a plugin, not a skill?

Skills inject text into the model context. They can't intercept tool calls. A skill can say "please don't edit .env" — and the model might listen. A hook says "no" and the edit doesn't happen.

```
Skill:   model reads instructions → model decides → model acts
Plugin:  model decides → model acts → hook intercepts → block/allow
```

### Why Node.js?

- Zero dependencies. No Python venv, no npm install, no build step.
- Claude Code hooks run shell commands. Node.js is guaranteed available (Claude Code itself is Node).
- The entire guard logic is 150 lines. It doesn't need a framework.

## Installation

```bash
# Claude Code plugin install
claude plugin add https://github.com/2233admin/salacia-guard

# Or manual clone
git clone https://github.com/2233admin/salacia-guard ~/.claude/plugins/salacia-guard
```

## Usage

### 1. Initialize a contract

Use the `/salacia-init` skill when starting a task:

```
> /salacia-init
> Task: fix the scheduler concurrency bug
```

This generates `.salacia/contract.json`:
```json
{
  "taskId": "fix-scheduler-concurrency",
  "allowedPaths": ["packages/core/src/execution/**", "packages/core/test/**"],
  "softAllowedPaths": ["packages/core/src/config.ts"],
  "excludedPaths": ["node_modules/**", ".git/**", "dist/**"],
  "protectedPaths": [".env", ".env.*", "*.pem", "*.key"],
  "maxFilesChanged": 10
}
```

### 2. Work normally

The hooks run silently. You won't notice them unless something is blocked.

### 3. Check drift status

```
> /salacia-status

┌─── Salacia Guard Status ─────────────────────┐
│ Task: fix-scheduler-concurrency               │
│ Enabled: ✅  Threshold: 30                     │
├─── Drift ─────────────────────────────────────┤
│ Score: 5/30                                    │
│ In-scope: 3 files                              │
│ Soft-scope: 1 file (config.ts)                │
│ Out-of-scope: 1 file (README.md) [+5]         │
└───────────────────────────────────────────────┘
```

### 4. Disable (if needed)

Set `enabled: false` in `.salacia/config.json`, or delete the file.

## Configuration

`.salacia/config.json`:
```json
{
  "enabled": true,
  "driftThreshold": 30
}
```

## Contract Schema

`.salacia/contract.json`:
```json
{
  "taskId": "string",
  "allowedPaths": ["glob patterns — agent CAN modify"],
  "softAllowedPaths": ["co-change zone — no penalty, tracked"],
  "excludedPaths": ["always excluded (node_modules, .git, dist)"],
  "protectedPaths": ["instant block (.env, *.pem, *.key)"],
  "maxFilesChanged": 10,
  "generatedAt": 1234567890,
  "generatedBy": "heuristic"
}
```

## Scoring

| Event | Points | Meaning |
|-------|--------|---------|
| In-scope file edited | 0 | Expected |
| Soft-scope file edited | 0 | Related, tracked |
| Out-of-scope file edited | +5 | Unexpected |
| Protected file edited | BLOCK | Hard reject |
| Excess files (beyond max) | +2 each | Scope creep |

Drift score ≥ threshold (default 30) triggers a warning.

## Glob Patterns Supported

| Pattern | Example | Matches |
|---------|---------|---------|
| Exact | `src/config.ts` | `src/config.ts` |
| Directory | `src/execution/**` | `src/execution/scheduler.ts`, `src/execution/pool.ts` |
| Extension | `*.pem` | `secret.pem`, `server.pem` |
| Prefix wildcard | `src/config*.ts` | `src/config.ts`, `src/configReader.ts` |
| Dotfile variants | `.env.*` | `.env`, `.env.local`, `.env.production` |

## Empirical Results

Tested on [full-self-coding](https://github.com/2233admin/full-self-coding) (80 commits, 15-commit replay):

| Metric | No Salacia | v1 (static contract) | v2.1 (this) |
|--------|-----------|---------------------|-------------|
| Clean rate | — | 33% | **73%** |
| Flag rate | — | 67% | **27%** |
| Soft-scope hits | — | 0 | **21** |
| False positives | — | High | **Near zero** |
| True positives kept | — | Yes | **Yes** |
| Token cost | 0 | ~500/task | **0** (hooks) |

The 4 remaining flagged commits are genuine cross-boundary changes (editing `CLAUDE.md` in a `feat:` commit, touching `packages/cli/` from a `core/` task). These **should** be flagged.

## Integration with FSC / OMC

salacia-guard works standalone, but integrates with orchestration systems:

- **FSC** (Full Self Coding): The engine has a deeper Salacia module with co-change coupling, A/B experiments, and post-merge testing. The plugin is the lightweight portable version.
- **OMC** (Oh My ClaudeCode): When OMC's executor agents run, salacia-guard protects them automatically. No configuration needed — the hooks fire on every Edit/Write.

## Complementary Plugins

Integrate `salacia-guard` with [`claude-code-safety-net`](https://github.com/kenryu42/claude-code-safety-net) for defense-in-depth. While salacia-guard enforces **spatial integrity** (which files can be edited), safety-net provides a **procedural firewall** against destructive shell commands (`rm -rf`, `git reset --hard`, `git push --force`). They intercept different tools (Edit/Write vs Bash), so both can run simultaneously with zero conflict.

```bash
# Install both for full coverage
claude plugin add https://github.com/2233admin/salacia-guard
claude plugin add https://github.com/kenryu42/claude-code-safety-net
```

## Roadmap

- [ ] `/salacia-locate` — Fault localization skill (ripgrep + PageRank file ranking) `[Planned]`
- [ ] OMC integration — Auto-read scope from `OMC_TASK_ID` environment variable `[Planned]`
- [ ] Monorepo support — Auto-detect package boundaries from `package.json` `[Planned]`
- [ ] Retry loop — On drift threshold exceeded, stash + retry with feedback `[Planned]`
- [ ] Gemini CLI + Copilot CLI support `[Planned]`
- [x] **GC Layer (L3)** — Auto-rotate audit, refine contract, learn patterns into memory.json
- [x] **`/salacia-gc` skill** — Manual GC: refine + rotate + learn
- [x] **memory.json** — Cross-session pattern learning with exponential decay
- [x] **Shared lib.mjs** — Atomic writes, Windows path normalization, `.env.*` glob fix
- [x] **Promotion upgrade** — `count >= 3 AND sessions >= 2` (was count-only)
- [x] SessionStart hook — Stale contract detection + .gitignore reminder
- [x] Audit logging — `.salacia/audit.jsonl` append-only event log
- [x] Self-learning — Auto-promote frequently overridden files to soft scope
- [x] `permissionDecision: "ask"` for out-of-scope (not hard deny)
- [x] `/salacia-stats` — Audit statistics dashboard

## License

MIT

## Acknowledgments

- [StartripAI/Salacia](https://github.com/StartripAI/Salacia) — Contract concept and drift scoring
- [claude-code-safety-net](https://github.com/kenryu42/claude-code-safety-net) — Hook protocol reference and complementary plugin
- [commit-prophet](https://github.com/LakshmiSravyaVedantham/commit-prophet) — Co-change coupling algorithm
- [Axon](https://github.com/harshkedia177/axon) — Coupling threshold validation
- [AgentFL](https://arxiv.org/abs/2403.16362) — Fault localization for agents
- [ContextCov](https://arxiv.org/abs/2603.00822) — Constraint derivation from instructions
- [LlamaFirewall](https://arxiv.org/abs/2505.03574) — Defense-in-depth guardrail architecture inspiration
