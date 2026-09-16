import { useEffect, useId, useMemo, useState } from "react";

import { ApiError, api } from "./api";
import { ConfirmDialog } from "./ConfirmDialog";
import { Icon } from "./icons";
import type { Entry, GeneratedValue, Revision, VoltField } from "./types";
import { DragDots, Modal, SearchField } from "./Ui";
import { dropItem, moveItem } from "./ui-helpers";

type Toast = (message: string, tone?: "ok" | "error") => void;
const MAX_ENTRY_VALUES = 20;

function maskValue(value: string) {
  return [...value].map((character) => character === "\n" || character === "\r" ? character : "*").join("");
}

function dateTime(value: string) {
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Could not complete the action";
}

function FieldValue({ entryId, field, position, revision, toast, onInteracted }: { entryId: string; field: VoltField; position: number; revision?: number; toast: Toast; onInteracted?: () => void }) {
  const [revealed, setRevealed] = useState<string | null>(null);
  const [manualReference, setManualReference] = useState<string | null>(null);
  const secret = field.visibility === "secret";

  useEffect(() => {
    setRevealed(null);
    setManualReference(null);
  }, [entryId, field.id, position, revision]);
  useEffect(() => {
    const hide = () => { if (document.hidden) setRevealed(null); };
    document.addEventListener("visibilitychange", hide);
    return () => document.removeEventListener("visibilitychange", hide);
  }, []);

  async function getValue(show = true) {
    if (!secret) return field.value ?? "";
    if (revealed != null) return revealed;
    const result = await api.reveal(entryId, field.id, revision);
    if (show) {
      setRevealed(result.value);
      window.setTimeout(() => setRevealed(null), 30_000);
    }
    return result.value;
  }

  async function reveal(event: React.MouseEvent) {
    event.stopPropagation();
    try {
      if (revealed != null) setRevealed(null);
      else {
        await getValue();
        if (revision == null) void api.recordEntryInteraction(entryId, "reveal").then(() => onInteracted?.()).catch(() => undefined);
      }
    } catch (error) { toast(errorMessage(error), "error"); }
  }

  async function copy(event: React.MouseEvent) {
    event.stopPropagation();
    if (!window.isSecureContext || !document.hasFocus() || !navigator.clipboard?.writeText) {
      toast("Clipboard unavailable — use Reveal to select the value manually", "error");
      return;
    }
    try {
      const value = await getValue(false);
      try {
        await navigator.clipboard.writeText(value);
        toast("Value copied");
        if (revision == null) void api.recordEntryInteraction(entryId, "copy.value").then(() => onInteracted?.()).catch(() => undefined);
      } catch {
        toast("Clipboard unavailable — use Reveal to select the value manually", "error");
      }
    } catch (error) { toast(errorMessage(error), "error"); }
  }

  async function copyReference(event: React.MouseEvent) {
    event.stopPropagation();
    try {
      const reference = `volt://${entryId}/${position}`;
      if (!window.isSecureContext || !document.hasFocus() || !navigator.clipboard?.writeText) {
        setManualReference(reference); toast("Clipboard unavailable — the reference is shown for manual copying", "error"); return;
      }
      try { await navigator.clipboard.writeText(reference); setManualReference(null); toast("Value reference copied"); void api.recordEntryInteraction(entryId, "copy.reference").then(() => onInteracted?.()).catch(() => undefined); }
      catch { setManualReference(reference); toast("Clipboard unavailable — the reference is shown for manual copying", "error"); }
    } catch (error) { toast(errorMessage(error), "error"); }
  }

  return (
    <div className="field-row">
      <div className="field-copy">
        <span className="field-key">{field.key}</span>
        <span className={`field-value${secret ? " mono" : ""}`} title={secret ? undefined : field.value ?? ""}>
          {secret && revealed == null ? "*".repeat(field.length ?? 12) : (revealed ?? field.value ?? "—")}
        </span>
      </div>
      <div className="field-actions">
        {revision == null && <button className="icon-button" type="button" title="Copy reference for Kernel Register" aria-label="Copy Volt reference" onClick={copyReference}><Icon name="link" /></button>}
        {secret && <button className="icon-button" type="button" aria-label={revealed == null ? "Reveal value" : "Hide value"} onClick={reveal}><Icon name="eye" /></button>}
        <button className="icon-button" type="button" aria-label="Copy value and replace clipboard contents" onClick={copy}><Icon name="copy" /></button>
      </div>
      {manualReference && <input className="manual-copy" aria-label="Volt reference for manual copying" readOnly value={manualReference} onFocus={(event) => event.currentTarget.select()} />}
    </div>
  );
}

