import { useEffect, useMemo, useState } from "react";

import { ApiError, api } from "./api";
import { ConfirmDialog } from "./ConfirmDialog";
import { Icon } from "./icons";
import type { Entry, GeneratedValue, Revision, VoltField } from "./types";

type Toast = (message: string, tone?: "ok" | "error") => void;

function dateTime(value: string) {
  return new Intl.DateTimeFormat("ru-RU", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Не удалось выполнить действие";
}

function FieldValue({ entryId, field, revision, toast }: { entryId: string; field: VoltField; revision?: number; toast: Toast }) {
  const [revealed, setRevealed] = useState<string | null>(null);
  const secret = field.visibility === "secret";

  useEffect(() => {
    setRevealed(null);
  }, [entryId, field.id, revision]);
  useEffect(() => {
    const hide = () => { if (document.hidden) setRevealed(null); };
    document.addEventListener("visibilitychange", hide);
    return () => document.removeEventListener("visibilitychange", hide);
  }, []);

  async function getValue() {
    if (!secret) return field.value ?? "";
    if (revealed != null) return revealed;
    const result = await api.reveal(entryId, field.id, revision);
    setRevealed(result.value);
    window.setTimeout(() => setRevealed(null), 30_000);
    return result.value;
  }

  async function reveal(event: React.MouseEvent) {
    event.stopPropagation();
    try {
      if (revealed != null) setRevealed(null);
      else await getValue();
    } catch (error) { toast(errorMessage(error), "error"); }
  }

  async function copy(event: React.MouseEvent) {
    event.stopPropagation();
    try {
      const value = await getValue();
      await navigator.clipboard.writeText(value);
      toast(`${field.key}: скопировано`);
      window.setTimeout(() => navigator.clipboard.readText()
        .then((current) => current === value ? navigator.clipboard.writeText("") : undefined)
        .catch(() => undefined), 30_000);
    } catch (error) { toast(errorMessage(error), "error"); }
  }

  async function copyReference(event: React.MouseEvent) {
    event.stopPropagation();
    try {
      await navigator.clipboard.writeText(`volt://${entryId}/${field.id}`);
      toast(`${field.key}: ссылка скопирована`);
    } catch (error) { toast(errorMessage(error), "error"); }
  }

  return (
    <div className="field-row">
      <div className="field-copy">
        <span className="field-label">{field.key}</span>
        <span className={`field-value${secret ? " mono" : ""}`} title={secret ? undefined : field.value ?? ""}>
          {secret && revealed == null ? "••••••••••••" : (revealed ?? field.value ?? "—")}
        </span>
      </div>
      <div className="field-actions">
        <button className="icon-button" type="button" title="Скопировать ссылку для Kernel Register" aria-label="Скопировать volt-ссылку" onClick={copyReference}><Icon name="link" /></button>
        {secret && <button className="icon-button" type="button" aria-label={revealed == null ? "Показать значение" : "Скрыть значение"} onClick={reveal}><Icon name="eye" /></button>}
        <button className="icon-button" type="button" aria-label="Скопировать значение" onClick={copy}><Icon name="copy" /></button>
      </div>
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
      toast(`Ревизия ${selected.revision} восстановлена`);
      onRestored();
      setRestorePending(false);
    } catch (error) { toast(errorMessage(error), "error"); }
  }

  return (
    <div className="revision-panel" onClick={(event) => event.stopPropagation()}>
      <div className="revision-heading">
        <div><span className="eyebrow">ИСТОРИЯ</span><strong>{revisions.length} ревизий</strong></div>
        <span className="muted">Старые значения раскрываются только вручную</span>
      </div>
      {busy ? <div className="inline-loader">Читаем историю…</div> : (
        <div className="revision-layout">
          <div className="revision-list">
            {revisions.map((revision) => (
              <button key={revision.id} className={`revision-item${selected?.revision === revision.revision ? " selected" : ""}`} onClick={() => inspect(revision)}>
                <span><b>v{revision.revision}</b>{revision.current && <em>текущая</em>}</span>
                <small>{dateTime(revision.created_at)}</small>
                <small>{revision.reason ?? "без комментария"}</small>
              </button>
            ))}
          </div>
          <div className="revision-preview">
            {!selected ? <div className="preview-placeholder">Выберите ревизию для просмотра</div> : <>
              <div className="revision-preview-head">
                <div><span className="eyebrow">СНИМОК</span><h4>v{selected.revision} · {selected.title}</h4></div>
                {selected.revision !== entry.revision && <button className="button secondary small" onClick={() => setRestorePending(true)}>Восстановить</button>}
              </div>
              {selected.fields.map((field) => <FieldValue key={field.id} entryId={entry.id} field={field} revision={selected.revision} toast={toast} />)}
            </>}
          </div>
        </div>
      )}
      {restorePending && selected && <ConfirmDialog title={`Восстановить ревизию ${selected.revision}?`} body={<p>Её значения станут новой ревизией. Текущая версия останется в истории.</p>} confirmLabel="Восстановить" onClose={() => setRestorePending(false)} onConfirm={restore} />}
    </div>
  );
}

