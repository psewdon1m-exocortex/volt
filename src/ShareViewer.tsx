import { useEffect, useState } from "react";

import { ApiError, api, type SharedEntry } from "./api";
import { Icon } from "./icons";
import { applyAccent } from "./ui-helpers";

function message(error: unknown) { return error instanceof Error ? error.message : "Share is unavailable"; }

function SharedField({ shareId, field }: { shareId: string; field: SharedEntry["fields"][number] }) {
  const [revealed, setRevealed] = useState<string | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (revealed == null) return;
    const timer = window.setTimeout(() => setRevealed(null), 30_000);
    const hide = () => { if (document.hidden) setRevealed(null); };
    document.addEventListener("visibilitychange", hide);
    return () => { window.clearTimeout(timer); document.removeEventListener("visibilitychange", hide); };
  }, [revealed]);

  async function value() { return field.visibility === "secret" ? (await api.publicShareReveal(shareId, field.id)).value : field.value ?? ""; }
  async function show() {
    try { setError(""); setRevealed(revealed == null ? await value() : null); }
    catch (cause) { setRevealed(null); setError(message(cause)); }
  }
  async function copy() {
    try {
      const content = await value();
      if (!window.isSecureContext || !document.hasFocus() || !navigator.clipboard?.writeText) {
        setRevealed(content); setError("Clipboard unavailable. Select the value to copy it."); return;
      }
      await navigator.clipboard.writeText(content);
      setError("Copied");
    } catch (cause) { setError(message(cause)); }
  }

  return <div className="shared-value">
    <div><span className="eyebrow">{field.key}</span><div className="shared-value-text">{field.visibility === "secret" && revealed == null ? "•".repeat(Math.min(field.length ?? 12, 64)) : revealed ?? field.value}</div></div>
    <div className="shared-value-actions">
      {field.visibility === "secret" && <button className="button secondary small" onClick={show}><Icon name="eye" />{revealed == null ? "Reveal" : "Hide"}</button>}
      <button className="button secondary small" onClick={copy}><Icon name="copy" />Copy</button>
    </div>
    {error && <span className="shared-field-notice" role="status">{error}</span>}
  </div>;
}

export function ShareViewer() {
  const id = window.location.pathname.split("/").at(-1) ?? "";
  const [token, setToken] = useState(() => window.location.hash.slice(1));
  const [passwordRequired, setPasswordRequired] = useState(false);
  const [password, setPassword] = useState("");
  const [entry, setEntry] = useState<SharedEntry | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [reachable, setReachable] = useState<boolean | null>(null);

  useEffect(() => {
    let live = true;
    async function start() {
      try {
        const policy = await api.publicSharePolicy(id);
        if (!live) return;
        setPasswordRequired(policy.password_required); setReachable(true); applyAccent(policy.accent);
        try { const existing = await api.publicShareEntry(id); if (live) setEntry(existing); return; }
        catch { /* The visitor may be arriving without a session. */ }
        if (token && !policy.password_required) {
          await api.publicShareSession(id, token);
          if (!live) return;
          const opened = await api.publicShareEntry(id);
          if (!live) return;
          window.history.replaceState(null, "", window.location.pathname);
          setToken("");
          setEntry(opened);
        } else if (!token) setError("Open the original Share link to continue.");
      } catch (cause) { if (live) { setReachable(cause instanceof ApiError); setError(message(cause)); } }
    }
    void start();
    return () => { live = false; };
  }, [id]);
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.hidden) return;
      (entry ? api.publicShareEntry(id) : api.publicSharePolicy(id)).then(() => setReachable(true)).catch(cause => {
        setEntry(null); setReachable(cause instanceof ApiError); setError(message(cause));
      });
    }, 5000);
    return () => window.clearInterval(timer);
  }, [id, entry]);

  async function unlock(event: React.FormEvent) {
    event.preventDefault();
    if (!token || busy) return;
    setBusy(true); setError("");
    try {
      await api.publicShareSession(id, token, password);
      const opened = await api.publicShareEntry(id);
      window.history.replaceState(null, "", window.location.pathname);
      setToken(""); setPassword("");
      setEntry(opened);
    } catch (cause) { setError(message(cause)); }
    finally { setBusy(false); }
  }

  if (!entry) return <main className="shared-gate">
    <div className="shared-gate-group">
      <form className="shared-gate-panel" onSubmit={unlock}>
        <p>{passwordRequired ? "Enter the Share password:" : "Opening shared entry…"}</p>
        {passwordRequired && <><label className="visually-hidden" htmlFor="share-password">Share password</label><input id="share-password" type="password" autoComplete="current-password" placeholder="Password…" value={password} onChange={event => setPassword(event.target.value)} autoFocus /><button className="button wide" disabled={busy || !token}>{busy ? "Opening…" : "Enter"}</button></>}
        {error && <p className="shared-error" role="alert">{error}</p>}
      </form>
      <div className={`shared-reach${reachable === false ? " offline" : reachable ? " reachable" : ""}`} role="status">{reachable === false ? "Service unavailable" : reachable ? "Service reachable" : "Checking service"}<span /></div>
    </div>
  </main>;

  return <main className="shared-viewer">
    <header><span className="eyebrow">VOLT · SHARED</span><h1>{entry.title}</h1></header>
    <div className="shared-viewer-body"><p className="muted">Read only · revision {entry.revision}</p><div className="shared-values">{entry.fields.map(field => <SharedField key={field.id} shareId={id} field={field} />)}</div></div>
  </main>;
}
