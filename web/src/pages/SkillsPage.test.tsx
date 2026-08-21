import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { vi } from "vitest";

import type { ApiClient } from "../lib/api";
import { SkillsPage } from "./SkillsPage";

/** 详情面板的配套数据 mock：校验报告 / 版本历史 / 差异 / 使用效果。 */
function detailMocks() {
  return {
    validateSkill: vi.fn(async () => ({ valid: true, issues: [] })),
    listSkillVersions: vi.fn(async () => [{
      skillId: "skill-1",
      version: 1,
      content: "---\nname: verify-release\n---\n\n# Steps",
      status: "verified" as const,
      createdAt: "2026-08-20T00:00:00Z",
    }]),
    skillDiff: vi.fn(async () => ({
      fromVersion: null,
      toVersion: 1,
      entries: [],
      summary: "首个版本，没有可比较的历史版本",
    })),
    skillRunSummary: vi.fn(async () => ({
      skillId: "skill-1",
      version: 1,
      runs: { recalled: 0, adopted: 0, succeeded: 0, failed: 0 },
      feedback: { useful: 0, irrelevant: 0, incorrect: 0, outdated: 0 },
      verdict: "no-evidence" as const,
      verdictLabel: "暂无使用记录，不宣称该 Skill 有效",
      hasEvidence: false,
    })),
    rollbackSkill: vi.fn(async () => undefined),
  };
}

test("lists skills and creates a draft SKILL document", async () => {
  const api = {
    listSkills: vi.fn(async () => [{
      id: "skill-1",
      name: "verify-release",
      description: "发布前执行完整验证",
      content: "---\nname: verify-release\ndescription: 发布前执行完整验证\n---\n\n# Steps",
      version: 1,
      status: "verified",
      scope: { userId: "local-admin", teamId: "local", agentId: "default" },
      sources: [],
      createdAt: "2026-08-20T00:00:00Z",
      updatedAt: "2026-08-20T00:00:00Z",
    }]),
    createSkill: vi.fn(async () => undefined),
    transitionSkill: vi.fn(async () => undefined),
    ...detailMocks(),
  } as unknown as ApiClient;

  render(<SkillsPage api={api} />);
  expect((await screen.findAllByText("verify-release")).length).toBeGreaterThan(0);

  fireEvent.click(screen.getByRole("button", { name: "新建 Skill" }));
  fireEvent.change(screen.getByLabelText("名称"), { target: { value: "review-code" } });
  fireEvent.change(screen.getByLabelText("描述"), { target: { value: "执行结构化代码审查" } });
  fireEvent.click(screen.getByRole("button", { name: "创建草稿" }));

  await waitFor(() => expect(api.createSkill).toHaveBeenCalledWith(expect.objectContaining({
    name: "review-code",
    description: "执行结构化代码审查",
  })));
});

test("shows skill creation errors inside the dialog", async () => {
  const api = {
    listSkills: vi.fn(async () => []),
    createSkill: vi.fn(async () => { throw new Error("Skill 创建失败"); }),
    ...detailMocks(),
  } as unknown as ApiClient;
  render(<SkillsPage api={api} />);
  await screen.findByText("还没有 Skill，先创建一份可执行方法。");
  fireEvent.click(screen.getByRole("button", { name: "新建 Skill" }));
  fireEvent.change(screen.getByLabelText("名称"), { target: { value: "review-code" } });
  fireEvent.change(screen.getByLabelText("描述"), { target: { value: "审查代码" } });
  fireEvent.click(screen.getByRole("button", { name: "创建草稿" }));
  expect(await screen.findByText("Skill 创建失败")).toBeInTheDocument();
});

test("detail pane renders quality validation and run summary evidence", async () => {
  const api = {
    listSkills: vi.fn(async () => [{
      id: "skill-9",
      name: "deploy-service",
      description: "按清单部署服务",
      content: "---\nname: deploy-service\ndescription: 按清单部署服务\n---\n\n# Workflow",
      version: 2,
      status: "draft",
      scope: { userId: "local-admin", teamId: "local", agentId: "default" },
      sources: [],
      createdAt: "2026-08-20T00:00:00Z",
      updatedAt: "2026-08-20T00:00:00Z",
    }]),
    createSkill: vi.fn(async () => undefined),
    transitionSkill: vi.fn(async () => undefined),
    validateSkill: vi.fn(async () => ({
      valid: false,
      issues: [{ field: "content", code: "TRIGGER_MISSING", severity: "warning", message: "缺少触发条件章节（When to use / 何时使用），Agent 难以判断何时采用" }],
    })),
    listSkillVersions: vi.fn(async () => [
      { skillId: "skill-9", version: 2, content: "v2", status: "draft" as const, createdAt: "2026-08-21T00:00:00Z" },
      { skillId: "skill-9", version: 1, content: "v1", status: "verified" as const, createdAt: "2026-08-20T00:00:00Z" },
    ]),
    skillDiff: vi.fn(async () => ({
      fromVersion: 1,
      toVersion: 2,
      entries: [{ kind: "section", change: "modified", target: "Workflow", addedLines: ["2. 健康检查"], removedLines: [] }],
      summary: "章节「Workflow」改动 1 增 / 0 删",
    })),
    skillRunSummary: vi.fn(async () => ({
      skillId: "skill-9",
      version: 2,
      runs: { recalled: 3, adopted: 2, succeeded: 2, failed: 0 },
      feedback: { useful: 1, irrelevant: 0, incorrect: 0, outdated: 0 },
      verdict: "supported" as const,
      verdictLabel: "有正向使用证据支撑",
      hasEvidence: true,
    })),
    rollbackSkill: vi.fn(async () => undefined),
  } as unknown as ApiClient;

  render(<SkillsPage api={api} />);
  // 质量校验的问题信息直接可见
  expect(await screen.findByText(/缺少触发条件章节/)).toBeInTheDocument();
  // 版本差异：新增行可见
  expect(await screen.findByText("2. 健康检查")).toBeInTheDocument();
  // 使用效果结论可见
  expect(await screen.findByText("有正向使用证据支撑")).toBeInTheDocument();
  // 历史版本可回滚
  const rollbackButton = await screen.findByRole("button", { name: "回滚到此版本" });
  fireEvent.click(rollbackButton);
  await waitFor(() => expect(api.rollbackSkill).toHaveBeenCalledWith("skill-9", 1));
});