function RevisionPanel({ entry, toast, onRestored }: { entry: Entry; toast: Toast; onRestored: () => void }) {
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [selected, setSelected] = useState<Entry | null>(null);
  const [busy, setBusy] = useState(true);
  const [restorePending, setRestorePending] = useState(false);

  useEffect(() => {
    api.revisions(entry.id).then((result) => setRevisions(result.revisions)).catch((error) => toast(errorMessage(error), "error")).finally(() => setBusy(false));
  }, [entry.id, toast]);

  async function inspect(revision: Revision) {
    try { setSelected(await api.revision(entry.id, revision.revision)); }
    catch (error) { toast(errorMessage(error), "error"); }
  }

  async function restore() {
    if (!selected) return;
    try {
      await api.restoreRevision(entry.id, selected.revision);
      toast(`Revision ${selected.revision} restored`);
      onRestored();
      setRestorePending(false);
    } catch (error) { toast(errorMessage(error), "error"); }
  }

  return (
    <section className="revision-panel editor-revisions" aria-label="Version history" onClick={(event) => event.stopPropagation()}>
      <div className="revision-heading">
        <div><span className="eyebrow">HISTORY</span><strong>{revisions.length} revisions</strong></div>
        <span className="muted">Previous values are revealed only on request</span>
      </div>
      {busy ? <div className="inline-loader">Loading history…</div> : (
        <div className="revision-layout">
          <div className="revision-list">
            {revisions.map((revision) => (
              <button type="button" key={revision.id} className={`revision-item${selected?.revision === revision.revision ? " selected" : ""}`} onClick={() => inspect(revision)}>
                <span><b>v{revision.revision}</b>{revision.current && <em>current</em>}</span>
                <small>{dateTime(revision.created_at)}</small>
                <small>{revision.reason ?? "no comment"}</small>
              </button>
            ))}
          </div>
          <div className="revision-preview">
            {!selected ? <div className="preview-placeholder">Select a revision to preview</div> : <>
              <div className="revision-preview-head">
                <div><span className="eyebrow">SNAPSHOT</span><h4>v{selected.revision} · {selected.title}</h4></div>
                {selected.revision !== entry.revision && <button type="button" className="button secondary small" onClick={() => setRestorePending(true)}>Restore</button>}
              </div>
              {selected.fields.map((field, index) => <FieldValue key={field.id} entryId={entry.id} field={field} position={index + 1} revision={selected.revision} toast={toast} />)}
            </>}
          </div>
        </div>
      )}
      {restorePending && selected && <ConfirmDialog title={`Restore revision ${selected.revision}?`} body={<p>Its values will become a new revision. The current version will remain in history.</p>} confirmLabel="Restore" onClose={() => setRestorePending(false)} onConfirm={restore} />}
    </section>
  );
}

interface EditorValue extends VoltField { value: string }

function createEditorValue(value = "", visibility: VoltField["visibility"] = "secret", key = "value"): EditorValue {
  const id = crypto.randomUUID();
  return { id, key, value, visibility, generator: null };
}

