import { BrainCircuit, Check, Plus, Search, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { StatusBadge } from "../components/StatusBadge";
import type { ApiClient, MemoryAsset } from "../lib/api";

export function MemoryPage({ api }: { api: ApiClient }) {
  const [items, setItems] = useState<MemoryAsset[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

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

  return (
    <section className="workspace">
      <header className="page-head">
        <div><p className="eyebrow">MEMORY / GOVERNED ASSETS</p><h1>记忆资产</h1><p>审查从对话证据中沉淀的长期事实与偏好。</p></div>
        <button className="primary" onClick={() => setCreating(true)}><Plus size={17} />新建记忆</button>
      </header>
      {error && <div className="error-banner">{error}</div>}
      <div className="split-panel">
        <aside className="asset-list">
          <label className="search"><Search size={16} /><input aria-label="搜索记忆" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索内容" /></label>
          <div className="list-meta"><span>{filtered.length} 条记录</span><span>按更新时间</span></div>
          <div className="list-scroll">
            {loading && <Empty icon={<BrainCircuit />} text="正在加载记忆…" />}
            {!loading && filtered.length === 0 && <Empty icon={<BrainCircuit />} text="还没有记忆，从一条证据开始。" />}
            {filtered.map((item) => (
              <button key={item.id} className={`asset-row ${selectedId === item.id ? "is-active" : ""}`} onClick={() => setSelectedId(item.id)}>
                <div className="asset-row-top"><span className="layer">{item.layer.toUpperCase()}</span><StatusBadge status={item.governance.status} /></div>
                <strong>{item.content}</strong>
                <small>可信度 {Math.round(item.governance.confidence * 100)}% · {formatDate(item.governance.updatedAt)}</small>
              </button>
            ))}
          </div>
        </aside>
        <main className="detail-pane">
          {selected ? <MemoryDetail item={selected} onTransition={async (target) => { try { await api.transitionMemory(selected.id, target); await load(); } catch (reason) { setError(reason instanceof Error ? reason.message : "状态更新失败"); } }} /> : <Empty icon={<BrainCircuit />} text="选择一条记忆查看详情" />}
        </main>
      </div>
      {creating && <MemoryDialog onClose={() => setCreating(false)} onSubmit={async (input) => { await api.createMemory(input); setCreating(false); await load(); }} />}
    </section>
  );
}

function MemoryDetail({ item, onTransition }: { item: MemoryAsset; onTransition: (target: "verified" | "rejected" | "archived") => Promise<void> }) {
  return <div className="detail-content"><div className="detail-title"><div><span className="mono-id">{item.id}</span><h2>{item.content}</h2></div><StatusBadge status={item.governance.status} /></div><dl className="facts"><div><dt>层级</dt><dd>{item.layer.toUpperCase()}</dd></div><div><dt>可信度</dt><dd>{Math.round(item.governance.confidence * 100)}%</dd></div><div><dt>敏感度</dt><dd>{item.governance.sensitivity}</dd></div><div><dt>更新时间</dt><dd>{formatDate(item.governance.updatedAt)}</dd></div></dl><div className="note"><span>沉淀理由</span><p>{item.governance.createdReason}</p></div><div className="note"><span>来源证据</span><p>{item.sources.length ? item.sources.map((source) => source.evidenceId).join("、") : "无"}</p></div><div className="detail-actions">{item.governance.status === "draft" && <><button className="primary" onClick={() => void onTransition("verified")}><Check size={16} />验证通过</button><button className="danger" onClick={() => void onTransition("rejected")}><X size={16} />拒绝</button></>} {(item.governance.status === "verified" || item.governance.status === "deprecated") && <button className="secondary" onClick={() => void onTransition("archived")}>归档</button>}</div></div>;
}

function MemoryDialog({ onClose, onSubmit }: { onClose: () => void; onSubmit: (input: { evidence: string; content: string; layer: "l1" | "l2" | "l3"; confidence: number; reason: string }) => Promise<void> }) {
  const [evidence, setEvidence] = useState(""); const [content, setContent] = useState(""); const [saving, setSaving] = useState(false); const [submitError, setSubmitError] = useState<string>();
  return <div className="modal-backdrop" role="presentation"><form className="modal" onSubmit={(event) => { event.preventDefault(); setSaving(true); setSubmitError(undefined); void onSubmit({ evidence, content, layer: "l1", confidence: 0.8, reason: "manual capture" }).catch((reason) => setSubmitError(reason instanceof Error ? reason.message : "记忆保存失败")).finally(() => setSaving(false)); }}><div className="modal-head"><div><p className="eyebrow">NEW MEMORY</p><h2>沉淀一条记忆</h2></div><button type="button" className="icon-button" onClick={onClose} aria-label="关闭"><X /></button></div><label>原始证据<textarea aria-label="原始证据" required value={evidence} onChange={(e) => setEvidence(e.target.value)} placeholder="保留用户的原始表达" /></label><label>记忆内容<textarea aria-label="记忆内容" required value={content} onChange={(e) => setContent(e.target.value)} placeholder="提炼为稳定、可复用的事实" /></label>{submitError && <div className="login-error">{submitError}</div>}<div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>取消</button><button className="primary" disabled={saving}>{saving ? "保存中…" : "保存为草稿"}</button></div></form></div>;
}

function Empty({ icon, text }: { icon: React.ReactNode; text: string }) { return <div className="empty">{icon}<p>{text}</p></div>; }
function formatDate(value: string) { return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value)); }