interface EditorValue extends VoltField { value: string }

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
      toast("Для пары ключей нужны два свободных значения", "error");
      return;
    }
    const options: Record<string, unknown> = { type };
    if (type === "password") Object.assign(options, sets, { length });
    if (type === "hmac") Object.assign(options, { bytes: hmacBytes, encoding: "base64url" });
    if (type === "rsa") options.modulus_length = rsaBits;
    if (type === "certificate") Object.assign(options, { common_name: commonName, sans: sans.split(",").map((item) => item.trim()).filter(Boolean), valid_days: 365 });
    setBusy(true);
    try { setPreview(await api.generate(options)); }
    catch (error) { toast(errorMessage(error), "error"); }
    finally { setBusy(false); }
  }

  return (
    <dialog open className="modal generator-modal" aria-labelledby="generator-title">
      <div className="modal-scrim" onClick={onClose} />
      <div className="modal-card">
        <header className="modal-header"><div><span className="eyebrow">ГЕНЕРАТОР</span><h2 id="generator-title">Новое значение</h2></div><button className="icon-button" onClick={onClose}><Icon name="close" /></button></header>
        <div className="generator-tabs">
          {[['password', 'Пароль'], ['identifier', 'ID'], ['certificate', 'Сертификат'], ['hmac', 'HMAC'], ['rsa', 'RSA']].map(([value, label]) => (
            <button key={value} className={type === value ? "active" : ""} onClick={() => { setType(value); setPreview(null); }}>{label}</button>
          ))}
        </div>
        <div className="generator-body">
          {type === "password" && <>
            <label className="control-label">Длина <output>{length}</output><input type="range" min="4" max="128" value={length} onChange={(event) => setLength(Number(event.target.value))} /></label>
            <div className="option-grid">
              {[['lowercase', 'a–z'], ['uppercase', 'A–Z'], ['numbers', '0–9'], ['special', 'спецсимволы']].map(([key, label]) => <label className="check-option" key={key}><input type="checkbox" checked={sets[key as keyof typeof sets]} onChange={(event) => setSets({ ...sets, [key]: event.target.checked })} /><span>{label}</span></label>)}
            </div>
            <p className="hint">Символы <code>"</code> и <code>@</code> всегда исключены.</p>
          </>}
          {type === "hmac" && <label className="control-label">Размер ключа<select value={hmacBytes} onChange={(event) => setHmacBytes(Number(event.target.value))}><option value="32">256 бит</option><option value="48">384 бит</option><option value="64">512 бит</option></select></label>}
          {type === "rsa" && <label className="control-label">Размер RSA<select value={rsaBits} onChange={(event) => setRsaBits(Number(event.target.value))}><option value="2048">2048 бит</option><option value="3072">3072 бит</option><option value="4096">4096 бит</option></select><small>Будут добавлены приватный и публичный ключи.</small></label>}
          {type === "certificate" && <div className="form-grid"><label className="control-label">Common Name<input value={commonName} onChange={(event) => setCommonName(event.target.value)} /></label><label className="control-label">SAN, через запятую<input value={sans} onChange={(event) => setSans(event.target.value)} /></label><small>Создаётся самоподписанный ECDSA P-256 сертификат и приватный ключ.</small></div>}
          {type === "identifier" && <div className="generator-note"><strong>16 знаков</strong><span>A–Z и 0–9 · ≈82,7 бит энтропии</span></div>}
          <button className="button generator-action" onClick={generate} disabled={busy}>{busy ? "Генерируем…" : preview ? "Сгенерировать заново" : "Сгенерировать"}</button>
          {preview && <div className="generated-preview"><div><span className="eyebrow">РЕЗУЛЬТАТ</span>{preview.entropy_bits != null && <b>{preview.entropy_bits} бит энтропии</b>}</div>{preview.values.map((value) => <code key={value.key}>{value.value}</code>)}</div>}
        </div>
        <footer className="modal-footer"><button className="button ghost" onClick={onClose}>Отмена</button><button className="button" disabled={!preview} onClick={() => preview && onApply(preview)}>Использовать</button></footer>
      </div>
    </dialog>
  );
}

