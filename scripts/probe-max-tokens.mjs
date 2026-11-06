#!/usr/bin/env node
/**
 * probe-max-tokens.mjs — 探测各模型真正接受的 max_tokens 区间
 *
 * 做法：发一个超大 max_tokens，服务端会用错误信息回出区间（"Range of max_tokens
 * should be [1, N]"），再分别用 N 和 N+1 验证边界。
 *
 * 顺带区分两个字段：
 *   - max_tokens            → 端点**校验范围**，超限 400
 *   - max_completion_tokens → 端点**不校验**，但照样按它截断输出（DSH 默认发这个）
 *
 * 用法：node probe-max-tokens.mjs [--env BAILIAN_API_KEY] [--model qwen3.8-flash ...]
 */

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const argv = process.argv.slice(2);
const argAll = (name) => {
  const out = [];
  argv.forEach((v, i) => { if (v === `--${name}` && argv[i + 1] && !argv[i + 1].startsWith("--")) out.push(argv[i + 1]); });
  return out;
};
const arg = (name, d) => { const i = argv.indexOf(`--${name}`); return i === -1 ? d : argv[i + 1]; };

const ENV_NAME = arg("env", "DASHSCOPE_API_KEY");
const BASES = argAll("base");
const MODELS = argAll("model");
const bases = BASES.length ? BASES : [
  "https://maas.qianwenaiapi.com/compatible-mode/v1",
  "https://dashscope.aliyuncs.com/compatible-mode/v1",
];
const models = MODELS.length ? MODELS : ["qwen3.8-flash", "qwen3.8-max", "qwen3.7-plus", "deepseek-v4.1-flash-1017", "kimi-k3"];

function loadKey() {
  if (process.env[ENV_NAME]) return process.env[ENV_NAME].trim();
  const f = join(homedir(), ".dsh", ".credentials.yaml");
  if (existsSync(f)) {
    const refs = readFileSync(f, "utf8").split(/^refs:\s*$/m)[1] ?? "";
    for (const name of [ENV_NAME, "BAILIAN_API_KEY", "DASHSCOPE_API_KEY"]) {
      const m = refs.match(new RegExp(`^\\s{2}${name}:\\s*"?([^"\\r\\n]+)"?\\s*$`, "m"));
      if (m) return m[1].trim();
    }
  }
  console.error(`找不到 API Key（环境变量 ${ENV_NAME} / ~/.dsh/.credentials.yaml）。`);
  process.exit(2);
}

const KEY = loadKey();
const SYS = [{ role: "system", content: "s" }, { role: "user", content: "hi" }];

async function post(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45000),
  });
  const t = await res.text();
  let msg = "";
  if (res.status !== 200) { try { const j = JSON.parse(t); msg = j.error?.message || j.message || ""; } catch { msg = t.slice(0, 120); } }
  return { status: res.status, msg };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (const base of bases) {
  const url = `${base.replace(/\/+$/, "")}/chat/completions`;
  console.log(`\n### ${base}`);
  for (const model of models) {
    const probe = await post(url, { model, messages: SYS, max_tokens: 100_000_000 });
    const m = probe.msg.match(/\[1,\s*(\d+)\]/);
    let verdict;
    if (probe.status === 200) verdict = "不设硬上限（接受超大 max_tokens）";
    else if (m) {
      const cap = Number(m[1]);
      const at = await post(url, { model, messages: SYS, max_tokens: cap });
      verdict = `上限 ${cap} → 取 ${cap}: HTTP ${at.status}（取 ${cap + 1} 会 400）`;
    } else verdict = `HTTP ${probe.status} :: ${probe.msg.slice(0, 110)}`;
    console.log(`  ${model.padEnd(26)} ${verdict}`);
    await sleep(4000);
  }
}
