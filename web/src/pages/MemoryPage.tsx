import { BrainCircuit, Check, Plus, Search, Sparkles, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { StatusBadge } from "../components/StatusBadge";
import { EvidenceBlock } from "../components/EvidenceBlock";
import { FeedbackBar } from "../components/FeedbackBar";
import { ConfirmDialog, Modal } from "../components/Modal";
import { formatDateTime } from "../lib/format";
import type { ApiClient, MemoryAsset } from "../lib/api";

export function MemoryPage({ api }: { api: ApiClient }) {
  const [items, setItems] = useState<MemoryAsset[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [proposing, setProposing] = useState(false);
  const [proposalNote, setProposalNote] = useState<string>();

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const next = await api.listMemories();
      setItems(next);
      setSelectedId((current) => current && next.some((item) => item.id === current) ? current : next[0]?.id);
      setError(undefined);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => { void load(); }, [load]);
  const filtered = useMemo(() => items.filter((item) => item.content.toLowerCase().includes(query.toLowerCase())), [items, query]);
  const selected = items.find((item) => item.id === selectedId);

  // 人工触发记忆提案：模型从最近证据提取候选，只产出 Draft，随后刷新列表供审核
  const runProposal = async () => {
    try {
      setProposing(true);
      setProposalNote(undefined);
      const report = await api.runMemoryProposal();
      const rejectedNote = report.rejected.length > 0 ? `；拒绝 ${report.rejected.length} 条候选（占位、敏感、重复或缺少来源）` : "";
      setProposalNote(`已生成 ${report.created.length} 条草稿${rejectedNote} · 模型 ${report.model || "未调用"} · ${report.latencyMs}ms`);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "提案生成失败");
    } finally {
      setProposing(false);
    }
  };

  return (
    <section className="workspace">
      <header className="page-head">
        <div><p className="eyebrow">MEMORY / GOVERNED ASSETS</p><h1>记忆资产</h1><p>审查从对话证据中沉淀的长期事实与偏好。</p></div>
        <div className="page-actions">
          <button className="secondary" onClick={() => void runProposal()} disabled={proposing}><Sparkles size={17} aria-hidden="true" />{proposing ? "生成中…" : "从证据生成草稿"}</button>
          <button className="primary" onClick={() => setCreating(true)}><Plus size={17} aria-hidden="true" />新建记忆</button>
        </div>
      </header>
      {proposalNote && <div className="info-banner" role="status">{proposalNote}</div>}
      {error && <div className="error-banner" role="alert">{error}</div>}
      <div className="split-panel">
        <aside className="asset-list">
          <label className="search"><Search size={16} aria-hidden="true" /><input aria-label="搜索记忆" type="search" autoComplete="off" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索内容" /></label>
          <div className="list-meta"><span>{filtered.length} 条记录</span><span>按更新时间</span></div>
          <div className="list-scroll">
            {loading && <Empty icon={<BrainCircuit aria-hidden="true" />} text="正在加载记忆…" />}
            {!loading && filtered.length === 0 && <Empty icon={<BrainCircuit aria-hidden="true" />} text="还没有记忆，从一条证据开始。" />}
            {filtered.map((item) => (
              <button key={item.id} className={`asset-row ${selectedId === item.id ? "is-active" : ""}`} onClick={() => setSelectedId(item.id)}>
                <div className="asset-row-top"><span className="layer">{item.layer.toUpperCase()}</span><StatusBadge status={item.governance.status} /></div>
                <strong>{item.content}</strong>
                <small>可信度 {Math.round(item.governance.confidence * 100)}% · {formatDateTime(item.governance.updatedAt)}</small>
              </button>
            ))}
          </div>
        </aside>
        <main className="detail-pane">
          {selected ? <MemoryDetail item={selected} api={api} onTransition={async (target) => { try { await api.transitionMemory(selected.id, target); await load(); } catch (reason) { setError(reason instanceof Error ? reason.message : "状态更新失败"); } }} /> : <Empty icon={<BrainCircuit aria-hidden="true" />} text="选择一条记忆查看详情" />}
        </main>
      </div>
      {creating && <MemoryDialog onClose={() => setCreating(false)} onSubmit={async (input) => { await api.createMemory(input); setCreating(false); await load(); }} />}
    </section>
  );
}

