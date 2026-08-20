import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { vi } from "vitest";

import type { ApiClient } from "../lib/api";
import { MemoryPage } from "./MemoryPage";

test("lists memories and creates a draft from evidence", async () => {
  const api = {
    listMemories: vi.fn(async () => [{
      id: "mem-1",
      layer: "l1",
      content: "用户偏好简洁的中文架构报告",
      scope: { userId: "local-admin", teamId: "local", agentId: "default" },
      governance: { status: "verified", confidence: 0.95, createdReason: "明确偏好", createdAt: "2026-08-20T00:00:00Z", updatedAt: "2026-08-20T00:00:00Z", sensitivity: "normal" },
      sources: [],
    }]),
    createMemory: vi.fn(async () => undefined),
    transitionMemory: vi.fn(async () => undefined),
  } as unknown as ApiClient;

  render(<MemoryPage api={api} />);
  expect((await screen.findAllByText("用户偏好简洁的中文架构报告")).length).toBeGreaterThan(0);

  fireEvent.click(screen.getByRole("button", { name: "新建记忆" }));
  fireEvent.change(screen.getByLabelText("原始证据"), { target: { value: "用户要求回答简洁" } });
  fireEvent.change(screen.getByLabelText("记忆内容"), { target: { value: "用户偏好简洁回答" } });
  fireEvent.click(screen.getByRole("button", { name: "保存为草稿" }));

  await waitFor(() => expect(api.createMemory).toHaveBeenCalledWith(expect.objectContaining({
    evidence: "用户要求回答简洁",
    content: "用户偏好简洁回答",
  })));
});

test("shows memory creation errors inside the dialog", async () => {
  const api = {
    listMemories: vi.fn(async () => []),
    createMemory: vi.fn(async () => { throw new Error("记忆保存失败"); }),
  } as unknown as ApiClient;
  render(<MemoryPage api={api} />);
  await screen.findByText("还没有记忆，从一条证据开始。");
  fireEvent.click(screen.getByRole("button", { name: "新建记忆" }));
  fireEvent.change(screen.getByLabelText("原始证据"), { target: { value: "证据" } });
  fireEvent.change(screen.getByLabelText("记忆内容"), { target: { value: "内容" } });
  fireEvent.click(screen.getByRole("button", { name: "保存为草稿" }));
  expect(await screen.findByText("记忆保存失败")).toBeInTheDocument();
});
