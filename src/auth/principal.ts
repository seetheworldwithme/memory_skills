import type { Scope } from "../governance/types.js";

/**
 * 最小角色集（Task 15）：
 * - admin：读取 + 写入 + 审核，本地模式的唯一角色；
 * - reviewer：读取 + 审核，可看到 Draft 并执行治理状态转换；
 * - reader：只读取，面向 Agent 宿主与查询类集成，永远不可见 Draft。
 */
export type Role = "admin" | "reviewer" | "reader";

/**
 * 授权动作三分类，与角色矩阵解耦：
 * - read：查询、召回、质量报告、使用记录与显式反馈采集（都不改变资产状态）；
 * - review：治理状态转换、回滚、续期、Draft 可见性；
 * - write：捕获 Evidence、创建/修改资产内容、运行提案、重建向量索引。
 */
export type AuthAction = "read" | "review" | "write";

/**
 * 作用域边界：Principal 允许访问的租户/用户/代理集合。
 * "*" 表示该维度不限制（仅本地 local-admin 默认使用）；
 * 团队 Token 恒为单租户：teamIds 固定为 [teamId]。
 * sessionId 只是更细的会话划分，不构成独立边界维度。
 */
export interface ScopeBoundary {
  teamIds: readonly string[] | "*";
  userIds: readonly string[] | "*";
  agentIds: readonly string[] | "*";
}

/**
 * 认证身份：Scope 的唯一权威来源。
 * 请求体中携带的任何作用域或角色字段都不参与身份判定，
 * 只能落在 boundary 内，越界一律拒绝。
 */
export interface Principal {
  userId: string;
  teamId: string;
  roles: readonly Role[];
  boundary: ScopeBoundary;
  source: "local-access-key" | "team-token";
  displayName?: string;
}

/** 本地模式默认身份：单一管理员，边界全开，兼容既有单机数据中任意作用域。 */
export const LOCAL_ADMIN_PRINCIPAL: Principal = {
  userId: "local-admin",
  teamId: "local",
  roles: ["admin"],
  boundary: { teamIds: "*", userIds: "*", agentIds: "*" },
  source: "local-access-key",
  displayName: "Local Administrator",
};

/** 请求作用域的类型收窄辅助：路由层读取 body 后用它判定 scope 是否存在。 */
export function isScope(value: unknown): value is Scope {
  if (typeof value !== "object" || value === null) return false;
  const scope = value as Partial<Scope>;
  return typeof scope.userId === "string" && typeof scope.teamId === "string" && typeof scope.agentId === "string";
}