function GeneratorDialog({ availableSlots, onApply, onClose, toast }: {
  availableSlots: number;
  onApply: (result: GeneratedValue) => void;
  onClose: () => void;
  toast: Toast;
}) {
  const [type, setType] = useState("password");
  const [length, setLength] = useState(24);
  const [sets, setSets] = useState({ lowercase: true, uppercase: true, numbers: true, special: true });
  const [hmacBytes, setHmacBytes] = useState(32);
  const [rsaBits, setRsaBits] = useState(3072);
  const [commonName, setCommonName] = useState("localhost");
  const [sans, setSans] = useState("localhost, 127.0.0.1");
  const [preview, setPreview] = useState<GeneratedValue | null>(null);
  const [busy, setBusy] = useState(false);

  async function generate() {
    if ((type === "rsa" || type === "certificate") && availableSlots < 2) {
      toast("A key pair requires two available value slots", "error");
      return;
    }
    const options: Record<string, unknown> = { type };
    if (type === "password") Object.assign(options, sets, { length });
    if (type === "hmac") Object.assign(options, { bytes: hmacBytes, encoding: "base64url" });
    if (type === "rsa") options.modulus_length = rsaBits;
    if (type === "certificate") Object.assign(options, { common_name: commonName, sans: sans.split(",").map((item) => item.trim()).filter(Boolean), valid_days: 365 });
    setBusy(true);
    try {
      const result = await api.generate(options);
      if (!Array.isArray(result.values) || !result.values.length) throw new Error("Generator returned an invalid response");
      setPreview(result);
    }
    catch (error) { toast(errorMessage(error), "error"); }
    finally { setBusy(false); }
  }

  return (
    <Modal title="New value" eyebrow="GENERATOR" dirty={busy} onClose={onClose} footer={<><button className="button ghost" onClick={onClose}>Cancel</button><button className="button" disabled={!preview} onClick={() => preview && onApply(preview)}>Use value</button></>}>
      <div className="generator-tabs">
          {[['password', 'Password'], ['identifier', 'ID'], ['certificate', 'Certificate'], ['hmac', 'HMAC'], ['rsa', 'RSA']].map(([value, label]) => (
            <button key={value} className={type === value ? "active" : ""} onClick={() => { setType(value); setPreview(null); }}>{label}</button>
          ))}
      </div>
      <div className="generator-body">
          {type === "password" && <>
            <label className="control-label">Length <output>{length}</output><input type="range" min="4" max="128" value={length} onChange={(event) => setLength(Number(event.target.value))} /></label>
            <div className="option-grid">
              {[['lowercase', 'a–z'], ['uppercase', 'A–Z'], ['numbers', '0–9'], ['special', 'special characters']].map(([key, label]) => <label className="check-option" key={key}><input type="checkbox" checked={sets[key as keyof typeof sets]} onChange={(event) => setSets({ ...sets, [key]: event.target.checked })} /><span>{label}</span></label>)}
            </div>
            <p className="hint"><code>"</code> and <code>@</code> are always excluded.</p>
          </>}
          {type === "hmac" && <label className="control-label">Key size<select value={hmacBytes} onChange={(event) => setHmacBytes(Number(event.target.value))}><option value="32">256 bits</option><option value="48">384 bits</option><option value="64">512 bits</option></select></label>}
          {type === "rsa" && <label className="control-label">RSA size<select value={rsaBits} onChange={(event) => setRsaBits(Number(event.target.value))}><option value="2048">2048 bits</option><option value="3072">3072 bits</option><option value="4096">4096 bits</option></select><small>A private key and public key will be added.</small></label>}
          {type === "certificate" && <div className="form-grid"><label className="control-label">Common Name<input value={commonName} onChange={(event) => setCommonName(event.target.value)} /></label><label className="control-label">SAN, comma-separated<input value={sans} onChange={(event) => setSans(event.target.value)} /></label><small>For local TLS and testing. Creates a self-signed certificate that browsers do not trust automatically, plus its secret private key.</small></div>}
          {type === "identifier" && <div className="generator-note"><strong>16 characters</strong><span>A–Z and 0–9 · ≈82.7 bits of entropy</span></div>}
          <button className="button generator-action" onClick={generate} disabled={busy}>{busy ? "Generating…" : preview ? "Generate again" : "Generate"}</button>
          {preview && <div className="generated-preview"><div><span className="eyebrow">RESULT</span>{preview.entropy_bits != null && <b>{preview.entropy_bits} bits of entropy</b>}</div>{preview.values.map((value) => <code key={value.key}>{value.value}</code>)}</div>}
      </div>
    </Modal>
  );
}

