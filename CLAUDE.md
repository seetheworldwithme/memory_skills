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
- 已完成：Sprint 1（版本化上下文契约 + 离线评测基线）、Sprint 2（诊断与审计事件 + MCP 工具目录抽取）、Sprint 4（供应商无关 LLM Provider + OpenAI 兼容 Provider 与契约测试，见 `docs/model-providers.md`）、Sprint 5（Task 9 Evidence→Draft 提案流水线：人工触发 `POST /v1/proposals/{memory,skill}/run`，模型只产 Draft，Web 可对照证据原文审核）、Task 10 混合检索（供应商无关 EmbeddingProvider + SQLite VectorIndex + 词法/向量确定性融合，`ContextService.recall` 已异步化；`MEMORY_SKILLS_RETRIEVAL=hybrid` 开启；真实模型 smoke 评测达标后已在 8421 投产 hybrid：text-embedding-3-large + minCos 0.5，见 `docs/retrieval.md`）、SessionEnd 半自动捕获 hook（`scripts/session-end-capture.mjs`，只到 Evidence 层，审核闸门保留，挂载方式见 README）、Task 12 显式反馈（`POST /v1/feedback` 与 `/v1/feedback/list`：有用/无关/错误/过期四类，关联召回 requestId 与资产版本；只用于评测与治理建议，不自动改写资产；Web 资产详情页有反馈条）、治理状态转换后自动向量同步（Verify/Reject/归档成功后自动增量同步该资产作用域，hybrid 下新 Verify 资产即时进入向量通道；失败只记 `retrieval.auto_sync.failed` 事件不影响治理操作，手动 `POST /v1/retrieval/sync` 保留用于初始化与补救）。
- Sprint 3 已完成（2026-08-21）：Task 5 多宿主接入——Claude Code（项目 `.mcp.json`，`${VAR}` 引用密钥）、Codex（用户级 `~/.codex/config.toml` + `node --env-file` 从 `.env` 取密钥，0.39.0 实测不向 MCP 子进程继承宿主环境）、OpenCode（项目 `opencode.json`，密钥靠进程环境继承）三者复用同一构建产物 `dist/adapters/mcp/server.js`；接入文档见 `docs/integrations/`；验收工具 `npm run smoke:agent-host`（dry 零费用 9 项全过；live 层 `MEMORY_SKILLS_SMOKE=1 --live` 打真实宿主 CLI，断言服务端 `context.recall.completed` 事件与答案关键词）。live 实测：Codex 真实召回通过；OpenCode 的 MCP 加载实测 connected，真实模型召回因本机默认模型 provider 不可用（`provider-auth-big/glm-5`）待宿主模型修复后补跑 `MEMORY_SKILLS_SMOKE=1 SMOKE_OPENCODE_MODEL=<provider/model> npm run smoke:agent-host -- --live --host opencode`；Claude Code 本机未装 CLI bin 链接（npm 包在），同命令 `--host claude-code` 可补验。Task 6 Pi 探测与决策——结论"暂不接入"（Pi 官方 No MCP 是刻意设计；装机后优先评估扩展注入而非 MCP 桥接），见 `docs/spikes/pi-integration-decision.md`，探测脚本 `npm run detect:pi`。
- 混合检索现状：真实模型 smoke 评测达标并已在 8421 投产（large + minCos 0.5，语义改写用例 zh-057~059 全中、禁止命中零退化）。Task 11（可选 Query Rewrite / Reranker）仍按评测结果决定是否引入，不按时间强行引入；换任何新 Embedding 模型先重跑 smoke 扫描再调阈值。反馈闭环（Task 12）已上线，接下来的运营动作：定期把 feedback 表中 incorrect/outdated 的真实失败样本脱敏后加入离线评测集。
- 每个阶段以契约测试和离线评测为发布门槛；先评测，后换算法。

## 开发规范

- 所有代码注释一律使用中文：新代码必须写中文注释；修改旧文件时，顺带把该文件中仍为英文的注释改为中文。
- 文档、提交说明优先使用中文。
- 标准验证命令：`npm test`、`npm run typecheck`、`npm run build`、`npm run eval:retrieval`；检索相关改动不得使评测指标退化。
- 涉及真实模型或真实 Agent 宿主的命令一律用 `smoke:*` 前缀，且需显式环境变量开启，避免意外产生费用。
- 遵守开发计划中的文件边界与"近期明确不做"清单：不让模型直接创建 Verified 资产、不提前拆微服务、不为每个宿主复制 MCP Server、不把访问密钥写入项目配置或数据库明文。
