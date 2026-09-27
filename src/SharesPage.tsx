import { useEffect, useMemo, useState } from "react";

import { api, type ShareRecord } from "./api";
import { ConfirmDialog } from "./ConfirmDialog";
import { Icon } from "./icons";
import type { Entry } from "./types";
import { Modal, SearchField } from "./Ui";
import type { Toast } from "./ui-helpers";

const localDate = (iso: string) => {
  const date = new Date(iso);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};
const stamp = (iso: string) => new Date(iso).toLocaleString();
const link = (path: string) => window.location.origin + path;
const message = (error: unknown) => error instanceof Error ? error.message : "Request failed";

async function copy(text: string) {
  if (!window.isSecureContext || !document.hasFocus() || !navigator.clipboard?.writeText) return false;
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

export function ShareDialog({ initialEntry, onClose, onCreated, toast }: {
  initialEntry?: Entry;
  onClose: () => void;
  onCreated: () => void;
  toast: Toast;
}) {
  const [entries, setEntries] = useState<Entry[]>(initialEntry ? [initialEntry] : []);
  const [entryId, setEntryId] = useState(initialEntry?.id ?? "");
  const [fieldIds, setFieldIds] = useState<string[]>([]);
  const [expires, setExpires] = useState(localDate(new Date(Date.now() + 86_400_000).toISOString()));
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (initialEntry) return;
    api.entries().then(result => setEntries(result.entries)).catch(cause => setError(message(cause)));
  }, [initialEntry]);
  const entry = entries.find(candidate => candidate.id === entryId);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!entry || !fieldIds.length || busy) return;
    setBusy(true); setError("");
    try {
      const result = await api.createShare({ entry_id: entry.id, field_ids: fieldIds, expected_revision: entry.revision, expires_at: new Date(expires).toISOString(), password: password || null });
      const url = link(result.path);
      const copied = await copy(url);
      onCreated(); onClose();
      toast(copied ? "Share created and link copied" : "Share created. Use Copy link in Shared to copy it.", copied ? undefined : "error");
    } catch (cause) { setError(message(cause)); }
    finally { setBusy(false); }
  }

  return <Modal title="Create Share" eyebrow="SHARED" onClose={onClose} dirty={busy} className="share-dialog">
      <form className="share-form" onSubmit={submit}>
        <p>Select the fields this visitor may read. The values stay fixed at the current revision.</p>
        <label>Entry<select required value={entryId} onChange={event => { setEntryId(event.target.value); setFieldIds([]); }}><option value="">Choose an entry</option>{entries.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
        {entry && <fieldset className="share-field-picker"><legend>Fields to share</legend>{entry.fields.map(field => <label key={field.id}><input type="checkbox" checked={fieldIds.includes(field.id)} onChange={event => setFieldIds(current => event.target.checked ? [...current, field.id] : current.filter(id => id !== field.id))} /><span>{field.key}</span><small>{field.visibility}</small></label>)}</fieldset>}
        <label>Expires<input type="datetime-local" required value={expires} onChange={event => setExpires(event.target.value)} /></label>
        <label>Share password <span className="muted">optional</span><input type="password" autoComplete="new-password" value={password} onChange={event => setPassword(event.target.value)} placeholder="Off" /></label>
        {error && <p className="share-error" role="alert">{error}</p>}
        <div className="share-form-actions"><button type="button" className="button ghost" onClick={onClose}>Cancel</button><button className="button" type="submit" disabled={busy || !fieldIds.length}>{busy ? "Creating…" : "Create Share"}</button></div>
      </form>
  </Modal>;
}

function PolicyDialog({ share, onClose, onUpdated }: { share: ShareRecord; onClose: () => void; onUpdated: () => void }) {
  const [expires, setExpires] = useState(localDate(share.expires_at));
  const [password, setPassword] = useState("");
  const [removePassword, setRemovePassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      await api.updateShare(share.id, { expires_at: new Date(expires).toISOString(), ...(removePassword ? { password: null } : password ? { password } : {}) });
      onUpdated(); onClose();
    } catch (cause) { setError(message(cause)); }
    finally { setBusy(false); }
  }
  return <Modal title={`Policy · ${share.title}`} eyebrow="SHARED" onClose={onClose} dirty={busy} className="share-dialog"><form className="share-form" onSubmit={submit}>
    <p>Access: View. Policy changes close all existing visitor sessions.</p>
    <label>Expires<input type="datetime-local" required value={expires} onChange={event => setExpires(event.target.value)} /></label>
    <label>New Share password<input type="password" autoComplete="new-password" value={password} onChange={event => setPassword(event.target.value)} placeholder="Leave empty to keep current password" disabled={removePassword} /></label>
    {share.password_required && <label className="share-check"><input type="checkbox" checked={removePassword} onChange={event => setRemovePassword(event.target.checked)} />Remove password</label>}
    {error && <p className="share-error" role="alert">{error}</p>}
    <div className="share-form-actions"><button type="button" className="button ghost" onClick={onClose}>Cancel</button><button className="button" disabled={busy}>{busy ? "Saving…" : "Apply policy"}</button></div>
  </form></Modal>;
}

