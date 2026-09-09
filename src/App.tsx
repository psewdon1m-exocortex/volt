import { useCallback, useEffect, useMemo, useState } from "react";

import { api, type InterfaceSettings } from "./api";
import { AuditPage } from "./AuditPage";
import { DashboardPage } from "./DashboardPage";
import { DocumentationPage } from "./DocumentationPage";
import { Icon } from "./icons";
import { SettingsPage } from "./SettingsPage";
import { TrashPage } from "./TrashPage";
import { VoltLogo } from "./Ui";
import { applyAccent, dropItem, errorMessage, moveItem, type Toast } from "./ui-helpers";
import { VaultPage } from "./VaultPage";

type PrimaryPage = "dashboard" | "vault" | "trash" | "audit" | "settings";
type Page = PrimaryPage | "docs";
type Notice = { id: string; message: string; tone: "ok" | "error" };

const DEFAULT_INTERFACE: InterfaceSettings = {
  accent: "#00A8FF",
  sidebar_mode: "fixed",
  navigation_order: ["dashboard", "vault", "trash", "audit", "settings"],
  settings_order: ["appearance", "security", "backup", "updates", "logs", "cryptography"],
  dashboard_order: ["cpu", "memory", "disk", "uptime", "entities"],
};

const labels: Record<PrimaryPage, { title: string; nav: string; icon: string }> = {
  dashboard: { title: "dashboard", nav: "Dashboard", icon: "dashboard" },
  vault: { title: "vault", nav: "Vault", icon: "vault" },
  trash: { title: "trash", nav: "Trash", icon: "trash" },
  audit: { title: "audit", nav: "Audit", icon: "audit" },
  settings: { title: "settings", nav: "Settings", icon: "settings" },
};

