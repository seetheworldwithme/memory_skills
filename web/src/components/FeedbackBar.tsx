import { useState } from "react";

import type { ApiClient, FeedbackKind } from "../lib/api";

/** 反馈四选项：顺序固定为 有用 / 无关 / 错误 / 过期。 */
const OPTIONS: ReadonlyArray<{ kind: FeedbackKind; label: string }> = [
  { kind: "useful", label: "有用" },
  { kind: "irrelevant", label: "无关" },
  { kind: "incorrect", label: "错误" },
  { kind: "outdated", label: "过期" },
];

/**
 * 显式反馈条：采集"这条资产对召回是否有帮助"的人工判断。
 * 反馈只用于评测与治理建议，提交后不会改写资产本身。
 */
export function FeedbackBar({ api, assetKind, assetId }: { api: ApiClient; assetKind: "memory" | "skill"; assetId: string }) {
  const [submitted, setSubmitted] = useState<FeedbackKind>();
  const [error, setError] = useState<string>();

  const submit = async (kind: FeedbackKind) => {
    try {
      setError(undefined);
      await api.submitFeedback({ assetKind, assetId, kind });
      setSubmitted(kind);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "反馈提交失败");
    }
  };

  return (
    <div className="feedback-bar">
      <span className="feedback-title">这条资产对召回有帮助吗？</span>
      <div className="feedback-options">
        {OPTIONS.map((option) => (
          <button
            key={option.kind}
            type="button"
            className={submitted === option.kind ? "is-chosen" : ""}
            onClick={() => void submit(option.kind)}
            disabled={submitted !== undefined}
          >
            {option.label}
          </button>
        ))}
      </div>
      {submitted && <small className="feedback-note" role="status">已记录「{OPTIONS.find((option) => option.kind === submitted)?.label}」，用于评测与治理建议</small>}
      {error && <small className="feedback-error" role="alert">{error}</small>}
    </div>
  );
}