function EntryEditor({ entry, initialFields, projectOptions, onClose, onSaved, toast }: {
  entry: Entry | null;
  initialFields?: EditorValue[];
  projectOptions: string[];
  onClose: () => void;
  onSaved: () => void;
  toast: Toast;
}) {
  const [title, setTitle] = useState(entry?.title ?? "");
  const [projects, setProjects] = useState<string[]>(entry?.projects ?? []);
  const [projectDraft, setProjectDraft] = useState("");
  const [reason, setReason] = useState("");
  const [fields, setFields] = useState<EditorValue[]>(() => initialFields ?? [createEditorValue()]);
  const [generatorIndex, setGeneratorIndex] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragReadyValue, setDragReadyValue] = useState<string | null>(null);
  const [draggingValue, setDraggingValue] = useState<string | null>(null);
  const [valueDropTarget, setValueDropTarget] = useState<{ id: string; before: boolean } | null>(null);
  const projectInputId = useId();
  const projectSuggestion = useMemo(() => {
    const needle = projectDraft.trim().toLocaleLowerCase("en-US");
    if (!needle) return null;
    return projectOptions.find((option) => (
      !projects.some((project) => project.toLocaleLowerCase("en-US") === option.toLocaleLowerCase("en-US"))
      && option.toLocaleLowerCase("en-US").startsWith(needle)
      && option.toLocaleLowerCase("en-US") !== needle
    )) ?? null;
  }, [projectDraft, projectOptions, projects]);

  function nextProjects(includeDraft = false) {
    const draft = projectDraft.trim();
    if (!includeDraft || !draft) return projects;
    return projects.some((project) => project.toLocaleLowerCase("en-US") === draft.toLocaleLowerCase("en-US")) ? projects : [...projects, draft];
  }

  function addProject(value = projectDraft) {
    const draft = value.trim();
    if (!draft) return;
    if (projects.length >= 20) return toast("An entry can belong to at most 20 projects", "error");
    if (projects.some((project) => project.toLocaleLowerCase("en-US") === draft.toLocaleLowerCase("en-US"))) {
      setProjectDraft("");
      return;
    }
    setProjects([...projects, draft]);
    setProjectDraft("");
  }

  function updateField(index: number, update: Partial<EditorValue>) {
    setFields((current) => current.map((field, fieldIndex) => fieldIndex === index ? { ...field, ...update } : field));
  }

  function moveField(index: number, direction: -1 | 1) {
    setFields((current) => moveItem(current, index, direction));
  }

  function dropField(targetId: string, before: boolean) {
    if (!draggingValue) return;
    setFields((current) => dropItem(current, current.findIndex((field) => field.id === draggingValue), current.findIndex((field) => field.id === targetId), before));
    setDragReadyValue(null);
    setDraggingValue(null);
    setValueDropTarget(null);
  }

  function applyGenerated(result: GeneratedValue) {
    if (generatorIndex == null) return;
    const values: EditorValue[] = result.values.map((value) => ({
      ...createEditorValue(value.value, value.visibility, value.key), generator: { type: result.kind, ...result.parameters },
    } satisfies EditorValue));
    if (fields.length - 1 + values.length > MAX_ENTRY_VALUES) {
      toast("Free one more value slot for the key pair", "error");
      return;
    }
    const current = fields[generatorIndex];
    values[0].id = current.id;
    if (current.key !== "value") values[0].key = current.key;
    if (values.length === 1) values[0].visibility = current.visibility;
    setFields([...fields.slice(0, generatorIndex), ...values, ...fields.slice(generatorIndex + 1)]);
    setGeneratorIndex(null);
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (projects.length >= 20 && projectDraft.trim() && !projects.some((project) => project.toLocaleLowerCase("en-US") === projectDraft.trim().toLocaleLowerCase("en-US"))) {
      toast("An entry can belong to at most 20 projects", "error");
      return;
    }
    setBusy(true);
    const payload = { title, projects: nextProjects(true), fields, reason: reason || undefined, expected_revision: entry?.revision };
    try {
      if (entry) await api.updateEntry(entry.id, payload);
      else await api.createEntry(payload);
      toast(entry ? "Entry updated — a new revision was created" : "Entry created");
      onSaved();
    } catch (error) {
      toast(error instanceof ApiError && error.code === "ENTRY_REVISION_CONFLICT" ? "This entry has already changed. Close the editor and open it again." : errorMessage(error), "error");
    } finally { setBusy(false); }
  }

  return <>
    <Modal title={entry ? "Edit entry" : "Add to Volt"} eyebrow={entry ? `ENTITY ${entry.id}` : "NEW ENTRY"} className="editor-card" dirty={busy || Boolean(title || projects.length || projectDraft || fields.some((field) => field.value))} onClose={onClose} footer={<><button className="button ghost" type="button" onClick={onClose}>Cancel</button><button className="button" form="entry-editor-form" disabled={busy}>{busy ? "Saving…" : "Save"}</button></>}>
      <form id="entry-editor-form" onSubmit={save}>
        <div className="editor-body">
          <div className="form-grid two editor-identity"><label className="control-label">Title<input required maxLength={120} autoFocus value={title} onChange={(event) => setTitle(event.target.value)} /></label><div className="control-label project-control"><label htmlFor={projectInputId}>Projects</label><div className="project-input-row"><div className="project-autocomplete"><span className="project-autocomplete-ghost" aria-hidden="true">{projectSuggestion ?? ""}</span><input id={projectInputId} autoComplete="off" aria-autocomplete="inline" aria-describedby={`${projectInputId}-hint`} maxLength={80} value={projectDraft} onChange={(event) => setProjectDraft(event.target.value)} onKeyDown={(event) => { if ((event.key === "Tab" || event.key === "ArrowRight") && projectSuggestion && (event.key === "Tab" || event.currentTarget.selectionStart === projectDraft.length)) { event.preventDefault(); setProjectDraft(projectSuggestion); return; } if (event.key !== "Enter" && event.key !== ",") return; event.preventDefault(); addProject(projectSuggestion ?? projectDraft); }} /></div><button className="button secondary" type="button" disabled={!projectDraft.trim() || projects.length >= 20} onClick={() => addProject()} aria-label="Add project"><Icon name="plus" />Add</button></div><span id={`${projectInputId}-hint`} className="project-autocomplete-hint">{projectSuggestion ? `Tab or right arrow completes “${projectSuggestion}”` : "Type a new or known project name"}</span>{projects.length > 0 && <span className="project-selection" aria-label="Selected projects">{projects.map((project) => <button key={project} type="button" className="project-tag selected" title={`Remove ${project}`} onClick={() => setProjects(projects.filter((value) => value !== project))}>{project}<span aria-hidden="true">×</span></button>)}</span>}</div></div>
          <div className="values-header"><div><span className="eyebrow">VALUES</span><strong>{fields.length} / {MAX_ENTRY_VALUES}</strong></div>{fields.length < MAX_ENTRY_VALUES && <button className="button secondary small" type="button" onClick={() => setFields([...fields, createEditorValue()])}><Icon name="plus" />Add</button>}</div>
          <p className="hint">Kernel references use these 1-based positions. Reordering or deleting values changes what an existing reference resolves.</p>
          <div className="editor-values">
            {fields.map((field, index) => {
              const dropClass = valueDropTarget?.id === field.id ? (valueDropTarget.before ? " drop-before" : " drop-after") : "";
              return <div className={`editor-value${draggingValue === field.id ? " dragging" : ""}${dropClass}`} key={field.id} draggable={dragReadyValue === field.id} onDragStart={(event) => { event.dataTransfer.effectAllowed = "move"; setDraggingValue(field.id); }} onDragEnd={() => { setDragReadyValue(null); setDraggingValue(null); setValueDropTarget(null); }} onDragOver={(event) => { event.preventDefault(); const rect = event.currentTarget.getBoundingClientRect(); setValueDropTarget({ id: field.id, before: event.clientY < rect.top + rect.height / 2 }); }} onDrop={(event) => { event.preventDefault(); dropField(field.id, valueDropTarget?.id === field.id ? valueDropTarget.before : true); }}>
              <DragDots label={`Move value ${index + 1}`} onPointerDown={() => setDragReadyValue(field.id)} onPointerUp={() => setDragReadyValue(null)} onKeyDown={(event) => { if (!event.altKey || !["ArrowUp", "ArrowDown"].includes(event.key)) return; event.preventDefault(); moveField(index, event.key === "ArrowUp" ? -1 : 1); }} />
              <span className="value-number">{String(index + 1).padStart(2, "0")}</span>
              <input className="value-key-input" aria-label={`Key ${index + 1}`} required maxLength={64} value={field.key} onChange={(event) => updateField(index, { key: event.target.value })} placeholder="Key" />
              <div className={`editor-value-input${field.visibility === "secret" ? " secret" : ""}`}>
                <textarea aria-label={`${field.visibility === "secret" ? "Secret " : ""}Value ${index + 1}`} required rows={field.value.includes("\n") ? 5 : 1} value={field.value} onChange={(event) => updateField(index, { value: event.target.value })} onCopy={(event) => { if (field.visibility !== "secret") return; const start = event.currentTarget.selectionStart; const end = event.currentTarget.selectionEnd; if (start === end) return; event.preventDefault(); event.clipboardData.setData("text/plain", field.value.slice(start, end)); }} placeholder="Value" />
                {field.visibility === "secret" && <span className={field.value.includes("\n") ? "multiline" : ""} aria-hidden="true">{maskValue(field.value)}</span>}
              </div>
              <div className="value-tools"><div className="segmented"><button type="button" className={field.visibility === "secret" ? "active" : ""} onClick={() => updateField(index, { visibility: "secret" })}>Secret</button><button type="button" className={field.visibility === "plain" ? "active" : ""} onClick={() => updateField(index, { visibility: "plain" })}>Plain</button></div><button className="icon-button accent" type="button" title="Generate" onClick={() => setGeneratorIndex(index)}><Icon name="spark" /></button>{fields.length > 1 && <button className="icon-button danger" type="button" title="Delete value" onClick={() => setFields(fields.filter((_, i) => i !== index))}><Icon name="trash" /></button>}</div>
            </div>; })}
          </div>
          {entry && <label className="control-label">Revision comment <span>optional</span><input maxLength={240} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Password updated" /></label>}
        </div>
      </form>
      {entry && <RevisionPanel entry={entry} toast={toast} onRestored={onSaved} />}
    </Modal>
    {generatorIndex != null && <GeneratorDialog availableSlots={MAX_ENTRY_VALUES + 1 - fields.length} toast={toast} onClose={() => setGeneratorIndex(null)} onApply={applyGenerated} />}
  </>;
}

