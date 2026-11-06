# 排错手册：四个真实踩过的坑

所有结论都来自对同一把 Key 的实测（`scripts/verify-provider.mjs` 可复现）。错误原文照抄服务端返回。

---

## 坑 1 · `400 Workspace endpoint is invalid.`

```json
{"message":"Workspace endpoint is invalid.","id":"3b270169-…","type":"invalid_request_error","code":"invalid_parameter_error"}
```

**根因**：API 地址里用了**文档占位符**。官方文档写的是
`https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`，示例又写成 `llm-xxx.cn-beijing.maas.aliyuncs.com`。
把 `llm-xxx` 原样抄进去（还常被识别成 `11m-xxx`，小写 l 与数字 1 混淆），网关解析不出业务空间，直接 400。

**判定**：请求根本没进模型，错误发生在域名路由阶段。

**修法**（二选一）：
1. 到百炼控制台复制真实的 **API Host**：创建 Key 后的弹窗里有，或[业务空间管理](https://bailian.console.aliyun.com/cn-beijing/settings/workspace)页的 `API Host` 列，形如 `llm-xxxx.cn-beijing.maas.aliyuncs.com`。
2. 直接用无占位符的域名：`https://dashscope.aliyuncs.com/compatible-mode/v1`（华北2北京）或 `https://maas.qianwenaiapi.com/compatible-mode/v1`（千问AI平台）。

**实测**：同一把 `sk-ws-` Key 在上面两个域名下都返回 200。

---

## 坑 2 · `400 developer is not one of ['system', 'assistant', 'user', 'tool', 'function']`

```json
{"code":"invalid_parameter_error","param":null,"message":"developer is not one of ['system', 'assistant', 'user', 'tool', 'function']","type":"invalid_request_error"}
```

**根因**：DSH 对推理类模型用 OpenAI 新规范的 **`developer` 角色**承载系统提示词。适配器逻辑（`pi-ai` 的 `openai-completions` 实现）：

```js
const instructionRole = model.reasoning && compat?.supportsDeveloperRole !== false ? "developer" : "system";
```

`compat` 缺省为 `true` → 发 `developer`；百炼/千问只接受 `system|assistant|user|tool|function` → 400。

**为什么内置目录不会踩**：DSH 内置的 Qwen / DeepSeek / Kimi / GLM 目录项都显式带了 `compat.supportsDeveloperRole: false`。走 GUI 的「自定义模型 API」新建的 provider 没有这个字段，**GUI 表单也不提供**。

**修法**：在 provider 块里补（model 级也可以，优先级更高）：

```yaml
compat:
  supportsDeveloperRole: false
  supportsReasoningEffort: false
  thinkingFormat: qwen
```

`thinkingFormat: qwen` 让思考开关改用百炼的 `enable_thinking`（实测 `enable_thinking`、`reasoning_effort`、`thinking:{type:enabled}` 在该端点都能被接受，但只有 `enable_thinking` 是百炼/千问的正式开关）。

**实测**（DSH 完整请求形态：system 角色 + enable_thinking + 工具 + 流式）：

```
✅ qwen3.8-flash           thinking=true/false  → HTTP 200
✅ qwen3.8-max             thinking=true/false  → HTTP 200
✅ deepseek-v4.1-flash-1017 thinking=true/false → HTTP 200
✅ kimi-k3                 thinking=true/false  → HTTP 200
```

---

## 坑 3 · `400 The product is not activated`

```json
{"code":"InvalidParameter","message":"The product is not activated, please confirm that you have activated products and try again after activation.","request_id":"…"}
```

**根因**：模型 ID 用了**带命名空间前缀的目录展示 ID**，例如 `kimi/kimi-k3.1-pro`。正确写法是 `kimi-k3`（前缀去掉）。另一种可能是该第三方模型产品在你的账号上确实没开通。

**判定**：换个模型 ID 试；若 `kimi-k3` 能通而 `kimi/kimi-k3.1-pro` 不行，就是前缀问题。

**修法**：用 API 实际接受的 model ID；或到控制台开通对应模型。

---

## 坑 4 · `400 Range of max_tokens should be [1, 131072]`

**根因**：DSH 把模型条目的 `maxTokens` **原样**作为 `max_tokens` 发出去。GUI「获取可用模型」带回来的目录值（如 `384000`）是模型的能力上限，不一定等于该端点接受的 `max_tokens` 上限。

**判定**：把 `maxTokens` 调小即可。

**修法**：模型条目的 `maxTokens` 设成保守值（**建议 65536**，上限内即可）：

```yaml
- id: qwen3.8-flash
  maxTokens: 65536
```

---

## 坑 5 · 「获取可用模型」返回 401 / 404

**根因**：百炼与千问AI平台的 OpenAI 兼容端点**不提供 `GET /models`**。这是预期行为，不是配置错误。

**修法**：忽略该按钮，在模型目录里手动添加模型 ID。

---

## 坑 6 · `MISSING_CREDENTIAL`

**根因**：provider 的 `apiKeyEnv` 指向的凭据名在凭据库里没有存上，或环境变量没生效。

**修法**：
- GUI 里重新输入 API Key 并保存（写进 `~/.dsh/.credentials.yaml` 的 `refs:`）；
- 或设置环境变量（`DASHSCOPE_API_KEY` 等）后**重启** DSH；
- 变量来源顺序：启动环境 → `$cwd/.env` → `$DSH_HOME/.env`。

---

## 排错决策顺序

1. **先单独验证 Key + 域名 + 模型 ID**（`scripts/verify-provider.mjs`）：三件事分离，能立刻区分"配置写错"和"适配器行为"。
2. **再看报错落在哪一层**：
   - 域名路由层（`Workspace endpoint is invalid`）→ 改 URL
   - 协议校验层（`developer is not one of ...`、`Range of max_tokens`）→ 改 compat / 模型条目
   - 产品开通层（`The product is not activated`）→ 改模型 ID 或开通产品
   - 鉴权层（401 / `MISSING_CREDENTIAL`）→ 改 Key
3. **改完重启 DSH**：配置在启动时加载，热改不生效。
4. **不要同时改两处**：一次只动一个变量，否则错误会互相掩盖（这次就是"改完域名以为好了，其实后面还压着 `developer` 角色"）。

---

## 关于用脚本自检

`scripts/verify-provider.mjs` 的要点：

- Key 从 `--env` 指定的环境变量或 `~/.dsh/.credentials.yaml` 读取，**任何情况下都不打印 Key**；
- 对每个 (Base URL × 模型) 组合发一条 `max_tokens=4096` 的最小请求，打印 ✅/❌；
- 额外做三项协议体检：`developer` 角色是否被拒（预期 400，说明需要 `supportsDeveloperRole: false`）、`max_tokens` 上限（探测模型真实上限）、`enable_thinking` / 工具调用是否被接受。

把体检结果贴给别人看时，Key 本身不会泄漏。
