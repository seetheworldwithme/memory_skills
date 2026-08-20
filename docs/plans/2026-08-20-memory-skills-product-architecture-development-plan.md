# Memory Skills Product and Architecture Development Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 将当前已跑通 Claude Code 的本地 Memory/Skill 服务，迭代成可接入多种 Agent、可配置多种大模型、可度量召回质量、可审计且默认安全的长期上下文产品。

**Architecture:** 保持治理优先的模块化单体。Memory、Skill、Evidence、Governance 和 Retrieval 属于平台无关核心；LLM Provider 只负责生成候选与排序，不直接写入正式资产；MCP/HTTP 属于交付适配层；Claude Code、Codex、OpenCode、Pi 只保留配置与轻量宿主策略。每个阶段都以契约测试和离线评测为发布门槛，达到规模瓶颈后再拆服务或引入专用向量存储。

**Tech Stack:** TypeScript、Node.js 22、SQLite、Node Test Runner、MCP TypeScript SDK、Zod、React/Vite；后续通过可插拔 Provider 接入 OpenAI/Anthropic 等模型，通过可插拔 Embedding/Reranker 接入语义检索。

---

## 1. 当前基线与总体结论

截至 2026-08-20，以下能力已经完成，应作为后续开发的回归基线，而不是重新实现：

- SQLite 持久化的 Evidence、L1/L2/L3 Memory、Skill 与派生关系；
- Draft、Verified、Deprecated、Rejected、Archived 生命周期；
- 基于作用域、状态和字符预算的 Memory/Skill 召回；
- 只保留 Chat Memory 和 Skill 的最小 Web 管理台；
- `POST /v1/context/recall` 统一上下文接口；
- 只读 stdio MCP Server，以及 Claude Code 项目级配置；
- MCP 作用域由服务端环境绑定、Draft 不对 Agent 暴露、空查询拒绝、结果包含 `structuredContent`；
- 中文自然句召回与常见词误匹配的回归测试。

后续开发应遵循以下产品主线：

```text
质量可测量
  -> 多 Agent 稳定读取
  -> LLM 只生成 Draft 候选
  -> 混合检索提升召回
  -> 人工审核与反馈闭环
  -> 多用户和生产化
```

核心判断：当前最有价值的下一步不是继续增加页面或数据库，而是先建立“上下文契约 + 评测集 + 可观测性”。没有这些基础，接入模型、Embedding 或更多 Agent 后无法判断改动是提升还是退化。

## 2. 产品原则与架构护栏

### 2.1 必须长期坚持

1. **Evidence 是事实来源。** 所有自动生成的 Memory/Skill 必须能追溯到 Evidence、模型、Prompt 版本和生成时间。
2. **模型只能提案。** LLM 输出先进入 Draft；是否 Verified 由治理策略或人工操作决定。
3. **读写能力分离。** Agent 默认只获得只读 recall/search 工具，捕获、审核、发布是另一组需显式授权的能力。
4. **宿主不承载业务规则。** Claude、Codex、OpenCode、Pi 适配层不得复制检索、状态、权限和作用域判断。
5. **先评测，后换算法。** 词法、Embedding、重排、Query Rewrite 都必须在同一评测集上比较。
6. **默认最小暴露。** Agent 只收到当前 Scope、当前任务相关、状态合格、预算内的资产。
7. **可逆优先。** 自动化操作必须能查看来源、版本差异、撤销、回滚和删除传播影响。

### 2.2 近期明确不做

- 不让模型直接创建 Verified Memory 或 Verified Skill；
- 不为了“智能化”立即绑定某一家向量数据库；
- 不为每个 Agent 平台复制一套 MCP Server；
- 不把访问密钥、模型密钥写入项目配置或数据库明文字段；
- 不在缺少评测数据时引入复杂 Agentic Retrieval；
- 不在本地个人版验证前提前拆成微服务；
- 不把 Skill 文本无条件作为高优先级系统指令注入。

## 3. 目标架构

