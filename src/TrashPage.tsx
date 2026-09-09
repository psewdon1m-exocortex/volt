import { useEffect, useMemo, useState } from "react";

import { api } from "./api";
import { ConfirmDialog } from "./ConfirmDialog";
import { Icon } from "./icons";
import type { TrashEntry } from "./types";
import { errorMessage, type Toast } from "./ui-helpers";

const DAY_MS = 24 * 60 * 60 * 1000;

function dateTime(value: string) {
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function remainingLabel(purgeAt: string, now: number) {
  const days = Math.max(0, Math.ceil((new Date(purgeAt).getTime() - now) / DAY_MS));
  return days === 1 ? "1 day left" : `${days} days left`;
}

export function TrashPage({ toast }: { toast: Toast }) {
  const [entries, setEntries] = useState<TrashEntry[]>([]);
  const [retentionDays, setRetentionDays] = useState(30);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [purgePending, setPurgePending] = useState<TrashEntry | null>(null);
  const [now, setNow] = useState(() => Date.now());

  function load(showLoader = false) {
    if (showLoader) setLoading(true);
    api.trash()
      .then((result) => { setEntries(result.entries); setRetentionDays(result.retention_days); })
      .catch((error) => toast(errorMessage(error), "error"))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    load(true);
    const timer = window.setInterval(() => { setNow(Date.now()); load(); }, 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("en-US");
    if (!needle) return entries;
    return entries.filter((entry) => [entry.title, entry.project, entry.id]
      .some((value) => value?.toLocaleLowerCase("en-US").includes(needle)));
  }, [entries, query]);

  async function restore(entry: TrashEntry) {
    setBusyId(entry.id);
    try {
      await api.restoreEntry(entry.id);
      setEntries((current) => current.filter((candidate) => candidate.id !== entry.id));
      toast(`“${entry.title}” restored to vault`);
    } catch (error) { toast(errorMessage(error), "error"); }
    finally { setBusyId(null); }
  }

  async function purge() {
    if (!purgePending) return;
    const entry = purgePending;
    setBusyId(entry.id);
    try {
      await api.purgeEntry(entry.id);
      setEntries((current) => current.filter((candidate) => candidate.id !== entry.id));
      setPurgePending(null);
      toast(`“${entry.title}” permanently deleted`);
    } catch (error) { toast(errorMessage(error), "error"); }
    finally { setBusyId(null); }
  }

  return <div className="page trash-page">
    <div className="collection-command-bar trash-command-bar" role="search" aria-label="Search deleted entries">
      <label className="search"><Icon name="search" /><input aria-label="Search trash" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Title, project, or entity ID" /></label>
      <div className="collection-information"><strong>{visible.length} / {entries.length}</strong><span>deleted</span><small>Permanently erased after {retentionDays} days</small></div>
    </div>
    {loading ? <div className="empty-state"><div className="loader" /><p>Opening trash…</p></div> : visible.length ? <div className="trash-grid">
      {visible.map((entry, index) => <article className="trash-card universal-card" key={entry.id}>
        <header className="entry-header">
          <div className="entry-title"><span className="card-ordinal">{String(index + 1).padStart(2, "0")}</span><h3>{entry.title}</h3><code className="entry-id">ID {entry.id}</code></div>
          <div className="trash-actions">
            <button className="button secondary" disabled={busyId === entry.id} onClick={() => void restore(entry)}><Icon name="restore" />Restore</button>
            <button className="button danger-button" disabled={busyId === entry.id} onClick={() => setPurgePending(entry)}><Icon name="trash" />Delete now</button>
          </div>
        </header>
        <div className="trash-card-body">
          <div className="entry-meta">{entry.project && <span className="project-tag">{entry.project}</span>}<span>v{entry.revision}</span><span>{entry.fields.length} {entry.fields.length === 1 ? "value" : "values"}</span></div>
          <dl className="trash-retention">
            <div><dt>Deleted</dt><dd><time dateTime={entry.deleted_at}>{dateTime(entry.deleted_at)}</time></dd></div>
            <div><dt>Permanent deletion</dt><dd><time dateTime={entry.purge_at}>{dateTime(entry.purge_at)}</time><strong>{remainingLabel(entry.purge_at, now)}</strong></dd></div>
          </dl>
        </div>
      </article>)}
    </div> : <div className="empty-state"><div className="empty-icon"><Icon name="trash" /></div><h2>{entries.length ? "No results" : "Trash is empty"}</h2><p>{entries.length ? "Change the search query." : `Deleted entities remain here for ${retentionDays} days before permanent deletion.`}</p></div>}
    {purgePending && <ConfirmDialog
      title={`Permanently delete “${purgePending.title}”?`}
      body={<p>All encrypted revisions and the entity key will be erased from personal.volt. This action cannot be undone.</p>}
      confirmLabel="Delete permanently"
      busy={busyId === purgePending.id}
      danger
      onClose={() => { if (!busyId) setPurgePending(null); }}
      onConfirm={purge}
    />}
  </div>;
}
