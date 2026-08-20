import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ContextService } from "../src/context/context-service.js";
import { MemoryService } from "../src/memory/memory-service.js";
import { SkillService } from "../src/skills/skill-service.js";
import { SqliteRepository } from "../src/storage/sqlite-repository.js";
import type { Scope } from "../src/governance/types.js";
import type { EventSink } from "../src/observability/event-sink.js";
import { NoopEventSink } from "../src/observability/event-sink.js";
import { JsonlEventSink, StderrEventSink, resolveEventSinkFromEnv } from "../src/observability/jsonl-event-sink.js";
import {
  EVENT_SCHEMA_VERSION,
  serializeObservabilityEvent,
  type ObservabilityEvent,
} from "../src/observability/events.js";

/** 测试用内存事件收集器。 */
class RecordingSink implements EventSink {
  readonly events: ObservabilityEvent[] = [];
  emit(event: ObservabilityEvent): void {
    this.events.push(event);
  }
}

const scope: Scope = { userId: "obs-user", teamId: "team-obs", agentId: "agent-obs" };

// 唯一标记用于验证"事件绝不携带资产正文或查询原文"
const secretContentMarker = "OBS-SECRET-CONTENT-9f3a";
const secretQueryMarker = "OBS-SECRET-QUERY-7c1e";

function seed(repository: SqliteRepository): void {
  const memory = new MemoryService(repository);
  const skills = new SkillService(repository);
  for (let index = 1; index <= 3; index += 1) {
    const evidence = memory.capture({
      id: `obs-ev-${index}`,
      scope,
      role: "user",
      content: `证据${index}：${secretContentMarker}`,
    });
    const asset = memory.propose({
      id: `obs-mem-${index}`,
      layer: "l1",
      scope,
      content: `用户偏好说明${index}，包含${secretContentMarker}的较长正文内容用于验证召回与审计。`,
      confidence: 0.9,
      reason: "observability fixture",
      sourceEvidenceIds: [evidence.id],
    });
    memory.transition(asset.id, scope, "verified");
  }
  const skill = skills.create({
    id: "obs-skill-1",
    scope,
    name: "obs-workflow",
    description: "观测性验证用 Skill",
    content: `---\nname: obs-workflow\ndescription: 观测性验证用 Skill\n---\n\n# Workflow\n包含${secretContentMarker}的 Skill 正文。`,
    sourceEvidenceIds: [],
  });
  skills.transition(skill.id, scope, "verified");
}

test("召回成功事件携带计数、预算与策略，且不包含资产正文与查询原文", async () => {
  const repository = new SqliteRepository(":memory:");
  seed(repository);
  const sink = new RecordingSink();
  const context = new ContextService(new MemoryService(repository), new SkillService(repository), undefined, {
    eventSink: sink,
    now: () => 0,
  });

  const response = await context.recall({
    query: `用户偏好说明 ${secretQueryMarker}`,
    scope,
    maxMemoryResults: 1,
    maxMemoryChars: 2_000,
  });

  assert.equal(sink.events.length, 1);
  const event = sink.events[0]!;
  assert.equal(event.eventType, "context.recall.completed");
  if (event.eventType !== "context.recall.completed") return;

  assert.equal(event.requestId, response.requestId);
  assert.equal(event.queryChars, `用户偏好说明 ${secretQueryMarker}`.length);
  assert.equal(event.memoryReturned, response.memories.length);
  // 检索候选数（含余量）必须不小于最终返回数，且大于被丢弃的条数
  assert.ok(event.memoryCandidates >= event.memoryReturned);
  assert.ok(event.durationMs >= 0);
  assert.equal(event.includeDraft, false);
  assert.deepEqual(event.matchStrategies, ["lexical"]);
  assert.equal(event.retrievalStrategy, "lexical");
  assert.deepEqual(event.scope, scope);
  assert.ok(event.warningCodes.includes("MEMORY_RESULTS_DROPPED"));

  // 字段级禁止：序列化结果不得出现正文标记或查询标记
  const line = serializeObservabilityEvent(event);
  assert.ok(!line.includes(secretContentMarker));
  assert.ok(!line.includes(secretQueryMarker));
});

test("召回截断时事件记录 truncated 与预算告警码", async () => {
  const repository = new SqliteRepository(":memory:");
  seed(repository);
  const sink = new RecordingSink();
  const context = new ContextService(new MemoryService(repository), new SkillService(repository), undefined, {
    eventSink: sink,
  });

  await context.recall({
    query: "用户偏好说明",
    scope,
    maxMemoryChars: 10,
    maxSkillChars: 10,
  });

  const event = sink.events[0]!;
  assert.equal(event.eventType, "context.recall.completed");
  if (event.eventType !== "context.recall.completed") return;
  assert.equal(event.truncated, true);
  assert.ok(event.warningCodes.includes("MEMORY_BUDGET_TRUNCATED"));
  assert.ok(event.usedMemoryChars <= 10);
});

