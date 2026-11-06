---
name: dsh-qwen-provider
description: Connect DeepSeek Harness (DSH) to Alibaba Cloud Model Studio (阿里云百炼) or the Qwen AI Platform (千问AI平台) with a pay-as-you-go API key, and diagnose the setup errors that follow. Use when adding or fixing a model provider in DSH's 设置 → 模型 page, when a Qwen/百炼/Qwen3/DeepSeek/Kimi request fails with "Workspace endpoint is invalid", "developer is not one of ['system', 'assistant', 'user', 'tool', 'function']", "The product is not activated", "Range of max_tokens should be [...]", 401/404 on "Fetch available models", or when asked which endpoint, API key or billing mode to use for 千问/百炼 models in DSH. 接入千问/百炼 API、DashScope、Qwen 快速接入与排错指南。
---

# DSH 接入阿里云百炼 / 千问AI平台

把 DSH 的「模型」设置页接到通义千问系模型上，并避开这条链路上已知的四个坑。

## 0. 先分清你在接哪一家

| 平台 | Key 页面 | 按量计费 Base URL | Key 前缀 |
| --- | --- | --- | --- |
| 阿里云百炼 | `bailian.console.aliyun.com/cn-beijing/model/settings/api-key` | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `sk-…` |
| 千问AI平台 | `platform.qianwenai.com/home/api-keys` | `https://maas.qianwenaiapi.com/compatible-mode/v1` | `sk-ws-…`（按量）/ `sk-sp-…`（Token Plan） |

两者都走 OpenAI Chat Completions 协议，`sk-ws-` 的通用 Key 在百炼的 `dashscope.aliyuncs.com` 域名下同样可用，反之不保证。**先看 Key 前缀，再选域名**，不要凭感觉混用。

## 1. 接入步骤

1. **拿 Key**：按上表创建。百炼的 Key **按地域独立**，不能跨地域混用；免费额度只有华北2（北京）地域有。
2. **DSH 图形界面**：`设置 → 模型 → 添加模型提供商 → 切换到「自定义模型 API」`，依次填
   - Provider ID：小写字母开头，如 `bailian` / `qianwen`（同时用于派生凭据名）
   - API 地址：见上表
   - API 协议：`OpenAI Chat Completions`
   - API 密钥：粘贴 Key（DSH 存进 `~/.dsh/.credentials.yaml`，不要写进 YAML）
   - 模型目录：`+ 添加模型`，手填模型 ID（见第 3 节）
3. **补 compat 开关（关键，GUI 里没有）**：见第 2 节。
4. **重启 DSH**，再在模型选择器里选中新模型。配置文件在启动时加载，不重启不生效。
5. **验证**：跑 `scripts/verify-provider.mjs` 或在 DSH 里发一条消息。

配置文件路径（GUI 的高级选项也在这个文件里）：

```
~/.dsh/profiles/<profile>/cordis.patch.yml     # profile ∈ desktop | web | headless
~/.dsh/.credentials.yaml                        # Key 存放处（不要手改）
```

## 2. 必补的 compat 开关

DSH 对**推理类模型**默认发 OpenAI 新规范的 `developer` 角色放系统提示词；百炼/千问只认 `system`，不补这个开关必然 400。

```yaml
- id: llm-pi-ai
  config:
    providers:
      bailian:
        displayName: Alibaba Cloud Model Studio
        apiKeyEnv: BAILIAN_API_KEY      # 引用凭据名，不写明文 Key
        api: openai-completions
        baseURL: https://maas.qianwenaiapi.com/compatible-mode/v1
        compat:
          supportsDeveloperRole: false   # 系统提示词改发 system 角色
          supportsReasoningEffort: false # 不发 reasoning_effort
          thinkingFormat: qwen            # 思考开关改用 enable_thinking
        models:
          - id: qwen3.8-flash
            name: qwen3.8-flash
            contextWindow: 1000000
            maxTokens: 131072             # 按模型真实上限填（见下表）
            input: [text, image]
            reasoningEfforts:
              off: null
              minimal: minimal
              low: low
              medium: medium
              high: high
```

`maxTokens` 是**单次请求能生成的最大 token 数**，按模型真实上限填，不要凭感觉写：

| 模型 | 文档「最大输出长度」 | 端点 `max_tokens` 校验区间 | 建议值 |
| --- | --- | --- | --- |
| qwen3.8-flash / qwen3.8-max / qwen3.7-plus | 131072 | [1, 131072] | **131072** |
| kimi-k3 | 1048576 | [1, 1048576] | **262144** |
| deepseek-v4.1-flash-1017 | — | 不设上限 | **384000** |

qwen3.8 系列的硬顶就是 128k，**拿不到 256k**；kimi-k3 与 deepseek 可以给到 256k 以上。设大不会多花钱（按实际输出计费），只会放宽单次生成长度。

