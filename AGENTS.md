# AGENTS.md

所有 Agent 宿主（Claude Code、Codex、OpenCode，以及后续评估中的 Pi 等）与编码代理共用的项目指南。

本项目是治理优先的长期上下文服务：Memory 与 Skill 资产经 Evidence 溯源和生命周期治理后，通过只读 MCP 工具与 HTTP API 交付给各宿主。各宿主只做启动配置（启动同一个 `dist/adapters/mcp/server.js` 与相同环境变量），不得复制检索、状态、权限和作用域判断；配置文件中一律不写 Access Key。

## 运行时调用策略（所有宿主相同）

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
- 已完成：Sprint 1（版本化上下文契约 + 离线评测基线）、Sprint 2（诊断与审计事件 + MCP 工具目录抽取）、Sprint 4（供应商无关 LLM Provider + OpenAI 兼容 Provider 与契约测试，见 `docs/model-providers.md`）、Sprint 5（Task 9 Evidence→Draft 提案流水线：人工触发 `POST /v1/proposals/{memory,skill}/run`，模型只产 Draft，Web 可对照证据原文审核）、Task 10 混合检索代码层（供应商无关 EmbeddingProvider + SQLite VectorIndex + 词法/向量确定性融合，`ContextService.recall` 已异步化；默认仍为 lexical，`MEMORY_SKILLS_RETRIEVAL=hybrid` 开启，向量同步走 `POST /v1/retrieval/sync`，见 `docs/retrieval.md`；离线评测已证明混合管线对词法零回归，真实模型的语义增益需 smoke 评测达标后才切默认）、SessionEnd 半自动捕获 hook（`scripts/session-end-capture.mjs`，只到 Evidence 层，审核闸门保留，挂载方式见 README）。
- 待做 Sprint 3：Task 5 多宿主接入（Claude/Codex/OpenCode 复用同一 MCP 构建产物，`.codex/config.toml.example`、`opencode.json.example`、smoke 脚本为本任务交付物）；Task 6 Pi 能力探测与适配决策。
- 混合检索后续：用真实 Embedding 模型跑 smoke 评测，对比语义改写用例（`evals/fixtures` 的 zh-057~059 / en-023，词法零命中）的召回增益；指标显著提升且禁止命中不退化后才把默认切到 hybrid。之后按评测结果决定 Task 11/12（Rewrite/Reranker、显式反馈），不按时间强行引入。
- 每个阶段以契约测试和离线评测为发布门槛；先评测，后换算法。

## 开发规范

- 所有代码注释一律使用中文：新代码必须写中文注释；修改旧文件时，顺带把该文件中仍为英文的注释改为中文。
- 文档、提交说明优先使用中文。
- 标准验证命令：`npm test`、`npm run typecheck`、`npm run build`、`npm run eval:retrieval`；检索相关改动不得使评测指标退化。
- 涉及真实模型或真实 Agent 宿主的命令一律用 `smoke:*` 前缀，且需显式环境变量开启，避免意外产生费用。
- 遵守开发计划中的文件边界与"近期明确不做"清单：不让模型直接创建 Verified 资产、不提前拆微服务、不为每个宿主复制 MCP Server、不把访问密钥写入项目配置或数据库明文。
