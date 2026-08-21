/**
 * 速率限制（Task 16）：确定性固定窗口计数器，零外部依赖。
 * 限制对象：
 * - write/review 域：捕获、创建、提案、状态转换等高价值操作（防费用失控与滥用）；
 * - read 域：查询与召回（远程接入时的兜底保护）；
 * - login 域：登录尝试总量；loginFailure 域：登录失败计数（更严，防凭据爆破）。
 * 本地单人模式默认阈值宽松，几乎不可感知；可通过环境变量收紧。
 */

export interface RateLimitRule {
  /** 窗口内允许的最大次数。 */
  limit: number;
  /** 窗口长度（毫秒）。 */
  windowMs: number;
}

export interface RateLimitRules {
  login: RateLimitRule;
  loginFailure: RateLimitRule;
  write: RateLimitRule;
  read: RateLimitRule;
}

/** 默认阈值：单人本地使用不受影响，异常脚本/爆破在分钟级即被拦停。 */
export const DEFAULT_RATE_LIMIT_RULES: RateLimitRules = {
  login: { limit: 20, windowMs: 60_000 },
  loginFailure: { limit: 10, windowMs: 60_000 },
  write: { limit: 120, windowMs: 60_000 },
  read: { limit: 600, windowMs: 60_000 },
};

/** 限流域名称；与 RateLimitRules 的键一一对应。 */
export type RateLimitDomain = keyof RateLimitRules;

interface WindowCounter {
  windowStart: number;
  count: number;
}

/** 固定窗口计数器的内存上限：超过后清理过期窗口，防止恶意构造 key 撑爆内存。 */
const MAX_TRACKED_KEYS = 50_000;

export interface RateLimitVerdict {
  allowed: boolean;
  /** 建议客户端等待的秒数（仅拒绝时有意义）。 */
  retryAfterSeconds: number;
}

export class RateLimiter {
  readonly #rules: RateLimitRules;
  readonly #counters = new Map<string, WindowCounter>();
  #now: () => number;

  constructor(rules: RateLimitRules = DEFAULT_RATE_LIMIT_RULES, now: () => number = Date.now) {
    this.#rules = rules;
    this.#now = now;
  }

  /**
   * 消耗一次配额并判定是否放行。
   * 固定窗口语义：窗口内第 limit+1 次被拒，窗口翻转即恢复——确定性强、可测、无锁。
   */
  consume(domain: RateLimitDomain, key: string): RateLimitVerdict {
    const rule = this.#rules[domain];
    const now = this.#now();
    const mapKey = `${domain}:${key}`;
    const current = this.#counters.get(mapKey);

    if (current === undefined || now - current.windowStart >= rule.windowMs) {
      if (this.#counters.size >= MAX_TRACKED_KEYS) this.#evictExpired(now);
      this.#counters.set(mapKey, { windowStart: now, count: 1 });
      return { allowed: true, retryAfterSeconds: 0 };
    }

    current.count += 1;
    if (current.count > rule.limit) {
      const elapsed = now - current.windowStart;
      const retryAfterSeconds = Math.max(1, Math.ceil((rule.windowMs - elapsed) / 1000));
      return { allowed: false, retryAfterSeconds };
    }
    return { allowed: true, retryAfterSeconds: 0 };
  }

  /** 清理所有已过期窗口；用于内存兜底，不影响活跃计数。 */
  #evictExpired(now: number): void {
    for (const [mapKey, counter] of this.#counters) {
      const domain = mapKey.slice(0, mapKey.indexOf(":")) as RateLimitDomain;
      if (now - counter.windowStart >= this.#rules[domain].windowMs) {
        this.#counters.delete(mapKey);
      }
    }
  }
}

type Environment = Record<string, string | undefined>;

/** 每分钟限额的环境变量名；未配置时用默认值。 */
const ENV_OVERRIDES: Record<RateLimitDomain, string> = {
  login: "MEMORY_SKILLS_RATE_LIMIT_LOGIN_PER_MIN",
  loginFailure: "MEMORY_SKILLS_RATE_LIMIT_LOGIN_FAILURE_PER_MIN",
  write: "MEMORY_SKILLS_RATE_LIMIT_WRITE_PER_MIN",
  read: "MEMORY_SKILLS_RATE_LIMIT_READ_PER_MIN",
};

/** 从环境变量解析限流规则：只允许收紧或放宽每分钟次数，窗口长度固定一分钟。 */
export function resolveRateLimitRulesFromEnv(environment: Environment): RateLimitRules {
  const rules: RateLimitRules = { ...DEFAULT_RATE_LIMIT_RULES };
  for (const domain of Object.keys(ENV_OVERRIDES) as RateLimitDomain[]) {
    const raw = environment[ENV_OVERRIDES[domain]];
    if (raw === undefined || raw.trim() === "") continue;
    const value = Number.parseInt(raw, 10);
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`${ENV_OVERRIDES[domain]} 必须是正整数（当前值：${raw}）`);
    }
    rules[domain] = { limit: value, windowMs: 60_000 };
  }
  return rules;
}
