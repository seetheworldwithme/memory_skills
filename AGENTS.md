# AGENTS.md

所有 Agent 宿主（Claude Code、Codex、OpenCode、ZCode，以及后续评估中的 Pi 等）与编码代理共用的项目指南。

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
- Phase 6 Task 15 认证身份绑定 Scope 已完成（2026-08-21）：`src/auth/principal.ts`（Principal = user/team/roles/scope 边界，身份是作用域唯一权威，请求体自报作用域越界即 403 `FORBIDDEN_SCOPE`；本地 `local-admin` 三维边界全开兼容单人模式）、`authorization-policy.ts`（admin ⊃ reviewer ⊃ reader 最小角色集 × read/review/write 动作矩阵；read=查询/召回/反馈与使用记录采集，review=状态转换/回滚/续期/治理工作台/Draft 可见性（`includeDraft:true` 需 review），write=捕获/创建/提案/向量同步；矩阵是授权唯一事实来源，回归测试锚定）、`auth-service.ts`（本地 Access Key 仍为根身份；团队 Token 配置文件 `MEMORY_SKILLS_AUTH_TOKENS_FILE` 只存 sha256 哈希、支持新旧并存轮换与 revoked 撤销、解析失败拒绝启动；`MEMORY_SKILLS_AUTH_TOKEN` 让 MCP 适配器优先用只读 reader Token，"Agent 只读"从约定升级为服务端强制）、`http-server.ts` 全端点接入动作+边界双层授权且授权先于能力探测（未授权者无法探测 LLM/Embedding 配置）、login 响应附带 principal（角色不可自报，body 携带 roles/principal 字段一律忽略）。回归测试 `tests/authorization.test.ts` 覆盖跨租户、同租户 userId/agentId 越界、ID 猜测不泄漏（404 不可区分）、Draft 泄漏、提权、撤销/伪造 Token 统一 401。安全模型与 Token 配置格式见 `docs/security-model.md`。
- Phase 5（v0.6）Skill 生命周期产品化已完成（2026-08-21）：Task 13 Skill 质量校验与版本差异——`src/skills/skill-validator.ts`（名称/描述/触发条件/步骤/失败处理/验证方式/来源/敏感信息八类校验；error=不建议 Verify 的硬伤，warning=由人决定的质量短板；只出报告不阻塞治理；创建与更新硬性拒绝疑似密钥）、`skill-diff.ts`（frontmatter 字段 + 正文章节两层语义化差异，默认对照最近已发布版本，附中文摘要）、`skill_versions` 新增 `status` 快照列（幂等迁移，回填当前版本）、`rollback` 把历史版本追加为新 Draft（历史永不覆盖，仍需人工 Verify）、`skill-run-record.ts` 使用记录（被召回/被采用/成功/失败四类事件 + `run-summary` 确定性结论；没有使用证据时不宣称 Skill 有效）；Web Skill 详情页展示质量校验、Verify 前版本差异、版本历史与回滚、使用效果。Task 14 冲突/过期/删除传播——`src/governance/conflict-service.ts`（确定性扫描重复/疑似冲突生成治理任务：任务 ID 确定、处置资产后自动消失、不调模型；Skill 只比较正文章节）、`retention-service.ts`（过期待复核清单、`deprecate-expired` 只降权（Verified→Deprecated）绝不物理删除、`renew` 续期并恢复 Verified）、`impact-analysis.ts`（删除证据前只读预览受影响 Memory/Skill 及将转换到的状态）；证据删除传播语义调整为 Verified→Deprecated 待复核（原先直接打入终态 archive；Draft 保持不变，来源悬空由校验器暴露）；降权/续期/回滚/证据删除后自动向量同步；Web 新增"治理工作台"页（冲突任务、过期续期/降权、长期未验证提示）。新端点与语义详见 `docs/api.md`。
- 已完成：Sprint 1（版本化上下文契约 + 离线评测基线）、Sprint 2（诊断与审计事件 + MCP 工具目录抽取）、Sprint 4（供应商无关 LLM Provider + OpenAI 兼容 Provider 与契约测试，见 `docs/model-providers.md`）、Sprint 5（Task 9 Evidence→Draft 提案流水线：人工触发 `POST /v1/proposals/{memory,skill}/run`，模型只产 Draft，Web 可对照证据原文审核）、Task 10 混合检索（供应商无关 EmbeddingProvider + SQLite VectorIndex + 词法/向量确定性融合，`ContextService.recall` 已异步化；`MEMORY_SKILLS_RETRIEVAL=hybrid` 开启；真实模型 smoke 评测达标后已在 8421 投产 hybrid：text-embedding-3-large + minCos 0.5，见 `docs/retrieval.md`）、SessionEnd 半自动捕获 hook（`scripts/session-end-capture.mjs`，只到 Evidence 层，审核闸门保留，挂载方式见 README）、Task 12 显式反馈（`POST /v1/feedback` 与 `/v1/feedback/list`：有用/无关/错误/过期四类，关联召回 requestId 与资产版本；只用于评测与治理建议，不自动改写资产；Web 资产详情页有反馈条）、治理状态转换后自动向量同步（Verify/Reject/归档成功后自动增量同步该资产作用域，hybrid 下新 Verify 资产即时进入向量通道；失败只记 `retrieval.auto_sync.failed` 事件不影响治理操作，手动 `POST /v1/retrieval/sync` 保留用于初始化与补救）。
- Sprint 3 已完成（2026-08-21）：Task 5 多宿主接入——Claude Code（项目 `.mcp.json`，`${VAR}` 引用密钥）、Codex（用户级 `~/.codex/config.toml` + `node --env-file` 从 `.env` 取密钥，0.39.0 实测不向 MCP 子进程继承宿主环境）、OpenCode（项目 `opencode.json`，密钥靠进程环境继承）三者复用同一构建产物 `dist/adapters/mcp/server.js`；接入文档见 `docs/integrations/`；验收工具 `npm run smoke:agent-host`（dry 零费用 9 项全过；live 层 `MEMORY_SKILLS_SMOKE=1 --live` 打真实宿主 CLI，断言服务端 `context.recall.completed` 事件与答案关键词）。live 实测：Codex 真实召回通过；OpenCode 的 MCP 加载实测 connected，真实模型召回因本机默认模型 provider 不可用（`provider-auth-big/glm-5`）待宿主模型修复后补跑 `MEMORY_SKILLS_SMOKE=1 SMOKE_OPENCODE_MODEL=<provider/model> npm run smoke:agent-host -- --live --host opencode`；Claude Code 本机未装 CLI bin 链接（npm 包在），同命令 `--host claude-code` 可补验。Task 6 Pi 探测与决策——结论"暂不接入"（Pi 官方 No MCP 是刻意设计；装机后优先评估扩展注入而非 MCP 桥接），见 `docs/spikes/pi-integration-decision.md`，探测脚本 `npm run detect:pi`。
- ZCode 宿主已接入（2026-08-21）：工作区 `.zcode/config.json`（`mcp.servers`，真实配置含本机路径不入库，模板 `.zcode/config.example.json`）启动同一 `dist/adapters/mcp/server.js`，密钥经 `node --env-file` 从 `.env` 注入、不进配置文件；已用与配置完全相同的命令实测 stdio 链路：四只读工具齐全、`recall_context` 命中 8421 生产库 Verified 资产。配置在会话启动时加载，改动后需新开会话生效。接入文档见 `docs/integrations/zcode.md`。
- 混合检索现状：真实模型 smoke 评测达标并已在 8421 投产（large + minCos 0.5，语义改写用例 zh-057~059 全中、禁止命中零退化）。Task 11（可选 Query Rewrite / Reranker）仍按评测结果决定是否引入，不按时间强行引入；换任何新 Embedding 模型先重跑 smoke 扫描再调阈值。反馈闭环（Task 12）已上线，接下来的运营动作：定期把 feedback 表中 incorrect/outdated 的真实失败样本脱敏后加入离线评测集。
- 每个阶段以契约测试和离线评测为发布门槛；先评测，后换算法。

## 开发规范

- 所有代码注释一律使用中文：新代码必须写中文注释；修改旧文件时，顺带把该文件中仍为英文的注释改为中文。
- 文档、提交说明优先使用中文。
- 标准验证命令：`npm test`、`npm run typecheck`、`npm run build`、`npm run eval:retrieval`；检索相关改动不得使评测指标退化。
- 涉及真实模型或真实 Agent 宿主的命令一律用 `smoke:*` 前缀，且需显式环境变量开启，避免意外产生费用。
- 遵守开发计划中的文件边界与"近期明确不做"清单：不让模型直接创建 Verified 资产、不提前拆微服务、不为每个宿主复制 MCP Server、不把访问密钥写入项目配置或数据库明文。
