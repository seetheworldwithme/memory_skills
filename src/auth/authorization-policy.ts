import type { Scope } from "../governance/types.js";
import type { AuthAction, Principal, Role } from "./principal.js";

/**
 * 角色 -> 动作矩阵：授权判定的唯一事实来源。
 * 提权回归测试锚定此表；任何放宽都必须先过 tests/authorization.test.ts。
 */
const ROLE_ACTIONS: Record<Role, readonly AuthAction[]> = {
  admin: ["read", "review", "write"],
  reviewer: ["read", "review"],
  reader: ["read"],
};

/** 动作授权：身份允许执行某动作。角色来自认证结果，请求体无法影响。 */
export function canPerform(principal: Principal, action: AuthAction): boolean {
  return principal.roles.some((role) => ROLE_ACTIONS[role]?.includes(action));
}

/** 边界匹配：集合为 "*" 不限制，否则必须显式包含该值。 */
function within(values: readonly string[] | "*", value: string): boolean {
  return values === "*" || values.includes(value);
}

/**
 * 作用域授权：请求作用域必须完全落在 Principal 边界内，边界是唯一判定权威
 * （principal.teamId 只表示归属租户，不参与判定：本地 admin 归属 local 但边界全开）。
 * teamId 跨租户、userId/agentId 越界都返回 false；
 * 通过后仍按 scoped 查询取数，ID 猜测不会泄漏其他作用域的资产。
 */
export function scopeAllowed(principal: Principal, scope: Scope): boolean {
  return within(principal.boundary.teamIds, scope.teamId)
    && within(principal.boundary.userIds, scope.userId)
    && within(principal.boundary.agentIds, scope.agentId);
}
