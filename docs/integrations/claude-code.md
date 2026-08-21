# Claude Code 接入

> 实测环境：Claude Code CLI 2.0.49，项目级 `.mcp.json`。当前默认走**远程 Streamable HTTP**（`http://<服务器>:8422/mcp`），本地 stdio 作为备选保留。与其他宿主（Codex、OpenCode、ZCode）复用同一 MCP 工具目录，宿主侧只有连接配置，不承载任何业务规则。

## 接入步骤（远程，默认）

1. 项目级 `.mcp.json` 已内置远程配置（支持 `${VAR}` 与 `${VAR:-default}` 展开，`url` 与 `headers` 均实测生效）：

```json
{
  "mcpServers": {
    "memory-skills": {
      "type": "http",
      "url": "${MEMORY_SKILLS_MCP_URL:-http://127.0.0.1:8422/mcp}",
      "headers": {
        "Authorization": "Bearer ${MEMORY_SKILLS_ACCESS_KEY}"
      }
    }
  }
}
```

2. 两个变量放在**用户级** `~/.claude/settings.json` 的 `env` 段（对每个会话生效，仓库文件只留引用，不落任何密钥或个人服务器地址）：

```json
{
  "env": {
    "MEMORY_SKILLS_ACCESS_KEY": "<与服务器 .env 相同的 Access Key>",
    "MEMORY_SKILLS_MCP_URL": "http://<服务器地址>:8422/mcp"
  }
}
```

3. 从项目根启动 Claude Code，首次用 `/mcp` 批准 `memory-skills` 并确认四个只读工具可见；项目 `.claude/settings.json` 已预授权 `mcp__memory-skills__recall_context`（服务器名不变即沿用）。

## 接入步骤（本地 stdio，备选）

本地自建服务（`npm run build` 后 `MEMORY_SKILLS_ACCESS_KEY=... npm start`）时，把 `.mcp.json` 换回启动子进程的写法：

```json
{
  "mcpServers": {
    "memory-skills": {
      "command": "node",
      "args": ["dist/adapters/mcp/server.js"],
      "env": {
        "MEMORY_SKILLS_URL": "${MEMORY_SKILLS_URL:-http://127.0.0.1:8421}",
        "MEMORY_SKILLS_ACCESS_KEY": "${MEMORY_SKILLS_ACCESS_KEY}",
        "MEMORY_SKILLS_USER_ID": "${MEMORY_SKILLS_USER_ID:-local-admin}",
        "MEMORY_SKILLS_TEAM_ID": "${MEMORY_SKILLS_TEAM_ID:-local}",
        "MEMORY_SKILLS_AGENT_ID": "${MEMORY_SKILLS_AGENT_ID:-default}"
      }
    }
  }
}
```

## 与其他宿主的差异

- Claude Code 是各宿主中唯一支持 `${VAR}` 展开的：Access Key 以**引用**形式出现在 `.mcp.json`，值始终来自用户级 settings 或 shell 环境，不落盘到项目文件。
- 远程入口的作用域由 Bearer Token 认证出的身份派生（userId/teamId 取自 Token，agentId 服务端绑定），`MEMORY_SKILLS_USER_ID/_TEAM_ID/_AGENT_ID` 只在 stdio 入口有意义。
- 跨宿主通用策略（调用时机、作用域绑定、Draft 不可见）见 `AGENTS.md` 与 `docs/integrations/mcp-contract.md`，Claude Code 不需要额外规则文件（`CLAUDE.md` 已承载）。

## 验收

- 快速连通性检查（注意：`mcp list` 子命令**不加载** `~/.claude/settings.json` 的 env，探测时需在 shell 里带上两个变量）：

```bash
MEMORY_SKILLS_MCP_URL=http://<服务器地址>:8422/mcp \
MEMORY_SKILLS_ACCESS_KEY=<你的 Key> \
claude mcp list    # 期望 memory-skills … ✓ Connected
```

- 真实链路验收（断言 `data/events.jsonl` 出现新增 `context.recall.completed` 事件，且最终答案包含期望资产关键词）：

```bash
MEMORY_SKILLS_SMOKE=1 npm run smoke:agent-host -- --live --host claude-code
```
