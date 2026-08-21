# memory-skills

An unofficial, governance-first derivative of
[TencentDB Agent Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory).

This project extracts the Chat Memory and Skill domains into a standalone
TypeScript service. It retains the MIT-licensed design lineage while removing
TencentDB, COS, Redis, Kafka, ClickHouse, OpenClaw, and other platform-specific
runtime dependencies from the core.

## First milestone

- SQLite-backed L0 evidence and L1/L2/L3 governed assets
- Draft/Verified/Deprecated/Rejected/Archived lifecycle
- Source references and derivation links
- Scope-aware recall with character budgets
- Versioned Skill documents with optimistic concurrency
- Minimal local HTTP API
- Access-key protected web console with only Chat Memory and Skill pages
- Unified, platform-neutral context recall for Memory and Skill routing
- Read-only stdio MCP adapter for Claude Code and other MCP-capable agents
- Proposal interfaces for future LLM extraction; no direct auto-publishing

## Commands

```bash
npm install
npm --prefix web install
npm test
npm run typecheck
npm run build
MEMORY_SKILLS_ACCESS_KEY='replace-with-a-long-random-key' npm start
```

Open `http://127.0.0.1:8421` and sign in with the same value configured in
`MEMORY_SKILLS_ACCESS_KEY`. The service defaults to `127.0.0.1:8421`, stores
data in `./data/memory-skills.db`, and serves the production web build from
`./web/dist`.

For frontend development, run the API and Vite dev server separately:

```bash
MEMORY_SKILLS_ACCESS_KEY='dev-only-key' npm run dev
npm run dev:web
```

The first web milestone uses one local administrator scope
(`local-admin/local/default`). It deliberately does not include registration,
multiple users, teams, password recovery, or role-based authorization.

## 部署（Docker Compose，远程服务器）

在远程服务器上以容器方式运行（非 root、数据目录显式挂载、健康检查走
`/health`）：

```bash
cp .env.example .env       # 编辑：MEMORY_SKILLS_ACCESS_KEY 必填，用长随机值
docker compose up -d       # 构建并启动 api 服务（HTTP API + Web 控制台）
curl http://127.0.0.1:8421/health
```

数据（SQLite、迁移前自动备份、审计事件）都在命名卷 `data` 的 `/app/data`
下；升级与备份恢复流程见 `docs/operations.md`。远程 MCP 端点（本地 Agent
宿主连接远程服务器）见 `docs/integrations/remote-mcp.md`。

安全提醒：`compose.yaml` 默认按公网直暴露发布端口（`8421:8421`）。此时
Access Key 与 Token 以 Bearer 明文走 HTTP，务必使用长随机密钥；更稳妥的
做法是把端口映射改为 `127.0.0.1:8421:8421` 回环绑定，经 SSH 隧道、
Tailscale 或带 TLS 的反向代理访问。CI（`.github/workflows/ci.yml`）与
发布链路（`release.yml`：SBOM + sha256 校验和 + ghcr 镜像 + GitHub
Release）在推送后自动生效。

## Agent 宿主 MCP 接入（Claude Code / Codex / OpenCode）

三个宿主复用同一个只读 MCP 构建产物 `dist/adapters/mcp/server.js`，宿主侧只有
启动配置，密钥一律不进配置文件。各宿主的接入步骤与实测校准的版本差异见
`docs/integrations/`（`claude-code.md`、`codex.md`、`opencode.md`）。

### Claude Code

Build and start the API, then launch Claude Code from this project with the
same access key in its environment:

```bash
npm run build
MEMORY_SKILLS_ACCESS_KEY='replace-with-your-key' npm start

export MEMORY_SKILLS_ACCESS_KEY='replace-with-your-key'
claude
```

