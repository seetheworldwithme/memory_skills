import assert from "node:assert/strict";
import test from "node:test";

import { validateSkillDocument } from "../src/skills/skill-validator.js";

/** 一份结构完整的参考 Skill：触发条件、步骤、验证、失败处理齐备。 */
function fullSkillContent(description: string, workflow: string): string {
  return [
    "---",
    "name: release-checklist",
    `description: ${description}`,
    "---",
    "",
    "# release-checklist",
    "",
    "## When to use",
    "",
    "发布新版本前、改动检索算法后需要完整回归。",
    "",
    "## Workflow",
    "",
    workflow,
    "",
    "## Verification",
    "",
    "npm test 与 npm run eval:retrieval 全部通过。",
    "",
    "## Failure handling",
    "",
    "评测指标退化时先回滚算法改动，再重新定位问题。",
    "",
  ].join("\n");
}

test("a complete skill passes validation without issues", () => {
  const report = validateSkillDocument({
    name: "release-checklist",
    description: "发布前执行完整回归检查",
    content: fullSkillContent("发布前执行完整回归检查", "1. 运行单元测试\n2. 运行离线评测"),
    sources: [{ evidenceId: "ev-1", capturedAt: "2026-08-20T00:00:00Z" }],
    sourceExists: () => true,
  });
  assert.deepEqual(report.issues, []);
  assert.equal(report.valid, true);
});

test("placeholder and sensitive content are errors, not warnings", () => {
  const placeholder = validateSkillDocument({
    name: "release-checklist",
    description: "占位描述",
    content: "---\nname: release-checklist\ndescription: 占位描述\n---\n\n## When to use\n\nDescribe the trigger conditions.\n",
    sources: [],
  });
  assert.equal(placeholder.valid, false);
  assert.ok(placeholder.issues.some((issue) => issue.code === "PLACEHOLDER_CONTENT" && issue.severity === "error"));

  const sensitive = validateSkillDocument({
    name: "release-checklist",
    description: "包含密钥",
    content: "---\nname: release-checklist\ndescription: 包含密钥\n---\n\napi_key=sk-abcdefgh1234567890\n",
    sources: [],
  });
  assert.ok(sensitive.issues.some((issue) => issue.code === "SENSITIVE_CONTENT" && issue.severity === "error"));
});

test("name format and frontmatter consistency are errors", () => {
  const report = validateSkillDocument({
    name: "Release Checklist",
    description: "描述",
    content: "---\nname: release-checklist\ndescription: 描述\n---\n\n正文",
    sources: [],
  });
  assert.equal(report.valid, false);
  assert.ok(report.issues.some((issue) => issue.code === "NAME_FORMAT"));
  assert.ok(report.issues.some((issue) => issue.code === "FRONTMATTER_NAME_MISMATCH"));

  const missing = validateSkillDocument({
    name: "release-checklist",
    description: "描述",
    content: "没有 frontmatter 的正文",
    sources: [],
  });
  assert.ok(missing.issues.some((issue) => issue.code === "FRONTMATTER_MISSING"));
});

test("missing structure sections are warnings so humans decide", () => {
  const report = validateSkillDocument({
    name: "release-checklist",
    description: "只有描述没有结构",
    content: "---\nname: release-checklist\ndescription: 只有描述没有结构\n---\n\n只有一段散文描述。",
    sources: [],
  });
  // 结构缺失是警告：文档可用但质量有短板，不阻止人工 Verify
  assert.equal(report.valid, true);
  const codes = report.issues.filter((issue) => issue.severity === "warning").map((issue) => issue.code);
  assert.ok(codes.includes("TRIGGER_MISSING"));
  assert.ok(codes.includes("WORKFLOW_MISSING"));
  assert.ok(codes.includes("VERIFICATION_MISSING"));
  assert.ok(codes.includes("FAILURE_HANDLING_MISSING"));
  assert.ok(codes.includes("SOURCES_EMPTY"));
});

test("workflow section without steps is flagged", () => {
  const report = validateSkillDocument({
    name: "release-checklist",
    description: "工作流没有步骤",
    content: fullSkillContent("工作流没有步骤", "先做测试，再做评测。"),
    sources: [],
  });
  assert.ok(report.issues.some((issue) => issue.code === "STEPS_MISSING" && issue.severity === "warning"));
});

test("chinese section aliases are recognized", () => {
  const content = [
    "---",
    "name: release-checklist",
    "description: 中文章节别名",
    "---",
    "",
    "## 何时使用",
    "",
    "发布前使用。",
    "",
    "## 工作流",
    "",
    "1. 跑测试",
    "",
    "## 如何验证",
    "",
    "看结果。",
    "",
    "## 失败处理",
    "",
    "回滚。",
    "",
  ].join("\n");
  const report = validateSkillDocument({
    name: "release-checklist",
    description: "中文章节别名",
    content,
    sources: [],
  });
  assert.deepEqual(
    report.issues.filter((issue) => issue.severity === "warning").map((issue) => issue.code),
    ["SOURCES_EMPTY"],
  );
});

test("dangling sources are errors once the evidence is gone", () => {
  const report = validateSkillDocument({
    name: "release-checklist",
    description: "来源已删除",
    content: fullSkillContent("来源已删除", "1. 检查"),
    sources: [{ evidenceId: "ev-gone", capturedAt: "2026-08-20T00:00:00Z" }],
    sourceExists: () => false,
  });
  assert.equal(report.valid, false);
  assert.ok(report.issues.some((issue) => issue.code === "SOURCE_DANGLING" && issue.severity === "error"));
});
