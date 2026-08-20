import { vi } from "vitest";

import { ApiClient } from "./api";

test("quotes user-provided skill metadata in YAML frontmatter", async () => {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({}));
  vi.stubGlobal("fetch", fetchMock);

  await new ApiClient("test-key").createSkill({
    name: "review-code",
    description: "审查范围: 代码",
  });

  const init = fetchMock.mock.calls[0]?.[1];
  expect(init).toBeDefined();
  if (!init) throw new Error("request init missing");
  const body = JSON.parse(String(init.body)) as { content: string };
  expect(body.content).toContain('description: "审查范围: 代码"');
});

test("notifies the shell when an API request is unauthorized", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(
    { error: "UNAUTHORIZED", message: "authentication required" },
    { status: 401 },
  )));
  const unauthorized = vi.fn();

  await expect(new ApiClient("expired-key", unauthorized).listMemories()).rejects.toMatchObject({ status: 401 });
  expect(unauthorized).toHaveBeenCalledOnce();
});
