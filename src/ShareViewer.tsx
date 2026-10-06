import { useEffect, useState } from "react";

import { ApiError, api, type SharedEntry } from "./api";
import { Icon } from "./icons";
import { VoltLogo } from "./Ui";
import { applyAccent } from "./ui-helpers";

type SharePolicy = Awaited<ReturnType<typeof api.publicSharePolicy>>;

function message(error: unknown) { return error instanceof Error ? error.message : "Share is unavailable"; }

function formatExpiry(value?: string) {
  if (!value) return "Unavailable";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Unavailable";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function ShareBrand() {
  return <div className="share-client-brand" aria-label="Volt">
    <VoltLogo size="login" />
    <span>volt</span>
  </div>;
}

function SharedField({ shareId, field, legacy }: { shareId: string; field: SharedEntry["fields"][number]; legacy: boolean }) {
  const [revealed, setRevealed] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  useEffect(() => {
    if (revealed == null) return;
    const timer = window.setTimeout(() => setRevealed(null), 30_000);
    const hide = () => { if (document.hidden) setRevealed(null); };
    document.addEventListener("visibilitychange", hide);
    return () => { window.clearTimeout(timer); document.removeEventListener("visibilitychange", hide); };
  }, [revealed]);

  async function value() { return field.visibility === "secret" ? (await api.publicShareReveal(shareId, field.id)).value : field.value ?? ""; }
  async function show() {
    try { setNotice(""); setRevealed(revealed == null ? await value() : null); }
    catch (cause) { setRevealed(null); setNotice(message(cause)); }
  }
  async function copy() {
    try {
      const content = await value();
      if (!window.isSecureContext || !document.hasFocus() || !navigator.clipboard?.writeText) {
        setNotice(field.visibility === "secret" ? "Clipboard unavailable. Use Reveal to select the value." : "Clipboard unavailable. Select the value to copy it.");
        return;
      }
      await navigator.clipboard.writeText(content);
      setNotice("Copied");
    } catch (cause) { setNotice(message(cause)); }
  }

  const hidden = field.visibility === "secret" && revealed == null;
  const content = hidden ? "*".repeat(field.length ?? 12) : revealed ?? field.value ?? "";

  if (legacy) return <div className="shared-value">
    <div><span className="eyebrow">{field.key}</span><div className="shared-value-text">{hidden ? "•".repeat(Math.min(field.length ?? 12, 64)) : content}</div></div>
    <div className="shared-value-actions">
      {field.visibility === "secret" && <button type="button" className="button secondary small" aria-label={`${revealed == null ? "Reveal" : "Hide"} ${field.key}`} onClick={show}><Icon name="eye" />{revealed == null ? "Reveal" : "Hide"}</button>}
      <button type="button" className="button secondary small" aria-label={`Copy ${field.key}`} onClick={copy}><Icon name="copy" />Copy</button>
    </div>
    {notice && <span className="shared-field-notice" role="status">{notice}</span>}
  </div>;

  return <article className={`share-client-value share-client-value--${field.visibility}`}>
    <div className="share-client-value-heading">
      <h2>{field.key}</h2>
      <span>{field.visibility === "secret" ? "Secret value" : "Plain value"}</span>
    </div>
    <div className="share-client-value-text">
      {hidden ? <span aria-label={`Secret value hidden, ${field.length ?? 12} characters`}><span aria-hidden="true">{content}</span></span> : content}
    </div>
    <div className="share-client-value-actions">
      {field.visibility === "secret" && <button type="button" aria-label={`${revealed == null ? "Reveal" : "Hide"} ${field.key}`} onClick={show}><Icon name="eye" />{revealed == null ? "Reveal" : "Hide"}</button>}
      <button type="button" aria-label={`Copy ${field.key}`} onClick={copy}><Icon name="copy" />Copy</button>
    </div>
    {notice && <p className="share-client-field-notice" role="status">{notice}</p>}
  </article>;
}

function LegacyGate({ passwordRequired, password, busy, token, error, reachable, onPassword, onSubmit }: {
  passwordRequired: boolean;
  password: string;
  busy: boolean;
  token: string;
  error: string;
  reachable: boolean | null;
  onPassword: (value: string) => void;
  onSubmit: (event: React.FormEvent) => void;
}) {
  return <main className="shared-gate">
    <div className="shared-gate-group">
      <form className="shared-gate-panel" onSubmit={onSubmit}>
        <p>{passwordRequired ? "Enter the Share password:" : "Opening shared entry…"}</p>
        {passwordRequired && <><label className="visually-hidden" htmlFor="share-password">Share password</label><input id="share-password" type="password" autoComplete="current-password" placeholder="Password…" value={password} onChange={event => onPassword(event.target.value)} autoFocus /><button className="button wide" disabled={busy || !token}>{busy ? "Opening…" : "Enter"}</button></>}
        {error && <p className="shared-error" role="alert">{error}</p>}
      </form>
      <div className={`shared-reach${reachable === false ? " offline" : reachable ? " reachable" : ""}`} role="status">{reachable === false ? "Service unavailable" : reachable ? "Service reachable" : "Checking service"}<span /></div>
    </div>
  </main>;
}

