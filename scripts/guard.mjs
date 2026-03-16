#!/usr/bin/env node
// salacia-guard — zero-token scope enforcement via Claude Code hooks
// Input: JSON from stdin (Claude Code hook protocol)
//   { session_id, cwd, tool_name, tool_input, tool_result, ... }
// Output: JSON to stdout (hook response protocol)
//   PreToolUse:  { hookSpecificOutput: { permissionDecision: "allow|deny" }, systemMessage }
//   PostToolUse: { systemMessage } (exit 0 = shown in transcript)

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from "fs";
import { resolve } from "path";
import { execFileSync } from "child_process";

// ── Read stdin (Claude Code hook input) ──

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf-8").trim();
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

// ── Paths ──

function salaciaDir(cwd) { return resolve(cwd, ".salacia"); }
function contractPath(cwd) { return resolve(salaciaDir(cwd), "contract.json"); }
function driftPath(cwd) { return resolve(salaciaDir(cwd), "drift.json"); }
function configPath(cwd) { return resolve(salaciaDir(cwd), "config.json"); }
function auditPath(cwd) { return resolve(salaciaDir(cwd), "audit.jsonl"); }
function learnedPath(cwd) { return resolve(salaciaDir(cwd), "learned.json"); }

// ── Glob matching (ported from FSC salacia/drift.ts) ──

function matchGlob(filePath, pattern) {
  if (filePath === pattern) return true;
  if (pattern.endsWith("/**")) {
    const prefix = pattern.slice(0, -3);
    return filePath.startsWith(prefix + "/") || filePath === prefix;
  }
  if (pattern.startsWith("*.")) return filePath.endsWith(pattern.slice(1));
  if (pattern.includes(".*")) {
    const base = pattern.replace(".*", "");
    return filePath === base || filePath.startsWith(base + ".");
  }
  if (pattern.endsWith("/")) return filePath.startsWith(pattern);
  if (pattern.includes("*") && !pattern.includes("**")) {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp(`^${escaped}$`).test(filePath);
  }
  return false;
}

function matchesAny(filePath, patterns) {
  return (patterns || []).some(p => matchGlob(filePath, p));
}

// ── Helpers ──

function loadJSON(p, fallback) {
  try { return JSON.parse(readFileSync(p, "utf-8")); } catch { return fallback; }
}

function saveDrift(cwd, drift) {
  mkdirSync(salaciaDir(cwd), { recursive: true });
  writeFileSync(driftPath(cwd), JSON.stringify(drift, null, 2));
}

// ── Audit log (append-only JSONL) ──

function auditLog(cwd, action, file, score, reason) {
  mkdirSync(salaciaDir(cwd), { recursive: true });
  const entry = JSON.stringify({ ts: new Date().toISOString(), action, file, score, reason });
  appendFileSync(auditPath(cwd), entry + "\n");
}

// ── Learned.json — self-learning from overrides ──

function trackLearning(cwd, filePath) {
  const lp = learnedPath(cwd);
  const learned = loadJSON(lp, { overrides: {}, autoSoftAllow: [] });
  const entry = learned.overrides[filePath] || { count: 0 };
  entry.count++;
  entry.lastSeen = new Date().toISOString().slice(0, 10);
  learned.overrides[filePath] = entry;
  if (entry.count >= 3 && !learned.autoSoftAllow.includes(filePath)) {
    learned.autoSoftAllow.push(filePath);
    mkdirSync(salaciaDir(cwd), { recursive: true });
    writeFileSync(lp, JSON.stringify(learned, null, 2));
    return true; // newly promoted
  }
  mkdirSync(salaciaDir(cwd), { recursive: true });
  writeFileSync(lp, JSON.stringify(learned, null, 2));
  return false;
}

function extractFilePath(toolInput) {
  if (!toolInput) return null;
  return toolInput.file_path || toolInput.filePath || toolInput.path || null;
}