function Unlock({ onUnlocked }: { onUnlocked: (settings: InterfaceSettings) => void }) {
  const [accessKey, setAccessKey] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [reachable, setReachable] = useState<boolean | null>(null);

  useEffect(() => {
    let active = true;
    const probe = () => fetch("/api/v1/health", { cache: "no-store" }).then((response) => { if (active) setReachable(response.ok); }).catch(() => { if (active) setReachable(false); });
    void probe();
    const timer = window.setInterval(probe, 5000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true); setError("");
    try { const session = await api.unlock(accessKey); setAccessKey(""); onUnlocked(session.interface); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }

  return <main className="unlock-page">
    <div className="unlock-composition">
      <header className="unlock-brand"><h1>Volt</h1><VoltLogo size="login" /></header>
      <section className="unlock-panel" aria-labelledby="unlock-title">
        <h2 className="visually-hidden" id="unlock-title">Open the Volt vault</h2>
        <div className={`reachability${reachable === false ? " offline" : reachable ? " reachable" : " checking"}`}>
          <span>{reachable === false ? "Service Unavailable" : reachable ? "Service Reachability" : "Checking Service"}</span>
          <span className={`status-square${reachable === false ? " offline" : ""}`} aria-hidden="true" />
        </div>
        {error && <div className="unlock-error" role="alert">{error}</div>}
        <form onSubmit={submit}>
          <label className="visually-hidden" htmlFor="volt-access-key">Access Key</label>
          <input id="volt-access-key" data-autofocus type="password" required autoFocus autoComplete="current-password" placeholder="Access Key..." value={accessKey} onChange={(event) => setAccessKey(event.target.value)} />
          <button className="button wide" disabled={busy || reachable === false}>{busy ? "Checking…" : "Open Volt"}</button>
        </form>
      </section>
    </div>
  </main>;
}

export function App() {
  const [ready, setReady] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [settings, setSettings] = useState(DEFAULT_INTERFACE);
  const [page, setPage] = useState<Page>("dashboard");
  const [notices, setNotices] = useState<Notice[]>([]);
  const [mobile, setMobile] = useState(() => window.matchMedia("(max-width: 720px)").matches);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [sidebarHover, setSidebarHover] = useState(false);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; before: boolean } | null>(null);

  useEffect(() => { api.session().then((session) => { setAuthenticated(session.authenticated); setSettings(session.interface ?? DEFAULT_INTERFACE); applyAccent(session.interface?.accent ?? DEFAULT_INTERFACE.accent); }).finally(() => setReady(true)); }, []);
  useEffect(() => { const media = window.matchMedia("(max-width: 720px)"); const listener = () => { setMobile(media.matches); if (!media.matches) setMobileOpen(false); }; media.addEventListener("change", listener); return () => media.removeEventListener("change", listener); }, []);
  useEffect(() => { applyAccent(settings.accent); }, [settings.accent]);
  useEffect(() => {
    function proportionalCardHover(event: Event) {
      const card = event.target instanceof Element ? event.target.closest<HTMLElement>(".universal-card, .button, .choice, .search, .collection-command-bar select") : null;
      const relatedTarget = (event as PointerEvent | FocusEvent).relatedTarget;
      if (!card || (relatedTarget instanceof Node && card.contains(relatedTarget))) return;
      const rect = card.getBoundingClientRect();
      const growth = Math.min(rect.width, rect.height) * (card.classList.contains("setting-card") ? .02 : .05);
      card.style.setProperty("--grow-x", String((rect.width + growth) / rect.width));
      card.style.setProperty("--grow-y", String((rect.height + growth) / rect.height));
      const horizontal = rect.left < 24 ? "left" : rect.right > window.innerWidth - 24 ? "right" : "center";
      const vertical = rect.top < 24 ? "top" : rect.bottom > window.innerHeight - 24 ? "bottom" : "center";
      card.style.transformOrigin = `${horizontal} ${vertical}`;
    }
    document.addEventListener("pointerover", proportionalCardHover);
    document.addEventListener("focusin", proportionalCardHover);
    return () => { document.removeEventListener("pointerover", proportionalCardHover); document.removeEventListener("focusin", proportionalCardHover); };
  }, []);

  const toast = useCallback<Toast>((message, tone = "ok") => {
    const id = crypto.randomUUID();
    setNotices((current) => [...current.slice(-4), { id, message, tone }]);
    window.setTimeout(() => setNotices((current) => current.filter((notice) => notice.id !== id)), tone === "error" ? 8000 : 4500);
  }, []);

  async function lock() { try { await api.lock(); } finally { setAuthenticated(false); setMobileOpen(false); } }
  function navigate(next: Page) { setPage(next); setMobileOpen(false); }

  async function reorderNavigation(index: number, direction: -1 | 1) {
    const order = moveItem(settings.navigation_order, index, direction);
    if (order === settings.navigation_order) return;
    const previous = settings;
    setSettings({ ...settings, navigation_order: order });
    try { setSettings(await api.updateInterface({ navigation_order: order })); toast(`Navigation order saved: position ${index + direction + 1}`); }
    catch (error) { setSettings(previous); toast(errorMessage(error), "error"); }
  }

  async function dropNavigation(target: string, before: boolean) {
    if (!dragging) return;
    const next = dropItem(settings.navigation_order, settings.navigation_order.indexOf(dragging), settings.navigation_order.indexOf(target), before);
    setDragging(null); setDropTarget(null);
    if (next === settings.navigation_order) return;
    const previous = settings;
    setSettings({ ...settings, navigation_order: next });
    try { setSettings(await api.updateInterface({ navigation_order: next })); toast(`Navigation order saved: position ${next.indexOf(dragging) + 1}`); }
    catch (error) { setSettings(previous); toast(errorMessage(error), "error"); }
  }

  const content = useMemo<Record<Page, React.ReactNode>>(() => ({
    dashboard: <DashboardPage settings={settings} onSettings={setSettings} toast={toast} />,
    vault: <VaultPage toast={toast} />,
    trash: <TrashPage toast={toast} />,
    audit: <AuditPage toast={toast} />,
    settings: <SettingsPage settings={settings} onSettings={setSettings} onLocked={() => setAuthenticated(false)} toast={toast} />,
    docs: <DocumentationPage />,
  }), [settings, toast]);

  if (!ready) return <div className="boot-screen"><VoltLogo size="boot" /><span>Opening Volt…</span></div>;
  if (!authenticated) return <Unlock onUnlocked={(next) => { setSettings(next); applyAccent(next.accent); setAuthenticated(true); }} />;

  const sidebarVisible = mobile ? mobileOpen : settings.sidebar_mode === "fixed" || sidebarHover;
  const title = page === "docs" ? "documentation" : labels[page].title;

  return <div className={`app-shell sidebar-${settings.sidebar_mode}${sidebarVisible ? " sidebar-visible" : ""}`}>
    {!mobile && settings.sidebar_mode === "auto" && <div className="sidebar-activation" onPointerEnter={() => setSidebarHover(true)} aria-hidden="true" />}
    {mobile && mobileOpen && <button className="sidebar-backdrop" aria-label="Close menu" onClick={() => setMobileOpen(false)} />}
    <aside className="sidebar" aria-hidden={!sidebarVisible} onPointerEnter={() => setSidebarHover(true)} onPointerLeave={() => setSidebarHover(false)}>
      <div className="sidebar-brand"><VoltLogo /><h2>Volt</h2></div>
      <nav className="primary-nav" aria-label="Primary navigation">{settings.navigation_order.map((rawPage, index) => {
        const item = rawPage as PrimaryPage;
        const meta = labels[item];
        const dropClass = dropTarget?.id === item ? (dropTarget.before ? " drop-before" : " drop-after") : "";
        return <div key={item} className={`nav-row${page === item ? " active" : ""}${dragging === item ? " dragging" : ""}${dropClass}`} draggable onDragStart={(event) => { event.dataTransfer.effectAllowed = "move"; setDragging(item); }} onDragEnd={() => { setDragging(null); setDropTarget(null); }} onDragOver={(event) => { event.preventDefault(); const rect = event.currentTarget.getBoundingClientRect(); setDropTarget({ id: item, before: event.clientY < rect.top + rect.height / 2 }); }} onDrop={(event) => { event.preventDefault(); void dropNavigation(item, dropTarget?.id === item ? dropTarget.before : true); }}><button tabIndex={sidebarVisible ? 0 : -1} title={`Alt+↑/↓ — move ${meta.nav}`} onKeyDown={(event) => { if (!event.altKey || !["ArrowUp", "ArrowDown"].includes(event.key)) return; event.preventDefault(); void reorderNavigation(index, event.key === "ArrowUp" ? -1 : 1); }} onClick={() => navigate(item)}><span>{meta.nav}</span><span className="nav-ordinal">{String(index + 1).padStart(2, "0")}</span></button></div>;
      })}</nav>
      <div className="sidebar-bottom"><button tabIndex={sidebarVisible ? 0 : -1} className={page === "docs" ? "active" : ""} onClick={() => navigate("docs")}>Documentation</button><button tabIndex={sidebarVisible ? 0 : -1} onClick={lock}>Log out</button></div>
    </aside>
    <main className="content"><header className="page-header">{mobile && <button className="icon-button menu-button" aria-label="Open menu" onClick={() => setMobileOpen(true)}><Icon name="menu" /></button>}<h1>{title}</h1></header>{content[page]}</main>
    <div className="toast-stack" aria-live="polite">{notices.map((notice) => <div key={notice.id} className={`toast ${notice.tone}`}><span>{notice.tone === "ok" ? "OK" : "!"}</span>{notice.message}</div>)}</div>
  </div>;
}
