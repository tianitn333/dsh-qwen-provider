#!/usr/bin/env node
/**
 * apply-compat.mjs — 给 DSH 的 provider 块补 compat 开关 / 修正 Base URL 与模型列表
 *
 * 只做文本级、可回滚的最小改动：
 *   - 备份原文件（<file>.bak-<时间戳>）
 *   - 只动目标 provider 块内的 baseURL / compat / models
 *   - 默认先打印改动摘要；--dry-run 只读不写
 *
 * 用法：
 *   node apply-compat.mjs --provider bailian --base https://maas.qianwenaiapi.com/compatible-mode/v1 \
 *        --models qwen3.8-flash,qwen3.8-max --max-tokens 65536 --dry-run
 *   node apply-compat.mjs --provider bailian --models qwen3.8-flash --yes
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const argv = process.argv.slice(2);
const arg = (name, fallback = undefined) => {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
};

const PROVIDER = arg("provider");
const BASE = arg("base");
const MODELS = arg("models");
const MAX_TOKENS = Number(arg("max-tokens", 65536));
const DRY = !!arg("dry-run", false);
const YES = !!arg("yes", false);
const PROFILE_ARG = arg("profile");
const FILE_OVERRIDE = arg("file");

if (!PROVIDER) {
  console.error("用法: node apply-compat.mjs --provider <id> [--profile desktop] [--base <url>] [--models a,b] [--max-tokens 65536] [--dry-run] [--yes]");
  process.exit(2);
}

/* ---------- 定位 profile 与目标文件 ---------- */

function resolveProfile() {
  const base = join(homedir(), ".dsh", "profiles");
  if (!existsSync(base)) { console.error(`找不到 ${base}`); process.exit(2); }
  if (PROFILE_ARG) return String(PROFILE_ARG);
  const available = readdirSync(base).filter((d) => existsSync(join(base, d, "cordis.patch.yml")));
  for (const pref of ["desktop", "web", "headless"]) if (available.includes(pref)) return pref;
  if (available.length) return available[0];
  console.error(`没有任何 profile 含 cordis.patch.yml：${available.join(", ") || "(空)"}`);
  process.exit(2);
}

const profile = FILE_OVERRIDE ? "(自定义文件)" : resolveProfile();
const file = FILE_OVERRIDE ? String(FILE_OVERRIDE) : join(homedir(), ".dsh", "profiles", profile, "cordis.patch.yml");
if (!existsSync(file)) { console.error(`找不到 ${file}`); process.exit(2); }

const original = readFileSync(file, "utf8");
let lines = original.split(/\r?\n/);

const indentOf = (s) => s.length - s.trimStart().length;

/* ---------- 找到 providers: 段里的目标 provider 块 ---------- */

function findProviderBlock() {
  let providersIndent = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)providers:\s*$/);
    if (m) { providersIndent = m[1].length; break; }
  }
  if (providersIndent < 0) return null;

  const wantIndent = providersIndent + 2;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)([A-Za-z0-9_-]+):\s*$/);
    if (!m || m[1].length !== wantIndent || m[2] !== PROVIDER) continue;
    const start = i;
    let end = i + 1;
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (line.trim() === "") { end = j + 1; continue; }
      if (indentOf(line) <= wantIndent) break;
      end = j + 1;
    }
    return { start, end, indent: wantIndent };
  }
  return null;
}

const block = findProviderBlock();
if (!block) {
  console.error(`在 ${file} 的 providers: 段里没找到 provider "${PROVIDER}"。`);
  process.exit(3);
}

const changes = [];
const before = lines.slice(block.start, block.end).join("\n");

/* 在块内定位某个子键的起始行与它的子块结束行 */
function findKey(start, end, key) {
  const keyIndent = block.indent + 2;
  for (let i = start; i < end; i++) {
    const m = lines[i].match(/^(\s*)([A-Za-z0-9_]+):\s*(.*)$/);
    if (!m || m[1].length !== keyIndent || m[2] !== key) continue;
    let subEnd = i + 1;
    for (let j = i + 1; j < end; j++) {
      if (lines[j].trim() === "") continue;
      if (indentOf(lines[j]) <= keyIndent) break;
      subEnd = j + 1;
    }
    return { index: i, subEnd, indent: keyIndent, value: m[3].trim() };
  }
  return null;
}

