#!/usr/bin/env node
// salacia-guard shared utilities
// Extracted from guard.mjs for reuse across guard + gc modules

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, statSync, renameSync } from "fs";
import { resolve, dirname } from "path";
import { randomBytes } from "crypto";

// ── Paths ──

export function salaciaDir(cwd) { return resolve(cwd, ".salacia"); }
export function contractPath(cwd) { return resolve(salaciaDir(cwd), "contract.json"); }
export function driftPath(cwd) { return resolve(salaciaDir(cwd), "drift.json"); }
export function configPath(cwd) { return resolve(salaciaDir(cwd), "config.json"); }
export function auditPath(cwd) { return resolve(salaciaDir(cwd), "audit.jsonl"); }
export function learnedPath(cwd) { return resolve(salaciaDir(cwd), "learned.json"); }
export function memoryPath(cwd) { return resolve(salaciaDir(cwd), "memory.json"); }
export function auditSummaryPath(cwd) { return resolve(salaciaDir(cwd), "audit-summary.json"); }

// ── IO (atomic write: tmp + rename) ──

export function loadJSON(p, fallback) {
  try { return JSON.parse(readFileSync(p, "utf-8")); } catch { return fallback; }
}

export function saveJSON(p, data) {
  const dir = dirname(p);
  mkdirSync(dir, { recursive: true });
  const tmp = p + "." + randomBytes(4).toString("hex") + ".tmp";
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, p);
}

// ── Glob matching ──
// Fixed: .env.* now uses regex fallback instead of startsWith special case

export function matchGlob(filePath, pattern) {
  if (filePath === pattern) return true;
  if (pattern.endsWith("/**")) {
    const prefix = pattern.slice(0, -3);
    return filePath.startsWith(prefix + "/") || filePath === prefix;
  }
  if (pattern.startsWith("*.")) return filePath.endsWith(pattern.slice(1));
  if (pattern.endsWith("/")) return filePath.startsWith(pattern);
  // General wildcard: convert to regex (handles .env.*, config*.ts, etc.)
  if (pattern.includes("*") && !pattern.includes("**")) {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp(`^${escaped}$`).test(filePath);
  }
  return false;
}

export function matchesAny(filePath, patterns) {
  return (patterns || []).some(p => matchGlob(filePath, p));
}

// ── Path normalization ──
// Fixed: handles Windows C:\ vs Git Bash /c/ mismatch

export function relativize(absPath, cwd) {
  let cwdNorm = cwd.replace(/\\/g, "/").replace(/\/$/, "");
  let pathNorm = absPath.replace(/\\/g, "/");
  // Normalize /c/Users → C:/Users and vice versa for comparison
  const driveRe = /^\/([a-zA-Z])\//;
  const winRe = /^([a-zA-Z]):\//;
  function normDrive(p) {
    const m1 = p.match(driveRe);
    if (m1) return m1[1].toUpperCase() + ":/" + p.slice(3);
    const m2 = p.match(winRe);
    if (m2) return m2[1].toUpperCase() + ":/" + p.slice(3);
    return p;
  }
  const cwdD = normDrive(cwdNorm);
  const pathD = normDrive(pathNorm);
  if (pathD.toLowerCase().startsWith(cwdD.toLowerCase() + "/")) {
    return pathD.slice(cwdD.length + 1);
  }
  return pathNorm;
}

// ── Audit helpers ──

export function readAudit(cwd) {
  try {
    const raw = readFileSync(auditPath(cwd), "utf-8").trim();
    if (!raw) return [];
    return raw.split("\n").map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

export function auditFileSize(cwd) {
  try { return statSync(auditPath(cwd)).size; } catch { return 0; }
}

export function ensureSalaciaDir(cwd) {
  mkdirSync(salaciaDir(cwd), { recursive: true });
}
