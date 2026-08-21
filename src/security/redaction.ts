/**
 * 输出侧脱敏（Task 16）：与 EventSink 的"整条替换"兜底互补，
 * 这里做的是字段内替换——把疑似密钥的文本片段替换为占位符、超长正文截断。
 * 用于审计备注、错误消息等允许携带自由文本、但绝不允许携带密钥的场景。
 */

/** 脱敏占位符：所有替换统一使用同一标记，便于审计时辨认。 */
export const REDACTED = "[REDACTED]";

/**
 * 疑似密钥模式：与 extraction/validators.ts 的 SENSITIVE_PATTERNS 同族，
 * 但用途相反——那是"输入侧拒绝入库"，这里是"输出侧替换泄漏"。
 */
const SECRET_LIKE_PATTERNS: RegExp[] = [
  /sk-[a-z0-9_-]{16,}/gi,
  /bearer\s+[a-z0-9._-]{16,}/gi,
  /(api[_-]?key|password|secret|token)\s*[:=]\s*["']?[a-z0-9._-]{12,}/gi,
];

/** 通用十六进制/base64 长随机串：常见于各家密钥格式（至少 32 位）。 */
const HIGH_ENTROPY_BLOB = /\b[a-f0-9]{32,}\b/gi;

export interface RedactionOptions {
  /** 精确禁止值（Access Key、模型密钥等）：完整命中即整体替换。 */
  forbiddenValues?: readonly string[];
  /** 单字段最大长度：超出截断并追加省略标记，防止正则绕过与正文泄漏。 */
  maxFieldLength?: number;
}

const DEFAULT_MAX_FIELD_LENGTH = 200;

/** 把字符串中的疑似密钥与禁止值替换为 [REDACTED]，并按需截断。 */
export function redactText(value: string, options: RedactionOptions = {}): string {
  let redacted = value;
  for (const forbidden of options.forbiddenValues ?? []) {
    if (forbidden.trim().length === 0) continue;
    // 全局替换需要转义正则元字符；禁止值来自配置而非用户输入
    redacted = redacted.split(forbidden).join(REDACTED);
  }
  for (const pattern of SECRET_LIKE_PATTERNS) {
    redacted = redacted.replace(pattern, REDACTED);
  }
  redacted = redacted.replace(HIGH_ENTROPY_BLOB, REDACTED);
  const max = options.maxFieldLength ?? DEFAULT_MAX_FIELD_LENGTH;
  if (redacted.length > max) {
    return `${redacted.slice(0, max)}…[truncated]`;
  }
  return redacted;
}

/** 深度脱敏 JSON 结构：字符串字段逐个替换，数组与对象递归，其余类型原样返回。 */
export function redactJson(value: unknown, options: RedactionOptions = {}): unknown {
  if (typeof value === "string") return redactText(value, options);
  if (Array.isArray(value)) return value.map((item) => redactJson(item, options));
  if (typeof value === "object" && value !== null) {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = redactJson(item, options);
    }
    return result;
  }
  return value;
}
