#!/usr/bin/env node
// salacia-guard — zero-token scope enforcement via Claude Code hooks
// Input: JSON from stdin (Claude Code hook protocol)
//   { session_id, cwd, tool_name, tool_input, tool_result, ... }
// Output: JSON to stdout (hook response protocol)
//   PreToolUse:  { hookSpecificOutput: { permissionDecision: "allow|deny" }, systemMessage }
//   PostToolUse: { systemMessage } (exit 0 = shown in transcript)

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve } from "path";

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

function warn(message) {
  process.stdout.write(JSON.stringify({ systemMessage: message }));
  process.exit(0);
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
    return deny(`🛡️ Salacia: BLOCKED — "${rel}" is a protected path. Do not modify this file.`);
  }
  if (matchesAny(rel, contract.excludedPaths)) {
    return deny(`🚫 Salacia: BLOCKED — "${rel}" is excluded from scope.`);
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

  if (matchesAny(rel, contract.allowedPaths)) {
    drift.files.push(rel);
  } else if (matchesAny(rel, contract.softAllowedPaths || [])) {
    drift.softFiles.push(rel);
  } else {
    drift.outOfScope.push(rel);
    drift.score += 5;
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

// ── Main ──

const mode = process.argv[2];
const input = await readStdin();

if (mode === "pre") preCheck(input);
else if (mode === "post") postTrack(input);
else { console.error("Usage: guard.mjs <pre|post>"); process.exit(1); }
