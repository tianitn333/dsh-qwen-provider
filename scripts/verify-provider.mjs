#!/usr/bin/env node
/**
 * verify-provider.mjs — 千问AI平台 / 阿里云百炼 接入体检
 *
 * 对每个 (Base URL × 模型) 组合发一条最小请求，并做三项协议体检：
 *   1. `developer` 角色是否被拒        → 决定要不要 compat.supportsDeveloperRole: false
 *   2. `max_tokens` 的真实上限          → 决定模型条目的 maxTokens 该填多少
 *   3. `enable_thinking` / 工具调用     → 决定 thinkingFormat 与工具兼容性
 *
 * Key 只从环境变量或 ~/.dsh/.credentials.yaml 读取，任何情况下都不会被打印。
 *
 * 用法：
 *   node verify-provider.mjs --base https://maas.qianwenaiapi.com/compatible-mode/v1 --model qwen3.8-flash
 *   node verify-provider.mjs --env BAILIAN_API_KEY --base <url> --model a --model b --json
 */

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const argv = process.argv.slice(2);
const arg = (name, fallback = undefined) => {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
};
const argAll = (name) => {
  const out = [];
  argv.forEach((v, i) => { if (v === `--${name}` && argv[i + 1] && !argv[i + 1].startsWith("--")) out.push(argv[i + 1]); });
  return out;
};

const BASES = argAll("base");
const MODELS = argAll("model");
const ENV_NAME = arg("env", "DASHSCOPE_API_KEY");
const AS_JSON = !!arg("json", false);
const TIMEOUT_MS = Number(arg("timeout", 45000));

const DEFAULT_BASES = [
  "https://maas.qianwenaiapi.com/compatible-mode/v1",
  "https://dashscope.aliyuncs.com/compatible-mode/v1",
];
const DEFAULT_MODELS = ["qwen3.8-flash", "qwen3.8-max", "qwen3.7-plus", "deepseek-v4.1-flash-1017", "kimi-k3"];

const bases = BASES.length ? BASES : DEFAULT_BASES;
const models = MODELS.length ? MODELS : DEFAULT_MODELS;

/* ---------- 取 Key：环境变量 → ~/.dsh/.credentials.yaml 的 refs ---------- */

function keyFromCredentialStore() {
  const file = join(homedir(), ".dsh", ".credentials.yaml");
  if (!existsSync(file)) return null;
  const text = readFileSync(file, "utf8");
  const refs = text.split(/^refs:\s*$/m)[1];
  if (!refs) return null;
  const wanted = [ENV_NAME, "BAILIAN_API_KEY", "DASHSCOPE_API_KEY", "QWEN_TOKEN_PLAN_CN_API_KEY"];
  for (const name of wanted) {
    const m = refs.match(new RegExp(`^\\s{2}${name}:\\s*"?([^"\\r\\n]+)"?\\s*$`, "m"));
    if (m) return { key: m[1].trim(), source: `~/.dsh/.credentials.yaml (${name})` };
  }
  return null;
}

function loadKey() {
  if (process.env[ENV_NAME]) return { key: process.env[ENV_NAME].trim(), source: `环境变量 ${ENV_NAME}` };
  const store = keyFromCredentialStore();
  if (store) return store;
  console.error(`找不到 API Key：既没有环境变量 ${ENV_NAME}，~/.dsh/.credentials.yaml 里也没有可用的 refs。`);
  process.exit(2);
}

/** 只显示前缀（前 8 字符）用于辨别 sk- / sk-ws- / sk-sp-，不泄露密钥本体。 */
const mask = (k) => `${k.slice(0, 8)}…(len=${k.length})`;

/* ---------- 请求封装 ---------- */

async function post(url, body, key) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text();
    let message = "";
    if (res.status !== 200) {
      try {
        const j = JSON.parse(text);
        message = j.error?.message || j.message || j.code || "";
      } catch { message = text.slice(0, 160); }
    }
    return { status: res.status, message, ms: Date.now() - t0 };
  } catch (e) {
    return { status: 0, message: `${e.name}: ${String(e.message).slice(0, 120)}`, ms: Date.now() - t0 };
  }
}

