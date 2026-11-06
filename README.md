# dsh-qwen-provider

把 **DeepSeek Harness（DSH）** 接到 **阿里云百炼 / 千问AI平台** 的按量计费 API 上，并把这条链路上真实踩过的坑固化成可复用的 skill。

> 这不是"调 API 的 SDK 封装"，而是**接入指南 + 排错手册**：DSH 的模型设置页能填的东西有限，真正的成败往往取决于四个 GUI 里看不见的细节。

## 为什么需要它

DSH 的「设置 → 模型 → 自定义模型 API」表单填完就能用？**不能**。至少还要补一个 GUI 不提供的 compat 开关，否则推理模型**必然 400**。本仓库把这套接入流程、以及四个已验证的错误 → 根因 → 修法，整理成 agent 可直接执行的 skill。

### 四个已验证的坑

| 报错 | 根因 | 修法 |
| --- | --- | --- |
| `400 Workspace endpoint is invalid.` | API 地址抄了文档占位符（`llm-xxx` / `{WorkspaceId}`） | 用控制台 **API Host** 的真实域名，或退回 `dashscope.aliyuncs.com` / `maas.qianwenaiapi.com` |
| `400 developer is not one of ['system','assistant','user','tool','function']` | DSH 对推理模型发 `developer` 角色，端点只认 `system` | `compat.supportsDeveloperRole: false` |
| `400 The product is not activated` | 模型 ID 用了带前缀的目录展示 ID（`kimi/kimi-k3.1-pro`） | 去掉前缀，用 `kimi-k3` |
| `400 Range of max_tokens should be [1, 131072]` | 设了 `maxTokensField: max_tokens` 且 `maxTokens` 超出模型上限 | 去掉 `maxTokensField`，或把 `maxTokens` 降到上限内 |
| 不报错但回答被截断 / `finish_reason: length`、正文为空 | `maxTokens` 太小，额度被思考链吃光 | 按模型上限填（见下表） |

## 目录结构

```
.
├── SKILL.md                     # skill 主体：接入步骤、compat、错误速查表、计费要点
├── references/
│   ├── setup.md                 # 两套平台的完整接入流程 + 官方文档链接
│   └── troubleshooting.md       # 四个坑的完整复现、判定与修复
└── scripts/
    ├── verify-provider.mjs      # 连通性与协议体检（不打印 Key）
    └── apply-compat.mjs         # 一键补 compat / 修模型列表（自动备份、幂等）
```

## 快速开始

### 1. 接入（GUI + 一处手改）

1. 取 Key：百炼 `bailian.console.aliyun.com` 或 千问AI平台 `platform.qianwenai.com`（看 Key 前缀：`sk-ws-` 是千问AI平台按量计费）。
2. `设置 → 模型 → 添加模型提供商 → 自定义模型 API`，填 Provider ID / API 地址 / 协议 / Key / 模型 ID。
   - 「获取可用模型」按钮在这两个平台上都会 401/404（端点不提供 `GET /models`），**手动填模型 ID**。
3. 在 `~/.dsh/profiles/<profile>/cordis.patch.yml` 的 provider 块补：

```yaml
        compat:
          supportsDeveloperRole: false
          supportsReasoningEffort: false
          thinkingFormat: qwen
```

4. **重启 DSH**（配置在启动时加载），新建对话选择模型。

### 2. 或者让脚本代劳

```bash
# 体检：Key × 域名 × 模型 是否成立，并探测协议差异
node scripts/verify-provider.mjs --env BAILIAN_API_KEY \
  --base https://maas.qianwenaiapi.com/compatible-mode/v1 --model qwen3.8-flash

# 一键打补丁（先备份、幂等、可 --dry-run）
node scripts/apply-compat.mjs --provider bailian \
  --base https://maas.qianwenaiapi.com/compatible-mode/v1 \
  --models qwen3.8-flash,qwen3.8-max --max-tokens 65536 --dry-run
```

`verify-provider.mjs` 的典型输出：

```
Key: sk-ws-H.…(len=116)  来源: ~/.dsh/.credentials.yaml (BAILIAN_API_KEY)

✅ https://maas.qianwenaiapi.com/compatible-mode/v1
   qwen3.8-flash → HTTP 200 (2051ms)

--- 协议体检 ---
⚠️ developer 角色: HTTP 400 → 被拒，必须加 compat.supportsDeveloperRole: false
⚠️  max_tokens 上限: 131072 → 模型条目的 maxTokens 请设 ≤ 65536
✅ enable_thinking: HTTP 200
✅ 工具调用: HTTP 200
```

## 各模型的 `maxTokens` 上限（实测）

| 模型 | 文档「最大输出长度」 | 端点 `max_tokens` 校验区间 | 建议 `maxTokens` |
| --- | --- | --- | --- |
| qwen3.8-flash / qwen3.8-max / qwen3.7-plus | 131072 | [1, 131072] | **131072**（硬顶，给不到 256k） |
| kimi-k3 | 1048576 | [1, 1048576] | **262144** |
| deepseek-v4.1-flash-1017 | — | 不设上限 | **384000** |

`maxTokens` 是**单次请求能生成的最大 token 数**，思考链与正文共用这个额度——设小了会出现"模型想了半天、一句话没说"。DSH 默认发 `max_completion_tokens`（端点不校验范围，但会照此截断）；显式设 `maxTokensField: max_tokens` 时端点会校验范围，超限直接 400。

## 在 DSH 里安装本 skill

复制到任一技能目录即可被发现：

- `~/.dsh/skills/dsh-qwen-provider/SKILL.md`（全局）
- `<项目>/.dsh/skills/dsh-qwen-provider/SKILL.md`（项目级）
- `~/.agents/skills/dsh-qwen-provider/SKILL.md`

## 计费提醒

- 抵扣顺序：**免费额度 > 资源包 > 节省计划 > 按量付费**；代金券在**计费环节**抵扣按量付费账单。
- 新人免费额度：每模型约 100 万 Token、有效期 90 天，百炼**仅华北2（北京）**地域。**记得打开「免费额度用完即停」**，否则额度耗尽会自动开始扣余额。
- 「云工开物」高校计划 300 元无门槛抵扣金可抵扣百炼推理费用（不含 Wan / HappyHorse / Omni），自领取起 1 年有效；走按量计费最稳。
- DSH 每轮都带完整历史与工具定义，token 消耗远大于普通聊天；日常用 `qwen3.8-flash`。

## 已验证结论来源

所有报错原文与兼容性结论来自对真实 Key 的实测（`maas.qianwenaiapi.com` 与 `dashscope.aliyuncs.com` 两个域名、四个模型、两种 thinking 开关、完整 DSH 请求形态）。官方文档链接见 [references/setup.md](references/setup.md)。

## License

MIT