```text
Claude Code   Codex   OpenCode   Pi/Extension   Other Agents
     \          |        |           |              /
      +---------+--------+-----------+-------------+
                         |
                  MCP / HTTP Adapters
                         |
               Versioned Context Contract
                         |
       +-----------------+------------------+
       |                 |                  |
  ContextService   ProposalService   GovernanceService
       |                 |                  |
  Retrieval Core    LLM Providers      Audit / Policy
       |                 |                  |
  Lexical/Vector    Extract/Rerank      Lifecycle/RBAC
       +-----------------+------------------+
                         |
          SQLite Repositories + Evidence Lineage
```

边界说明：

- `ContextService` 只负责召回编排、预算和统一输出；
- `ProposalService` 调用模型提取候选，但不负责发布；
- `GovernanceService` 是唯一允许变更生命周期状态的应用服务；
- Provider 接口不得泄漏 OpenAI、Anthropic 等供应商的响应类型；
- MCP 的本地 stdio 与未来远程 Streamable HTTP 共用同一工具定义；
- Web 控制台通过 HTTP API 操作，不直接访问 SQLite。

## 4. 优先级与版本节奏

| 优先级 | 建议版本 | 目标 | 发布结果 |
| --- | --- | --- | --- |
| P0 | v0.2 | 质量基线与稳定契约 | 能量化召回正确率，客户端升级不破坏契约 |
| P0 | v0.3 | 多 Agent 读取接入 | Claude、Codex、OpenCode 可复用同一 MCP；Pi 有明确适配结论 |
| P1 | v0.4 | LLM Provider 与 Draft 提案 | 真实对话可受控地产生候选，不自动污染长期资产 |
| P1 | v0.5 | 混合检索与反馈 | 语义召回有可证明收益，用户反馈可回流评测 |
| P2 | v0.6 | Skill 生命周期产品化 | 可比较版本、验证质量、回滚和查看使用效果 |
| P2 | v0.7 | 多用户与安全 | 身份决定 Scope，具备角色、审计、限流和密钥轮换 |
| P3 | v1.0 | 部署与开放集成 | 可迁移、可备份、可观测、可发布、可远程接入 |

建议按 1～2 周一个小里程碑推进。每个版本只在其验收条件全部满足后进入下一阶段；时间不足时缩小功能范围，不降低治理和回归门槛。

## 5. Phase 1 — v0.2：Context Contract 与评测基线

### Task 1：定义版本化上下文契约

**Files:**
- Create: `src/context/contract.ts`
- Modify: `src/context/types.ts`
- Modify: `src/context/context-service.ts`
- Modify: `src/api/http-server.ts`
- Modify: `src/adapters/mcp/server.ts`
- Modify: `docs/api.md`
- Test: `tests/context-contract.test.ts`
- Test: `tests/http-api.test.ts`
- Test: `tests/mcp-server.test.ts`

1. 先写失败测试，锁定 `contractVersion`、`requestId`、`query`、`scope`、`memories`、`skills`、预算和截断字段。
2. 为召回项增加 `match` 元数据：匹配策略、分数、命中的查询片段；不得暴露内部 SQL。
3. 为响应增加稳定的 `warnings`，表达预算截断、降级和部分失败。
4. REST 与 MCP `structuredContent` 使用同一 Schema；文本块仅作为兼容展示。
5. 对新增字段采用向后兼容策略，破坏性变更必须提升 `contractVersion`。
6. 运行：`npm run test:server && npm run typecheck && npm run build:server`。

**Definition of Done:** HTTP 与 MCP 契约测试使用同一组 fixture；旧客户端所需字段不变；错误、空结果和截断结果均有快照或结构断言。

### Task 2：建立离线召回评测集

**Files:**
- Create: `evals/fixtures/context-recall.zh-CN.jsonl`
- Create: `evals/fixtures/context-recall.en.jsonl`
- Create: `evals/run-context-recall.ts`
- Create: `src/evaluation/types.ts`
- Modify: `package.json`
- Create: `tests/evaluation-runner.test.ts`
- Create: `docs/evaluation.md`

