# 完整接入流程

## A. 阿里云百炼（Alibaba Cloud Model Studio）

### 1. 创建 API Key

- 控制台：<https://bailian.console.aliyun.com/cn-beijing/model/settings/api-key>
- **右上角先选地域**：每个地域有独立的接入域名、API Key 和模型列表，**不能跨地域混用**。
- 创建时可设置：归属账号（主账号 / RAM 用户）、归属业务空间、权限（全部 / 自定义 IP 白名单与模型范围）。
- Key **永久有效**，只显示一次；删除后异步任务仍会跑完（可能继续产生账单）。
- 限制：账号+地域维度最多 50 个 Key；临时 Key 最长 1800 秒。

### 2. 选接入域名

| 用途 | 华北2（北京） |
| --- | --- |
| 业务空间专属（推荐） | `https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1` |
| DashScope 存量域名 | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| 试用域名 | `https://trial.cn-beijing.maas.aliyuncs.com/compatible-mode/v1` |

`{WorkspaceId}` 的真实值：**创建 Key 后的弹窗里有一行 `API Host`**，或在[业务空间管理](https://bailian.console.aliyun.com/cn-beijing/settings/workspace)的 `API Host` 列复制，形如 `llm-xxxx.cn-beijing.maas.aliyuncs.com`。

> ⚠️ 文档示例里的 `llm-xxx`、`{WorkspaceId}` 是**占位符**。原样抄进去会得到 `400 Workspace endpoint is invalid.`。

其他地域域名见 [Base URL 总览](https://help.aliyun.com/zh/model-studio/base-url)：
新加坡 `dashscope-intl.aliyuncs.com`、中国香港 `cn-hongkong.dashscope.aliyuncs.com`、美国 `dashscope-us.aliyuncs.com`；
法兰克福 / 东京 / 弗吉尼亚**只有**业务空间专属域名。

### 3. 计费方案与对应域名

| 方案 | Base URL | Key 来源 |
| --- | --- | --- |
| 按量计费 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | 百炼 API Key |
| Token Plan | `https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1` | Token Plan 专属 Key |
| Coding Plan | `https://coding.dashscope.aliyuncs.com/v1` | Coding Plan Key |

按量计费接法在购买**节省计划 / 资源包**后无需改动，调用费用按抵扣顺序自动抵扣。

## B. 千问AI平台（platform.qianwenai.com）

### 1. 创建 API Key

- 控制台：<https://platform.qianwenai.com/home/api-keys> → `创建 API Key` → 填描述 → `生成 API Key`。
- **完整 Key 只在创建时显示一次**，之后列表里只有掩码。
- Key 前缀决定计费方式：

| 前缀 | 含义 |
| --- | --- |
| `sk-ws-…` | 通用 Key，**按 API 调用量计费**（早期创建的为 `sk-…`） |
| `sk-sp-…` | Token Plan 专属 Key，绑定订阅套餐，按 Credits 计费 |

### 2. 域名

| 方案 | Base URL |
| --- | --- |
| 按量计费 | `https://maas.qianwenaiapi.com/compatible-mode/v1` |
| Token Plan | `https://token-plan.maas.qianwenaiapi.com/compatible-mode/v1` |

平台同时提供 OpenAI 兼容与 Anthropic 兼容两套协议，`base_url` 不同，别混用。

### 3. 账号准备

- **实名认证**是前提：未认证不给免费额度，额度耗尽后也无法继续按量付费。
- 开通即自动发放新人免费额度：每个模型通常 100 万 Token，有效期从**账号开通之日**起算 90 天。
- 权益页：<https://platform.qianwenai.com/home/benefits>（模型调用额度 / Agent 开发额度 / **优惠券** 三个页签）。

## C. DSH 侧的两种配置方式

### 方式 1：图形界面（推荐）

`设置 → 模型 → 添加模型提供商`

- 两种添加方式：**第三方模型提供商**（内置目录，OpenAI/Anthropic/Kimi 等，填 Key 即可）与**自定义模型 API**（中转站、自部署、其他兼容 OpenAI/Anthropic 协议的接口，需填 API 地址、协议和模型）。
- 自定义模式的字段：Provider ID、显示名称、API 地址、API 协议、API 密钥、模型目录。
- 模型目录里可配：模型 ID、显示名称、上下文窗口、最大输出 token 数、输入类型（文本/图片）、推理等级（档位 + API 参数值）。
- **「获取可用模型」按钮在这两个平台上都会 401/404**（OpenAI 兼容端点不提供 `GET /models`），忽略它，手填模型 ID。
- GUI 表单**不暴露 `compat` 开关**，需要它时在 `cordis.patch.yml` 里补（界面提示「其余字段在 cordis.patch.yml 中，请直接编辑对应段」）。

### 方式 2：配置文件

路径：`~/.dsh/profiles/<profile>/cordis.patch.yml`，profile 取 `desktop` / `web` / `headless`（按你启动方式选；桌面端是 `desktop`）。

```yaml
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      bailian:
        displayName: Alibaba Cloud Model Studio
        apiKeyEnv: BAILIAN_API_KEY
        api: openai-completions
        baseURL: https://maas.qianwenaiapi.com/compatible-mode/v1
        compat:
          supportsDeveloperRole: false
          supportsReasoningEffort: false
          thinkingFormat: qwen
        models:
          - id: qwen3.8-flash
            name: qwen3.8-flash
            contextWindow: 1000000
            maxTokens: 131072
            input: [text, image]
            reasoningEfforts:
              off: null
              minimal: minimal
              low: low
              medium: medium
              high: high
```

`maxTokens` 按模型真实上限填，别一律用同一个保守值：

| 模型 | 建议 `maxTokens` |
| --- | --- |
| qwen3.8-flash / qwen3.8-max / qwen3.7-plus | 131072（硬顶，给不到 256k） |
| kimi-k3 | 262144（端点最高接受 1048576） |
| deepseek-v4.1-flash-1017 | 384000（端点不设上限） |

DSH 对这类地址默认发 `max_completion_tokens`（端点不校验范围但照样按它截断）；**思考 token 与正文共用这个额度**，值太小会出现"想半天没输出"。

顶层还有一段决定默认模型：

```yaml
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: bailian
    model: qwen3.8-flash
    reasoningEffort: off
```

### 凭据存放

- GUI 输入的 Key 写进 `~/.dsh/.credentials.yaml` 的 `refs:`，provider 用 `apiKeyEnv` 引用**凭据名**。
- 也可以走环境变量后备：启动环境 → `$cwd/.env` → `$DSH_HOME/.env`（GUI 会显示「已检测到环境变量」）。
- **不要把明文 Key 写进 YAML 或提交进仓库。**

### 生效方式

配置在**启动时**加载。改完 `cordis.patch.yml` 必须重启 DSH；改了 GUI 里新增的 provider 之后，如果模型选择器里看不到，也重启一次。

## D. 官方文档

- 百炼 · 获取与配置 API Key：<https://help.aliyun.com/zh/model-studio/get-api-key>
- 百炼 · Base URL 总览：<https://help.aliyun.com/zh/model-studio/base-url>
- 百炼 · 地域与接入域名：<https://help.aliyun.com/zh/model-studio/regions>
- 百炼 · DeepSeek Harness 接入：<https://help.aliyun.com/zh/model-studio/deepseek-harness>
- 百炼 · 新人免费额度：<https://help.aliyun.com/zh/model-studio/new-free-quota>
- 千问AI平台 · 获取 API Key：<https://platform.qianwenai.com/docs/api-reference/preparation/api-key.md>
- 千问AI平台 · DeepSeek Harness 接入：<https://platform.qianwenai.com/docs/developer-guides/clients-and-developer-tools/deepseek-harness.md>
- 千问AI平台 · 计费说明：<https://platform.qianwenai.com/docs/developer-guides/getting-started/pricing.md>
- 千问AI平台 · 免费额度：<https://platform.qianwenai.com/docs/resources/free-quota.md>
- 阿里云 · 代金券管理：<https://help.aliyun.com/zh/user-center/voucher-management>
- 「云工开物」高校计划（300 元抵扣金）：<https://help.aliyun.com/zh/model-studio/introduction-to-yungongkaiwu>
