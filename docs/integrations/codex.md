# Codex CLI 接入

> 实测环境：codex-cli 0.39.0（`codex mcp` 子命令为 experimental）。与其他宿主（Claude Code、OpenCode）复用同一 MCP 构建产物 `dist/adapters/mcp/server.js`，宿主侧只有启动配置，不承载任何业务规则。

## 实测校准的关键事实（0.39.0）

1. **Codex 只读用户级 `~/.codex/config.toml`，不读项目内 `.codex/config.toml`**（`codex mcp get` 实测确认）。`.codex/config.toml.example` 是合并模板，不是可直接生效的项目配置。
2. **Codex 不向 MCP 子进程继承宿主 shell 环境变量**（实测确认：export 的 `MEMORY_SKILLS_ACCESS_KEY` 子进程拿不到，server 因缺配置退出，Codex 报 `MCP client ... failed to start: request timed out`）。解决办法：用 `node --env-file-if-exists=<项目>/.env` 让 server 进程自己从 `.env` 加载密钥——密钥仍然只存在于 `.env`（不入库），`config.toml` 中只有路径引用、无密钥明文。`--env-file` 不会覆盖已存在的环境变量，因此 `env` 表中的显式配置优先级高于 `.env`。
3. Codex 可从任意目录启动，全局配置中的 `command`/`args` 必须用**绝对路径**。

## 接入步骤

1. 构建并启动服务，然后注册 MCP（在 memory_skills 项目根执行，命令自动写入绝对路径）：

```bash
npm run build
MEMORY_SKILLS_ACCESS_KEY='replace-with-your-key' npm start

codex mcp add memory-skills \
  --env MEMORY_SKILLS_URL=http://127.0.0.1:8421 \
  --env MEMORY_SKILLS_USER_ID=local-admin \
  --env MEMORY_SKILLS_TEAM_ID=local \
  --env MEMORY_SKILLS_AGENT_ID=default \
  -- node --env-file-if-exists="$PWD/.env" "$PWD/dist/adapters/mcp/server.js"
```

2. 等价的手工方式：把 `.codex/config.toml.example` 中的 `[mcp_servers.memory-skills]` 段合并进 `~/.codex/config.toml`，把路径替换为本机绝对路径。

3. 检查注册结果：

```bash
codex mcp list
codex mcp get memory-skills
```

移除：`codex mcp remove memory-skills`。

## 调用策略

Codex 读取项目根的 `AGENTS.md`（其标准的宿主指令文件），其中已写明：每个用户回合先调用 `recall_context`、只读边界、作用域由服务端绑定。不需要 Codex 专属规则文件。

## 验收

```bash
MEMORY_SKILLS_SMOKE=1 npm run smoke:agent-host -- --live --host codex
```

断言：`data/events.jsonl` 出现新增 `context.recall.completed` 事件（工具确实被调用），且最终答案包含期望资产关键词。
