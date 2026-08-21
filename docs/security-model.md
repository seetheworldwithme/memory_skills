# Security Model（Task 15：认证身份绑定 Scope）

> 版本：v0.7 Phase 6。本文回答三个问题：请求是谁发的（认证）、能做什么（角色授权）、
> 能看到哪些数据（作用域边界）。所有判定都发生在服务端，调用方无法自报。

## 1. 核心原则

1. **身份是 Scope 的唯一权威来源。** 认证得到的 Principal（user/team/roles/boundary）
   决定请求能访问的作用域；请求体中的 `scope` 只是"想访问哪里"的声明，越界即 403，
   不再有"调用方自报租户"的信任路径。
2. **角色无法自报。** 请求体携带的 `roles`/`principal` 等字段一律忽略；角色只来自
   Token 的认证结果。
3. **默认最小暴露不变。** Draft 只对审核角色可见；MCP 工具仍只返回 Verified 资产；
   授权判定在能力探测（LLM/Embedding 是否配置）之前，未授权者无法探测服务配置。
4. **Token 明文不落盘。** 团队 Token 配置文件只存 sha256 哈希；明文只在签发时出现一次。

## 2. 认证（Authentication）

两种 Token，共用同一 Bearer 通道与常量时间比较：

| Token 来源 | Principal | 适用模式 |
| --- | --- | --- |
| `MEMORY_SKILLS_ACCESS_KEY` | `local-admin`（admin，边界全开） | 本地单人模式（唯一根身份） |
| `MEMORY_SKILLS_AUTH_TOKENS_FILE` 登记的团队 Token | 配置文件声明的身份 | 团队/多租户模式 |

认证失败一律 401 `UNAUTHORIZED`，不区分"Token 不存在/已撤销/格式错误"。

### 团队 Token 配置文件

`MEMORY_SKILLS_AUTH_TOKENS_FILE` 指向的 JSON（不入 git，权限 600）：

```json
{
  "version": 1,
  "tokens": [
    {
      "id": "agent-reader-1",
      "tokenHash": "<sha256(明文) 的 64 位小写 hex>",
      "userId": "codex-agent",
      "teamId": "team-a",
      "roles": ["reader"],
      "userIds": ["codex-agent"],
      "agentIds": ["default"],
      "createdAt": "2026-08-21T00:00:00.000Z"
    },
    {
      "id": "reviewer-carol",
      "tokenHash": "...",
      "userId": "carol",
      "teamId": "team-a",
      "roles": ["reviewer"],
      "userIds": "*",
      "revoked": false
    }
  ]
}
```

- **签发：** `node -e 'const c=require("crypto");const t=c.randomBytes(32).toString("base64url");console.log(t, c.createHash("sha256").update(t).digest("hex"))'`
  生成明文与哈希；明文交给使用方，哈希写入配置。
- **轮换：** 新 Token 追加一条记录（新旧并存过渡），旧记录删除或 `"revoked": true`。
  配置文件在服务启动时加载，轮换后需重启服务生效。
- **边界维度：** `userIds`/`agentIds` 取 `"*"`（不限制）或显式数组（白名单）；
  `teamIds` 恒为该记录的 `teamId`（团队 Token 天然单租户）。
- **失败即拒绝启动：** 文件存在但 JSON 损坏、角色非法、哈希格式错误时服务直接终止，
  绝不静默降级为纯本地模式。

### MCP 适配器

`MemorySkillsHttpClient.fromEnv` 优先使用 `MEMORY_SKILLS_AUTH_TOKEN`，未配置时回落
`MEMORY_SKILLS_ACCESS_KEY`。团队模式下给 Agent 宿主签发 **reader Token**：即使 Agent
被诱导调用写端点，也会被服务端 403 拒绝，"Agent 只读"从约定升级为强制。

## 3. 角色与动作（Authorization）

