import { AlertTriangle, Copy, RefreshCw, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { StatusBadge } from "../components/StatusBadge";
import type { ApiClient, GovernanceTask, RetentionReview } from "../lib/api";

/**
 * 治理工作台（Task 14）：冲突/重复任务、过期与长期未验证的待复核清单。
 * 所有动作都是建议或显式确认：降权过期资产需要点击确认，续期是用户
 * 明确表达"仍然有效"；这里没有任何静默的自动处置。
 */
export function GovernancePage({ api }: { api: ApiClient }) {
  const [tasks, setTasks] = useState<GovernanceTask[]>([]);
  const [review, setReview] = useState<RetentionReview>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [note, setNote] = useState<string>();

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const [taskList, reviewResult] = await Promise.all([api.listConflicts(), api.retentionReview()]);
      setTasks(taskList);
      setReview(reviewResult);
      setError(undefined);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => { void load(); }, [load]);

  const deprecateExpired = async () => {
    try {
      setBusy(true);
      const result = await api.deprecateExpired();
      setNote(result.memories.length > 0
        ? `已把 ${result.memories.length} 条过期记忆降权为待复核（Deprecated），可随时续期恢复`
        : "当前没有需要降权的过期记忆");
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "降权失败");
    } finally {
      setBusy(false);
    }
  };

  const renew = async (id: string, validUntil: string | null) => {
    try {
      setBusy(true);
      await api.renewMemory(id, validUntil);
      setNote(validUntil === null ? "已清除有效期（长期有效）并恢复 Verified" : "已续期 90 天并恢复召回");
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "续期失败");
    } finally {
      setBusy(false);
    }
  };

  const expired = review?.expiredMemories ?? [];
  const staleMemories = review?.staleMemories ?? [];
  const staleSkills = review?.staleSkills ?? [];

  return <section className="workspace">
    <header className="page-head">
      <div>
        <p className="eyebrow">GOVERNANCE / REVIEW QUEUE</p>
        <h1>治理工作台</h1>
        <p>处理重复与冲突资产，复核过期内容；所有动作都需要人工确认。</p>
      </div>
      <div className="page-actions">
        <button className="secondary" onClick={() => void load()} disabled={loading || busy}><RefreshCw size={17} />刷新</button>
        <button className="primary" onClick={() => void deprecateExpired()} disabled={busy || expired.length === 0}>
          <ShieldCheck size={17} />{busy ? "处理中…" : `降权 ${expired.length} 条过期记忆`}
        </button>
      </div>
    </header>
    {note && <div className="info-banner">{note}</div>}
    {error && <div className="error-banner">{error}</div>}
    {loading && <div className="empty"><p>正在扫描资产…</p></div>}
    {!loading && (
      <div className="gov-stack">
        <section className="gov-card">
          <header className="gov-card-head">
            <h2><AlertTriangle size={16} />重复与冲突任务 <span className="gov-count">{tasks.length}</span></h2>
            <p>确定性扫描（不调用模型）：处置其中一条资产后，任务会在下次扫描中消失。</p>
          </header>
          {tasks.length === 0
            ? <p className="gov-empty">没有发现重复或相互冲突的 Verified 资产。</p>
            : <ul className="gov-task-list">{tasks.map((task) => <li key={task.id} className="gov-task">
              <div className="gov-task-top">
                <span className={`gov-kind gov-kind--${task.kind}`}>{task.kind === "duplicate" ? <><Copy size={13} />重复</> : <><AlertTriangle size={13} />疑似冲突</>}</span>
                <span className="gov-asset-kind">{task.assetKind === "memory" ? "记忆" : "Skill"}</span>
              </div>
              <p className="gov-task-detail">{task.detail}</p>
              <div className="gov-task-assets">{task.assets.map((asset) => <div key={asset.id} className="gov-asset"><small className="mono-id">{asset.name ?? asset.id}</small><p>{asset.preview}</p></div>)}</div>
              <p className="gov-task-suggestion">建议：{task.suggestion}</p>
            </li>)}</ul>}
        </section>

        <section className="gov-card">
          <header className="gov-card-head">
            <h2>过期待复核 <span className="gov-count">{expired.length}</span></h2>
            <p>已过有效期的 Verified 记忆；降权后仍可续期恢复，不会物理删除。</p>
          </header>
          {expired.length === 0
            ? <p className="gov-empty">没有已过期的记忆。</p>
            : <ul className="gov-item-list">{expired.map((item) => <li key={item.id} className="gov-item">
              <div className="gov-item-main"><strong className="mono-id">{item.id}</strong><p>{item.preview}</p><small>过期于 {formatDate(item.validUntil!)}</small></div>
              <div className="gov-item-actions">
                <button className="secondary" disabled={busy} onClick={() => void renew(item.id, extendDate(90))}>续期 90 天</button>
                <button className="secondary" disabled={busy} onClick={() => void renew(item.id, null)}>长期有效</button>
              </div>
            </li>)}</ul>}
        </section>

        <section className="gov-card">
          <header className="gov-card-head">
            <h2>长期未验证 <span className="gov-count">{staleMemories.length + staleSkills.length}</span></h2>
            <p>超过 90 天未再验证/更新的 Verified 资产（仅提示，无自动动作）。</p>
          </header>
          {staleMemories.length + staleSkills.length === 0
            ? <p className="gov-empty">所有 Verified 资产都在验证期内。</p>
            : <ul className="gov-item-list">{[...staleMemories, ...staleSkills].map((item) => <li key={item.id} className="gov-item">
              <div className="gov-item-main"><strong className="mono-id">{item.id}</strong><p>{item.preview}</p><small>上次更新 {formatDate(item.updatedAt)}</small></div>
              <StatusBadge status={item.status} />
            </li>)}</ul>}
        </section>
      </div>
    )}
  </section>;
}

function extendDate(days: number): string {
  const date = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  return date.toISOString();
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "short", day: "numeric" }).format(new Date(value));
}