function EntryEditor({ entry, initialFields, onClose, onSaved, toast }: {
  entry: Entry | null;
  initialFields?: EditorValue[];
  onClose: () => void;
  onSaved: () => void;
  toast: Toast;
}) {
  const [title, setTitle] = useState(entry?.title ?? "");
  const [project, setProject] = useState(entry?.project ?? "");
  const [reason, setReason] = useState("");
  const [fields, setFields] = useState<EditorValue[]>(initialFields ?? [{ id: crypto.randomUUID(), key: "", value: "", visibility: "secret", generator: null }]);
  const [generatorIndex, setGeneratorIndex] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  function updateField(index: number, update: Partial<EditorValue>) {
    setFields(fields.map((field, fieldIndex) => fieldIndex === index ? { ...field, ...update } : field));
  }

  function applyGenerated(result: GeneratedValue) {
    if (generatorIndex == null) return;
    const values: EditorValue[] = result.values.map((value) => ({
      id: crypto.randomUUID(), key: value.key, value: value.value, visibility: value.visibility, generator: { type: result.kind, ...result.parameters },
    } satisfies EditorValue));
    if (fields.length - 1 + values.length > 5) {
      toast("Для пары ключей освободите ещё одно место в записи", "error");
      return;
    }
    const current = fields[generatorIndex];
    values[0].id = current.id;
    values[0].key = current.key || values[0].key;
    values[0].visibility = current.visibility;
    setFields([...fields.slice(0, generatorIndex), ...values, ...fields.slice(generatorIndex + 1)]);
    setGeneratorIndex(null);
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    const payload = { title, project: project || null, fields, reason: reason || undefined, expected_revision: entry?.revision };
    try {
      if (entry) await api.updateEntry(entry.id, payload);
      else await api.createEntry(payload);
      toast(entry ? "Запись обновлена — создана новая ревизия" : "Запись создана");
      onSaved();
    } catch (error) {
      toast(error instanceof ApiError && error.code === "ENTRY_REVISION_CONFLICT" ? "Запись уже изменилась. Закройте редактор и откройте её снова." : errorMessage(error), "error");
    } finally { setBusy(false); }
  }

  return <>
    <dialog open className="modal" aria-labelledby="entry-editor-title">
      <div className="modal-scrim" onClick={onClose} />
      <form className="modal-card editor-card" onSubmit={save}>
        <header className="modal-header"><div><span className="eyebrow">{entry ? `РЕВИЗИЯ ${entry.revision + 1}` : "НОВАЯ ЗАПИСЬ"}</span><h2 id="entry-editor-title">{entry ? "Изменить запись" : "Добавить в Volt"}</h2></div><button className="icon-button" type="button" onClick={onClose}><Icon name="close" /></button></header>
        <div className="editor-body">
          <div className="form-grid two"><label className="control-label">Название<input required maxLength={120} autoFocus value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Google account" /></label><label className="control-label">Проект <span>необязательно</span><input maxLength={80} value={project} onChange={(event) => setProject(event.target.value)} placeholder="personal" /></label></div>
          <div className="values-header"><div><span className="eyebrow">ЗНАЧЕНИЯ</span><strong>{fields.length} / 5</strong></div>{fields.length < 5 && <button className="button secondary small" type="button" onClick={() => setFields([...fields, { id: crypto.randomUUID(), key: "", value: "", visibility: "secret", generator: null }])}><Icon name="plus" />Добавить</button>}</div>
          <div className="editor-values">
            {fields.map((field, index) => <div className="editor-value" key={field.id}>
              <span className="value-number">{String(index + 1).padStart(2, "0")}</span>
              <div className="value-inputs"><input aria-label={`Название значения ${index + 1}`} required maxLength={64} value={field.key} onChange={(event) => updateField(index, { key: event.target.value })} placeholder="password" /><textarea aria-label={`Значение ${index + 1}`} required rows={field.value.includes("\n") ? 5 : 1} value={field.value} onChange={(event) => updateField(index, { value: event.target.value })} placeholder="Значение" /></div>
              <div className="value-tools"><div className="segmented"><button type="button" className={field.visibility === "secret" ? "active" : ""} onClick={() => updateField(index, { visibility: "secret" })}>Секрет</button><button type="button" className={field.visibility === "plain" ? "active" : ""} onClick={() => updateField(index, { visibility: "plain" })}>Открыто</button></div><button className="icon-button accent" type="button" title="Сгенерировать" onClick={() => setGeneratorIndex(index)}><Icon name="spark" /></button>{fields.length > 1 && <button className="icon-button danger" type="button" title="Удалить значение" onClick={() => setFields(fields.filter((_, i) => i !== index))}><Icon name="trash" /></button>}</div>
            </div>)}
          </div>
          {entry && <label className="control-label">Комментарий к ревизии <span>необязательно</span><input maxLength={240} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Пароль обновлён" /></label>}
        </div>
        <footer className="modal-footer"><button className="button ghost" type="button" onClick={onClose}>Отмена</button><button className="button" disabled={busy}>{busy ? "Сохраняем…" : "Сохранить"}</button></footer>
      </form>
    </dialog>
    {generatorIndex != null && <GeneratorDialog availableSlots={6 - fields.length} toast={toast} onClose={() => setGeneratorIndex(null)} onApply={applyGenerated} />}
  </>;
}

function EntryCard({ entry, onChanged, toast, move }: { entry: Entry; onChanged: () => void; toast: Toast; move: (direction: -1 | 1) => void }) {
  const [expanded, setExpanded] = useState(false);
  const [editorFields, setEditorFields] = useState<EditorValue[] | null>(null);
  const [loadingEdit, setLoadingEdit] = useState(false);
  const [deletePending, setDeletePending] = useState(false);

  async function edit(event: React.MouseEvent) {
    event.stopPropagation();
    setLoadingEdit(true);
    try {
      const resolved = await Promise.all(entry.fields.map(async (field) => ({
        ...field,
        value: field.visibility === "secret" ? (await api.reveal(entry.id, field.id)).value : field.value ?? "",
      })));
      setEditorFields(resolved);
    } catch (error) { toast(errorMessage(error), "error"); }
    finally { setLoadingEdit(false); }
  }

  async function remove() {
    try { await api.deleteEntry(entry.id); toast("Запись перемещена в удалённые"); setDeletePending(false); onChanged(); }
    catch (error) { toast(errorMessage(error), "error"); }
  }

  return <>
    <article className={`entry-card${expanded ? " expanded" : ""}`}>
      <div className="card-main">
        <header className="entry-header"><div className="entry-title"><div className="entry-mark"><Icon name="lock" /></div><div><h3>{entry.title}</h3><div className="entry-meta">{entry.project && <span className="project-tag">{entry.project}</span>}<span>v{entry.revision}</span><span>{dateTime(entry.updated_at)}</span></div></div></div><div className="entry-actions"><button className="icon-button" title="Выше" onClick={() => move(-1)}><Icon name="arrowUp" /></button><button className="icon-button" title="Ниже" onClick={() => move(1)}><Icon name="arrowDown" /></button><button className="icon-button" title="Изменить" disabled={loadingEdit} onClick={edit}><Icon name="edit" /></button><button className="icon-button danger" title="Удалить" onClick={() => setDeletePending(true)}><Icon name="trash" /></button><button className="icon-button expand-button" aria-expanded={expanded} title="История ревизий" onClick={() => setExpanded(!expanded)}><Icon name="chevron" className="expand-icon" /></button></div></header>
        <div className="field-list">{entry.fields.map((field) => <FieldValue key={field.id} entryId={entry.id} field={field} toast={toast} />)}</div>
      </div>
      {expanded && <RevisionPanel entry={entry} toast={toast} onRestored={onChanged} />}
    </article>
    {editorFields && <EntryEditor entry={entry} initialFields={editorFields} toast={toast} onClose={() => setEditorFields(null)} onSaved={() => { setEditorFields(null); onChanged(); }} />}
    {deletePending && <ConfirmDialog title={`Удалить «${entry.title}»?`} body={<p>Запись исчезнет из списка. Её зашифрованные ревизии пока сохранятся в базе.</p>} confirmLabel="Удалить" danger onClose={() => setDeletePending(false)} onConfirm={remove} />}
  </>;
}

export function VaultPage({ toast }: { toast: Toast }) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [project, setProject] = useState("all");
  const [editor, setEditor] = useState(false);

  function load() {
    setLoading(true);
    api.entries().then((result) => setEntries(result.entries)).catch((error) => toast(errorMessage(error), "error")).finally(() => setLoading(false));
  }
  useEffect(load, []);

  const projects = useMemo(() => [...new Set(entries.map((entry) => entry.project).filter(Boolean) as string[])].sort(), [entries]);
  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("ru-RU");
    return entries.filter((entry) => (project === "all" || entry.project === project) && (!needle || [entry.title, entry.project, ...entry.fields.flatMap((field) => [field.key, field.visibility === "plain" ? field.value : ""])].some((value) => value?.toLocaleLowerCase("ru-RU").includes(needle))));
  }, [entries, project, query]);

  async function move(id: string, direction: -1 | 1) {
    const index = entries.findIndex((entry) => entry.id === id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= entries.length) return;
    const next = [...entries];
    [next[index], next[target]] = [next[target], next[index]];
    setEntries(next);
    try { await api.reorderEntries(next.map((entry) => entry.id)); }
    catch (error) { toast(errorMessage(error), "error"); load(); }
  }

  return <div className="page vault-page">
    <section className="page-intro"><div><span className="eyebrow">ЛОКАЛЬНОЕ ХРАНИЛИЩЕ</span><h1>Записи</h1><p>Открытые и секретные значения для Kernel Register. Изменения сохраняются как новые ревизии.</p></div><button className="button" onClick={() => setEditor(true)}><Icon name="plus" />Новая запись</button></section>
    <div className="command-bar"><label className="search"><Icon name="search" /><input aria-label="Поиск записей" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Поиск по названию, проекту или открытому значению" /></label><select aria-label="Фильтр по проекту" value={project} onChange={(event) => setProject(event.target.value)}><option value="all">Все проекты</option>{projects.map((value) => <option key={value} value={value}>{value}</option>)}</select><span className="result-count">{visible.length} / {entries.length}</span></div>
    {loading ? <div className="empty-state"><div className="loader" /><p>Открываем хранилище…</p></div> : visible.length ? <div className="entry-grid">{visible.map((entry) => <EntryCard key={entry.id} entry={entry} toast={toast} onChanged={load} move={(direction) => move(entry.id, direction)} />)}</div> : <div className="empty-state"><div className="empty-icon"><Icon name="vault" /></div><h2>{entries.length ? "Ничего не найдено" : "Хранилище пусто"}</h2><p>{entries.length ? "Измените запрос или фильтр проекта." : "Создайте первую запись и добавьте от одного до пяти значений."}</p>{!entries.length && <button className="button" onClick={() => setEditor(true)}><Icon name="plus" />Создать запись</button>}</div>}
    {editor && <EntryEditor entry={null} toast={toast} onClose={() => setEditor(false)} onSaved={() => { setEditor(false); load(); }} />}
  </div>;
}