function EntryCard({ entry, index, projectOptions, onChanged, onInteracted, toast, move, dragging, dropTarget, onDragStart, onDragEnd, onDragPosition, onDrop }: {
  entry: Entry;
  index: number;
  projectOptions: string[];
  onChanged: () => void;
  onInteracted: () => void;
  toast: Toast;
  move: (direction: -1 | 1) => void;
  dragging: string | null;
  dropTarget: { id: string; before: boolean } | null;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDragPosition: (before: boolean) => void;
  onDrop: () => void;
}) {
  const [editorFields, setEditorFields] = useState<EditorValue[] | null>(null);
  const [loadingEdit, setLoadingEdit] = useState(false);
  const [deletePending, setDeletePending] = useState(false);
  const [dragReady, setDragReady] = useState(false);

  async function openEditor() {
    if (loadingEdit) return;
    setLoadingEdit(true);
    try {
      const resolved = await Promise.all(entry.fields.map(async (field) => ({
        ...field,
        value: field.visibility === "secret" ? (await api.reveal(entry.id, field.id)).value : field.value ?? "",
      })));
      setEditorFields(resolved);
      void api.recordEntryInteraction(entry.id, "open").catch(() => undefined);
    } catch (error) { toast(errorMessage(error), "error"); }
    finally { setLoadingEdit(false); }
  }

  async function remove() {
    try { await api.deleteEntry(entry.id); toast("Entry moved to trash"); setDeletePending(false); onChanged(); }
    catch (error) { toast(errorMessage(error), "error"); }
  }

  const dropClass = dropTarget?.id === entry.id ? (dropTarget.before ? " drop-before" : " drop-after") : "";
  return <>
    <article className={`entry-card universal-card${dragging === entry.id ? " dragging" : ""}${dropClass}`} draggable={dragReady} onDoubleClick={(event) => { if (!(event.target instanceof Element && event.target.closest("button, input, textarea, select, a"))) void openEditor(); }} onDragStart={(event) => { event.dataTransfer.effectAllowed = "move"; onDragStart(); }} onDragEnd={() => { setDragReady(false); onDragEnd(); }} onDragOver={(event) => { event.preventDefault(); const rect = event.currentTarget.getBoundingClientRect(); onDragPosition(event.clientY < rect.top + rect.height / 2); }} onDrop={(event) => { event.preventDefault(); setDragReady(false); onDrop(); }}>
      <div className="card-main">
        <header className="entry-header"><div className="entry-title"><span className="card-ordinal">{String(index + 1).padStart(2, "0")}</span><h3>{entry.title}</h3><code className="entry-id">ID {entry.id}</code></div><div className="entry-actions"><button className="icon-button" title="Edit" disabled={loadingEdit} onClick={(event) => { event.stopPropagation(); void openEditor(); }}><Icon name="edit" /></button><button className="icon-button danger" title="Delete" onClick={() => setDeletePending(true)}><Icon name="trash" /></button><DragDots label={`Move ${entry.title}`} onPointerDown={() => setDragReady(true)} onPointerUp={() => setDragReady(false)} onKeyDown={(event) => { if (!event.altKey || !["ArrowUp", "ArrowDown"].includes(event.key)) return; event.preventDefault(); move(event.key === "ArrowUp" ? -1 : 1); }} /></div></header>
        <div className="entry-meta">{entry.projects.map((project) => <span className="project-tag" key={project}>{project}</span>)}<span>v{entry.revision}</span><span>{dateTime(entry.updated_at)}</span></div>
        <div className="field-list">{entry.fields.map((field, index) => <FieldValue key={field.id} entryId={entry.id} field={field} position={index + 1} toast={toast} onInteracted={onInteracted} />)}</div>
      </div>
    </article>
    {editorFields && <EntryEditor entry={entry} initialFields={editorFields} projectOptions={projectOptions} toast={toast} onClose={() => { setEditorFields(null); onChanged(); }} onSaved={() => { setEditorFields(null); onChanged(); }} />}
    {deletePending && <ConfirmDialog title={`Move “${entry.title}” to trash?`} body={<p>The entity will leave the vault and remain recoverable for the retention period configured in Settings. After that, all encrypted revisions will be permanently erased.</p>} confirmLabel="Move to trash" danger onClose={() => setDeletePending(false)} onConfirm={remove} />}
  </>;
}

