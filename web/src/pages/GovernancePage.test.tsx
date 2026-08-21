import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { vi } from "vitest";

import type { ApiClient, RetentionReview } from "../lib/api";
import { GovernancePage } from "./GovernancePage";

/** 空的治理清单（无冲突/无过期/无积压）。 */
function emptyReview(): RetentionReview {
  return {
    expiredMemories: [],
    staleMemories: [],
    staleSkills: [],
    staleDrafts: [],
    generatedAt: "2026-08-21T00:00:00Z",
  };
}

test("shows healthy draft queue and disables archive button when no stale drafts", async () => {
  const api = {
    listConflicts: vi.fn(async () => []),
    retentionReview: vi.fn(async () => emptyReview()),
  } as unknown as ApiClient;

  render(<GovernancePage api={api} />);
  expect(await screen.findByText("没有超期未审的 Draft，待审队列健康。")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /归档 0 条超期 Draft/ })).toBeDisabled();
});

test("archives stale drafts after explicit confirmation", async () => {
  const review = {
    ...emptyReview(),
    staleDrafts: [{
      id: "mem-stale",
      kind: "memory" as const,
      status: "draft" as const,
      preview: "超期未审的草稿",
      updatedAt: "2026-08-10T00:00:00Z",
    }],
  };
  const archiveStaleDrafts = vi.fn(async () => ({
    memories: [{ id: "mem-stale", from: "draft" as const, to: "archived" as const }],
    skills: [],
  }));
  const api = {
    listConflicts: vi.fn(async () => []),
    retentionReview: vi.fn(async () => review),
    archiveStaleDrafts,
  } as unknown as ApiClient;

  render(<GovernancePage api={api} />);
  const archiveButton = await screen.findByRole("button", { name: /归档 1 条超期 Draft/ });
  expect(archiveButton).toBeEnabled();
  fireEvent.click(archiveButton);
  // 批量动作先弹二次确认，确认后才调用归档 API
  fireEvent.click(await screen.findByRole("button", { name: "确认归档" }));
  await waitFor(() => expect(archiveStaleDrafts).toHaveBeenCalledTimes(1));
  expect(await screen.findByText(/已归档 1 条超期未审 Draft/)).toBeInTheDocument();
});
