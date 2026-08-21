import { bearerToken } from "../../auth/access-key.js";
import type { AuthService } from "../../auth/auth-service.js";
import type { Principal } from "../../auth/principal.js";
import type { Scope } from "../../governance/types.js";

type Environment = Record<string, string | undefined>;

/** 远程 MCP 入站认证结果：失败原因只分"缺凭据/凭据无效"，对调用方不区分细节，防探测。 */
export type McpAuthResult =
  | { ok: true; principal: Principal }
  | { ok: false; reason: "missing-token" | "invalid-token" };

/**
 * 远程 MCP 的 Bearer 认证桥（Task 19）：
 * 复用主服务同一套验签路径（AuthService：本地 Access Key 与团队 Token 先哈希再常量时间比较），
 * 保证"签发的 Token 在 HTTP API 与远程 MCP 行为一致"，不产生第二套认证实现。
 */
export function authenticateMcpRequest(
  authService: AuthService,
  authorization: string | undefined,
): McpAuthResult {
  const token = bearerToken(authorization);
  if (!token) return { ok: false, reason: "missing-token" };
  const principal = authService.authenticate(token);
  return principal ? { ok: true, principal } : { ok: false, reason: "invalid-token" };
}

/** 401 挑战响应头（RFC 6750）：远程端点未认证时必须返回，宿主据此识别需要 Bearer 凭据。 */
export const BEARER_CHALLENGE_HEADERS: Readonly<Record<string, string>> = {
  "www-authenticate": 'Bearer realm="memory-skills"',
} as const;

/**
 * 从认证主体派生召回作用域：身份是作用域唯一权威（Task 15 哲学的远程延伸）。
 * - userId/teamId 取自 Principal（本地 Access Key 即 local-admin/local，与 stdio 默认一致；
 *   不同团队 Token 天然召回各自作用域，调用方无法越权声明）；
 * - agentId 维度与接入设备/宿主相关，仍由服务端环境变量绑定（默认 default），不接受请求输入。
 * 只依赖主体的身份两个字段，与角色/边界无关。
 */
export function scopeFromPrincipal(
  principal: Pick<Principal, "userId" | "teamId">,
  environment: Environment = process.env,
): Scope {
  const scope: Scope = {
    userId: principal.userId,
    teamId: principal.teamId,
    agentId: environment.MEMORY_SKILLS_AGENT_ID?.trim() || "default",
  };
  const sessionId = environment.MEMORY_SKILLS_SESSION_ID?.trim();
  if (sessionId) scope.sessionId = sessionId;
  return scope;
}
