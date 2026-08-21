import { BrainCircuit, KeyRound, LogOut, Scale, ShieldCheck, Sparkles, Wrench } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { ApiClient, login } from "./lib/api";
import { clearAccessKey, readAccessKey, saveAccessKey } from "./lib/session";
import { MemoryPage } from "./pages/MemoryPage";
import { SkillsPage } from "./pages/SkillsPage";
import { GovernancePage } from "./pages/GovernancePage";

type Page = "memory" | "skills" | "governance";

export function App() {
  const [storedKey] = useState(() => readAccessKey());
  const [accessKey, setAccessKey] = useState<string | null>(null);
  const [checkingSession, setCheckingSession] = useState(Boolean(storedKey));
  const [page, setPage] = useState<Page>("memory");
  const logout = useCallback(() => {
    clearAccessKey();
    setAccessKey(null);
  }, []);
  const api = useMemo(() => accessKey ? new ApiClient(accessKey, logout) : null, [accessKey, logout]);

  useEffect(() => {
    if (!storedKey) return;
    let active = true;
    void login(storedKey)
      .then(() => { if (active) setAccessKey(storedKey); })
      .catch(() => { if (active) logout(); })
      .finally(() => { if (active) setCheckingSession(false); });
    return () => { active = false; };
  }, [logout, storedKey]);

  if (checkingSession) return <div className="session-check"><BrainCircuit /><span>正在验证本地会话…</span></div>;

  if (!accessKey || !api) return <LoginScreen onLogin={(key) => { saveAccessKey(key); setAccessKey(key); }} />;

  return <div className="app-shell"><aside className="sidebar"><div className="brand"><span className="brand-mark"><BrainCircuit /></span><div><strong>Memory Skills</strong><small>LOCAL CONSOLE</small></div></div><nav><p>资产</p><button className={page === "memory" ? "active" : ""} onClick={() => setPage("memory")}><BrainCircuit size={18} />Chat Memory</button><button className={page === "skills" ? "active" : ""} onClick={() => setPage("skills")}><Wrench size={18} />Skill</button></nav><nav><p>治理</p><button className={page === "governance" ? "active" : ""} onClick={() => setPage("governance")}><Scale size={18} />治理工作台</button></nav><div className="sidebar-foot"><div className="local-status"><span /><div><strong>本地服务</strong><small>127.0.0.1 · 已连接</small></div></div><button className="logout" onClick={logout}><LogOut size={16} />退出登录</button></div></aside><main className="app-main"><div className="topline"><span><ShieldCheck size={15} />治理优先模式</span><span className="scope-label">LOCAL / DEFAULT</span></div>{page === "memory" ? <MemoryPage api={api} /> : page === "skills" ? <SkillsPage api={api} /> : <GovernancePage api={api} />}</main></div>;
}

function LoginScreen({ onLogin }: { onLogin: (accessKey: string) => void }) {
  const [key, setKey] = useState(""); const [error, setError] = useState<string>(); const [submitting, setSubmitting] = useState(false);
  return <main className="login-page"><section className="login-story"><div className="story-grid" /><div className="story-content"><span className="story-kicker"><Sparkles size={15} />GOVERNED AGENT MEMORY</span><h2>让经验留下，<br /><em>让下一次更准确。</em></h2><p>一个只保留 Chat Memory 与 Skill 的本地工作台。证据可追溯，状态可治理，知识可复用。</p><div className="signal-card"><div><BrainCircuit /><span>MEMORY CORE</span></div><div className="signal-lines"><i /><i /><i /><i /></div><small>L0 EVIDENCE → L1 / L2 / L3 ASSETS</small></div></div></section><section className="login-panel"><form onSubmit={(event) => { event.preventDefault(); setSubmitting(true); setError(undefined); void login(key.trim()).then(() => onLogin(key.trim())).catch((reason) => setError(reason instanceof Error ? reason.message : "登录失败")).finally(() => setSubmitting(false)); }}><span className="login-icon"><KeyRound /></span><p className="eyebrow">SECURE LOCAL ACCESS</p><h1>登录 Memory Skills</h1><p className="login-copy">输入启动服务时配置的管理员访问密钥。</p><label>访问密钥<div className="key-input"><KeyRound size={17} /><input aria-label="访问密钥" type="password" autoComplete="current-password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="MEMORY_SKILLS_ACCESS_KEY" /></div></label>{error && <div className="login-error">{error}</div>}<button className="primary login-submit" disabled={submitting || !key.trim()}>{submitting ? "正在验证…" : "进入控制台"}</button><small className="login-hint">密钥只保存在当前浏览器中，接口通过 Bearer Token 验证。</small></form></section></main>;
}
