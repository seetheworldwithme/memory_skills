# 模型 Provider（LLM Provider）

本文档描述 Sprint 4（Task 7 + Task 8）建立的供应商无关模型调用层：接口定义、配置方式、密钥边界、错误与重试语义，以及如何接入第二家模型供应商。

治理边界（长期有效）：

- Provider 只负责生成候选内容，**模型只能提案**：LLM 输出进入 Draft，由治理流程决定是否 Verified（Sprint 5 的提案流水线继续遵守）。
- Provider 不持有 Repository、GovernanceService 等任何领域引用；领域服务只依赖 `LlmProvider` 接口与注册表，**不 import 厂商 SDK**。
- 默认**不保存完整 Prompt/Response 正文**：指标在结构上只有计数与数字字段。

## 模块结构

| 文件 | 职责 |
| --- | --- |
| `src/llm/types.ts` | 供应商无关的请求、响应、用量与 Provider 接口 |
| `src/llm/provider.ts` | 超时/重试韧性装饰器、指标收集器、HTTP 状态到错误分类的统一映射 |
| `src/llm/mock-provider.ts` | 可脚本化的确定性 Mock Provider（测试与离线评测） |
| `src/llm/model-config.ts` | `LlmProviderConfig` 与环境变量解析（只含密钥变量名） |
| `src/llm/provider-registry.ts` | 按配置创建 Provider 的注册表，支持自定义工厂注册 |
| `src/llm/providers/openai-provider.ts` | 第一个真实 Provider：OpenAI Chat Completions 兼容协议 |

## 核心接口

```ts
// 输入：只包含任务、允许给模型看的内容与输出结构
interface LlmStructuredRequest<T> {
  task: string;          // 任务标识（指标统计用，不发给模型）
  systemPrompt: string;  // 任务指令（未来的 Prompt Registry 提供）
  userContent: string;   // 已筛选、裁剪、脱敏的内容（如 Evidence 文本）
  schemaName: string;    // 输出结构名
  schema: ZodType<T>;    // 输出结构校验
  temperature?: number;
  maxOutputTokens?: number;
  signal?: AbortSignal;  // 外部取消
}

// 输出：统一为项目内部类型，供应商响应类型不外泄
interface LlmStructuredResponse<T> {
  data: T;               // 已通过 Schema 校验
  model: string;
  usage: LlmUsage;       // inputTokens / outputTokens / totalTokens / costUsd?
  finishReason?: "stop" | "length" | "content_filter" | "other";
  attempts: number;      // 含重试的总尝试次数
  latencyMs: number;
}

interface LlmProvider {
  readonly name: string;
  structured<T>(request: LlmStructuredRequest<T>): Promise<LlmStructuredResponse<T>>;
}
```

## 错误分类与重试

所有 Provider 复用同一映射，错误经 `LlmProviderError`（`src/errors.ts`）抛出，携带稳定的 `kind`、`code` 与 `retryable`：

| kind | code | 默认可重试 | 含义 |
| --- | --- | --- | --- |
| `timeout` | `LLM_TIMEOUT` | 是 | 单次尝试超过 `timeoutMs` |
| `canceled` | `LLM_CANCELED` | 否 | 调用方主动取消 |
| `rate_limited` | `LLM_RATE_LIMITED` | 是 | 供应商限流（HTTP 429） |
| `invalid_response` | `LLM_INVALID_RESPONSE` | 否 | 非法 JSON、未通过 Schema 校验、其他 4xx |
| `network` | `LLM_NETWORK_ERROR` | 是 | 网络层失败 |
| `server_error` | `LLM_SERVER_ERROR` | 是 | 供应商 5xx / 408 |
| `auth` | `LLM_AUTH_ERROR` | 否 | 鉴权失败（HTTP 401/403 或密钥缺失） |
| `config` | `LLM_CONFIG_ERROR` | 否 | 本地配置错误 |
| `unknown` | `LLM_UNEXPECTED` | 否 | 未分类异常（保守不重试） |

韧性装饰器（`withLlmResilience`）语义：

- 每次尝试注入内部 `AbortController`，外部取消与超时计时器都汇入它；外部已取消 → `canceled`，内部信号中止但外部未取消 → `timeout`。
- 只有可重试错误按指数退避重试（`baseDelayMs * 2^(attempt-1)`，上限 `maxDelayMs`），优先尊重供应商的 `Retry-After`。
- 错误消息保持稳定模板，不拼接模型响应正文或密钥，防止敏感数据进入日志。

## 配置与环境变量