function CurrentGate({ passwordRequired, password, busy, token, error, reachable, onPassword, onSubmit }: {
  passwordRequired: boolean;
  password: string;
  busy: boolean;
  token: string;
  error: string;
  reachable: boolean | null;
  onPassword: (value: string) => void;
  onSubmit: (event: React.FormEvent) => void;
}) {
  const unavailable = Boolean(error) && !passwordRequired;
  return <main className="share-client share-client-gate">
    <div className="share-client-gate-shell">
      <ShareBrand />
      <section className="share-client-gate-card" aria-labelledby="share-gate-title">
        <div className="share-client-lock" aria-hidden="true"><Icon name={passwordRequired ? "lock" : "link"} /></div>
        <span className="share-client-kicker">{passwordRequired ? "PRIVATE SHARED LINK" : "SHARED ENTRY"}</span>
        <h1 id="share-gate-title">{passwordRequired ? "This link is protected" : unavailable ? "Share unavailable" : "Opening shared entry"}</h1>
        <p>{passwordRequired ? "Enter the password provided by the sender to view the shared values." : unavailable ? "The link may be invalid, expired, or no longer available." : "Checking the link and its access policy…"}</p>
        {passwordRequired && <form onSubmit={onSubmit}>
          <label htmlFor="share-client-password">Password</label>
          <input id="share-client-password" type="password" required autoComplete="current-password" value={password} onChange={event => onPassword(event.target.value)} autoFocus />
          <button type="submit" disabled={busy || !token}>{busy ? "Checking…" : "Continue"}</button>
        </form>}
        {error && <p className="share-client-error" role="alert">{error}</p>}
        {reachable === false && <p className="share-client-service-error" role="status">Volt is currently unreachable. Try again when the service is available.</p>}
      </section>
      <p className="share-client-attribution">Shared securely with Volt</p>
    </div>
  </main>;
}

function LegacyOpened({ id, entry }: { id: string; entry: SharedEntry }) {
  return <main className="shared-viewer">
    <header><span className="eyebrow">VOLT · SHARED</span><h1>{entry.title}</h1></header>
    <div className="shared-viewer-body"><p className="muted">Read only · revision {entry.revision}</p><div className="shared-values">{entry.fields.map(field => <SharedField key={field.id} shareId={id} field={field} legacy />)}</div></div>
  </main>;
}

function CurrentOpened({ id, entry, policy }: { id: string; entry: SharedEntry; policy: SharePolicy | null }) {
  const expiry = formatExpiry(policy?.expires_at);
  return <main className="share-client share-client-opened">
    <header className="share-client-topbar">
      <div className="share-client-topbar-inner">
        <ShareBrand />
        <div className="share-client-access"><span>View only</span><time dateTime={policy?.expires_at}>Available until {expiry}</time></div>
      </div>
    </header>
    <div className="share-client-main">
      <section className="share-client-intro" aria-labelledby="share-entry-title">
        <span className="share-client-kicker">SHARED ENTRY</span>
        <h1 id="share-entry-title">{entry.title}</h1>
        <p>{entry.fields.length} {entry.fields.length === 1 ? "value" : "values"} · revision {entry.revision}</p>
      </section>
      <section className="share-client-collection" aria-labelledby="shared-values-title">
        <div className="share-client-collection-head"><h2 id="shared-values-title">Shared values</h2><span>{entry.fields.length}</span></div>
        <div className="share-client-values">{entry.fields.map(field => <SharedField key={field.id} shareId={id} field={field} legacy={false} />)}</div>
      </section>
      <details className="share-client-about">
        <summary>About access</summary>
        <div><p>This read-only link exposes only the selected values from revision {entry.revision}. It does not provide access to the rest of the Vault entry.</p><p>Secret values remain hidden until Reveal is selected and hide again after 30 seconds or when this tab moves to the background. Content delivered to a browser can still be copied.</p><p>This link is available until {expiry}.</p></div>
      </details>
    </div>
    <footer className="share-client-footer">Shared via Volt</footer>
  </main>;
}

export function ShareViewer() {
  const id = window.location.pathname.split("/").at(-1) ?? "";
  const legacy = new URLSearchParams(window.location.search).get("legacy") === "1";
  const [token] = useState(() => window.location.hash.slice(1));
  const [policy, setPolicy] = useState<SharePolicy | null>(null);
  const [password, setPassword] = useState("");
  const [entry, setEntry] = useState<SharedEntry | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [reachable, setReachable] = useState<boolean | null>(null);

  useEffect(() => {
    let live = true;
    async function start() {
      try {
        const nextPolicy = await api.publicSharePolicy(id);
        if (!live) return;
        setPolicy(nextPolicy); setReachable(true); applyAccent(nextPolicy.accent);
        try {
          const existing = await api.publicShareEntry(id);
          if (!live) return;
          setEntry(existing);
          return;
        } catch { /* The visitor may be arriving without a session. */ }
        if (token && !nextPolicy.password_required) {
          await api.publicShareSession(id, token);
          if (!live) return;
          const opened = await api.publicShareEntry(id);
          if (!live) return;
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
      (entry ? api.publicShareEntry(id) : api.publicSharePolicy(id)).then(result => {
        setReachable(true);
        if (!entry) setPolicy(result as SharePolicy);
      }).catch(cause => {
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
      setEntry(opened);
    } catch (cause) { setError(message(cause)); }
    finally { setPassword(""); setBusy(false); }
  }

  if (!entry) {
    const gate = { passwordRequired: policy?.password_required ?? false, password, busy, token, error, reachable, onPassword: setPassword, onSubmit: unlock };
    return legacy ? <LegacyGate {...gate} /> : <CurrentGate {...gate} />;
  }
  return legacy ? <LegacyOpened id={id} entry={entry} /> : <CurrentOpened id={id} entry={entry} policy={policy} />;
}