function relativize(absPath, cwd) {
  const cwdNorm = cwd.replace(/\\/g, "/").replace(/\/$/, "");
  const pathNorm = absPath.replace(/\\/g, "/");
  // Case-insensitive prefix match for Windows drive letters
  if (pathNorm.toLowerCase().startsWith(cwdNorm.toLowerCase() + "/")) {
    return pathNorm.slice(cwdNorm.length + 1);
  }
  return pathNorm;
}

// ── Output (Claude Code hook response format) ──

function allow() { process.exit(0); }

function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason
    }
  }));
  process.exit(0);
}

function ask(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "ask",
      permissionDecisionReason: reason
    }
  }));
  process.exit(0);
}

function warn(message) {
  process.stdout.write(JSON.stringify({ systemMessage: message }));
  process.exit(0);
}

function info(message) {
  process.stdout.write(JSON.stringify({ systemMessage: message }));
  process.exit(0);
}

// ── SessionStart ──

function sessionCheck(input) {
  const cwd = input.cwd || process.cwd();
  const messages = [];

  const contract = loadJSON(contractPath(cwd), null);
  if (contract) {
    const hours = (Date.now() - (contract.generatedAt || 0)) / 3600000;
    if (hours > 24) {
      messages.push(`⏰ Contract is ${Math.floor(hours)}h old. Consider /salacia-init to refresh.`);
    }
    try {
      const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, timeout: 5000 }).toString().trim();
      if (contract.taskId && !contract.taskId.includes(branch) && branch !== "main" && branch !== "master") {
        messages.push(`🔀 Branch "${branch}" doesn't match contract "${contract.taskId}". Run /salacia-init?`);
      }
    } catch {}
  }

  if (existsSync(resolve(cwd, ".salacia")) && existsSync(resolve(cwd, ".gitignore"))) {
    try {
      if (!readFileSync(resolve(cwd, ".gitignore"), "utf-8").includes(".salacia")) {
        messages.push(`📝 Add ".salacia/" to .gitignore.`);
      }
    } catch {}
  }

  if (messages.length > 0) return info("🛡️ Salacia Guard active.\n" + messages.join("\n"));
  return allow();
}

// ── PreToolUse ──

function preCheck(input) {
  const cwd = input.cwd || process.cwd();
  const config = loadJSON(configPath(cwd), { enabled: true });
  if (!config.enabled) return allow();

  const contract = loadJSON(contractPath(cwd), null);
  if (!contract) return allow();

  const filePath = extractFilePath(input.tool_input);
  if (!filePath) return allow();

  const rel = relativize(filePath, cwd);

  if (matchesAny(rel, contract.protectedPaths)) {
    auditLog(cwd, "deny", rel, 0, "protected path");
    return deny(`🛡️ Salacia: BLOCKED — "${rel}" is a protected path. Do not modify this file.`);
  }
  if (matchesAny(rel, contract.excludedPaths)) {
    auditLog(cwd, "deny", rel, 0, "excluded path");
    return deny(`🚫 Salacia: BLOCKED — "${rel}" is excluded from scope.`);
  }
  // Out of scope (not allowed, not soft) → ask user
  const learned = loadJSON(learnedPath(cwd), { overrides: {}, autoSoftAllow: [] });
  const softPaths = [...(contract.softAllowedPaths || []), ...learned.autoSoftAllow];
  if (contract.allowedPaths.length > 0 && !matchesAny(rel, contract.allowedPaths) && !matchesAny(rel, softPaths)) {
    auditLog(cwd, "ask", rel, 0, "out of scope");
    return ask(`⚠️ Salacia: "${rel}" is outside scope. Allow this edit?`);
  }
  return allow();
}

// ── PostToolUse ──

