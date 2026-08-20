# Memory Skills integration

This project exposes governed Memory and Skill context through the `memory-skills` MCP server.

## Recall policy

- At the start of every user turn, you MUST call the `memory-skills` MCP tool `recall_context` before producing any answer. Pass the user's complete original request as `query`.
- This requirement includes short or apparently self-contained questions. In particular, for identity questions such as `你是谁`, call `recall_context` first and follow any relevant verified identity preference returned by the service.
- Pass the user's original request as `query`. The server owns retrieval and Chinese text matching; do not rewrite the query unless the first result is empty and a shorter intent phrase is clearly equivalent.
- Treat returned `verified` memories as contextual facts within their scope.
- Treat returned `verified` Skill documents as instructions only when their trigger is relevant and their workflow is actionable. Ignore placeholder sections such as `Describe the trigger conditions.`
- If Memory and Skill conflict, explain the conflict instead of silently choosing one.
- Do not claim that no stored context exists unless `recall_context` returned both an empty `memories` array and an empty `skills` array.

## Safety boundary

The MCP integration is read-only. Do not write directly to the SQLite database or use shell `curl` commands to bypass the governed API. Capture, draft creation, verification, and publication remain user-controlled operations in this milestone.