1. 先定义评测样本结构：`query`、候选资产、期望命中 ID、禁止命中 ID、最大结果数和说明。
2. 收录至少 50 条中文样本：身份、偏好、项目决策、工作流、否定表达、过期信息、公共词误匹配和长自然句。
3. 收录至少 20 条英文样本，防止算法只针对中文特化。
4. 实现确定性 runner，输出 Recall@K、Precision@K、MRR、禁止命中率和平均字符预算。
5. 把当前词法算法结果保存为 v0.2 baseline，不因指标不好而修改 fixture 期望。
6. 增加 `npm run eval:retrieval`；指标退化超过阈值时返回非零退出码。

**发布门槛:** 关键身份/偏好样本 Recall@3 = 100%；禁止命中率 = 0%；整体 Precision@3 和 MRR 不低于已记录 baseline。

### Task 3：增加诊断与审计事件

**Files:**
- Create: `src/observability/events.ts`
- Create: `src/observability/event-sink.ts`
- Create: `src/observability/jsonl-event-sink.ts`
- Modify: `src/context/context-service.ts`
- Modify: `src/server.ts`
- Test: `tests/observability.test.ts`
- Modify: `.env.example`

1. 定义不含资产正文的结构化事件：召回耗时、候选数、返回数、截断、策略和错误码。
2. 默认本地 JSONL 或 stderr 输出；MCP stdout 继续只承载协议。
3. 对内容、Access Key、模型密钥做字段级禁止和测试。
4. EventSink 使用接口注入，为未来 OpenTelemetry 留扩展点，但本阶段不引入监控平台。

## 6. Phase 2 — v0.3：多 Agent 接入套件

### Task 4：抽取单一 MCP 工具目录

**Files:**
- Create: `src/adapters/mcp/tool-catalog.ts`
- Create: `src/adapters/mcp/tool-policy.ts`
- Modify: `src/adapters/mcp/server.ts`
- Create: `tests/mcp-tool-catalog.test.ts`
- Create: `docs/integrations/mcp-contract.md`

1. 把工具名、输入 Schema、输出 Schema、只读标记和说明从 stdio 启动代码中抽出。
2. 保留四个只读能力；默认推荐 Agent 只调用 `recall_context`。
3. 在 Server `instructions` 前 512 字符内写清调用时机、作用域绑定和 Draft 不可用规则。
4. 测试所有宿主拿到相同工具 Schema，调用方不能覆盖 Scope 或状态策略。

### Task 5：Claude、Codex、OpenCode 配置与端到端测试

**Files:**
- Modify: `CLAUDE.md`
- Modify: `.mcp.json`
- Create: `AGENTS.md`
- Create: `.codex/config.toml.example`
- Create: `opencode.json.example`
- Create: `scripts/smoke-agent-host.mjs`
- Create: `evals/agent-host-cases.json`
- Create: `docs/integrations/claude-code.md`
- Create: `docs/integrations/codex.md`
- Create: `docs/integrations/opencode.md`
- Modify: `.gitignore`
- Modify: `package.json`

1. 每个平台只配置启动同一个 `dist/adapters/mcp/server.js` 和相同环境变量。
2. Codex 使用项目 `.codex/config.toml`/用户配置承载 stdio MCP，`AGENTS.md` 只写调用策略；不要在文件中写 Access Key。
3. OpenCode 按其当前官方配置结构提供本地 MCP 示例；正式实现时重新核对官方文档版本，不把示例配置当作核心契约。
4. 用相同用例验证：身份、偏好、Skill 命中、无关查询不命中、密钥错误、服务不可用。
5. Smoke 脚本输出宿主、工具是否被调用、结果是否命中和最终答案断言；真实模型测试独立于默认单元测试，避免每次产生费用。

**发布门槛:** Claude、Codex、OpenCode 至少各完成一次真实 CLI 验收；三者均复用同一 MCP 构建产物；没有宿主专属业务分支。