const SYS = [{ role: "system", content: "You are a coding agent." }, { role: "user", content: "say hi" }];
const TOOL = {
  type: "function",
  function: { name: "get_time", description: "get current time", parameters: { type: "object", properties: { tz: { type: "string" } }, required: [] } },
};

/* ---------- 主流程 ---------- */

const { key, source } = loadKey();
if (!AS_JSON) {
  console.log(`Key: ${mask(key)}  来源: ${source}\n`);
}

const report = { key: mask(key), source, checks: [], matrix: [], hints: [] };

for (const base of bases) {
  const url = `${base.replace(/\/+$/, "")}/chat/completions`;
  for (const model of models) {
    const r = await post(url, { model, messages: SYS, max_tokens: 4096 }, key);
    const ok = r.status === 200;
    report.matrix.push({ base, model, status: r.status, ms: r.ms, message: r.message });
    if (!AS_JSON) console.log(`${ok ? "✅" : "❌"} ${base}\n   ${model} → HTTP ${r.status}${ok ? ` (${r.ms}ms)` : ` :: ${r.message}`}`);
    if (!ok && /not activated/i.test(r.message)) report.hints.push(`模型 ${model} 在此账号未开通或 ID 写法有误（去掉 kimi/ 这类前缀再试）。`);
  }
}

if (!AS_JSON) console.log("\n--- 协议体检 ---");

const firstBase = bases[0].replace(/\/+$/, "");
const firstUrl = `${firstBase}/chat/completions`;
const firstModel = models[0];

/* 1. developer 角色 */
{
  const r = await post(firstUrl, { model: firstModel, messages: [{ role: "developer", content: "sys" }, ...SYS.slice(1)], max_tokens: 64 }, key);
  const rejected = r.status === 400 && /developer is not one of/i.test(r.message);
  report.checks.push({ name: "developer-role", status: r.status, rejected, message: r.message });
  if (!AS_JSON) console.log(`${rejected ? "⚠️ " : "✅ "}developer 角色: HTTP ${r.status}${rejected ? " → 被拒，必须加 compat.supportsDeveloperRole: false" : ""}`);
  if (rejected) report.hints.push("在 provider 块补 compat.supportsDeveloperRole: false（DSH 对推理模型默认发 developer 角色）。");
}

/* 2. max_tokens 上限 */
{
  const r = await post(firstUrl, { model: firstModel, messages: SYS, max_tokens: 262144 }, key);
  const m = r.message.match(/\[1,\s*(\d+)\]/);
  const limit = m ? Number(m[1]) : null;
  report.checks.push({ name: "max-tokens-limit", status: r.status, limit, message: r.message });
  if (!AS_JSON) {
    if (limit) console.log(`⚠️  max_tokens 上限: ${limit} → 模型条目的 maxTokens 请设 ≤ ${Math.min(limit, 65536)}`);
    else console.log(`ℹ️  max_tokens=262144: HTTP ${r.status}${r.message ? " :: " + r.message.slice(0, 90) : "（未报上限错误）"}`);
  }
  if (limit) report.hints.push(`max_tokens 上限是 ${limit}，模型条目的 maxTokens 设成 ${Math.min(limit, 65536)} 以内（DSH 会原样发送该值）。`);
}

/* 3. enable_thinking 与工具调用 */
{
  const r = await post(firstUrl, { model: firstModel, messages: SYS, max_tokens: 512, enable_thinking: true }, key);
  report.checks.push({ name: "enable-thinking", status: r.status, message: r.message });
  if (!AS_JSON) console.log(`${r.status === 200 ? "✅" : "❌"} enable_thinking: HTTP ${r.status}`);
}
{
  const r = await post(firstUrl, { model: firstModel, messages: SYS, max_tokens: 512, tools: [TOOL], tool_choice: "auto" }, key);
  report.checks.push({ name: "tools", status: r.status, message: r.message });
  if (!AS_JSON) console.log(`${r.status === 200 ? "✅" : "❌"} 工具调用: HTTP ${r.status}`);
}

if (!AS_JSON && report.hints.length) {
  console.log("\n--- 建议 ---");
  for (const h of report.hints) console.log(`• ${h}`);
  console.log("\n参考 SKILL.md 第 2 节（compat）与第 4 节（错误速查表）。");
}

if (AS_JSON) console.log(JSON.stringify(report, null, 2));
