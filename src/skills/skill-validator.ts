import type { SourceReference } from "../governance/types.js";
import { containsPlaceholderContent, containsSensitiveContent } from "../extraction/validators.js";
import { findSectionByAliases, parseSkillMarkdown } from "./skill-markdown.js";

/**
 * Skill 质量校验器（Task 13）。
 *
 * 与提案流水线的硬拒绝校验不同，这里是面向"发布前审核"的结构化质量报告：
 * 错误（error）表示不该被 Verify 的硬伤（格式、占位、敏感信息、来源悬空），
 * 警告（warning）表示质量短板（缺触发条件、缺失败处理等），由人决定是否放行。
 * 校验器只产出报告，不改写资产，也不阻塞任何治理操作。
 */

export type SkillValidationSeverity = "error" | "warning";

export interface SkillValidationIssue {
  /** 问题所属部分：name / description / content / frontmatter / sources。 */
  field: string;
  /** 稳定问题码，供 UI 与测试断言，文案改动不影响程序判断。 */
  code: string;
  severity: SkillValidationSeverity;
  /** 中文说明，面向审核者。 */
  message: string;
}

export interface SkillValidationReport {
  /** 是否存在 error 级问题。 */
  valid: boolean;
  /** 全部问题（含警告），按校验顺序排列。 */
  issues: SkillValidationIssue[];
}

/** 各章节的中文/英文标题别名：命中任一即视为该能力章节存在。 */
const TRIGGER_SECTION_ALIASES = ["when to use", "when to run", "何时使用", "触发条件", "使用时机", "适用场景"];
const WORKFLOW_SECTION_ALIASES = ["workflow", "steps", "工作流", "步骤", "执行步骤", "操作步骤"];
const VERIFICATION_SECTION_ALIASES = ["verification", "verify", "验证", "验证方式", "如何验证"];
const FAILURE_SECTION_ALIASES = ["failure", "failures", "failure handling", "error handling", "失败处理", "故障处理", "失败", "错误处理", "回退"];

/** 可执行步骤的最低要求：编号列表或无序列表项。 */
const STEP_PATTERN = /(^|\n)\s*(?:\d+[.、)]\s+\S|- \S)/;

export interface SkillValidationInput {
  name: string;
  description: string;
  content: string;
  sources: SourceReference[];
  /** 来源存在性检查：Evidence 被删除后来源会悬空，需要在这里暴露。 */
  sourceExists?: (evidenceId: string) => boolean;
}

/** 校验一份 Skill 文档，返回结构化质量报告（不抛异常）。 */
export function validateSkillDocument(input: SkillValidationInput): SkillValidationReport {
  const issues: SkillValidationIssue[] = [];
  const error = (field: string, code: string, message: string): void => {
    issues.push({ field, code, severity: "error", message });
  };
  const warn = (field: string, code: string, message: string): void => {
    issues.push({ field, code, severity: "warning", message });
  };

  // 名称与描述：格式与一致性是硬性要求
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.name)) {
    error("name", "NAME_FORMAT", "name 必须是 kebab-case（小写字母、数字与连字符）");
  }
  if (!input.description.trim()) {
    error("description", "DESCRIPTION_EMPTY", "description 不能为空");
  }

  // 内容安全红线：占位内容与敏感信息（密钥等）不允许进入长期资产
  if (containsPlaceholderContent(input.content)) {
    error("content", "PLACEHOLDER_CONTENT", "内容包含占位文本（如 Describe the trigger conditions / 待补充），需补全后再审核");
  }
  if (containsSensitiveContent(`${input.name} ${input.description} ${input.content}`)) {
    error("content", "SENSITIVE_CONTENT", "疑似包含敏感信息（如密钥），密钥只能保存在环境变量中");
  }

  // frontmatter：必须存在且与字段一致
  const parsed = parseSkillMarkdown(input.content);
  if (parsed.frontmatterRaw === null) {
    error("frontmatter", "FRONTMATTER_MISSING", "缺少 YAML frontmatter（--- 包裹的头部）");
  } else if (parsed.frontmatterError !== null) {
    error("frontmatter", "FRONTMATTER_INVALID", `frontmatter 解析失败：${parsed.frontmatterError}`);
  } else {
    const frontmatter = parsed.frontmatter!;
    if (frontmatter.name !== input.name) {
      error("frontmatter", "FRONTMATTER_NAME_MISMATCH", "frontmatter 的 name 必须与 Skill 名称一致");
    }
    if (frontmatter.description !== input.description) {
      error("frontmatter", "FRONTMATTER_DESCRIPTION_MISMATCH", "frontmatter 的 description 必须与描述字段一致");
    }
  }

  // 结构完整性：触发条件 / 步骤 / 验证方式 / 失败处理
  const sections = parsed.sections;
  const trigger = findSectionByAliases(sections, TRIGGER_SECTION_ALIASES);
  if (!trigger || !trigger.body.trim()) {
    warn("content", "TRIGGER_MISSING", "缺少触发条件章节（When to use / 何时使用），Agent 难以判断何时采用");
  }
  const workflow = findSectionByAliases(sections, WORKFLOW_SECTION_ALIASES);
  if (!workflow || !workflow.body.trim()) {
    warn("content", "WORKFLOW_MISSING", "缺少工作流章节（Workflow / 步骤），内容只是描述而非可执行方法");
  } else if (!STEP_PATTERN.test(workflow.body)) {
    warn("content", "STEPS_MISSING", "工作流章节缺少编号或列表步骤，无法按序执行");
  }
  if (!findSectionByAliases(sections, VERIFICATION_SECTION_ALIASES)) {
    warn("content", "VERIFICATION_MISSING", "缺少验证方式章节（Verification / 如何验证），无法判断执行结果是否正确");
  }
  if (!findSectionByAliases(sections, FAILURE_SECTION_ALIASES)) {
    warn("content", "FAILURE_HANDLING_MISSING", "缺少失败处理章节（失败处理 / Failure），执行偏离时没有恢复路径");
  }

  // 来源溯源：无来源是质量短板（人工新建允许后补），来源悬空是硬伤
  if (input.sources.length === 0) {
    warn("sources", "SOURCES_EMPTY", "没有来源证据，无法追溯到原始对话");
  } else if (input.sourceExists) {
    for (const source of input.sources) {
      if (!input.sourceExists(source.evidenceId)) {
        error("sources", "SOURCE_DANGLING", `来源证据已不存在：${source.evidenceId}`);
      }
    }
  }

  return { valid: !issues.some((issue) => issue.severity === "error"), issues };
}