export function SharesPage({ toast }: { toast: Toast }) {
  const [shares, setShares] = useState<ShareRecord[]>([]);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<"name" | "created">("created");
  const [ascending, setAscending] = useState(false);
  const [page, setPage] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [create, setCreate] = useState(false);
  const [policy, setPolicy] = useState<ShareRecord | null>(null);
  const [revoke, setRevoke] = useState<ShareRecord | null>(null);
  const [manualLink, setManualLink] = useState<{ id: string; value: string } | null>(null);
  const [loading, setLoading] = useState(true);
  function load() { api.shares().then(result => setShares(result.shares)).catch(cause => toast(message(cause), "error")).finally(() => setLoading(false)); }
  useEffect(load, []);
  const filtered = useMemo(() => shares.filter(item => [item.title, ...item.field_names, item.status].join(" ").toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
    .sort((a, b) => (sort === "name" ? a.title.localeCompare(b.title) : a.created_at.localeCompare(b.created_at)) * (ascending ? 1 : -1)), [shares, query, sort, ascending]);
  const visible = filtered.slice(page * 100, (page + 1) * 100);

  async function copyLink(id: string) {
    try {
      const result = await api.shareLink(id); const url = link(result.path);
      if (await copy(url)) toast("Link copied");
      else { setExpanded(id); setManualLink({ id, value: url }); toast("Select the link to copy it", "error"); }
    } catch (cause) { toast(message(cause), "error"); }
  }
  async function confirmRevoke() {
    if (!revoke) return;
    try { await api.updateShare(revoke.id, { revoke: true }); setRevoke(null); setExpanded(null); load(); toast("Share revoked"); }
    catch (cause) { toast(message(cause), "error"); }
  }
  function toggleSort(next: "name" | "created") { setAscending(sort === next ? !ascending : next === "name"); setSort(next); }

  return <div className="page shares-page">
    <div className="shared-toolbar"><SearchField label="Search Shares" placeholder="Search shared entries" value={query} onChange={value => { setQuery(value); setPage(0); }} /><div className="shared-toolbar-actions"><span>{filtered.length} of {shares.length} · page {page + 1}</span><button className="button" onClick={() => setCreate(true)}>Create Share</button><button className="button secondary" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</button><button className="button secondary" disabled={(page + 1) * 100 >= filtered.length} onClick={() => setPage(page + 1)}>Next</button></div></div>
    <div className="shared-list-head"><button onClick={() => toggleSort("name")}>Name {sort === "name" ? ascending ? "↑" : "↓" : "↕"}</button><button onClick={() => toggleSort("created")}>Shared since {sort === "created" ? ascending ? "↑" : "↓" : "↕"}</button><span>Access</span></div>
    {loading ? <div className="empty-state"><p>Loading Shares…</p></div> : !visible.length ? <div className="empty-state"><h2>No Shares</h2><p>Create a link to selected fields in a Vault entry.</p></div> : <div className="shared-list">{visible.map(item => <article className={`shared-list-item${expanded === item.id ? " expanded" : ""}`} key={item.id}>
      <div className="shared-list-row"><button className="shared-list-toggle" aria-expanded={expanded === item.id} onClick={() => setExpanded(expanded === item.id ? null : item.id)}><strong>{item.title}</strong><time>{stamp(item.created_at)}</time><span>View</span></button><button className="shared-copy-button" disabled={item.status !== "active"} onClick={() => void copyLink(item.id)}>Copy link</button></div>
      {expanded === item.id && <div className="shared-list-details"><dl className="shared-metadata"><div><dt>Password</dt><dd>{item.password_required ? "On" : "Off"}</dd></div><div><dt>Shared since</dt><dd>{stamp(item.created_at)}</dd></div><div><dt>Expires at</dt><dd>{stamp(item.expires_at)}</dd></div><div><dt>Fields</dt><dd>{item.field_count}</dd></div><div><dt>Access</dt><dd>View</dd></div><div><dt>Status</dt><dd>{item.status}</dd></div></dl><p className="muted">Fields: {item.field_names.join(", ") || "Unavailable"} · Revision {item.revision ?? "—"}</p>{manualLink?.id === item.id && <label className="share-manual-link">Share link<input readOnly value={manualLink.value} onFocus={event => event.currentTarget.select()} /></label>}<div className="shared-list-footer"><p>This link opens only the selected fields from this revision.</p><div><button className="button secondary" onClick={() => setPolicy(item)}>Policy</button><button className="button danger-button" onClick={() => setRevoke(item)}>Revoke</button></div></div></div>}
    </article>)}</div>}
    {create && <ShareDialog onClose={() => setCreate(false)} onCreated={load} toast={toast} />}
    {policy && <PolicyDialog share={policy} onClose={() => setPolicy(null)} onUpdated={() => { load(); toast("Share policy updated"); }} />}
    {revoke && <ConfirmDialog title="Revoke Share?" body={<p>The link and all visitor sessions will stop working. The Vault entry remains unchanged.</p>} confirmLabel="Revoke" danger onClose={() => setRevoke(null)} onConfirm={() => void confirmRevoke()} />}
  </div>;
}