配置对象 `LlmProviderConfig` 含 `provider / model / baseUrl / timeoutMs / maxRetries / responseMode / temperature / maxOutputTokens / costPerMillionTokens`。**密钥只在环境变量中**：配置里只有密钥变量名 `apiKeyEnv`，Registry 创建 Provider 时才从环境读取，密钥不进入任何返回值、日志、指标或数据库明文。

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `MEMORY_SKILLS_LLM_PROVIDER` | `mock` | `mock` / `openai` / 自定义注册名 |
| `MEMORY_SKILLS_LLM_MODEL` | `mock-model`（仅 mock） | 模型名，非 mock 必填 |
| `MEMORY_SKILLS_LLM_BASE_URL` | `https://api.openai.com/v1` | 兼容端点地址 |
| `MEMORY_SKILLS_LLM_TIMEOUT_MS` | `120000` | 单次尝试超时（全量捕获后大证据提案常见超 30s） |
| `MEMORY_SKILLS_LLM_MAX_RETRIES` | `2` | 额外重试次数 |
| `MEMORY_SKILLS_LLM_RESPONSE_MODE` | `json_object` | `json_object` / `json_schema` |
| `MEMORY_SKILLS_LLM_API_KEY_ENV` | `OPENAI_API_KEY`（openai） | 密钥所在环境变量名 |
| `MEMORY_SKILLS_LLM_TEMPERATURE` | `0` | 采样温度 |
| `MEMORY_SKILLS_LLM_MAX_OUTPUT_TOKENS` | 不设 | 输出 Token 上限 |
| `MEMORY_SKILLS_LLM_COST_INPUT_PER_MTOK` / `_OUTPUT_PER_MTOK` | 不设 | 每百万 Token 单价（美元），用于成本指标 |

`describeLlmConfig(config)` 返回不含密钥的安全描述，可放心写入日志。

## Mock Provider

`MockLlmProvider` 通过行为步骤脚本化（`ok` / `http-error` / `invalid-json` / `schema-mismatch` / `network-error`，均支持 `latencyMs`），错误走与真实 Provider 完全相同的映射。它是默认 Provider，也是单元测试与离线评测的确定性基础；Sprint 5 的提案流水线将复用它保证"给定固定 Evidence 结果完全可复现"。

## OpenAI 兼容 Provider（第一个真实 Provider）

`OpenAiCompatibleProvider` 走 `POST {baseUrl}/chat/completions`，只用 Node 全局 `fetch`，不依赖厂商 SDK。`baseUrl` 可指向任何 OpenAI 兼容服务（例如智谱 `https://open.bigmodel.cn/api/paas/v4`、DeepSeek `https://api.deepseek.com/v1` 等）。

结构化输出两种模式：

- `json_object`（默认）：`response_format: { type: "json_object" }`，JSON Schema 写入系统指令，客户端用 Zod 校验兜底。最大兼容，任何兼容端点可用。
- `json_schema`：`response_format: { type: "json_schema", ... }`，走官方结构化输出，Schema 随请求传递。仅建议在确认端点支持时启用。

## 指标与隐私

`InMemoryLlmMetricsRecorder` 记录每次尝试的 Provider、模型、任务、成败、错误分类、尝试序号、延迟与用量（Token、可选成本），并可汇总出 `calls / failures / retries / tokens / costUsd / p50 / p95`。`LlmCallMetric` 在类型上不存在正文字段——"默认不保存 Prompt/Response 正文"由结构保证，并有测试断言序列化结果不含正文标记与密钥。

## 真实模型冒烟（显式开启，防误费）

```bash
# 1. 在 .env 或环境中配置（示例指向 OpenAI 兼容端点）
MEMORY_SKILLS_LLM_PROVIDER=openai
MEMORY_SKILLS_LLM_MODEL=gpt-4o-mini
MEMORY_SKILLS_LLM_API_KEY_ENV=MY_MODEL_KEY
export MY_MODEL_KEY=sk-...

# 2. 显式开启冒烟
MEMORY_SKILLS_SMOKE=1 npm run smoke:model-provider
```

脚本会发起一次小的偏好提取任务，打印结构化结果、用量、尝试次数与指标摘要；未设置 `MEMORY_SKILLS_SMOKE=1` 时直接退出，不产生任何费用。默认测试全部基于 Mock / 假 fetch，不访问真实 API。

## 接入第二家模型 Provider

1. 新建 `src/llm/providers/<name>-provider.ts`，实现 `LlmProvider`（只用内部类型；错误经 `llmErrorForHttpStatus` 等统一映射；不持有领域引用）。
2. 在 `provider-registry.ts` 注册工厂（或在应用层用 `registerLlmProviderFactory` 注册）。
3. 复用 `tests/llm-provider-contract.test.ts` 导出的 `defineLlmProviderContractTests`，提供一个把行为步骤翻译成该厂商响应的工厂，套件会验证成功语义、错误映射、超时、取消、重试与密钥边界——这正是"接口存在但实际上绑定首家厂商"的回归防线。