/* ---------- 1. Base URL ---------- */
const baseKey = findKey(block.start, block.end, "baseURL");
if (BASE) {
  const url = String(BASE).trim();
  if (!/^https?:\/\//.test(url)) { console.error(`--base 必须是 http(s) URL：${url}`); process.exit(2); }
  if (baseKey) {
    if (baseKey.value !== url) {
      lines[baseKey.index] = lines[baseKey.index].replace(/(\s*baseURL:\s*).*$/, `$1${url}`);
      changes.push(`baseURL → ${url}`);
    }
  } else {
    lines.splice(block.start + 1, 0, `${" ".repeat(block.indent + 2)}baseURL: ${url}`);
    changes.push(`新增 baseURL → ${url}`);
    block.end += 1;
  }
}

/* ---------- 2. compat ---------- */
const COMPAT_DEFAULTS = {
  supportsDeveloperRole: "false",
  supportsReasoningEffort: "false",
  thinkingFormat: "qwen",
};

function ensureCompat() {
  const existing = findKey(block.start, block.end, "compat");
  if (!existing) {
    const insertAt = baseKey ? baseKey.index + 1 : block.start + 1;
    const indent = " ".repeat(block.indent + 2);
    const body = Object.entries(COMPAT_DEFAULTS).map(([k, v]) => `${indent}  ${k}: ${v}`).join("\n");
    lines.splice(insertAt, 0, `${indent}compat:\n${body}`);
    block.end += Object.keys(COMPAT_DEFAULTS).length + 1;
    changes.push("新增 compat（supportsDeveloperRole=false / supportsReasoningEffort=false / thinkingFormat=qwen）");
    return;
  }
  const missing = [];
  for (const [k, v] of Object.entries(COMPAT_DEFAULTS)) {
    const idx = lines.findIndex((l, i) => i >= existing.index && i < existing.subEnd && new RegExp(`^\\s*${k}:`).test(l));
    if (idx < 0) { missing.push([k, v]); continue; }
    const m = lines[idx].match(new RegExp(`^(\\s*${k}:\\s*)(.*)$`));
    const oldVal = (m ? m[2] : "").trim();
    if (oldVal !== v) {
      lines[idx] = `${m[1]}${v}`;
      changes.push(`compat.${k}: ${oldVal || "(空)"} → ${v}`);
    }
  }
  if (missing.length) {
    const body = missing.map(([k, v]) => `${" ".repeat(existing.indent + 2)}${k}: ${v}`);
    lines.splice(existing.subEnd, 0, ...body);
    block.end += body.length;
    changes.push(`compat 补字段：${missing.map(([k]) => k).join(", ")}`);
  }
}

/* ---------- 3. 模型列表 ---------- */
function setModels() {
  const ids = String(MODELS).split(",").map((s) => s.trim()).filter(Boolean);
  if (!ids.length) return;
  const modelsKey = findKey(block.start, block.end, "models");
  if (!modelsKey) { console.error("provider 块里没有 models: 列表，无法替换。"); process.exit(3); }
  const listIndent = " ".repeat(modelsKey.indent + 2);
  const entryIndent = " ".repeat(modelsKey.indent + 4);
  const body = [];
  for (const id of ids) {
    body.push(`${listIndent}- id: ${id}`);
    body.push(`${entryIndent}name: ${id}`);
    body.push(`${entryIndent}contextWindow: 1000000`);
    body.push(`${entryIndent}maxTokens: ${MAX_TOKENS}`);
    body.push(`${entryIndent}input:`);
    body.push(`${entryIndent}  - text`);
    body.push(`${entryIndent}  - image`);
    body.push(`${entryIndent}reasoningEfforts:`);
    body.push(`${entryIndent}  off: null`);
    body.push(`${entryIndent}  minimal: minimal`);
    body.push(`${entryIndent}  low: low`);
    body.push(`${entryIndent}  medium: medium`);
    body.push(`${entryIndent}  high: high`);
  }
  lines.splice(modelsKey.index + 1, modelsKey.subEnd - modelsKey.index - 1, ...body);
  block.end += body.length - (modelsKey.subEnd - modelsKey.index - 1);
  changes.push(`models → ${ids.join(", ")}（maxTokens=${MAX_TOKENS}）`);
}

ensureCompat();
if (MODELS) setModels();

const after = lines.slice(block.start, block.end).join("\n");
const output = lines.join("\n");

if (output === original) {
  console.log(`无需改动：${file}\nprovider "${PROVIDER}"（profile ${profile}）已经是目标状态。`);
  process.exit(0);
}

console.log(`文件：${file}`);
console.log(`profile：${profile}    provider：${PROVIDER}\n`);
console.log("改动：");
for (const c of changes) console.log(`  • ${c}`);

if (DRY) {
  console.log("\n--- dry-run，以下为改后的 provider 块（未写入）---");
  console.log(after);
  process.exit(0);
}

if (!YES) {
  console.log("\n加 --yes 才会写入（会先自动备份）。");
  process.exit(0);
}

const backup = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
copyFileSync(file, backup);
writeFileSync(file, output, "utf8");
console.log(`\n已写入。备份：${backup}`);
console.log("请重启 DSH 让配置生效，然后新建对话验证。");