The project-level `.mcp.json` starts `dist/adapters/mcp/server.js`（密钥以
`${MEMORY_SKILLS_ACCESS_KEY}` 引用，值来自 shell 环境）. Use `/mcp`
inside Claude Code to approve and inspect the `memory-skills` server. The
adapter exposes four read-only tools: `recall_context`, `recall_memory`,
`search_skills`, and `get_skill`. `CLAUDE.md`/`AGENTS.md` tell the agent when
to use the unified tool; `.claude/settings.json` pre-authorizes only that
unified read-only tool. The adapter binds all calls to its configured scope
and never exposes Draft content. Retrieval and governance rules remain in the
core service.

For a private machine-specific registration instead of `.mcp.json`, run:

```bash
claude mcp add memory-skills --scope local \
  --env MEMORY_SKILLS_URL="$MEMORY_SKILLS_URL" \
  --env MEMORY_SKILLS_ACCESS_KEY="$MEMORY_SKILLS_ACCESS_KEY" \
  -- node "$PWD/dist/adapters/mcp/server.js"
```

### Codex（用户级配置）

Codex 0.39.0 只读用户级 `~/.codex/config.toml`，且不向 MCP 子进程继承宿主
shell 环境，注册时用 `node --env-file` 让 server 直接从项目 `.env` 取密钥：

```bash
codex mcp add memory-skills \
  --env MEMORY_SKILLS_URL=http://127.0.0.1:8421 \
  --env MEMORY_SKILLS_USER_ID=local-admin \
  --env MEMORY_SKILLS_TEAM_ID=local \
  --env MEMORY_SKILLS_AGENT_ID=default \
  -- node --env-file-if-exists="$PWD/.env" "$PWD/dist/adapters/mcp/server.js"
```

模板见 `.codex/config.toml.example`，调用策略读项目 `AGENTS.md`。

### OpenCode（项目级配置）

复制 `opencode.json.example` 为项目根的 `opencode.json`（真实配置不入库），
OpenCode 的 MCP 子进程继承宿主环境，启动前 `export
MEMORY_SKILLS_ACCESS_KEY` 即可：

```bash
cp opencode.json.example opencode.json
export MEMORY_SKILLS_ACCESS_KEY='replace-with-your-key'
opencode mcp list   # 应显示 memory-skills connected
```

### 多宿主验收

```bash
npm run smoke:agent-host                                  # dry：零费用，9 项断言
MEMORY_SKILLS_SMOKE=1 npm run smoke:agent-host -- --live   # live：真实宿主 CLI（产生模型费用）
```

dry 层覆盖身份/偏好/Skill 命中/无关查询不命中/密钥错误/服务不可用六类用例
与三宿主配置漂移检测；live 层断言真实宿主调用 `recall_context`（服务端
`context.recall.completed` 事件）且最终答案包含期望资产关键词。Pi 的能力
探测与适配决策见 `docs/spikes/pi-integration-decision.md`（`npm run
detect:pi` 复核）。

## SessionEnd 半自动捕获（Evidence 层 + 可选即时审核）

有价值对话无需再手动 POST：`scripts/session-end-capture.mjs` 在 Claude Code
会话结束时读取转录文件，把用户消息与助手回复的摘要自动送入
`POST /v1/evidence`（携带来源会话 `originSessionId`，供多会话佐证规则使用）。

设置 `MEMORY_SKILLS_SESSION_PROPOSALS=1` 后（显式 opt-in，提案会产生真实
模型费用），hook 在捕获证据后自动触发 `POST /v1/proposals/memory/run`：

- 能被服务端确定性规则放行的 Draft 直接自动 Verify（见上文「规则化自动
  Verify」，hook 本身没有发布决策权）；
- 剩余 Draft 在宿主终端存在时**当场快速审核**（逐条展示内容与证据摘录，
  `y`/`n`/`a`/`q`，每个键入都是人的显式决定）；非交互环境只提示一行
  `npm run review:drafts`。脚本总预算 60 秒，超时静默收尾，绝不阻塞会话收尾。

在项目级 `.claude/settings.json`（或用户级 `~/.claude/settings.json`）中挂载：