> **字段细节**：DSH 对这个地址默认发 `max_completion_tokens`（`compat.maxTokensField` 的默认值）。端点**不校验**它的范围，但**照样按它截断输出**；若显式设 `maxTokensField: max_tokens`，端点会校验范围，超限直接 400。两者都会截断，而且**思考 token 也从这个额度里扣**——额度太小会出现「模型想了半天、一句话没说」的 `finish_reason: length`（实测 `max_completion_tokens=64` 时正文为空、64 token 全进了思考链）。

`compat` 可写在 **provider 级**或**model 级**（model 级优先）。DSH 的判定逻辑：

```js
const instructionRole = model.reasoning && compat?.supportsDeveloperRole !== false ? "developer" : "system";
```

常用字段：`supportsStore`、`supportsDeveloperRole`、`supportsReasoningEffort`、`maxTokensField`（`max_tokens` / `max_completion_tokens`）、`thinkingFormat`（`openai` / `qwen` / `deepseek` / `zai` …）、`supportsStrictMode`、`requiresReasoningContentOnAssistantMessages`、`supportsMidConvoSystemMessages`。

## 3. 已验证可用的模型 ID（千问AI平台 + 百炼，按量计费）

`qwen3.8-flash`、`qwen3.8-max`、`qwen3.7-plus`、`qwen3.7-max`、`deepseek-v4.1-flash-1017`、`deepseek-v4-pro-0813`、`kimi-k3`。

不要用带命名空间前缀的写法（如 `kimi/kimi-k3.1-pro`）——那是目录里的展示 ID，直接当 API model 传会报 "The product is not activated"。

## 4. 错误速查表

| 报错 | 根因 | 修法 |
| --- | --- | --- |
| `400 Workspace endpoint is invalid.` | API 地址里抄了文档占位符（`llm-xxx` / `{WorkspaceId}`），网关解析不出业务空间 | 用控制台 **API Host** 列的真实域名，或退回 `dashscope.aliyuncs.com` / `maas.qianwenaiapi.com` |
| `400 invalid_parameter_error: developer is not one of ['system','assistant','user','tool','function']` | DSH 发 `developer` 角色，端点只认 `system` | `compat.supportsDeveloperRole: false` |
| `400 The product is not activated` | 模型 ID 带前缀或该产品未开通 | 去掉 `kimi/` 之类前缀；或先在控制台开通该模型 |
| `400 Range of max_tokens should be [1, 131072]` | 设了 `maxTokensField: max_tokens` 且 `maxTokens` 超出模型上限 | 去掉 `maxTokensField`，或把 `maxTokens` 降到上限内 |
| 不报错，但回答被截断 / `finish_reason: length`、正文为空 | `maxTokens` 太小，额度被思考链吃光 | 按上表把 `maxTokens` 调到模型上限 |
| 「获取可用模型」返回 401 / 404 | OpenAI 兼容端点不提供 `GET /models` | 忽略该按钮，手填模型 ID |
| `MISSING_CREDENTIAL` | Key 未保存或环境变量未生效 | GUI 里重填并保存；或设 `apiKeyEnv` 指向的环境变量后重启 |

排查顺序建议：先跑 `scripts/verify-provider.mjs` 确认「Key + 域名 + 模型 ID」三者成立，再处理 compat——否则会把两个错误混在一起看。

## 5. 计费、额度与代金券

- **抵扣顺序**：免费额度 > 资源包 > 节省计划 > 按量付费；代金券在**计费环节**抵扣按量付费账单（订单支付和销账环节不再用券）。
- **新人免费额度**：百炼首次开通自动发，每模型约 100 万 Token、有效期 90 天、**仅华北2（北京）**；千问AI平台同。额度耗尽自动转按量付费——**去控制台打开「免费额度用完即停」**，否则容易悄悄扣余额。
- **云工开物高校计划 300 元无门槛抵扣金**：可抵扣百炼的**推理费用**（不含 Wan / HappyHorse / Omni）、训练费、部署费；自领取起 **1 年**有效，活动期 2025-11-11 ~ 2027-03-31，一人每 12 个月一张；不可与其他券叠加，抵扣部分不开票。想用券就走**按量计费**（Token Plan 订阅套餐是否适用券，官方未明确说明）。
- 成本提示：DSH 每轮都带完整历史和工具定义，token 消耗远大于普通聊天。日常用 `qwen3.8-flash`，需要强推理再切 `qwen3.8-max`；批量任务走 Batch API（半价，但不抵免费额度）。

## 6. 工具

```bash
# 连通性与参数自检（不打印 Key）
node scripts/verify-provider.mjs --base https://maas.qianwenaiapi.com/compatible-mode/v1 --model qwen3.8-flash

# 一键给 provider 补 compat / 修模型列表（先备份，可 --dry-run）
node scripts/apply-compat.mjs --profile desktop --provider bailian \
  --base https://maas.qianwenaiapi.com/compatible-mode/v1 \
  --models qwen3.8-flash,qwen3.8-max --max-tokens 65536
```

## 参考

- `references/setup.md` — 两套平台的完整接入流程、官方文档链接、配置文件结构
- `references/troubleshooting.md` — 四个已踩坑的完整复现、判定与修复