### Task 6：Pi 能力探测与适配决策

**Files:**
- Create: `docs/spikes/pi-integration-decision.md`
- Create: `src/adapters/pi/README.md`
- Conditional Create: `src/adapters/pi/extension.ts`
- Conditional Test: `tests/pi-extension.test.ts`

1. 先核对 Pi 当前稳定版是否已经原生支持 stdio MCP，不依据旧 Issue 或非官方 Fork 做假设。
2. 如果原生支持，增加配置示例并纳入相同 smoke cases。
3. 如果不支持，基于 Pi 官方 Extension API 实现薄桥接：只把统一 Context Contract 映射为只读工具。
4. 决策文档记录版本、来源、选择、限制和删除适配器的条件。

**发布门槛:** Pi 至少通过原生 MCP 或 Extension 真实召回同一条 Verified Memory；桥接层不直接访问 SQLite。

参考实现时以官方资料为准：[Claude Code MCP](https://docs.anthropic.com/en/docs/mcp)、[Codex MCP](https://developers.openai.com/codex/mcp)、[OpenCode MCP](https://opencode.ai/v2/docs/mcp-servers)、[Pi 官方仓库](https://github.com/badlogic/pi-mono)。

## 7. Phase 3 — v0.4：LLM Provider 与受控 Draft 提案

### Task 7：建立供应商无关的模型接口

**Files:**
- Create: `src/llm/types.ts`
- Create: `src/llm/provider.ts`
- Create: `src/llm/provider-registry.ts`
- Create: `src/llm/model-config.ts`
- Create: `src/llm/mock-provider.ts`
- Modify: `src/errors.ts`
- Modify: `.env.example`
- Test: `tests/llm-provider.test.ts`
- Create: `docs/model-providers.md`

1. 先以 Mock Provider 写失败测试，覆盖结构化输出、超时、取消、重试、限流和无效响应。
2. Provider 输入只包含任务、允许的 Evidence 和结构 Schema；输出统一成项目内部类型。
3. 配置采用 `provider/model/baseUrl/timeout` 与密钥环境变量引用；密钥不进入 API 返回或日志。
4. Registry 根据配置创建 Provider；领域服务不得直接 import 厂商 SDK。
5. 记录请求次数、延迟、Token 和可选成本，但默认不保存完整 Prompt/Response 正文。

### Task 8：实现第一个真实 Provider

**Files:**
- Create: `src/llm/providers/openai-provider.ts` 或 `src/llm/providers/anthropic-provider.ts`
- Create: `tests/llm-provider-contract.test.ts`
- Create: `scripts/smoke-model-provider.mjs`
- Modify: `package.json`
- Modify: `docs/model-providers.md`

1. 根据用户实际账号先选一个 Provider，实现结构化输出和错误映射。
2. 用录制/Mock 响应完成默认测试；真实 API smoke 由显式环境变量开启。
3. Provider contract test 必须能原样复用于第二家模型，避免“接口存在但实际上绑定首家厂商”。
4. 禁止 Provider 拥有 Repository 或 GovernanceService 引用。

### Task 9：Evidence 到 Draft 的提案流水线

**Files:**
- Create: `src/extraction/proposal-service.ts`
- Create: `src/extraction/prompt-registry.ts`
- Create: `src/extraction/validators.ts`
- Modify: `src/extraction/interfaces.ts`
- Modify: `src/memory/memory-service.ts`
- Modify: `src/skills/skill-service.ts`
- Modify: `src/api/http-server.ts`
- Create: `tests/proposal-service.test.ts`
- Create: `evals/fixtures/extraction.jsonl`
- Modify: `docs/api.md`

1. 定义提案 Job：选择 Evidence、调用 Provider、Schema 校验、敏感检测、去重/冲突检查、创建 Draft、记录派生关系。
2. 提案必须包含 `model`、`promptVersion`、`inputEvidenceIds`、`confidence`、`reason` 和校验结果。
3. 增加人工触发 API；本阶段不在每次聊天后自动运行。
4. 对空洞 Skill、占位内容、无触发条件、无来源、重复候选直接拒绝或标记需修订。
5. 即使模型输出要求发布，也只能创建 Draft。

**发布门槛:** 给定固定 Evidence 和 Mock Provider，结果完全可复现；真实模型提案可在 Web 中查看来源后手工 Verify/Reject；失败不会产生半写入资产。

## 8. Phase 4 — v0.5：混合检索、重排与反馈闭环

### Task 10：引入可替换的语义检索接口

**Files:**
- Create: `src/retrieval/types.ts`
- Create: `src/retrieval/retriever.ts`
- Create: `src/retrieval/lexical-retriever.ts`
- Create: `src/retrieval/embedding-provider.ts`
- Create: `src/retrieval/vector-index.ts`
- Create: `src/retrieval/hybrid-retriever.ts`
- Modify: `src/context/context-service.ts`
- Test: `tests/hybrid-retrieval.test.ts`
- Modify: `evals/run-context-recall.ts`

1. 先把现有词法逻辑包装成 Retriever，并证明结果与 baseline 一致。
2. 定义 EmbeddingProvider 和 VectorIndex，不让 ContextService 感知厂商或数据库。
3. 第一版可用 SQLite 表保存 embedding 元数据和版本；向量实现以最小可替换为目标。
4. Hybrid 先召回词法/向量候选，再以确定性融合分数排序；保留匹配解释。
5. 只有评测集 Recall/Precision 有显著提升且禁止命中不退化时才默认开启。

### Task 11：可选 Query Rewrite 与 Reranker

**Files:**
- Create: `src/retrieval/query-rewriter.ts`
- Create: `src/retrieval/reranker.ts`
- Modify: `src/context/context-service.ts`
- Test: `tests/query-rewrite.test.ts`
- Modify: `evals/run-context-recall.ts`

1. 默认关闭，失败时无损回退到原查询和融合排序。
2. Rewrite 不得改变用户明确否定、实体、时间和作用域。
3. Reranker 只能重排已通过 Scope/状态过滤的候选，不能越权扩展候选集。
4. 分别统计质量收益、P95 延迟和模型成本；未达阈值则保持实验功能。

### Task 12：采集显式反馈

**Files:**
- Create: `src/feedback/types.ts`
- Create: `src/feedback/feedback-service.ts`
- Modify: `src/storage/sqlite-repository.ts`
- Modify: `src/api/http-server.ts`
- Modify: `web/src/pages/MemoryPage.tsx`
- Modify: `web/src/pages/SkillsPage.tsx`
- Test: `tests/feedback-service.test.ts`
- Test: `web/src/pages/MemoryPage.test.tsx`

1. 支持有用、无关、错误、过期四类显式反馈，关联 `requestId` 和资产版本。
2. 反馈先用于评测与治理建议，不直接自动改写资产。
3. 定期把真实失败样本脱敏后加入离线评测集。

## 9. Phase 5 — v0.6：Skill 生命周期产品化

### Task 13：Skill 质量校验与版本差异

**Files:**
- Create: `src/skills/skill-validator.ts`
- Create: `src/skills/skill-diff.ts`
- Create: `src/skills/skill-run-record.ts`
- Modify: `src/skills/skill-service.ts`
- Modify: `web/src/pages/SkillsPage.tsx`
- Test: `tests/skill-validator.test.ts`
- Test: `tests/skill-versioning.test.ts`

1. 校验名称、描述、触发条件、步骤、失败处理、验证方式、来源和敏感信息。
2. Verify 前展示当前 Draft 与已发布版本的语义化差异。
3. 支持回滚为新版本，不覆盖历史版本。
4. 记录 Skill 被召回、被采用、任务结果和用户反馈；没有证据时不宣称 Skill 有效。

### Task 14：冲突、过期与删除传播

**Files:**
- Create: `src/governance/conflict-service.ts`
- Create: `src/governance/retention-service.ts`
- Create: `src/governance/impact-analysis.ts`
- Modify: `src/storage/sqlite-repository.ts`
- Modify: `web/src/App.tsx`
- Test: `tests/governance-impact.test.ts`

1. 对同一 Scope 中相互矛盾或高度重复的资产生成治理任务。
2. 删除 Evidence 前展示受影响的 Memory/Skill；默认标记待复核，不静默保留来源已消失的 Verified 资产。
3. 过期策略只降权/待复核，不直接物理删除；支持用户确认续期。

## 10. Phase 6 — v0.7：身份、多租户与安全

### Task 15：认证身份绑定 Scope

**Files:**
- Create: `src/auth/principal.ts`
- Create: `src/auth/auth-service.ts`
- Create: `src/auth/authorization-policy.ts`
- Modify: `src/auth/access-key.ts`
- Modify: `src/api/http-server.ts`
- Modify: `src/adapters/mcp/server.ts`
- Test: `tests/authorization.test.ts`
- Create: `docs/security-model.md`

1. Principal 中包含 user/team/roles；请求体不再是 Scope 权威来源。
2. 支持 admin、reviewer、reader 最小角色集；写入、审核、读取分别授权。
3. Access Key 只作为本地模式；团队模式支持可轮换 Token，远程 MCP 再评估 OAuth。
4. 增加跨租户、ID 猜测、Draft 泄漏和提权回归测试。

### Task 16：安全与运维基线

**Files:**
- Create: `src/security/rate-limit.ts`
- Create: `src/security/redaction.ts`
- Create: `src/security/audit-service.ts`
- Create: `docs/threat-model.md`
- Create: `tests/security-boundaries.test.ts`
- Modify: `src/server.ts`

1. 完成数据流威胁建模：Prompt Injection、Skill Injection、跨 Scope、密钥泄漏、敏感 Evidence 和删除不彻底。
2. 对写入、模型调用和远程接口设置速率与大小限制。
3. 审计所有状态变更、登录失败、授权拒绝和模型提案，不记录密钥和完整敏感正文。
4. 增加备份加密、日志保留和数据导出/删除策略文档。

## 11. Phase 7 — v1.0：交付、迁移和开放集成

### Task 17：数据库迁移、备份与恢复

**Files:**
- Create: `src/storage/migrations/`
- Create: `src/storage/migration-runner.ts`
- Create: `scripts/backup.mjs`
- Create: `scripts/restore.mjs`
- Create: `tests/migrations.test.ts`
- Create: `docs/operations.md`

1. 所有 Schema 变化使用单向版本迁移；启动前备份并支持 dry-run。
2. 备份包含数据库版本、内容哈希和恢复说明；恢复到临时库验证后再替换目标。
3. 用至少两个历史 fixture 测试跨版本升级。

### Task 18：可发布运行形态

**Files:**
- Create: `Dockerfile`
- Create: `.dockerignore`
- Create: `compose.yaml`
- Create: `.github/workflows/ci.yml`
- Create: `.github/workflows/release.yml`
- Modify: `package.json`
- Modify: `README.md`

1. CI 运行 server/web tests、typecheck、build、eval regression 和依赖审计。
2. Docker 默认非 root、只绑定必要端口、数据目录显式挂载、健康检查不泄漏配置。
3. 发布 npm/容器前确认 MIT attribution、SBOM、版本迁移说明和校验和。
4. 本地验证与真实 GitHub Runner/容器验收分别记录，不互相替代。

### Task 19：远程 MCP（可选，最后实施）

**Files:**
- Create: `src/adapters/mcp/http-server.ts`
- Create: `src/adapters/mcp/auth.ts`
- Test: `tests/remote-mcp.test.ts`
- Create: `docs/integrations/remote-mcp.md`

1. 只在多设备或团队共享需求真实出现后实现 Streamable HTTP。
2. 复用 `tool-catalog.ts`，不得产生第二套工具行为。
3. 上线前完成 TLS、认证、Scope 绑定、限流、审计、断线恢复和兼容测试。

## 12. 横向测试矩阵

每个阶段都要维护以下层次，不能只依赖真实大模型手工测试：

| 层级 | 默认是否运行 | 目的 |
| --- | --- | --- |
| Domain Unit | 是 | 生命周期、权限、预算、验证器等确定性规则 |
| Repository Integration | 是 | SQLite 事务、迁移、隔离、并发版本 |
| HTTP/MCP Contract | 是 | 不同交付层输出一致、错误稳定 |
| Retrieval/Extraction Eval | 是 | 算法和 Prompt 质量不退化 |
| Mock Provider | 是 | 超时、重试、Schema 错误、部分失败 |
| Real Provider Smoke | 否，显式开启 | 验证真实供应商兼容，控制成本 |
| Real Agent Host E2E | 发布前 | 验证 Claude/Codex/OpenCode/Pi 实际调用链 |

标准验证命令：

```bash
npm test
npm run typecheck
npm run build
npm run eval:retrieval
```

涉及真实模型或 Agent 的命令必须单独命名为 `smoke:*`，并要求显式环境变量开启，避免 CI 意外产生费用或上传真实对话。

## 13. 产品指标

### 北极星指标

**有效上下文采用率：** 被 Agent 实际采用且未被用户标记为错误/无关的召回次数 ÷ 总召回次数。

### 质量指标

- 关键记忆 Recall@3；
- Skill Precision@3；
- 禁止资产命中率；
- Draft 到 Verified 的接受率；
- Verified 后 30 天内被纠正/回滚率；
- 过期资产仍被采用的比例；
- 有完整 Evidence 来源的资产比例。

### 性能与成本指标

- Context recall P50/P95；
- 每次召回返回字符数/Token 估算；
- 每次提案的模型 Token 和成本；
- Provider 失败/重试/降级率；
- Agent 首次正确调用 `recall_context` 的比例。

## 14. 开发顺序建议

接下来直接从以下四个迭代开始：

1. **Sprint 1：** Task 1 + Task 2，完成契约和评测基线；
2. **Sprint 2：** Task 3 + Task 4，完成可观测性和 MCP 工具目录；
3. **Sprint 3：** Task 5 + Task 6，真实跑通 Codex、OpenCode，并确定 Pi 路径；
4. **Sprint 4：** Task 7 + Task 8，建立 LLM Provider 并只做 Provider smoke；
5. **Sprint 5：** Task 9，把 Evidence 提取为可审核 Draft；
6. 后续根据评测结果决定是否进入混合检索，而不是按时间强行引入。

第一批不应同时开发的工作：多用户、远程 MCP、向量数据库和自动捕获。它们会同时改变权限、部署、检索和数据增长路径，难以定位质量问题。

## 15. 全项目完成标准

达到 v1.0 时，应满足：

- 任一支持的 Agent 宿主都通过同一版本化契约获取上下文；
- 切换模型供应商不需要修改领域服务；
- 自动生成内容永远先进入 Draft，并可追溯、审核、拒绝和回滚；
- 检索算法升级有离线指标和真实反馈证明收益；
- 认证身份是 Scope 的唯一权威来源，不存在调用方自报租户；
- 所有 Verified 资产都能解释来源、版本、验证者和最近验证时间；
- 备份、恢复、迁移、安全审计和 CI 发布链路通过真实环境验证；
- Web 页面继续聚焦 Memory 与 Skill，不因架构扩展退化为通用运维后台。

## 16. 关联文档

- [Memory 与 Skill 治理路线图](./2026-08-20-memory-skill-governance-roadmap.md)
- [独立项目拆分计划](./2026-08-20-standalone-extraction.md)
- [最小 Web 控制台计划](./2026-08-20-minimal-web-console.md)
- [Claude Code MCP 适配计划](./2026-08-20-claude-code-mcp-adapter.md)
- [HTTP API](../api.md)

