# CLAUDE.md

Claude Code 项目说明。本仓库既开发 memory-skills 服务，也通过项目级 `.mcp.json` 接入了只读的 `memory-skills` MCP Server（启动 `dist/adapters/mcp/server.js`，密钥与作用域来自环境变量）。跨宿主的通用指南见 `AGENTS.md`，两份文件的核心策略保持一致。

## 运行时调用策略

- 每个用户回合开始、产出任何回答之前，先调用 `memory-skills` 的 `recall_context`，`query` 传入用户完整原始请求；简短或看似自包含的问题（包括 `你是谁` 这类身份问题）也不例外。
- 检索与中文匹配由服务端负责；除非首次结果为空且更短的意图短语明确等价，否则不改写查询。
- 常规上下文查询只使用 `recall_context`；`recall_memory`、`search_skills`、`get_skill` 是补充能力，且 `get_skill` 只会返回 Verified Skill。
- 作用域由服务端环境变量绑定，调用方无法覆盖；Draft 资产永不对 Agent 暴露，返回的只有 Verified 资产。
- 返回的 `verified` Memory 视为其作用域内的上下文事实；`verified` Skill 仅当触发条件与当前任务相关且工作流可执行时才作为指令，忽略 `Describe the trigger conditions.` 之类的占位内容。
- Memory 与 Skill 冲突时说明冲突本身，不静默二选一。
- 只有 `recall_context` 同时返回空 `memories` 和空 `skills` 时，才可以说系统中没有已存储的上下文。

## 安全与治理边界（长期有效，不随里程碑变化）

- Agent 侧永远只读。捕获、提案、Verify/Reject、发布走需 Access Key 授权的 HTTP API，由用户显式触发。
- 模型只能提案：LLM 生成的内容只能进入 Draft，即使模型输出要求发布，也不能直接产生 Verified 资产。后续 LLM Provider 与提案流水线（Sprint 4/5）同样遵守。
- 不直接写 SQLite，不用 shell `curl` 绕过受治理 API。
- Access Key 与模型密钥只存在于环境变量（`.env`，不入库），不进配置文件、代码、日志、事件和数据库明文。
- 默认最小暴露：只返回当前 Scope、Verified、预算内的资产。

## 开发路线与当前状态

- 完整路线图与任务定义见 `docs/plans/2026-08-20-memory-skills-product-architecture-development-plan.md`，MCP 契约见 `docs/integrations/mcp-contract.md`。
- 已完成：Sprint 1（版本化上下文契约 + 离线评测基线）、Sprint 2（诊断与审计事件 + MCP 工具目录抽取）、Sprint 4（供应商无关 LLM Provider + OpenAI 兼容 Provider 与契约测试，见 `docs/model-providers.md`）、Sprint 5（Task 9 Evidence→Draft 提案流水线：人工触发 `POST /v1/proposals/{memory,skill}/run`，模型只产 Draft，Web 可对照证据原文审核）。
- 待做 Sprint 3：Task 5 多宿主接入（Claude/Codex/OpenCode 复用同一 MCP 构建产物与 `.mcp.json`、smoke 脚本）；Task 6 Pi 能力探测与适配决策。
- 之后按评测结果决定是否进入混合检索（Task 10-12），而不是按时间强行引入。
- 每个阶段以契约测试和离线评测为发布门槛；先评测，后换算法。

## 开发规范

- 所有代码注释一律使用中文：新代码必须写中文注释；修改旧文件时，顺带把该文件中仍为英文的注释改为中文。
- 文档、提交说明优先使用中文。
- 标准验证命令：`npm test`、`npm run typecheck`、`npm run build`、`npm run eval:retrieval`；检索相关改动不得使评测指标退化。
- 涉及真实模型或真实 Agent 宿主的命令一律用 `smoke:*` 前缀，且需显式环境变量开启，避免意外产生费用。
- 遵守开发计划中的文件边界与"近期明确不做"清单：不让模型直接创建 Verified 资产、不提前拆微服务、不为每个宿主复制 MCP Server、不把访问密钥写入项目配置或数据库明文。
