# Pi 适配层（预留目录）

当前为空目录，**没有 Pi 适配代码**。Pi 的能力探测结论与适配决策见 `docs/spikes/pi-integration-decision.md`（结论：Pi 无原生 MCP，暂不接入；若接入优先走"扩展每回合注入上下文"而非 MCP 桥接）。

若将来在此目录落代码，必须遵守与 MCP 适配层相同的边界：

- 只通过受治理 HTTP API（`POST /v1/context/recall` 等）读取 Verified 资产，不直接访问 SQLite；
- 作用域由服务端环境变量绑定，适配层不复制检索、状态、权限和作用域判断；
- 不承载宿主专属业务分支，与 `src/adapters/mcp/` 共用同一份工具目录语义。

删除条件：确认长期不接入 Pi 时，删除本目录并同步更新决策文档。
