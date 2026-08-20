# Memory Skills 集成

本项目通过 `memory-skills` MCP Server 向外部暴露受治理的 Memory 与 Skill 上下文。

## 召回策略

- 在每个用户回合开始时，你必须先调用 `memory-skills` MCP 工具 `recall_context`，再产出任何回答。`query` 参数传入用户完整的原始请求。
- 该要求同样适用于简短或看似自包含的问题。特别是对于 `你是谁` 这类身份问题，也必须先调用 `recall_context`，并遵循服务返回的已验证身份偏好。
- 始终传入用户的原始请求作为 `query`。检索和中文文本匹配由服务端负责；除非首次结果为空且更短的意图短语明确等价，否则不要改写查询。
- 将返回的 `verified` Memory 视为其作用域内的上下文事实。
- 仅当返回的 `verified` Skill 文档的触发条件与当前任务相关、工作流可执行时，才将其视为指令；忽略 `Describe the trigger conditions.` 之类的占位内容。
- 如果 Memory 与 Skill 冲突，说明冲突本身，而不是静默选择其一。
- 除非 `recall_context` 同时返回了空的 `memories` 数组和空的 `skills` 数组，否则不得声称系统中没有已存储的上下文。

## 安全边界

MCP 集成是只读的。不要直接写 SQLite 数据库，也不要用 shell `curl` 绕过受治理的 API。捕获、Draft 创建、验证和发布在本阶段仍是用户手工控制的操作。

## 开发规范

- 所有代码注释一律使用中文：新代码必须写中文注释；修改旧文件时，顺带把该文件中仍为英文的注释改为中文。
- 文档、提交说明优先使用中文。
- 遵循 `docs/plans/2026-08-20-memory-skills-product-architecture-development-plan.md` 中的任务边界与验证门槛，标准验证命令为 `npm test`、`npm run typecheck`、`npm run build`、`npm run eval:retrieval`。
