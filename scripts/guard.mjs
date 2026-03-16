#!/usr/bin/env node
// salacia-guard — zero-token scope enforcement via hooks
// PreToolUse: check if target file is allowed → block/allow
// PostToolUse: track drift score → warn if threshold exceeded

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";

const SALACIA_DIR = ".salacia";
const CONTRACT_FILE = resolve(SALACIA_DIR, "contract.json");
const DRIFT_FILE = resolve(SALACIA_DIR, "drift.json");
const CONFIG_FILE = resolve(SALACIA_DIR, "config.json");

// ── Glob matching (ported from FSC salacia/drift.ts) ──

function matchGlob(filePath, pattern) {
  if (filePath === pattern) return true;
  if (pattern.endsWith("/**")) {
    const prefix = pattern.slice(0, -3);
    return filePath.startsWith(prefix + "/") || filePath === prefix;
  }
  if (pattern.startsWith("*.")) {
    return filePath.endsWith(pattern.slice(1));
  }
  if (pattern.includes(".*")) {
    const base = pattern.replace(".*", "");
    return filePath === base || filePath.startsWith(base + ".");
  }
  if (pattern.endsWith("/")) {
    return filePath.startsWith(pattern);
  }
  // Mid-pattern wildcard: prefix*.ext
  if (pattern.includes("*") && !pattern.includes("**")) {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp(`^${escaped}$`).test(filePath);
  }
  return false;
}

function matchesAny(filePath, patterns) {
  return (patterns || []).some(p => matchGlob(filePath, p));
}

// ── Load contract & config ──

function loadJSON(path, fallback) {
  try { return JSON.parse(readFileSync(path, "utf-8")); }
  catch { return fallback; }
}

function loadContract() {
  return loadJSON(CONTRACT_FILE, null);
}

function loadConfig() {
  return loadJSON(CONFIG_FILE, { driftThreshold: 30, enabled: true });
}

function loadDrift() {
  return loadJSON(DRIFT_FILE, { score: 0, files: [], softFiles: [], outOfScope: [], protected: [] });
}

function saveDrift(drift) {
  mkdirSync(SALACIA_DIR, { recursive: true });
  writeFileSync(DRIFT_FILE, JSON.stringify(drift, null, 2));
}

// ── Extract file path from tool input ──

function extractFilePath(toolInput) {
  try {
    const input = typeof toolInput === "string" ? JSON.parse(toolInput) : toolInput;
    return input.file_path || input.filePath || input.path || null;
  } catch {
    return null;
  }
}

function relativize(absPath) {
  const cwd = process.cwd().replace(/\\/g, "/");
  const normalized = absPath.replace(/\\/g, "/");
  if (normalized.startsWith(cwd + "/")) {
    return normalized.slice(cwd.length + 1);
  }
  return normalized;
}

// ── PreToolUse: check scope ──

function preCheck() {
  const config = loadConfig();
  if (!config.enabled) { process.exit(0); }

  const contract = loadContract();
  if (!contract) { process.exit(0); } // no contract = no enforcement

  const toolInput = process.env.TOOL_INPUT || "{}";
  const filePath = extractFilePath(toolInput);
  if (!filePath) { process.exit(0); }

  const rel = relativize(filePath);

  // Protected → hard block
  if (matchesAny(rel, contract.protectedPaths)) {
    console.log(JSON.stringify({
      decision: "block",
      reason: `🛡️ Salacia: BLOCKED — "${rel}" is a protected path. Do not modify this file.`
    }));
    process.exit(0);
  }

  // Excluded → hard block
  if (matchesAny(rel, contract.excludedPaths)) {
    console.log(JSON.stringify({
      decision: "block",
      reason: `🚫 Salacia: BLOCKED — "${rel}" is excluded from scope.`
    }));
    process.exit(0);
  }

  // Allowed or soft-allowed → allow silently
  // Out of scope → allow but will be tracked in post
  process.exit(0);
}

// ── PostToolUse: track drift ──

function postTrack() {
  const config = loadConfig();
  if (!config.enabled) { process.exit(0); }

  const contract = loadContract();
  if (!contract) { process.exit(0); }

  const toolInput = process.env.TOOL_INPUT || "{}";
  const filePath = extractFilePath(toolInput);
  if (!filePath) { process.exit(0); }

  const rel = relativize(filePath);
  const drift = loadDrift();

  // Skip if already tracked
  if (drift.files.includes(rel) || drift.softFiles.includes(rel) || drift.outOfScope.includes(rel)) {
    process.exit(0);
  }

  // Classify
  if (matchesAny(rel, contract.allowedPaths)) {
    drift.files.push(rel);
  } else if (matchesAny(rel, contract.softAllowedPaths || [])) {
    drift.softFiles.push(rel);
  } else {
    drift.outOfScope.push(rel);
    drift.score += 5;
  }

  // Check excess files
  const totalFiles = drift.files.length + drift.softFiles.length + drift.outOfScope.length;
  if (totalFiles > (contract.maxFilesChanged || 20)) {
    drift.score += 2;
  }

  saveDrift(drift);

  // Warn if threshold exceeded
  const threshold = config.driftThreshold || 30;
  if (drift.score >= threshold) {
    console.log(JSON.stringify({
      decision: "warn",
      reason: `⚠️ Salacia: drift score ${drift.score}/${threshold} — out-of-scope files: ${drift.outOfScope.join(", ")}. Consider staying within contract scope.`
    }));
  }

  process.exit(0);
}

// ── Main ──

const mode = process.argv[2];
if (mode === "pre") preCheck();
else if (mode === "post") postTrack();
else {
  console.error("Usage: guard.mjs <pre|post>");
  process.exit(1);
}
