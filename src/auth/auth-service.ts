import { readFile } from "node:fs/promises";

import { accessKeyMatches, sha256Hex } from "./access-key.js";
import {
  LOCAL_ADMIN_PRINCIPAL,
  type Principal,
  type Role,
  type ScopeBoundary,
} from "./principal.js";

/** 合法角色集合：解析团队 Token 配置时做硬校验，未知角色直接拒绝加载。 */
const ROLES: readonly Role[] = ["admin", "reviewer", "reader"];

/**
 * 团队 Token 记录（存储形态）：
 * - tokenHash 是明文的 sha256 hex，明文不进任何文件、日志与数据库；
 * - 轮换 = 在配置文件追加新记录、删除（或标记 revoked）旧记录；
 * - 边界默认：userIds 仅自身，agentIds 不限制，teamIds 恒为 [teamId]。
 */
export interface TeamTokenRecord {
  id: string;
  tokenHash: string;
  userId: string;
  teamId: string;
  roles: Role[];
  /** 用户边界：缺省仅自身；"*" 表示整个租户（reviewer 审核全团队 Draft 时使用）。 */
  userIds?: readonly string[] | "*";
  /** 代理边界：缺省不限制。 */
  agentIds?: readonly string[] | "*";
  createdAt?: string;
  revoked?: boolean;
}

export interface AuthServiceOptions {
  accessKey: string;
  /** 本地 Access Key 对应的 Principal；缺省为全边界 local-admin。 */
  localPrincipal?: Principal;
  /** 团队 Token 列表；未配置即纯本地模式。 */
  teamTokens?: readonly TeamTokenRecord[];
}

/**
 * 认证服务：把 Bearer Token 解析为 Principal，是身份的唯一入口。
 * 本地 Access Key 与团队 Token 共用同一比较路径（先哈希再常量时间比较）。
 */
export class AuthService {
  readonly #accessKey: string;
  readonly #localPrincipal: Principal;
  readonly #teamTokens: readonly TeamTokenRecord[];

  constructor(options: AuthServiceOptions) {
    if (!options.accessKey.trim()) throw new Error("accessKey must not be empty");
    this.#accessKey = options.accessKey;
    this.#localPrincipal = options.localPrincipal ?? LOCAL_ADMIN_PRINCIPAL;
    this.#teamTokens = options.teamTokens ?? [];
  }

  /** 认证：成功返回 Principal，失败返回 undefined（调用方统一回 401，不区分失败原因）。 */
  authenticate(token: string): Principal | undefined {
    if (accessKeyMatches(token, this.#accessKey)) return this.#localPrincipal;
    const tokenHash = sha256Hex(token);
    for (const record of this.#teamTokens) {
      if (record.revoked) continue;
      if (accessKeyMatches(tokenHash, record.tokenHash)) return toPrincipal(record);
    }
    return undefined;
  }
}

/** 团队 Token 记录 -> Principal：租户边界固定为单租户，用户边界默认仅自身。 */
function toPrincipal(record: TeamTokenRecord): Principal {
  const boundary: ScopeBoundary = {
    teamIds: [record.teamId],
    userIds: record.userIds ?? [record.userId],
    agentIds: record.agentIds ?? "*",
  };
  return {
    userId: record.userId,
    teamId: record.teamId,
    roles: [...record.roles],
    boundary,
    source: "team-token",
  };
}

interface TokenFileShape {
  version?: unknown;
  tokens?: unknown;
}

const TOKEN_FILE_VERSION = 1;

/**
 * 从环境变量组装 AuthService：
 * - MEMORY_SKILLS_ACCESS_KEY 必填（本地模式根身份）；
 * - MEMORY_SKILLS_AUTH_TOKENS_FILE 可选，指向团队 Token JSON 配置（存哈希）；
 *   文件不存在视为未启用团队模式；存在但解析失败直接抛错，绝不静默降级。
 */
export async function resolveAuthServiceFromEnv(
  environment: Record<string, string | undefined>,
): Promise<AuthService> {
  const accessKey = environment.MEMORY_SKILLS_ACCESS_KEY?.trim();
  if (!accessKey) throw new Error("MEMORY_SKILLS_ACCESS_KEY is required");
  const tokensFile = environment.MEMORY_SKILLS_AUTH_TOKENS_FILE?.trim();
  const teamTokens = tokensFile ? await loadTeamTokensFile(tokensFile) : [];
  return new AuthService({ accessKey, teamTokens });
}

/** 读取并硬校验团队 Token 配置文件；任何格式问题都抛错并指向具体记录。 */
export async function loadTeamTokensFile(path: string): Promise<TeamTokenRecord[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    throw new Error(`无法读取团队 Token 配置文件：${path}`);
  }
  let parsed: TokenFileShape;
  try {
    parsed = JSON.parse(raw) as TokenFileShape;
  } catch {
    throw new Error(`团队 Token 配置不是合法 JSON：${path}`);
  }
  if (parsed.version !== TOKEN_FILE_VERSION) {
    throw new Error(`团队 Token 配置 version 必须为 ${TOKEN_FILE_VERSION}：${path}`);
  }
  if (!Array.isArray(parsed.tokens)) {
    throw new Error(`团队 Token 配置缺少 tokens 数组：${path}`);
  }
  return parsed.tokens.map((entry, index) => parseTeamTokenRecord(entry, path, index));
}

function parseTeamTokenRecord(entry: unknown, path: string, index: number): TeamTokenRecord {
  const where = `${path} tokens[${index}]`;
  if (typeof entry !== "object" || entry === null) throw new Error(`${where} 必须是对象`);
  const record = entry as Record<string, unknown>;
  const id = readString(record.id, `${where}.id`);
  const tokenHash = readString(record.tokenHash, `${where}.tokenHash`);
  if (!/^[0-9a-f]{64}$/.test(tokenHash)) {
    throw new Error(`${where}.tokenHash 必须是明文 Token 的 sha256 hex（64 位小写十六进制）`);
  }
  const userId = readString(record.userId, `${where}.userId`);
  const teamId = readString(record.teamId, `${where}.teamId`);
  if (!Array.isArray(record.roles) || record.roles.length === 0) {
    throw new Error(`${where}.roles 必须是非空数组`);
  }
  const roles = record.roles.map((role) => {
    if (typeof role !== "string" || !ROLES.includes(role as Role)) {
      throw new Error(`${where}.roles 含未知角色：${String(role)}（合法值：${ROLES.join("/")}）`);
    }
    return role as Role;
  });
  const userIds = readBoundaryDimension(record.userIds, `${where}.userIds`);
  const agentIds = readBoundaryDimension(record.agentIds, `${where}.agentIds`);
  return {
    id,
    tokenHash,
    userId,
    teamId,
    roles,
    ...(userIds === undefined ? {} : { userIds }),
    ...(agentIds === undefined ? {} : { agentIds }),
    ...(typeof record.createdAt === "string" ? { createdAt: record.createdAt } : {}),
    ...(record.revoked === true ? { revoked: true } : {}),
  };
}

/**
 * 边界维度取值：JSON 里是 "*"（整个租户/不限制）或非空字符串数组（显式白名单）；
 * 缺省由 toPrincipal 给各自默认值。
 */
function readBoundaryDimension(value: unknown, where: string): readonly string[] | "*" | undefined {
  if (value === undefined) return undefined;
  if (value === "*") return "*";
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim().length === 0)) {
    throw new Error(`${where} 必须是 "*" 或非空字符串数组`);
  }
  return value as string[];
}

function readString(value: unknown, where: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${where} 必须是非空字符串`);
  return value.trim();
}