test("无效预算参数触发失败事件，错误码稳定且不携带正文", async () => {
  const repository = new SqliteRepository(":memory:");
  seed(repository);
  const sink = new RecordingSink();
  const context = new ContextService(new MemoryService(repository), new SkillService(repository), undefined, {
    eventSink: sink,
  });

  await assert.rejects(context.recall({
    query: `用户偏好说明 ${secretQueryMarker}`,
    scope,
    maxMemoryResults: 0,
  }), /maxMemoryResults/);

  assert.equal(sink.events.length, 1);
  const event = sink.events[0]!;
  assert.equal(event.eventType, "context.recall.failed");
  if (event.eventType !== "context.recall.failed") return;
  assert.equal(event.errorCode, "UNEXPECTED");
  assert.equal(event.errorName, "Error");
  assert.ok(event.requestId.length > 0);
  const line = serializeObservabilityEvent(event);
  assert.ok(!line.includes(secretQueryMarker));
});

test("序列化白名单会剥离未知字段，误传的正文与密钥字段不会进入输出", () => {
  const smuggled = {
    schemaVersion: EVENT_SCHEMA_VERSION,
    eventType: "context.recall.failed",
    timestamp: "2026-08-20T00:00:00.000Z",
    requestId: "req-1",
    scope,
    durationMs: 1,
    queryChars: 5,
    errorCode: "X",
    errorName: "Error",
    // 以下字段全部不在白名单内
    query: `带 ${secretQueryMarker} 的查询`,
    content: secretContentMarker,
    accessKey: "smuggled-access-key",
  } as unknown as ObservabilityEvent;

  const line = serializeObservabilityEvent(smuggled);
  assert.ok(!line.includes(secretQueryMarker));
  assert.ok(!line.includes(secretContentMarker));
  assert.ok(!line.includes("smuggled-access-key"));
  assert.ok(!line.includes('"query"'));
  assert.ok(!line.includes('"content"'));
});

test("JsonlEventSink 逐行追加事件，禁止值命中时整条脱敏", () => {
  const directory = mkdtempSync(join(tmpdir(), "memory-skills-events-"));
  try {
    const accessKey = "OBS-FORBIDDEN-KEY-42";
    const sink = new JsonlEventSink({ path: join(directory, "events.jsonl"), forbiddenValues: [accessKey] });

    sink.emit({
      schemaVersion: EVENT_SCHEMA_VERSION,
      eventType: "service.started",
      timestamp: "2026-08-20T00:00:00.000Z",
      host: "127.0.0.1",
      port: 8421,
      databasePath: "data/memory-skills.db",
    });
    // 模拟未来误用：把 Access Key 写进允许字段（scope.userId）
    sink.emit({
      schemaVersion: EVENT_SCHEMA_VERSION,
      eventType: "context.recall.failed",
      timestamp: "2026-08-20T00:00:01.000Z",
      requestId: "req-2",
      scope: { ...scope, userId: accessKey },
      durationMs: 2,
      queryChars: 3,
      errorCode: "X",
      errorName: "Error",
    });

    const lines = readFileSync(join(directory, "events.jsonl"), "utf8").trim().split("\n");
    assert.equal(lines.length, 2);

    const started = JSON.parse(lines[0]!);
    assert.equal(started.eventType, "service.started");
    assert.equal(started.schemaVersion, EVENT_SCHEMA_VERSION);

    const redacted = JSON.parse(lines[1]!);
    assert.equal(redacted.eventType, "event.redacted");
    assert.equal(redacted.originalEventType, "context.recall.failed");
    assert.ok(!lines[1]!.includes(accessKey));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("resolveEventSinkFromEnv 按 MEMORY_SKILLS_EVENT_SINK 解析输出", () => {
  assert.ok(resolveEventSinkFromEnv({ MEMORY_SKILLS_EVENT_SINK: "off" }) instanceof NoopEventSink);
  assert.ok(resolveEventSinkFromEnv({ MEMORY_SKILLS_EVENT_SINK: "none" }) instanceof NoopEventSink);
  assert.ok(resolveEventSinkFromEnv({ MEMORY_SKILLS_EVENT_SINK: "stderr" }) instanceof StderrEventSink);
  assert.ok(resolveEventSinkFromEnv({}) instanceof JsonlEventSink);

  const directory = mkdtempSync(join(tmpdir(), "memory-skills-events-"));
  try {
    const sink = resolveEventSinkFromEnv({
      MEMORY_SKILLS_EVENT_SINK: "jsonl",
      MEMORY_SKILLS_EVENT_LOG: join(directory, "custom.jsonl"),
    });
    assert.ok(sink instanceof JsonlEventSink);
    sink.emit({
      schemaVersion: EVENT_SCHEMA_VERSION,
      eventType: "service.started",
      timestamp: "2026-08-20T00:00:00.000Z",
      host: "127.0.0.1",
      port: 1,
      databasePath: "x",
    });
    assert.ok(readFileSync(join(directory, "custom.jsonl"), "utf8").includes("service.started"));

    assert.throws(() => resolveEventSinkFromEnv({ MEMORY_SKILLS_EVENT_SINK: "syslog" }), /MEMORY_SKILLS_EVENT_SINK/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
