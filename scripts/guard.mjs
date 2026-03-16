#!/usr/bin/env node
// salacia-guard — zero-token scope enforcement via Claude Code hooks
// Input: JSON from stdin (Claude Code hook protocol)
// Output: JSON to stdout (hook response protocol)

import { readFileSync, appendFileSync, existsSync } from "fs";
import { resolve } from "path";
import { execFileSync } from "child_process";
import {
  salaciaDir, contractPath, driftPath, configPath, auditPath, learnedPath,
  loadJSON, saveJSON, matchesAny, relativize, ensureSalaciaDir, auditFileSize
} from "./lib.mjs";

// ── Read stdin ──

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf-8").trim();
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

// ── Audit log (append-only JSONL, skip if > 1MB) ──

const AUDIT_MAX = 1024 * 1024;

function auditLog(cwd, action, file, score, reason) {
  if (auditFileSize(cwd) > AUDIT_MAX) return; // skip, GC will rotate
  ensureSalaciaDir(cwd);
  const entry = JSON.stringify({ ts: new Date().toISOString(), action, file, score, reason });
  appendFileSync(auditPath(cwd), entry + "\n");
}

// ── Learned.json — promotion: count >= 3 AND sessions >= 2 ──

function trackLearning(cwd, filePath) {
  const lp = learnedPath(cwd);
  const learned = loadJSON(lp, { overrides: {}, autoSoftAllow: [] });
  const entry = learned.overrides[filePath] || { count: 0, sessions: new Set() };
  // sessions stored as array in JSON
  const sessions = new Set(entry.sessionDates || []);
  const today = new Date().toISOString().slice(0, 10);
  sessions.add(today);

  entry.count++;
  entry.lastSeen = today;
  entry.sessionDates = [...sessions];
  learned.overrides[filePath] = entry;

  const promoted = entry.count >= 3 && sessions.size >= 2 && !learned.autoSoftAllow.includes(filePath);
  if (promoted) learned.autoSoftAllow.push(filePath);

  saveJSON(lp, learned);
  return promoted;
}

function extractFilePath(toolInput) {
  if (!toolInput) return null;
  return toolInput.file_path || toolInput.filePath || toolInput.path || null;
}

// ── Output ──

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
  const drift = loadJSON(driftPath(cwd), { score: 0, files: [], softFiles: [], outOfScope: [], protected: [] });

  const allTracked = [...drift.files, ...drift.softFiles, ...drift.outOfScope];
  if (allTracked.includes(rel)) return allow();

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

  saveJSON(driftPath(cwd), drift);

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
