# Claude Code 接入

> 实测环境：Claude Code CLI，项目级 `.mcp.json`。与其他宿主（Codex、OpenCode）复用同一 MCP 构建产物 `dist/adapters/mcp/server.js`，宿主侧只有启动配置，不承载任何业务规则。

## 接入步骤

1. 构建并启动服务（Claude Code 与服务使用同一个 Access Key）：

```bash
npm run build
MEMORY_SKILLS_ACCESS_KEY='replace-with-your-key' npm start
```

2. 项目级 `.mcp.json` 已内置 memory-skills 配置（支持 `${VAR}` 与 `${VAR:-default}` 展开）：

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

3. 从项目根启动 Claude Code（`${VAR}` 从 shell 环境读取）：

```bash
export MEMORY_SKILLS_ACCESS_KEY='replace-with-your-key'
claude
```

首次在 Claude Code 里用 `/mcp` 批准并检查 `memory-skills`；`.claude/settings.json` 已只预授权 `recall_context` 这一个只读工具。

## 与其他宿主的差异

- Claude Code 是三个宿主中唯一支持 `${VAR}` 展开的：Access Key 以**引用**形式出现在 `.mcp.json`，值始终来自 shell 环境，不落盘到项目文件。
- `args` 用相对路径即可：Claude Code 以项目根为工作目录启动 MCP 子进程。
- 跨宿主通用策略（调用时机、作用域绑定、Draft 不可见）见 `AGENTS.md` 与 `docs/integrations/mcp-contract.md`，Claude Code 不需要额外规则文件（`CLAUDE.md` 已承载）。

## 验收

```bash
MEMORY_SKILLS_SMOKE=1 npm run smoke:agent-host -- --live --host claude-code
```

断言：`data/events.jsonl` 出现新增 `context.recall.completed` 事件（工具确实被调用），且最终答案包含期望资产关键词。