| 角色 | read | review | write | 典型使用者 |
| --- | --- | --- | --- | --- |
| admin | ✓ | ✓ | ✓ | 本地管理员、团队所有者 |
| reviewer | ✓ | ✓ | ✗ | 审核员（Web 治理工作台） |
| reader | ✓ | ✗ | ✗ | Agent 宿主、查询集成 |

动作语义与端点映射：

- **read（读取）**：recall、context/recall、memories/skills 的 get/list/search/versions/diff/validate/run-summary、
  evidence/get、evidence impact 预览、feedback 提交、skill 使用记录（runs）。
  反馈与使用记录是"采集"而非"变更"：不改变资产状态，向所有可读取身份开放，最大化回流评测的数据量。
- **review（审核）**：状态转换（status）、回滚（rollback）、续期（renew）、deprecate-expired、
  feedback/list、governance/conflicts、retention/review、以及 **Draft 可见性**（`includeDraft: true`）。
- **write（写入）**：evidence 捕获/删除、memories/skills 创建与更新、proposals run、retrieval/sync。

矩阵的唯一事实来源是 `src/auth/authorization-policy.ts` 的 `ROLE_ACTIONS`；
`tests/authorization.test.ts` 锚定该矩阵，任何放宽都须先过测试。

## 4. 作用域边界（Scope Boundary）

请求体 `scope: { userId, teamId, agentId, sessionId? }` 必须完全落在 Principal 边界内：

```
teamId  ∈ boundary.teamIds   （团队 Token 恒为单租户 → 跨租户请求 403）
userId  ∈ boundary.userIds   （默认仅自身；reviewer 常配 "*" 审核全租户）
agentId ∈ boundary.agentIds  （默认 "*" 不限制；可限定特定 Agent）
sessionId                             （会话细分，不构成独立边界）
```

本地 `local-admin` 三个维度均为 `"*"`：单人本地模式下作用域只是数据组织维度，
不是安全边界；团队模式一旦启用，边界立即收紧。

**ID 猜测防线：** 作用域是数据查询键而非过滤器——即使拿到其他用户的资产 ID，
用边界内作用域查询也只会得到 404（scoped 查询找不到），直接用越界作用域查询则
先被 403 拦截，两者都不会泄漏资产存在性。

## 5. 威胁与对策（回归测试锚点）

| 威胁 | 对策 | 测试 |
| --- | --- | --- |
| 跨租户访问 | 团队 Token 单租户边界 + `FORBIDDEN_SCOPE` | `作用域边界` 用例 |
| 同租户越权（他用户数据） | `userIds` 白名单 + scoped 查询 | `作用域边界`/`ID 猜测` 用例 |
| ID 猜测枚举资产 | 404 与真实不存在不可区分 | `ID 猜测不泄漏` 用例 |
| Draft 泄漏给 Agent | `includeDraft` 需 review 动作；MCP 工具无该字段 | `Draft 可见性` 用例 |
| 请求体自报角色提权 | 授权只认认证结果，body 字段忽略 | `提权与认证失败` 用例 |
| 已撤销/伪造 Token | 常量时间哈希比对，统一 401 | 同上 |
| 探测服务配置（LLM/Embedding） | 授权先于能力探测（503） | `动作矩阵` 用例（提案端点） |

## 6. 明确不做与后续边界

- **Access Key 只作为本地模式。** 团队模式一律用可轮换 Token；OAuth 留到远程 MCP
  （Task 19）再评估，本阶段不引入。
- **Token 管理没有 API。** 配置文件由管理员手工维护（支持新旧并存轮换），
  避免 Task 15 引入密钥管理面；后续如需 API 再单独评审。
- 速率限制、脱敏中间件、独立审计服务、威胁建模文档属于 Task 16（安全与运维基线），
  本阶段不提前实现。
- 事件输出已把 Access Key 注入禁止值；团队 Token 明文不进进程（只有请求头里的候选值），
  哈希不具备反推风险。
