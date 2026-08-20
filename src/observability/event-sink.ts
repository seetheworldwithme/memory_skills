import type { ObservabilityEvent } from "./events.js";

/**
 * 事件输出接口。
 * 通过接口注入具体实现，本地阶段使用 JSONL / stderr，
 * 未来接入 OpenTelemetry 时只需新增实现，不改动领域服务。
 */
export interface EventSink {
  emit(event: ObservabilityEvent): void;
}

/** 空实现：事件关闭或测试中不想产生输出时使用。 */
export class NoopEventSink implements EventSink {
  emit(): void {
    // 有意不做任何事情
  }
}
