# MCP 工具契约

> 适用版本：v0.2 起。本文描述 `memory-skills` MCP Server 的单一工具目录、策略边界与宿主接入规则。

## 单一目录原则

工具名、输入 Schema、输出 Schema、只读标记和说明统一定义在 `src/adapters/mcp/tool-catalog.ts`，策略与 Server instructions 统一定义在 `src/adapters/mcp/tool-policy.ts`。

- stdio 启动入口（`src/adapters/mcp/server.ts`）与未来的远程 Streamable HTTP 入口必须共用同一份目录，不得出现第二套工具行为。
- 宿主（Claude Code、Codex、OpenCode、Pi 等）只做启动配置与轻量调用策略，不得复制作用域、状态或权限判断。

## 工具目录（四个，全部只读）

| 工具 | 用途 | 推荐度 |
| --- | --- | --- |
| `recall_context` | 一次性取回相关的 Verified Memory 与 Skill（统一上下文契约） | 默认推荐，常规查询只调用它 |
| `recall_memory` | 只取回 Memory 资产 | 备用 |
| `search_skills` | 按触发条件、名称、描述、正文搜索 Skill | 备用 |
| `get_skill` | 按 ID 加载单个 Verified Skill 全文 | 发现后按需调用 |

所有工具都带 `readOnlyHint: true`、`destructiveHint: false`、`idempotentHint: true`、`openWorldHint: false` 注解，且都声明输出 Schema：`structuredContent` 必须匹配对应 Schema（loose 模式，允许服务端向后兼容地新增字段）。

## 策略边界（服务端强制，调用方不可覆盖）

1. **作用域绑定**：作用域由服务端环境变量（`MEMORY_SKILLS_USER_ID` / `MEMORY_SKILLS_TEAM_ID` / `MEMORY_SKILLS_AGENT_ID` / 可选 `MEMORY_SKILLS_SESSION_ID`）在启动时解析。工具输入 Schema 不接受任何作用域字段；即使调用方混入 `userId`、`teamId`、`scope` 等字段，也会被剥离，实际生效的永远是服务端绑定值。
2. **状态策略**：只有 `verified` 状态的资产对 Agent 暴露。`recall_context`、`recall_memory`、`search_skills` 不返回 Draft 资产；`get_skill` 对非 Verified Skill 直接报错。
3. **只读**：所有工具均为只读查询，不存在写入、状态变更或删除能力。捕获与审核走 HTTP API，由用户手工控制。
4. **预算**：`recall_context` 的结果条数与字符预算可由调用方在 Schema 上限内调整（条数 ≤ 20，字符 ≤ 50 000），但不影响作用域与状态过滤。

## Server instructions 约定

`mcpServerInstructions()` 生成的指令文本前 512 字符必须写清三件事，回归测试锁定该约束：

1. 调用时机：每个用户回合开始、产出回答前先调用 `recall_context`；
2. 作用域绑定：服务端环境变量绑定，输入无法覆盖；
3. Draft 不可用：只返回 Verified 资产。

## 输入 Schema 摘要

- `recall_context`：`query`（必填，trim 后非空）、`maxMemoryResults?`、`maxMemoryChars?`、`maxSkillResults?`、`maxSkillChars?`。
- `recall_memory`：`query`（必填）、`maxResults?`、`maxTotalChars?`。
- `search_skills`：`query`（必填）。
- `get_skill`：`id`（必填）。

未知字段会被剥离而不是报错；空查询、超上限预算字段会被 Schema 拒绝并以工具错误返回。

## 输出契约

`recall_context` 返回版本化上下文契约（`contractVersion`、`requestId`、`memories`、`skills`、`budget`、`truncated`、`warnings`），与 `POST /v1/context/recall` 使用同一 Schema；文本块仅为兼容展示，宿主应优先读取 `structuredContent`。

## 回归测试

- `tests/mcp-tool-catalog.test.ts`：目录完整性、两次构建定义一致（所有宿主拿到相同 Schema）、指令前 512 字符规则、作用域不可覆盖、Draft 拒绝、输入校验。
- `tests/mcp-server.test.ts`：真实 stdio 链路下的工具列表、只读注解、召回契约与错误行为。
