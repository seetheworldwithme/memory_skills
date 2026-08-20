import type { MemoryCandidate, SkillCandidate } from "./prompt-registry.js";

/**
 * 提案候选校验器：模型输出在成为 Draft 之前必须通过这里的检查。
 * 校验失败不抛异常，而是收集拒因交给提案报告——审核者能看到模型为什么被拦下。
 */

/** 占位内容黑名单：命中任意一条即拒绝（含 Web 手动建 Skill 模板中的英文占位句）。 */
const PLACEHOLDER_PATTERNS: RegExp[] = [
  /describe the trigger conditions/i,
  /describe the first step/i,
  /describe how to verify/i,
  /lorem ipsum/i,
  /\btodo\b/i,
  /待补充/,
  /占位符?/,
];

/** 疑似敏感信息模式：命中则拒绝入库，防止密钥被写进长期记忆。 */
const SENSITIVE_PATTERNS: RegExp[] = [
  /sk-[a-z0-9_-]{16,}/i,
  /api[_-]?key\s*[:=]/i,
  /password\s*[:=]/i,
  /secret\s*[:=]/i,
  /token\s*[:=]\s*[a-z0-9]{12,}/i,
  /bearer\s+[a-z0-9._-]{16,}/i,
];

/** 内容归一化：压缩空白并统一小写，用于重复检测。 */
export function normalizeForDedup(content: string): string {
  return content.replace(/\s+/g, "").toLowerCase();
}

/** 记忆候选校验，返回拒因列表（空数组表示通过）。 */
export function validateMemoryCandidate(candidate: MemoryCandidate): string[] {
  const reasons: string[] = [];
  if (candidate.content.replace(/\s+/g, "").length < 6) reasons.push("内容过于简短");
  if (PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(candidate.content))) reasons.push("包含占位内容");
  if (SENSITIVE_PATTERNS.some((pattern) => pattern.test(candidate.content))) reasons.push("疑似包含敏感信息（如密钥）");
  if (!candidate.reason.trim()) reasons.push("缺少提取理由");
  if (candidate.evidenceRefs.length === 0) reasons.push("缺少来源证据引用");
  return reasons;
}

/** Skill 候选校验，返回拒因列表（空数组表示通过）。 */
export function validateSkillCandidate(candidate: SkillCandidate): string[] {
  const reasons: string[] = [];
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(candidate.name)) reasons.push("name 必须是 kebab-case");
  if (!candidate.description.trim()) reasons.push("description 不能为空");
  if (PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(candidate.content))) reasons.push("SKILL.md 包含占位内容");
  if (SENSITIVE_PATTERNS.some((pattern) => pattern.test(`${candidate.name} ${candidate.description} ${candidate.content}`))) {
    reasons.push("疑似包含敏感信息（如密钥）");
  }
  const frontmatter = candidate.content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!frontmatter) {
    reasons.push("SKILL.md 缺少 frontmatter");
  } else if (
    !frontmatter[1]!.includes(candidate.name)
    || !frontmatter[1]!.includes(candidate.description)
  ) {
    reasons.push("frontmatter 的 name/description 与字段不一致");
  }
  // 可执行性最低要求：至少一个编号步骤，否则只是描述而非工作流
  if (!/(^|\n)\s*(?:\d+[.、)]|- )/.test(candidate.content)) reasons.push("缺少可执行步骤");
  if (candidate.evidenceRefs.length === 0) reasons.push("缺少来源证据引用");
  return reasons;
}

/** 归一化内容是否与既有内容重复（同批候选或库内现存资产）。 */
export function isDuplicateContent(content: string, existingNormalized: ReadonlySet<string>): boolean {
  return existingNormalized.has(normalizeForDedup(content));
}
