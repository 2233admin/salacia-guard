#!/usr/bin/env node
// salacia-guard GC layer — environment self-cleaning and evolution
// Modes: auto | rotate | refine | learn | stale
// Usage: echo '{"cwd":"/path"}' | node gc.mjs <mode>
//   or:  node gc.mjs <mode>  (uses process.cwd())

import { readFileSync, writeFileSync, unlinkSync, existsSync } from "fs";
import { execFileSync } from "child_process";
import {
  salaciaDir, contractPath, auditPath, memoryPath, auditSummaryPath,
  learnedPath, driftPath,
  loadJSON, saveJSON, readAudit, auditFileSize, ensureSalaciaDir, matchesAny
} from "./lib.mjs";

// ── Stdin ──

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf-8").trim();
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

// ── Constants ──

const AUDIT_MAX_BYTES = 1024 * 1024; // 1MB
const AUDIT_RETAIN_DAYS = 7;
const DECAY_FACTOR = 0.9;
const DECAY_PRUNE_THRESHOLD = 0.1;
const PROMOTE_MIN_COUNT = 3;
const PROMOTE_MIN_SESSIONS = 2;

// ── Mode: auto ──
// Quick check on SessionStart: audit size + contract staleness

function modeAuto(cwd) {
  const messages = [];

  // Check audit size
  const size = auditFileSize(cwd);
  if (size > AUDIT_MAX_BYTES) {
    modeRotate(cwd);
    messages.push(`🗑️ Audit rotated (was ${(size / 1024).toFixed(0)}KB > 1MB limit)`);
  }

  // Check contract staleness
  const contract = loadJSON(contractPath(cwd), null);
  if (contract) {
    const hours = (Date.now() - (contract.generatedAt || 0)) / 3600000;
    if (hours > 48) {
      messages.push(`⏰ Contract is ${Math.floor(hours)}h old — consider refreshing`);
    }
    // Stale check inline
    const staleMessages = modeStale(cwd, contract);
    messages.push(...staleMessages);
  }

  if (messages.length > 0) {
    output({ systemMessage: "🧹 Salacia GC:\n" + messages.join("\n") });
  }
  process.exit(0);
}

// ── Mode: rotate ──
// Retain 7 days of audit, aggregate older into audit-summary.json

function modeRotate(cwd) {
  const events = readAudit(cwd);
  if (events.length === 0) {
    report("rotate", "No audit data to rotate.");
    return;
  }

  const cutoff = new Date(Date.now() - AUDIT_RETAIN_DAYS * 86400000).toISOString();
  const recent = [];
  const old = [];
  for (const e of events) {
    (e.ts >= cutoff ? recent : old).push(e);
  }

  // Aggregate old events into summary
  const summary = loadJSON(auditSummaryPath(cwd), { rotations: [], totalEventsArchived: 0 });
  if (old.length > 0) {
    const counts = {};
    const files = {};
    for (const e of old) {
      counts[e.action] = (counts[e.action] || 0) + 1;
      if (e.file) files[e.file] = (files[e.file] || 0) + 1;
    }
    summary.rotations.push({
      ts: new Date().toISOString(),
      period: { from: old[0]?.ts, to: old[old.length - 1]?.ts },
      eventsArchived: old.length,
      counts,
      topFiles: Object.entries(files).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([f, c]) => ({ file: f, count: c }))
    });
    summary.totalEventsArchived += old.length;
    // Keep only last 20 rotation records
    if (summary.rotations.length > 20) summary.rotations = summary.rotations.slice(-20);
    saveJSON(auditSummaryPath(cwd), summary);
  }

  // Rewrite audit with only recent events
  ensureSalaciaDir(cwd);
  const auditContent = recent.map(e => JSON.stringify(e)).join("\n") + (recent.length > 0 ? "\n" : "");
  writeFileSync(auditPath(cwd), auditContent);

  report("rotate", `Archived ${old.length} events (kept ${recent.length} from last ${AUDIT_RETAIN_DAYS} days).`);
}

// ── Mode: refine ──
// Analyze drift patterns, output suggestions

function modeRefine(cwd) {
  const contract = loadJSON(contractPath(cwd), null);
  if (!contract) { report("refine", "No contract found."); return; }

  const events = readAudit(cwd);
  const drift = loadJSON(driftPath(cwd), { files: [], softFiles: [], outOfScope: [] });
  const learned = loadJSON(learnedPath(cwd), { overrides: {}, autoSoftAllow: [] });

  const suggestions = [];

  // 1. overScoped: allowed paths never touched
  const touchedFiles = new Set([...drift.files, ...drift.softFiles, ...drift.outOfScope]);
  const overScoped = (contract.allowedPaths || []).filter(p => {
    return ![...touchedFiles].some(f => matchesAny(f, [p]));
  });
  if (overScoped.length > 0) {
    suggestions.push({ type: "overScoped", paths: overScoped, hint: "These allowed paths were never touched — contract may be too wide" });
  }

  // 2. underScoped: out-of-scope files edited repeatedly
  const oosFreq = {};
  for (const e of events) {
    if (e.action === "drift" && e.file) oosFreq[e.file] = (oosFreq[e.file] || 0) + 1;
  }
  const underScoped = Object.entries(oosFreq).filter(([, c]) => c >= 2).map(([f, c]) => ({ file: f, count: c }));
  if (underScoped.length > 0) {
    suggestions.push({ type: "underScoped", files: underScoped, hint: "These files are repeatedly edited out-of-scope — add to softAllowedPaths?" });
  }

  // 3. shouldPromote: learned overrides ready for promotion
  const shouldPromote = Object.entries(learned.overrides || {})
    .filter(([f, e]) => e.count >= PROMOTE_MIN_COUNT && !learned.autoSoftAllow.includes(f))
    .map(([f, e]) => ({ file: f, count: e.count, lastSeen: e.lastSeen }));
  if (shouldPromote.length > 0) {
    suggestions.push({ type: "shouldPromote", files: shouldPromote, hint: "These files have been overridden enough times to promote to soft-allow" });
  }

  if (suggestions.length === 0) {
    report("refine", "No optimization suggestions — contract looks well-fitted.");
  } else {
    report("refine", JSON.stringify(suggestions, null, 2));
  }
}