function MemoryDetail({ item, api, onTransition }: { item: MemoryAsset; api: ApiClient; onTransition: (target: "verified" | "rejected" | "archived") => Promise<void> }) {
  // 破坏性操作（拒绝/归档）先弹二次确认；请求期间禁用所有治理按钮防重复提交
  const [confirming, setConfirming] = useState<"rejected" | "archived">();
  const [pending, setPending] = useState(false);
  const runTransition = async (target: "verified" | "rejected" | "archived") => {
    try {
      setPending(true);
      await onTransition(target);
    } finally {
      setPending(false);
      setConfirming(undefined);
    }
  };
  return <div className="detail-content"><div className="detail-title"><div><span className="mono-id">{item.id}</span><h2>{item.content}</h2></div><StatusBadge status={item.governance.status} /></div><dl className="facts"><div><dt>层级</dt><dd>{item.layer.toUpperCase()}</dd></div><div><dt>可信度</dt><dd>{Math.round(item.governance.confidence * 100)}%</dd></div><div><dt>敏感度</dt><dd>{item.governance.sensitivity}</dd></div><div><dt>更新时间</dt><dd>{formatDateTime(item.governance.updatedAt)}</dd></div></dl><div className="note"><span>沉淀理由</span><p>{item.governance.createdReason}</p></div><div className="note"><span>来源证据（审核时对照原文）</span><EvidenceBlock api={api} evidenceIds={item.sources.map((source) => source.evidenceId)} /></div><div className="detail-actions">{item.governance.status === "draft" && <><button className="primary" disabled={pending} onClick={() => void runTransition("verified")}><Check size={16} aria-hidden="true" />验证通过</button><button className="danger" disabled={pending} onClick={() => setConfirming("rejected")}><X size={16} aria-hidden="true" />拒绝</button></>}{(item.governance.status === "verified" || item.governance.status === "deprecated") && <button className="secondary" disabled={pending} onClick={() => setConfirming("archived")}>归档</button>}</div>
    {confirming && (
      <ConfirmDialog
        title={confirming === "rejected" ? "拒绝这条记忆？" : "归档这条记忆？"}
        description={confirming === "rejected"
          ? "拒绝后资产进入 Rejected 状态，不会出现在召回结果中；历史版本仍保留可追溯。"
          : "归档后资产退出召回，可在治理工作台查看；资产本身不会被删除。"}
        confirmLabel={confirming === "rejected" ? "确认拒绝" : "确认归档"}
        busy={pending}
        onClose={() => setConfirming(undefined)}
        onConfirm={() => void runTransition(confirming)}
      />
    )}
    <FeedbackBar key={item.id} api={api} assetKind="memory" assetId={item.id} /></div>;
}

function MemoryDialog({ onClose, onSubmit }: { onClose: () => void; onSubmit: (input: { evidence: string; content: string; layer: "l1" | "l2" | "l3"; confidence: number; reason: string }) => Promise<void> }) {
  const [evidence, setEvidence] = useState(""); const [content, setContent] = useState(""); const [saving, setSaving] = useState(false); const [submitError, setSubmitError] = useState<string>();
  return <Modal eyebrow="NEW MEMORY" title="沉淀一条记忆" onClose={onClose} onSubmit={(event) => { event.preventDefault(); setSaving(true); setSubmitError(undefined); void onSubmit({ evidence, content, layer: "l1", confidence: 0.8, reason: "manual capture" }).catch((reason) => setSubmitError(reason instanceof Error ? reason.message : "记忆保存失败")).finally(() => setSaving(false)); }}><label>原始证据<textarea aria-label="原始证据" required value={evidence} onChange={(e) => setEvidence(e.target.value)} placeholder="保留用户的原始表达" /></label><label>记忆内容<textarea aria-label="记忆内容" required value={content} onChange={(e) => setContent(e.target.value)} placeholder="提炼为稳定、可复用的事实" /></label>{submitError && <div className="login-error" role="alert">{submitError}</div>}<div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>取消</button><button type="submit" className="primary" disabled={saving}>{saving ? "保存中…" : "保存为草稿"}</button></div></Modal>;
}

function Empty({ icon, text }: { icon: React.ReactNode; text: string }) { return <div className="empty">{icon}<p>{text}</p></div>; }
