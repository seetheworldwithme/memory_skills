import { useEffect, useState } from "react";

import type { ApiClient, EvidenceRecord } from "../lib/api";

/**
 * 来源证据原文对照：审核 Draft 时查看模型依据的原始 Evidence。
 * 只在存在来源时才发起请求；加载失败显示提示而不是阻塞审核。
 */
export function EvidenceBlock({ api, evidenceIds }: { api: ApiClient; evidenceIds: string[] }) {
  // 用拼接键作为请求依赖，避免父组件每次渲染生成新数组导致重复请求
  const idsKey = evidenceIds.join("\u0000");
  const [records, setRecords] = useState<EvidenceRecord[] | undefined>();

  useEffect(() => {
    const ids = idsKey === "" ? [] : idsKey.split("\u0000");
    if (ids.length === 0) {
      setRecords([]);
      return;
    }
    let active = true;
    void api.getEvidence(ids)
      .then((items) => { if (active) setRecords(items); })
      .catch(() => { if (active) setRecords(undefined); });
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, idsKey]);

  if (evidenceIds.length === 0) return <p>无（该资产为手工创建）</p>;
  if (!records) return <p>来源证据加载中…</p>;

  const found = new Map(records.map((record) => [record.id, record]));
  return (
    <div className="evidence-list">
      {evidenceIds.map((id) => {
        const record = found.get(id);
        return (
          <figure key={id} className="evidence-item">
            <figcaption>
              <span className={`role role-${record?.role ?? "unknown"}`}>{record?.role ?? "未知"}</span>
              <span className="mono-id">{id}</span>
              {record && <time>{new Date(record.capturedAt).toLocaleString("zh-CN")}</time>}
            </figcaption>
            {record ? <blockquote>{record.content}</blockquote> : <blockquote>（证据已被删除或不可见）</blockquote>}
          </figure>
        );
      })}
    </div>
  );
}
