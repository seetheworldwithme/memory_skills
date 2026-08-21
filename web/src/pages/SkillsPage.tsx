import { Check, FileCode2, Plus, Search, Sparkles, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { StatusBadge } from "../components/StatusBadge";
import { EvidenceBlock } from "../components/EvidenceBlock";
import { FeedbackBar } from "../components/FeedbackBar";
import type { ApiClient, SkillDiffResult, SkillDocument, SkillRunSummary, SkillValidationReport, SkillVersionInfo } from "../lib/api";

export function SkillsPage({ api }: { api: ApiClient }) {
  const [items, setItems] = useState<SkillDocument[]>([]); const [selectedId, setSelectedId] = useState<string>(); const [query, setQuery] = useState(""); const [creating, setCreating] = useState(false); const [loading, setLoading] = useState(true); const [error, setError] = useState<string>(); const [proposing, setProposing] = useState(false); const [proposalNote, setProposalNote] = useState<string>();
  const load = useCallback(async () => { try { setLoading(true); const next = await api.listSkills(); setItems(next); setSelectedId((current) => current && next.some((item) => item.id === current) ? current : next[0]?.id); setError(undefined); } catch (reason) { setError(reason instanceof Error ? reason.message : "加载失败"); } finally { setLoading(false); } }, [api]);
  useEffect(() => { void load(); }, [load]);
  // 人工触发 Skill 提案：模型从最近证据提取可执行工作流，只产出 Draft
  const runProposal = async () => { try { setProposing(true); setProposalNote(undefined); const report = await api.runSkillProposal(); const rejectedNote = report.rejected.length > 0 ? `；拒绝 ${report.rejected.length} 条候选（占位、格式或缺少来源）` : ""; setProposalNote(`已生成 ${report.created.length} 条草稿${rejectedNote} · 模型 ${report.model || "未调用"} · ${report.latencyMs}ms`); await load(); } catch (reason) { setError(reason instanceof Error ? reason.message : "提案生成失败"); } finally { setProposing(false); } };
  const filtered = useMemo(() => items.filter((item) => `${item.name} ${item.description}`.toLowerCase().includes(query.toLowerCase())), [items, query]); const selected = items.find((item) => item.id === selectedId);
  return <section className="workspace"><header className="page-head"><div><p className="eyebrow">SKILL / EXECUTABLE KNOWLEDGE</p><h1>Skill 库</h1><p>管理可复用的执行方法、版本与审核状态。</p></div><div className="page-actions"><button className="secondary" onClick={() => void runProposal()} disabled={proposing}><Sparkles size={17} />{proposing ? "生成中…" : "从证据生成草稿"}</button><button className="primary" onClick={() => setCreating(true)}><Plus size={17} />新建 Skill</button></div></header>{proposalNote && <div className="info-banner">{proposalNote}</div>}{error && <div className="error-banner">{error}</div>}<div className="split-panel"><aside className="asset-list"><label className="search"><Search size={16} /><input aria-label="搜索 Skill" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索名称或描述" /></label><div className="list-meta"><span>{filtered.length} 个 Skill</span><span>按更新时间</span></div><div className="list-scroll">{loading && <Empty text="正在加载 Skill…" />}{!loading && filtered.length === 0 && <Empty text="还没有 Skill，先创建一份可执行方法。" />}{filtered.map((item) => <button key={item.id} className={`asset-row ${selectedId === item.id ? "is-active" : ""}`} onClick={() => setSelectedId(item.id)}><div className="asset-row-top"><span className="layer">V{item.version}</span><StatusBadge status={item.status} /></div><strong className="skill-name">{item.name}</strong><p>{item.description}</p><small>{formatDate(item.updatedAt)}</small></button>)}</div></aside><main className="detail-pane">{selected ? <SkillDetail key={`${selected.id}:${selected.version}`} item={selected} api={api} onTransition={async (target) => { try { await api.transitionSkill(selected.id, target); await load(); } catch (reason) { setError(reason instanceof Error ? reason.message : "状态更新失败"); } }} onReload={load} /> : <Empty text="选择一个 Skill 查看 SKILL.md" />}</main></div>{creating && <SkillDialog onClose={() => setCreating(false)} onSubmit={async (input) => { await api.createSkill(input); setCreating(false); await load(); }} />}</section>;
}

function SkillDetail({ item, api, onTransition, onReload }: {
  item: SkillDocument;
  api: ApiClient;
  onTransition: (target: "verified" | "rejected" | "archived") => Promise<void>;
  onReload: () => Promise<void>;
}) {
  const [validation, setValidation] = useState<SkillValidationReport>(); const [versions, setVersions] = useState<SkillVersionInfo[]>(); const [diff, setDiff] = useState<SkillDiffResult>(); const [runSummary, setRunSummary] = useState<SkillRunSummary>(); const [note, setNote] = useState<string>();
  useEffect(() => { let active = true; setNote(undefined); void Promise.all([api.validateSkill(item.id), api.listSkillVersions(item.id), api.skillDiff(item.id), api.skillRunSummary(item.id)]).then(([report, versionList, diffResult, summary]) => { if (!active) return; setValidation(report); setVersions(versionList); setDiff(diffResult); setRunSummary(summary); }).catch(() => { if (active) setNote("质量校验 / 版本信息加载失败"); }); return () => { active = false; }; }, [api, item.id]);
  const rollback = async (targetVersion: number) => { try { await api.rollbackSkill(item.id, targetVersion); await onReload(); } catch (reason) { setNote(reason instanceof Error ? reason.message : "回滚失败"); } };
  const hasDiff = diff !== undefined && diff.entries.length > 0;
  return <div className="detail-content"><div className="detail-title"><div><span className="mono-id">SKILL.md · VERSION {item.version}</span><h2 className="skill-heading">{item.name}</h2><p>{item.description}</p></div><StatusBadge status={item.status} /></div>
    {note && <div className="error-banner">{note}</div>}
    <QualityPanel report={validation} />
    {item.status === "draft" && <DiffPanel diff={diff} />}
    <pre className="code-document">{item.content}</pre>
    <VersionPanel versions={versions} currentVersion={item.version} onRollback={rollback} />
    <div className="note"><span>来源证据（审核时对照原文）</span><EvidenceBlock api={api} evidenceIds={item.sources.map((source) => source.evidenceId)} /></div>
    <RunSummaryPanel summary={runSummary} />
    <div className="detail-actions">{item.status === "draft" && <><button className="primary" onClick={() => void onTransition("verified")}><Check size={16} />验证通过</button><button className="danger" onClick={() => void onTransition("rejected")}><X size={16} />拒绝</button></>}{(item.status === "verified" || item.status === "deprecated") && <button className="secondary" onClick={() => void onTransition("archived")}>归档</button>}</div><FeedbackBar key={item.id} api={api} assetKind="skill" assetId={item.id} /></div>;
}

/** 质量校验报告：错误不建议 Verify，警告由人决定。 */
function QualityPanel({ report }: { report: SkillValidationReport | undefined }) {
  if (!report) return null;
  return <div className="note quality-panel"><span>质量校验</span>{report.issues.length === 0 ? <p className="quality-ok">结构完整：名称、描述、触发条件、步骤、验证方式、失败处理与来源均符合要求。</p> : <ul className="issue-list">{report.issues.map((issue) => <li key={`${issue.code}-${issue.field}`} className={`issue issue--${issue.severity}`}><b className="issue-tag">{issue.severity === "error" ? "错误" : "警告"}</b><span>{issue.message}</span></li>)}</ul>}</div>;
}

/** 与最近已发布版本的语义化差异：Verify 前的对照视图。 */
function DiffPanel({ diff }: { diff: SkillDiffResult | undefined }) {
  if (!diff) return null;
  if (diff.fromVersion === null) return <div className="note diff-panel"><span>版本差异</span><p className="diff-empty">首个版本，没有已发布版本可比较。</p></div>;
  if (diff.entries.length === 0) return <div className="note diff-panel"><span>版本差异</span><p className="diff-empty">与已发布版本 V{diff.fromVersion} 内容一致。</p></div>;
  return <div className="note diff-panel"><span>版本差异 · 对照已发布版本 V{diff.fromVersion} → 当前 V{diff.toVersion}</span><p className="diff-summary">{diff.summary}</p><ul className="diff-list">{diff.entries.map((entry) => <li key={`${entry.kind}-${entry.change}-${entry.target}`} className={`diff-entry diff-entry--${entry.change}`}><b>{entry.kind === "field" ? `字段 ${entry.target}` : `章节 ${entry.target}`}</b>{entry.change === "modified" && <span className="diff-lines">＋{entry.addedLines?.length ?? 0} 行 / －{entry.removedLines?.length ?? 0} 行</span>}{entry.change === "modified" && (entry.addedLines?.length ?? 0) > 0 && <blockquote className="diff-block diff-block--added">{entry.addedLines!.join("\n")}</blockquote>}{entry.change === "modified" && (entry.removedLines?.length ?? 0) > 0 && <blockquote className="diff-block diff-block--removed">{entry.removedLines!.join("\n")}</blockquote>}</li>)}</ul></div>;
}

/** 版本历史：每个历史版本都可回滚（追加为新 Draft，不覆盖历史）。 */
function VersionPanel({ versions, currentVersion, onRollback }: { versions: SkillVersionInfo[] | undefined; currentVersion: number; onRollback: (targetVersion: number) => Promise<void> }) {
  if (!versions || versions.length <= 1) return null;
  return <div className="note version-panel"><span>版本历史</span><ul className="version-list">{versions.map((version) => <li key={version.version} className={version.version === currentVersion ? "version-item is-current" : "version-item"}><span className="mono-id">V{version.version}</span><StatusBadge status={version.status ?? "draft"} /><small>{formatDate(version.createdAt)}</small>{version.version !== currentVersion && <button className="secondary rollback-button" onClick={() => void onRollback(version.version)}>回滚到此版本</button>}</li>)}</ul><small className="version-hint">回滚会把历史内容追加为新草稿版本，仍需人工验证通过；历史版本永不覆盖。</small></div>;
}

/** 使用效果：只呈现落库的使用证据，没有证据时不宣称有效。 */
function RunSummaryPanel({ summary }: { summary: SkillRunSummary | undefined }) {
  if (!summary) return null;
  const cells: Array<[string, number]> = [["被召回", summary.runs.recalled], ["被采用", summary.runs.adopted], ["任务成功", summary.runs.succeeded], ["任务失败", summary.runs.failed]];
  const feedbackCells: Array<[string, number]> = [["有用", summary.feedback.useful], ["无关", summary.feedback.irrelevant], ["错误", summary.feedback.incorrect], ["过期", summary.feedback.outdated]];
  return <div className="note run-panel"><span>使用效果</span><p className={`run-verdict run-verdict--${summary.verdict}`}>{summary.verdictLabel}</p><div className="run-counts">{[...cells, ...feedbackCells.map(([label, value]) => [`反馈·${label}`, value] as [string, number])].map(([label, value]) => <div key={label} className="run-count"><small>{label}</small><strong>{value}</strong></div>)}</div><small className="run-hint">使用记录需通过 API 落库（被召回/被采用/任务结果）或来自显式反馈；系统不会在没有证据时宣称 Skill 有效。</small></div>;
}

function SkillDialog({ onClose, onSubmit }: { onClose: () => void; onSubmit: (input: { name: string; description: string }) => Promise<void> }) { const [name, setName] = useState(""); const [description, setDescription] = useState(""); const [saving, setSaving] = useState(false); const [submitError, setSubmitError] = useState<string>(); return <div className="modal-backdrop" role="presentation"><form className="modal" onSubmit={(event) => { event.preventDefault(); setSaving(true); setSubmitError(undefined); void onSubmit({ name, description }).catch((reason) => setSubmitError(reason instanceof Error ? reason.message : "Skill 创建失败")).finally(() => setSaving(false)); }}><div className="modal-head"><div><p className="eyebrow">NEW SKILL</p><h2>创建 Skill 草稿</h2></div><button type="button" className="icon-button" onClick={onClose} aria-label="关闭"><X /></button></div><label>名称<input aria-label="名称" required pattern="[a-z0-9]+(?:-[a-z0-9]+)*" value={name} onChange={(e) => setName(e.target.value)} placeholder="review-code" /><small>使用小写字母、数字和连字符</small></label><label>描述<textarea aria-label="描述" required value={description} onChange={(e) => setDescription(e.target.value)} placeholder="一句话说明它解决什么问题" /></label>{submitError && <div className="login-error">{submitError}</div>}<div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>取消</button><button className="primary" disabled={saving}>{saving ? "创建中…" : "创建草稿"}</button></div></form></div>; }

function Empty({ text }: { text: string }) { return <div className="empty"><FileCode2 /><p>{text}</p></div>; }
function formatDate(value: string) { return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value)); }
