# ZCode 接入

ZCode（ZCode CLI 宿主）与其他宿主一样只做启动配置：复用同一构建产物
`dist/adapters/mcp/server.js`，不复制任何检索、状态、权限和作用域逻辑。

## 配置位置

工作区级配置文件 `<repo>/.zcode/config.json`（`mcp.servers` 嵌套结构）。
同名 server 用户级（`~/.zcode/cli/config.json`）覆盖工作区；工作区声明的
server 会在会话启动时自动信任并连接。真实配置含本机绝对路径，
**不入库**（`.gitignore` 已忽略），模板见 `.zcode/config.example.json`。

```json
{
  "mcp": {
    "servers": {
      "memory-skills": {
        "type": "stdio",
        "command": "node",
        "args": [
          "--env-file=/absolute/path/to/memory_skills/.env",
          "/absolute/path/to/memory_skills/dist/adapters/mcp/server.js"
        ],
        "env": {
          "MEMORY_SKILLS_URL": "http://127.0.0.1:8421",
          "MEMORY_SKILLS_USER_ID": "local-admin",
          "MEMORY_SKILLS_TEAM_ID": "local",
          "MEMORY_SKILLS_AGENT_ID": "default"
        }
      }
    }
  }
}
```

## 密钥注入

- 配置文件中**不写 Access Key**（与 Claude Code 的 `${VAR}`、Codex 的
  `node --env-file` 同一原则）：`--env-file` 直接从项目 `.env` 读取
  `MEMORY_SKILLS_ACCESS_KEY`，`.env` 本身不入库。
- `MEMORY_SKILLS_URL` 是 MCP 适配器的必填项（指向 8421 主服务），
  写在 `env` 的非密钥区；作用域变量给默认 `local-admin/local/default`。

## 前置条件

1. 8421 主服务在运行（`npm start`，MCP 壳通过 HTTP 调它）；
2. `npm run build` 已产出 `dist/adapters/mcp/server.js`；
3. `.env` 存在且含有效的 `MEMORY_SKILLS_ACCESS_KEY`。

## 验证

- 工具目录：连接后应列出且仅列出四个只读工具
  `recall_context` / `recall_memory` / `search_skills` / `get_skill`；
- 真实召回：调用 `recall_context`（如 query `你是谁`）应返回
  `contractVersion: 1` 契约结构并命中该作用域的 Verified 资产；
- 注意：MCP 配置在**会话启动时**加载，修改 `.zcode/config.json` 后需要
  新开会话才生效（当前会话的工具列表不会热更新）。
