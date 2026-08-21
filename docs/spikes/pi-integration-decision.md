# Pi 能力探测与适配决策（Task 6）

> 状态：**暂不接入，路径已定**。探测日期：2026-08-21。复核方式：装机后重跑 `npm run detect:pi`。

## 结论（TL;DR）

Pi（badlogic/pi-mono，现 earendil-works/pi-mono）**没有原生 MCP 支持，且这是官方刻意的设计取舍，不是待补齐的能力缺口**。当前决策：不写 MCP 桥接扩展、不进入接入清单；若将来装机接入，优先评估"扩展每回合注入上下文"的更薄路径，而非 MCP 桥接。

## 探测到的事实（版本与来源）

| 事实 | 内容 | 来源 |
| --- | --- | --- |
| 官方包与 CLI | `@earendil-works/pi-coding-agent`，CLI 名 `pi` | pi.dev 首页安装说明（2026-08-21 核实） |
| MCP 内置支持 | 无。官网"What we didn't build"明确列出 "No MCP" | pi.dev 首页 |
| 官方建议的替代 | "Build CLI tools with READMEs (see Skills), or build an extension that adds MCP support" | pi.dev 首页 |
| 扩展能力 | TypeScript 模块，可访问 tools/commands/events/TUI，可"inject messages before each turn"、过滤历史、实现 RAG/长期记忆 | pi.dev 首页 |
| MCP 扩展示例 | 官方 issue #563（earendil-works/pi）讨论 MCP extension example | GitHub issue |
| 本机安装状态 | 未安装 `pi` | `npm run detect:pi`（2026-08-21） |

## 选择与理由

1. **不实现 MCP 桥接扩展。** 官方对 MCP 是刻意拒绝的态度，桥接层需要自带 MCP client 协议栈，属于官方明示"可以自己建"但无人维护基础设施的路径，维护成本高于收益。
2. **不满足发布门槛就不写适配代码。** Task 6 的发布门槛是"Pi 至少通过原生 MCP 或 Extension 真实召回同一条 Verified Memory"。本机未安装 Pi，没有真实验收条件；按项目"先评测后投产"的规矩，没有验收条件的适配代码不进主线。
3. **已定接入路径（按优先级）：**
   - 路径 A（推荐）：官方 Extension API 的**上下文注入**方案——扩展在每个用户回合前 HTTP 调用 `POST /v1/context/recall`（与 MCP 适配器同一受治理接口），把返回的 Verified 上下文注入消息流。不需要 MCP 协议栈，天然符合治理边界（只读、不触碰 SQLite），且与 Pi 官方"CLI 工具优先"的哲学一致。
   - 路径 B：若 Pi 未来原生支持 stdio MCP，或出现官方维护的 MCP 扩展包，则与 Codex/OpenCode 走同一条配置接入路径（同一构建产物 `dist/adapters/mcp/server.js` + 环境变量，见 `docs/integrations/`）。

## 限制

- 本决策基于 pi.dev 官网与 GitHub issue 的 2026-08-21 快照，未做装机实测；Pi 迭代快，接入前必须重跑 `npm run detect:pi` 并重新核对官网。
- 路径 A 的扩展 API 细节（消息注入的具体挂点、TypeScript 模块签名）未经实际编码验证，正式立项时以 pi-mono 仓库 `docs/` 与 `examples/extensions/` 为准。

## 重新评估（或删除 `src/adapters/pi/`）的条件

- 安装 Pi 后：重跑探测脚本，若 `pi --help` 出现 MCP 相关子命令（原生支持），按路径 B 升级为配置接入，并纳入 `scripts/smoke-agent-host.mjs --live` 用例。
- 若确认长期不接入：删除 `src/adapters/pi/` 目录与本文档中路径 A 的预留，不留空壳。