// ── Mode: learn ──
// Merge session patterns into memory.json with decay

function modeLearn(cwd) {
  const memory = loadJSON(memoryPath(cwd), { version: 1, patterns: {} });
  const contract = loadJSON(contractPath(cwd), null);
  const drift = loadJSON(driftPath(cwd), { files: [], softFiles: [], outOfScope: [] });

  // Determine task type from contract or branch
  let taskType = "unknown";
  if (contract?.taskId) {
    const prefix = contract.taskId.match(/^(feat|fix|refactor|docs|chore|test|perf|ci)/);
    if (prefix) taskType = prefix[1];
  }
  if (taskType === "unknown") {
    try {
      const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, timeout: 3000 }).toString().trim();
      const prefix = branch.match(/^(feat|fix|refactor|docs|chore|test|perf|ci)/);
      if (prefix) taskType = prefix[1];
    } catch {}
  }

  // Initialize pattern if needed
  if (!memory.patterns[taskType]) {
    memory.patterns[taskType] = { softPaths: {}, avgFilesChanged: 0, sessions: 0 };
  }
  const pat = memory.patterns[taskType];

  // Decay existing weights
  for (const [, info] of Object.entries(pat.softPaths)) {
    info.weight *= DECAY_FACTOR;
  }

  // Merge current session's soft + out-of-scope files
  const sessionFiles = [...(drift.softFiles || []), ...(drift.outOfScope || [])];
  for (const f of sessionFiles) {
    if (!pat.softPaths[f]) pat.softPaths[f] = { weight: 0, occurrences: 0 };
    pat.softPaths[f].weight = Math.min(1.0, pat.softPaths[f].weight + 0.3);
    pat.softPaths[f].occurrences++;
  }

  // Prune decayed entries
  for (const [f, info] of Object.entries(pat.softPaths)) {
    if (info.weight < DECAY_PRUNE_THRESHOLD) delete pat.softPaths[f];
  }

  // Update avg files changed (rolling average)
  const totalFiles = (drift.files?.length || 0) + (drift.softFiles?.length || 0) + (drift.outOfScope?.length || 0);
  pat.sessions = (pat.sessions || 0) + 1;
  pat.avgFilesChanged = Math.round(((pat.avgFilesChanged * (pat.sessions - 1)) + totalFiles) / pat.sessions);

  saveJSON(memoryPath(cwd), memory);

  const pathCount = Object.keys(pat.softPaths).length;
  report("learn", `Merged into "${taskType}" pattern: ${sessionFiles.length} files learned, ${pathCount} paths retained (decay applied).`);
}

// ── Mode: stale ──
// Check if contract references files/branches that no longer exist

function modeStale(cwd, contractOverride) {
  const contract = contractOverride || loadJSON(contractPath(cwd), null);
  if (!contract) return contractOverride ? [] : void report("stale", "No contract found.");

  const messages = [];

  // Check branch match
  try {
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, timeout: 3000 }).toString().trim();
    if (contract.taskId && !contract.taskId.includes(branch) && !["main", "master"].includes(branch)) {
      messages.push(`Branch "${branch}" ≠ contract "${contract.taskId}"`);
    }
  } catch {}

  // Check if key allowed paths still exist (non-glob exact paths)
  for (const p of (contract.allowedPaths || [])) {
    if (!p.includes("*") && !p.endsWith("/")) {
      try {
        execFileSync("git", ["ls-files", "--error-unmatch", p], { cwd, timeout: 3000, stdio: "pipe" });
      } catch {
        messages.push(`"${p}" no longer exists in repo`);
      }
    }
  }

  if (contractOverride) return messages; // called from auto
  if (messages.length === 0) report("stale", "Contract is up-to-date.");
  else report("stale", "Stale entries:\n" + messages.join("\n"));
}

// ── Output helpers ──

function output(obj) {
  process.stdout.write(JSON.stringify(obj));
}

function report(mode, message) {
  console.log(`[gc:${mode}] ${message}`);
}

// ── Main ──

const mode = process.argv[2];
const input = await readStdin();
const cwd = input.cwd || process.cwd();

if (mode === "auto") modeAuto(cwd);
else if (mode === "rotate") { modeRotate(cwd); process.exit(0); }
else if (mode === "refine") { modeRefine(cwd); process.exit(0); }
else if (mode === "learn") { modeLearn(cwd); process.exit(0); }
else if (mode === "stale") { modeStale(cwd); process.exit(0); }
else { console.error("Usage: gc.mjs <auto|rotate|refine|learn|stale>"); process.exit(1); }
