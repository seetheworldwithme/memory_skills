import { z } from "zod";

/**
 * 提取任务的 Prompt 注册表。
 * 每个任务的 Prompt 与版本绑定：提案报告携带 promptVersion，
 * 使任何 Draft 都能追溯到"哪个版本的指令 + 哪个模型"产出它。
 */

export interface ExtractionPrompt<T> {
  /** 传给 Provider 的任务标识（用于指标统计）。 */
  task: string;
  /** Prompt 版本号；修改指令内容必须提升版本。 */
  promptVersion: string;
  /** 输出结构名。 */
  schemaName: string;
  /** 输出结构校验。 */
  schema: z.ZodType<T>;
  /** 任务指令（发给模型的 system prompt）。 */
  systemPrompt: string;
}

/** 记忆候选：evidenceRefs 是输入列表中的证据编号，服务端映射回真实 ID。 */
const memoryCandidateSchema = z.object({
  layer: z.enum(["l1", "l2", "l3"]),
  content: z.string(),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
  evidenceRefs: z.array(z.number().int().min(1)),
});
export type MemoryCandidate = z.infer<typeof memoryCandidateSchema>;

/** Skill 候选：content 是完整 SKILL.md 文档（含 frontmatter）。 */
const skillCandidateSchema = z.object({
  name: z.string(),
  description: z.string(),
  content: z.string(),
  evidenceRefs: z.array(z.number().int().min(1)),
});
export type SkillCandidate = z.infer<typeof skillCandidateSchema>;

export const MEMORY_EXTRACTION_PROMPT: ExtractionPrompt<{ candidates: MemoryCandidate[] }> = {
  task: "memory-extraction",
  promptVersion: "memory-extraction-v2",
  schemaName: "memory_candidates",
  schema: z.object({ candidates: z.array(memoryCandidateSchema) }),
  systemPrompt: [
    "你从对话证据中提取用户的长期记忆候选（事实、偏好、项目决策）。",
    "规则：",
    "- 只提取稳定、可长期复用的信息；忽略一次性闲聊、临时状态和与用户无关的内容；",
    "- 已完成的工作与里程碑（如某项修复/功能已落地、验证通过、关键提交号）属于项目事实，",
    "  应单独成条而不是并入泛化的偏好总结；",
    "- layer 含义：l1=具体事实与偏好，l2=主题层面的规律总结，l3=全局画像；不确定时用 l1；",
    "- content 用简洁的中文陈述句，独立可读，不要写“用户说过”这类转述前缀；",
    "- confidence 为 0 到 1 之间的置信度；reason 简要说明提取依据；",
    "- evidenceRefs 填写支撑该记忆的证据编号（正整数数组，编号见输入列表），不得虚构编号；",
    "- 相互重复的信息只输出一条；没有值得提取的信息时返回空的 candidates 数组。",
  ].join("\n"),
};

export const SKILL_EXTRACTION_PROMPT: ExtractionPrompt<{ candidates: SkillCandidate[] }> = {
  task: "skill-extraction",
  promptVersion: "skill-extraction-v1",
  schemaName: "skill_candidates",
  schema: z.object({ candidates: z.array(skillCandidateSchema) }),
  systemPrompt: [
    "你从对话证据中提取可复用的 Skill 候选（可执行的工作方法）。",
    "规则：",
    "- 只有当证据中存在明确、可步骤化复用的工作流时才生成候选；普通偏好和事实不是 Skill；",
    "- name 用小写字母与连字符（kebab-case）；description 一句话说明触发场景与用途；",
    "- content 是完整的 SKILL.md 文档：以 YAML frontmatter 开头（name 与 description 必须和字段值完全一致），",
    "  正文包含“何时使用（触发条件）”“工作流（编号步骤）”“失败处理”“验证方式”四个小节，禁止任何占位文本；",
    "- evidenceRefs 填写支撑该 Skill 的证据编号（正整数数组，编号见输入列表），不得虚构编号；",
    "- 没有可提取的工作流时返回空的 candidates 数组。",
  ].join("\n"),
};