function postTrack(input) {
  const cwd = input.cwd || process.cwd();
  const config = loadJSON(configPath(cwd), { enabled: true, driftThreshold: 30 });
  if (!config.enabled) return allow();

  const contract = loadJSON(contractPath(cwd), null);
  if (!contract) return allow();

  const filePath = extractFilePath(input.tool_input);
  if (!filePath) return allow();

  const rel = relativize(filePath, cwd);
  const drift = loadJSON(driftPath(cwd), {
    score: 0, files: [], softFiles: [], outOfScope: [], protected: []
  });

  const allTracked = [...drift.files, ...drift.softFiles, ...drift.outOfScope];
  if (allTracked.includes(rel)) return allow();

  // Merge learned autoSoftAllow into soft scope
  const learned = loadJSON(learnedPath(cwd), { overrides: {}, autoSoftAllow: [] });
  const softPaths = [...(contract.softAllowedPaths || []), ...learned.autoSoftAllow];

  if (matchesAny(rel, contract.allowedPaths)) {
    drift.files.push(rel);
    auditLog(cwd, "allow", rel, drift.score);
  } else if (matchesAny(rel, softPaths)) {
    drift.softFiles.push(rel);
    auditLog(cwd, "soft", rel, drift.score);
  } else {
    drift.outOfScope.push(rel);
    drift.score += 5;
    trackLearning(cwd, rel);
    auditLog(cwd, "drift", rel, drift.score, "out of scope");
  }

  const totalFiles = drift.files.length + drift.softFiles.length + drift.outOfScope.length;
  if (totalFiles > (contract.maxFilesChanged || 20)) drift.score += 2;

  saveDrift(cwd, drift);

  const threshold = config.driftThreshold || 30;
  if (drift.score >= threshold) {
    return warn(`⚠️ Salacia: drift score ${drift.score}/${threshold} — out-of-scope: ${drift.outOfScope.join(", ")}`);
  }
  return allow();
}

// ── Stats ──

function generateStats(cwd) {
  const lines = [];
  try {
    const raw = readFileSync(auditPath(cwd), "utf-8").trim().split("\n").filter(Boolean);
    const events = raw.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const counts = { allow: 0, deny: 0, drift: 0, soft: 0, ask: 0 };
    const fileFreq = {};
    for (const e of events) {
      counts[e.action] = (counts[e.action] || 0) + 1;
      if (e.action === "drift") fileFreq[e.file] = (fileFreq[e.file] || 0) + 1;
    }
    const topDrift = Object.entries(fileFreq).sort((a, b) => b[1] - a[1]).slice(0, 5);
    const learned = loadJSON(learnedPath(cwd), { overrides: {}, autoSoftAllow: [] });

    lines.push("┌─── Salacia Stats ─────────────────────────┐");
    lines.push(`│ Total events: ${events.length}`);
    lines.push(`│ Allow: ${counts.allow}  Soft: ${counts.soft}  Drift: ${counts.drift}  Deny: ${counts.deny}  Ask: ${counts.ask}`);
    if (topDrift.length > 0) {
      lines.push("├─── Top drifted files ──────────────────────┤");
      for (const [f, c] of topDrift) lines.push(`│ ${c}x ${f}`);
    }
    if (learned.autoSoftAllow.length > 0) {
      lines.push("├─── Learned (auto-promoted to soft) ────────┤");
      for (const f of learned.autoSoftAllow) lines.push(`│ ✅ ${f}`);
    }
    lines.push("└────────────────────────────────────────────┘");
  } catch {
    lines.push("No audit data found. Use /salacia-init to start.");
  }
  return lines.join("\n");
}

// ── Main ──

const mode = process.argv[2];
const input = await readStdin();

if (mode === "pre") preCheck(input);
else if (mode === "post") postTrack(input);
else if (mode === "session") sessionCheck(input);
else if (mode === "stats") { console.log(generateStats(input.cwd || process.cwd())); process.exit(0); }
else { console.error("Usage: guard.mjs <pre|post|session|stats>"); process.exit(1); }
