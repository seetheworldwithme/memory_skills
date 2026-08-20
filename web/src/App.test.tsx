import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { vi } from "vitest";

import { App } from "./App";

test("valid access key opens the two-page console", async () => {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/v1/auth/login")) {
      return Response.json({ authenticated: true, user: { id: "local-admin", name: "Local Administrator" } });
    }
    if (url.endsWith("/v1/memories/list") || url.endsWith("/v1/skills/list")) {
      return Response.json({ items: [] });
    }
    return Response.json({ error: "NOT_FOUND" }, { status: 404 });
  }));

  render(<App />);
  expect(screen.getByRole("heading", { name: "登录 Memory Skills" })).toBeInTheDocument();

  fireEvent.change(screen.getByLabelText("访问密钥"), { target: { value: "test-secret-key" } });
  fireEvent.click(screen.getByRole("button", { name: "进入控制台" }));

  await waitFor(() => expect(screen.getByText("Chat Memory")).toBeInTheDocument());
  expect(screen.getByText("Skill")).toBeInTheDocument();
  expect(screen.queryByText("Wiki")).not.toBeInTheDocument();
});

test("revalidates a stored key before restoring the console", async () => {
  localStorage.setItem("memory-skills.access-key", "expired-key");
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(
    { error: "UNAUTHORIZED", message: "invalid access key" },
    { status: 401 },
  )));

  render(<App />);

  expect(await screen.findByRole("heading", { name: "登录 Memory Skills" })).toBeInTheDocument();
  expect(localStorage.getItem("memory-skills.access-key")).toBeNull();
  expect(screen.queryByRole("button", { name: "Chat Memory" })).not.toBeInTheDocument();
});