```json
{
  "hooks": {
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /absolute/path/to/memory_skills/scripts/session-end-capture.mjs"
          }
        ]
      }
    ]
  }
}
```

运行环境需提供 `MEMORY_SKILLS_URL` 与 `MEMORY_SKILLS_ACCESS_KEY`（作用域变量
`MEMORY_SKILLS_USER_ID` 等可选，默认与 MCP 适配器一致；触发提案需 admin 级
Access Key，即同时持有 write 与 review 权限）。证据 ID 携带内容指纹：
同一会话重复触发且摘要未变时幂等。hook 任何失败都静默退出，不影响会话收尾。

批量补审（随时可用，与当场审核走同一 API）：

```bash
npm run review:drafts            # 审 memory Draft（内容 + 来源证据对照）
npm run review:drafts -- --skills # 连 Skill Draft 一起审
```

## 规则化自动 Verify（降低人工审核负担）

默认关闭。开启后，memory 提案产生的 Draft 会在创建后立即按**用户预先配置的
确定性规则**评估放行；未通过的留在 Draft 队列等人工审核。治理边界不变：
发布决策来自用户预配的规则代码路径，模型输出本身永远不构成发布依据，
评估抛错一律留 Draft（失败安全）。

```bash
MEMORY_SKILLS_AUTO_VERIFY=rules                              # 开启（缺省 off）
MEMORY_SKILLS_AUTO_VERIFY_MIN_CONFIDENCE=0.8                 # 候选置信度下限
MEMORY_SKILLS_AUTO_VERIFY_LAYERS=l1                          # 允许的层级（默认仅 l1）
MEMORY_SKILLS_AUTO_VERIFY_EVIDENCE_ROLES=user                # 来源证据角色白名单（默认仅用户原话）
MEMORY_SKILLS_AUTO_VERIFY_MIN_OVERLAP=0.8                    # Draft 与证据原文的字符 bigram 覆盖率下限
MEMORY_SKILLS_AUTO_VERIFY_REQUIRE_MULTI_SESSION=0            # 要求证据来自 >=2 个独立会话
```

放行条件（全部满足）：memory 资产（v1 Skill 永不自动 Verify，可执行指令
风险高）、`sensitivity=normal`、层级在白名单内、置信度达标、来源证据角色
全部在白名单内、Draft 内容对证据原文的 bigram 覆盖率达标（防模型改写发挥）。
非法配置值整体回退缺省（更保守一侧）。

语义说明：忠实抽取意味着"用户确实说过这句话"，但用户口误也会原样进入
Verified——资产带 `verifiedBy=auto` 标记区分规则放行与人工放行，便于事后
复核与降级。每次评估（无论放行与否）都产生 `governance.auto_verify.evaluated`
事件，放行走 `audit.state_changed`（trigger=`proposal.auto_verify`）与自动
向量同步，与人工 Verify 同一管线。

事后开启规则或想对历史 Draft 补评估：`POST /v1/proposals/memory/auto-verify`
（review 权限）批量复评该作用域全部现存 Draft。注意：调用提案的身份必须
同时持有审核权限，自动 Verify 才会执行——write-only 身份只能拿到 Draft，
不能借提案端点间接发布。

## Hybrid retrieval（混合检索）

服务默认词法检索；配置 `MEMORY_SKILLS_RETRIEVAL=hybrid` 并配齐 Embedding
环境变量后，`/v1/context/recall` 走词法 + 向量双通道确定性融合，向量故障自动
降级为词法。记忆/Skill 的治理状态转换（Verify/Reject/归档等）成功后会自动
增量同步向量索引，新 Verify 的资产即时进入向量通道；`POST /v1/retrieval/sync`
保留用于初始化、换模型后补齐或自动同步失败后的补救。
设计、环境变量与启用门槛见 `docs/retrieval.md`。

## Attribution

Portions of the architecture and domain semantics are derived from TencentDB
Agent Memory, Copyright (C) 2026 Tencent, under the MIT License. This fork is
not an official Tencent product and does not imply Tencent endorsement.
