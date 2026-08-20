import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { NoopEventSink, type EventSink } from "./event-sink.js";
import { serializeObservabilityEvent, type ObservabilityEvent } from "./events.js";

type Environment = Record<string, string | undefined>;

/** JSONL 事件输出的公共选项。 */
interface LineSinkOptions {
  /**
   * 禁止值列表（如 Access Key、模型密钥）。
   * 序列化结果一旦命中禁止值，整条事件被替换为脱敏占位事件，绝不原样写出。
   */
  forbiddenValues?: readonly string[];
}

/**
 * 按行输出 JSONL 事件的基类。
 * 负责统一执行白名单投影与禁止值兜底，子类只决定写入目的地。
 */
abstract class LineEventSink implements EventSink {
  private readonly forbiddenValues: readonly string[];

  constructor(options: LineSinkOptions = {}) {
    this.forbiddenValues = (options.forbiddenValues ?? []).filter((value) => value.trim().length > 0);
  }

  emit(event: ObservabilityEvent): void {
    const line = serializeObservabilityEvent(event);
    if (this.forbiddenValues.some((value) => line.includes(value))) {
      // 命中禁止值：写出脱敏占位事件，保留"发生了什么类型的事件"这一审计事实
      this.writeLine(serializeObservabilityEvent({
        schemaVersion: event.schemaVersion,
        eventType: "event.redacted",
        timestamp: event.timestamp,
        originalEventType: event.eventType,
        reason: "forbidden-value-detected",
      }));
      return;
    }
    this.writeLine(line);
  }

  protected abstract writeLine(line: string): void;
}

/** 追加写入本地 JSONL 文件的事件输出。 */
export class JsonlEventSink extends LineEventSink {
  private readonly filePath: string;

  constructor(options: LineSinkOptions & { path: string }) {
    super(options);
    this.filePath = resolve(options.path);
    mkdirSync(dirname(this.filePath), { recursive: true });
  }

  protected writeLine(line: string): void {
    appendFileSync(this.filePath, `${line}\n`, "utf8");
  }
}

/** 输出到 stderr 的 JSONL 事件输出。MCP 进程的 stdout 始终只承载协议，不写事件。 */
export class StderrEventSink extends LineEventSink {
  private readonly stream: NodeJS.WritableStream;

  constructor(options: LineSinkOptions & { stream?: NodeJS.WritableStream } = {}) {
    super(options);
    this.stream = options.stream ?? process.stderr;
  }

  protected writeLine(line: string): void {
    this.stream.write(`${line}\n`);
  }
}

/**
 * 从环境变量解析事件输出：
 * - MEMORY_SKILLS_EVENT_SINK：jsonl（默认）/ stderr / off
 * - MEMORY_SKILLS_EVENT_LOG：JSONL 文件路径，默认 data/events.jsonl
 */
export function resolveEventSinkFromEnv(
  environment: Environment = process.env,
  options: LineSinkOptions = {},
): EventSink {
  const mode = environment.MEMORY_SKILLS_EVENT_SINK?.trim().toLowerCase() ?? "jsonl";
  if (mode === "off" || mode === "none") return new NoopEventSink();
  if (mode === "stderr") return new StderrEventSink(options);
  if (mode === "jsonl") {
    return new JsonlEventSink({ ...options, path: environment.MEMORY_SKILLS_EVENT_LOG?.trim() || "data/events.jsonl" });
  }
  throw new Error(`MEMORY_SKILLS_EVENT_SINK must be one of jsonl, stderr, off; received: ${mode}`);
}
