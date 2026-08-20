import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { vi } from "vitest";

import type { ApiClient } from "../lib/api";
import { SkillsPage } from "./SkillsPage";

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
  } as unknown as ApiClient;
  render(<SkillsPage api={api} />);
  await screen.findByText("还没有 Skill，先创建一份可执行方法。");
  fireEvent.click(screen.getByRole("button", { name: "新建 Skill" }));
  fireEvent.change(screen.getByLabelText("名称"), { target: { value: "review-code" } });
  fireEvent.change(screen.getByLabelText("描述"), { target: { value: "审查代码" } });
  fireEvent.click(screen.getByRole("button", { name: "创建草稿" }));
  expect(await screen.findByText("Skill 创建失败")).toBeInTheDocument();
});