export function VaultPage({ rankingEnabled, toast }: { rankingEnabled: boolean; toast: Toast }) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [project, setProject] = useState("all");
  const [editor, setEditor] = useState(false);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; before: boolean } | null>(null);

  function load(showLoader = false) {
    if (showLoader) setLoading(true);
    api.entries().then((result) => setEntries(result.entries)).catch((error) => toast(errorMessage(error), "error")).finally(() => setLoading(false));
  }
  useEffect(() => load(true), [rankingEnabled]);

  const projects = useMemo(() => [...new Set(entries.flatMap((entry) => entry.projects))].sort(), [entries]);
  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("en-US");
    return entries.filter((entry) => (project === "all" || entry.projects.includes(project)) && (!needle || [entry.title, ...entry.projects, ...entry.fields.flatMap((field) => [field.key, field.visibility === "plain" ? field.value : ""])].some((value) => value?.toLocaleLowerCase("en-US").includes(needle))));
  }, [entries, project, query]);

  async function move(id: string, direction: -1 | 1) {
    const index = entries.findIndex((entry) => entry.id === id);
    const next = moveItem(entries, index, direction);
    if (next === entries) return;
    setEntries(next);
    try { await api.reorderEntries(next.map((entry) => entry.id)); toast(`Entry order saved: position ${index + direction + 1}`); }
    catch (error) { toast(errorMessage(error), "error"); load(); }
  }

  async function dropEntry(targetId: string, before: boolean) {
    if (!dragging) return;
    const next = dropItem(entries, entries.findIndex((entry) => entry.id === dragging), entries.findIndex((entry) => entry.id === targetId), before);
    setDragging(null); setDropTarget(null);
    if (next === entries) return;
    setEntries(next);
    try { await api.reorderEntries(next.map((entry) => entry.id)); toast(`Entry order saved: position ${next.findIndex((entry) => entry.id === dragging) + 1}`); }
    catch (error) { toast(errorMessage(error), "error"); load(); }
  }

  return <div className="page vault-page">
    <div className="collection-command-bar" role="search" aria-label="Search and manage entries"><SearchField label="Search entries" value={query} onChange={setQuery} placeholder="Title, project, key, or plain value" /><div className="collection-information"><strong>{visible.length} / {entries.length}</strong><span>entries</span><small>Secret values are excluded from search</small></div><button className="button" onClick={() => setEditor(true)}><Icon name="plus" />New entry</button><select aria-label="Filter by project" value={project} onChange={(event) => setProject(event.target.value)}><option value="all">All projects</option>{projects.map((value) => <option key={value} value={value}>{value}</option>)}</select></div>
    {loading ? <div className="empty-state"><div className="loader" /><p>Opening vault…</p></div> : visible.length ? <div className="entry-grid">{visible.map((entry, index) => <EntryCard key={entry.id} index={index} entry={entry} projectOptions={projects} toast={toast} onChanged={load} onInteracted={load} move={(direction) => move(entry.id, direction)} dragging={dragging} dropTarget={dropTarget} onDragStart={() => setDragging(entry.id)} onDragEnd={() => { setDragging(null); setDropTarget(null); }} onDragPosition={(before) => setDropTarget({ id: entry.id, before })} onDrop={() => dropEntry(entry.id, dropTarget?.id === entry.id ? dropTarget.before : true)} />)}</div> : <div className="empty-state"><div className="empty-icon"><Icon name="vault" /></div><h2>{entries.length ? "No results" : "Vault is empty"}</h2><p>{entries.length ? "Change the query or project filter." : "Create your first entry and add between one and twenty values."}</p>{!entries.length && <button className="button" onClick={() => setEditor(true)}><Icon name="plus" />Create entry</button>}</div>}
    {editor && <EntryEditor entry={null} projectOptions={projects} toast={toast} onClose={() => setEditor(false)} onSaved={() => { setEditor(false); load(); }} />}
  </div>;
}
