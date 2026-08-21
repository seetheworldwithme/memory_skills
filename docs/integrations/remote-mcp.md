# 远程 MCP 接入（Streamable HTTP）

> Task 19 起提供。服务跑在远程服务器、Agent 宿主在本地时，用远程 MCP 替代 stdio 适配器。
> 工具目录、契约与策略与 stdio 完全一致（单一目录原则，见 `mcp-contract.md`）；本文只描述
> 传输、部署与连接差异。

## 架构

```
本地 Agent 宿主 ──HTTP POST /mcp──▶ 远程服务器 mcp 进程 (:8422)
                                        │ Bearer Token（出站，服务端配置）
                                        ▼
                                   api 进程 (:8421，HTTP API + Web 控制台 + SQLite)
```

- `mcp` 进程（`dist/adapters/mcp/http-server.js`）是独立入口：入站接收宿主的 MCP 请求，
  出站用与 stdio 适配器相同的 `MemorySkillsHttpClient` 回调 `api` 的 HTTP API。
- 两个进程可以同机（compose 双容器）也可以分机（`MEMORY_SKILLS_URL` 指向远端 api）。
- 无状态逐请求模型：每个请求由 SDK 工厂新建 server 实例，服务端不保存会话；
  工具全部只读幂等，断线后宿主直接重试即恢复，无需会话存储与事件回放。
  GET/DELETE 会话操作按无状态语义返回 405。

## 服务器部署（Docker Compose）

```bash
cp .env.example .env    # 编辑：MEMORY_SKILLS_ACCESS_KEY 必填（用长随机值）
docker compose up -d    # api + mcp 两容器，mcp 等 api 健康后启动
curl http://127.0.0.1:8421/health   # api 健康
curl http://127.0.0.1:8422/health   # mcp 健康（无需认证）
```

- 端点：`http://<服务器地址>:8422/mcp`（POST，Bearer Token 认证）。
- 团队模式：给 Agent 签发只读 reader Token（配置文件只存 sha256 哈希，格式见
  `docs/security-model.md`），在 `compose.yaml` 的 mcp 服务里只读挂载并设置
  `MEMORY_SKILLS_AUTH_TOKENS_FILE`；单人模式直接用 `MEMORY_SKILLS_ACCESS_KEY`。
- 不用 Docker 时手动起两个进程：`npm start` + `npm run mcp:http`（或
  `node --env-file-if-exists=.env dist/adapters/mcp/http-server.js`）。

### 环境变量（mcp 进程）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `MEMORY_SKILLS_URL` | 必填 | api 服务地址（compose 内 `http://api:8421`） |
| `MEMORY_SKILLS_ACCESS_KEY` | 必填 | 入站认证与出站回落凭据，与 api 侧同值 |
| `MEMORY_SKILLS_AUTH_TOKEN` | 空 | 出站 Token（团队模式建议签发 reader，优先于 ACCESS_KEY） |
| `MEMORY_SKILLS_AUTH_TOKENS_FILE` | 空 | 团队 Token 文件（入站认证同样支持团队 Token） |
| `MEMORY_SKILLS_MCP_HOST` / `_PORT` | `127.0.0.1` / `8422` | 监听地址与端口 |
| `MEMORY_SKILLS_MCP_ALLOWED_HOSTS` | 空 | Host 头允许列表（逗号分隔）；配置后非列表 Host 一律 403 |
| `MEMORY_SKILLS_MCP_ALLOWED_ORIGINS` | 空 | Origin 允许列表；配置后用于拒绝浏览器跨站请求 |
| `MEMORY_SKILLS_AGENT_ID` / `_SESSION_ID` | `default` / 空 | 作用域的 agent 维度仍由服务端绑定 |
| `MEMORY_SKILLS_EVENT_SINK` | `stderr`（mcp 入口默认） | 与 api 分进程，避免争写 events.jsonl；可改为 jsonl/off |

## 安全模型

公网直暴露（默认 compose 端口绑定）时的防线与边界：

1. **认证**：`POST /mcp` 一律要求 Bearer Token（401 + `WWW-Authenticate` 挑战），
   验签与 HTTP API 同一套（sha256 + 常量时间比较）；匿名请求在读取请求体之前即被拒绝。
2. **作用域跟随身份**：召回作用域由认证出的 Principal 派生（userId/teamId 取自 Token 身份），
   不同团队 Token 天然只能召回各自作用域；工具输入不接受任何作用域字段。
3. **限流**：read 域按认证主体计数（默认 600 次/分，`MEMORY_SKILLS_RATE_LIMIT_READ_PER_MIN` 可调），
   超限 429 + `Retry-After`。
4. **审计**：401/403/429 写 `audit.denied` 事件（不含凭据值），事件输出默认 stderr（进容器日志）。
5. **请求体上限**：1MB，与 HTTP API 红线一致，超限 413。
6. **Host/Origin 校验**：可选允许列表（默认不校验，认证是主防线）；公网部署建议配置。

> ⚠️ **无 TLS 的明文风险**：直连 `http://<服务器>:8422` 时 Bearer Token 以明文过公网，
> 存在被嗅探与中间人风险。务必使用长随机密钥；更稳妥的做法是把 compose 端口映射改成
> `127.0.0.1:8422:8422` 回环绑定，经 SSH 隧道（`ssh -L 8422:127.0.0.1:8422`）、Tailscale
> 或带 TLS 的反向代理（Caddy/nginx）访问。Token 泄漏可立即在 Token 文件标记 `revoked` 轮换。

## 本地宿主连接配置

远程连接只需要 URL + Bearer Token，四个只读工具与 stdio 完全一致。

### ZCode（配置在会话启动时加载，改动后需新开会话）

工作区 `.zcode/config.json`（真实配置不入库）的 `mcp.servers` 追加：

```json
{
  "mcp": {
    "servers": {
      "memory-skills-remote": {
        "type": "http",
        "url": "http://<服务器地址>:8422/mcp",
        "headers": {
          "Authorization": "Bearer <你的 Token>"
        }
      }
    }
  }
}
```

注意 ZCode 的 MCP schema 严格：未知键会导致整个 server 被丢弃；密钥只放 `headers`。

### Claude Code

```bash
claude mcp add --transport http memory-skills-remote \
  http://<服务器地址>:8422/mcp \
  --header "Authorization: Bearer <你的 Token>"
```

### Codex / OpenCode

两宿主均已支持基于 URL 的 Streamable HTTP MCP，配置字段随版本演进较快，
以各自官方文档为准（本地 stdio 接入见 `codex.md` / `opencode.md`，远程只是把
command 换成 url + Authorization 头）。

## 行为一致性与验收

- 与 stdio 共用 `tool-catalog.ts` 单一目录与 `createMemorySkillsMcpServer` 工厂，
  契约测试锁定两通道行为一致（`tests/mcp-server.test.ts` vs `tests/remote-mcp.test.ts`）。
- `tests/remote-mcp.test.ts`（9 例）：401 挑战、无效 Token 审计、工具列表与目录一致、
  `recall_context` 契约字段与作用域跟随认证主体（团队 Token 只见本作用域资产）、
  限流 429、1MB 上限 413、无状态 GET/DELETE 405、`/health`、Host 允许列表 403。
- 本地 compose 演练记录见 `AGENTS.md`（api+mcp 双容器健康、真实 MCP 客户端经 8422 召回）。
