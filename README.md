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

## SessionEnd 半自动捕获（Evidence 层）

有价值对话无需再手动 POST：`scripts/session-end-capture.mjs` 在 Claude Code
会话结束时读取转录文件，把用户消息与助手回复的摘要自动送入
`POST /v1/evidence`。治理边界不变：hook 只自动捕获证据，提案仍需人工触发
`POST /v1/proposals/*/run`，审核仍必须人工 Verify。

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
`MEMORY_SKILLS_USER_ID` 等可选，默认与 MCP 适配器一致）。证据 ID 携带内容指纹：
同一会话重复触发且摘要未变时幂等。hook 任何失败都静默退出，不影响会话收尾。

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
