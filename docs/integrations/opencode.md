# OpenCode 接入

> 实测环境：opencode 1.1.50。与其他宿主（Claude Code、Codex）复用同一 MCP 构建产物 `dist/adapters/mcp/server.js`，宿主侧只有启动配置，不承载任何业务规则。

## 实测校准的关键事实（1.1.50）

1. 项目根的 `opencode.json` 顶层 `"mcp"` 字段会被读取（`opencode mcp list` 显示 connected 实测确认）。
2. local 型 MCP 的结构：`type: "local"`、`command`（**数组**）、`environment`（对象）、`enabled`、可选 `cwd`/`timeout`。
3. `command` 数组中的相对路径按项目根解析，`dist/adapters/mcp/server.js` 可直接使用。
4. 文档未声明 local `environment` 支持 `${VAR}` 展开，因此 **Access Key 不写进配置**：MCP 子进程继承 OpenCode 进程的环境变量（实测 connected 即为继承生效的证据），启动前在 shell 里 `export MEMORY_SKILLS_ACCESS_KEY` 即可。

## 接入步骤

1. 构建并启动服务：

```bash
npm run build
MEMORY_SKILLS_ACCESS_KEY='replace-with-your-key' npm start
```

2. 把 `opencode.json.example` 复制为项目根的 `opencode.json`（真实配置已列入 `.gitignore`，不入库）：

```bash
cp opencode.json.example opencode.json
```

3. 检查加载状态：

```bash
export MEMORY_SKILLS_ACCESS_KEY='replace-with-your-key'
opencode mcp list   # 应显示 memory-skills connected
```

## 调用策略

OpenCode 读取项目根的 `AGENTS.md`（其标准的宿主指令文件），其中已写明：每个用户回合先调用 `recall_context`、只读边界、作用域由服务端绑定。不需要 OpenCode 专属规则文件。

## 验收

```bash
MEMORY_SKILLS_SMOKE=1 npm run smoke:agent-host -- --live --host opencode
```

断言：`data/events.jsonl` 出现新增 `context.recall.completed` 事件（工具确实被调用），且最终答案包含期望资产关键词。

## 版本注意

OpenCode 配置结构演进较快（local server 的字段名与早期版本不同）。本文与 `opencode.json.example` 按 1.1.50 实测校准；升级 OpenCode 后先重跑 `opencode mcp list` 确认，再以其官方文档（<https://opencode.ai/docs/mcp-servers/>）为准更新示例，不把示例配置当作核心契约。
