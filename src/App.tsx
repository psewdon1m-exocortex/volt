import { useCallback, useEffect, useMemo, useState } from "react";

import { api } from "./api";
import { ConfirmDialog } from "./ConfirmDialog";
import { Icon } from "./icons";
import type { AuditEvent } from "./types";
import { VaultPage } from "./VaultPage";

type Page = "vault" | "audit" | "settings";
type Toast = (message: string, tone?: "ok" | "error") => void;

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Не удалось выполнить действие";
}

function formatDate(value: string | null) {
  if (!value) return "никогда";
  return new Intl.DateTimeFormat("ru-RU", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function Unlock({ onUnlocked }: { onUnlocked: (appearance: "dark" | "light") => void }) {
  const [accessKey, setAccessKey] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const session = await api.unlock(accessKey);
      setAccessKey("");
      onUnlocked(session.appearance);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }

  return <main className="unlock-page">
    <div className="unlock-noise" />
    <section className="unlock-card">
      <div className="brand-mark large"><span>V</span></div>
      <span className="eyebrow">EXOCORTEX / VOLT</span>
      <h1>Секреты остаются<br />под вашим контролем.</h1>
      <p>Локальное зашифрованное хранилище. Введите Access Key, чтобы открыть Volt.</p>
      <form onSubmit={submit}>
        <label className="control-label">Access Key<input type="password" required autoFocus autoComplete="current-password" value={accessKey} onChange={(event) => setAccessKey(event.target.value)} placeholder="••••••••••••••••" /></label>
        {error && <div className="form-error" role="alert">{error}</div>}
        <button className="button wide" disabled={busy}>{busy ? "Проверяем…" : "Открыть Volt"}<Icon name="chevron" /></button>
      </form>
      <footer><span className="status-dot" />Только локальное подключение</footer>
    </section>
  </main>;
}

function AuditPage({ toast }: { toast: Toast }) {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [query, setQuery] = useState("");
  useEffect(() => { api.audit().then((result) => setEvents(result.events)).catch((error) => toast(errorMessage(error), "error")); }, [toast]);
  const visible = useMemo(() => events.filter((event) => !query || `${event.actor} ${event.action} ${event.target ?? ""} ${event.status}`.toLowerCase().includes(query.toLowerCase())), [events, query]);
  return <div className="page"><section className="page-intro"><div><span className="eyebrow">БЕЗ ЗНАЧЕНИЙ СЕКРЕТОВ</span><h1>Аудит</h1><p>Кто, когда и к какой записи обращался. Сами значения никогда не журналируются.</p></div></section><div className="command-bar"><label className="search"><Icon name="search" /><input aria-label="Поиск событий" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Фильтр событий" /></label><span className="result-count">{visible.length}</span></div><div className="audit-table" role="table"><div className="audit-row audit-head" role="row"><span>Время</span><span>Событие</span><span>Субъект</span><span>Объект</span><span>Статус</span></div>{visible.map((event) => <div className="audit-row" role="row" key={event.event_id}><span>{formatDate(event.created_at)}</span><code>{event.action}</code><span>{event.actor}</span><code>{event.target ?? "—"}</code><span className={`status-badge ${event.status === "success" ? "active" : "revoked"}`}>{event.status}</span></div>)}</div></div>;
}

function SettingsPage({ appearance, setAppearance, onLocked, toast }: { appearance: "dark" | "light"; setAppearance: (value: "dark" | "light") => void; onLocked: () => void; toast: Toast }) {
  const [key, setKey] = useState("");
  const [confirm, setConfirm] = useState("");
  const [restoreFile, setRestoreFile] = useState<File | null>(null);
  const [inspection, setInspection] = useState<Awaited<ReturnType<typeof api.inspectBackup>> | null>(null);
  const [restorePhrase, setRestorePhrase] = useState("");
  const [backupBusy, setBackupBusy] = useState(false);
  const [neptune, setNeptune] = useState<Awaited<ReturnType<typeof api.neptuneStatus>> | null>(null);
  const [neptuneUpdate, setNeptuneUpdate] = useState<Awaited<ReturnType<typeof api.neptuneCheckUpdate>> | null>(null);
  const [neptuneInterval, setNeptuneInterval] = useState(24);
  const [neptuneBusy, setNeptuneBusy] = useState(false);
  const [neptuneError, setNeptuneError] = useState("");
  const loadNeptune = useCallback(async () => {
    try {
      const status = await api.neptuneStatus();
      setNeptune(status);
      setNeptuneInterval(status.project.interval_hours);
      setNeptuneError("");
    } catch (error) {
      setNeptune(null);
      setNeptuneError(errorMessage(error));
    }
  }, []);
  useEffect(() => { void loadNeptune(); }, [loadNeptune]);
  async function theme(value: "dark" | "light") {
    setAppearance(value);
    document.documentElement.dataset.theme = value;
    try { await api.appearance(value); } catch (error) { toast(errorMessage(error), "error"); }
  }
  async function changeKey(event: React.FormEvent) {
    event.preventDefault();
    if (key.length < 12) return toast("Access Key должен содержать не менее 12 символов", "error");
    if (key !== confirm) return toast("Введённые ключи не совпадают", "error");
    try { await api.changeAccessKey(key); toast("Access Key изменён. Все сессии закрыты."); onLocked(); }
    catch (error) { toast(errorMessage(error), "error"); }
  }
  async function downloadBackup() {
    setBackupBusy(true);
    try {
      const { blob, disposition } = await api.downloadBackup();
      const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? "volt-backup.zip";
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url; link.download = filename; link.click();
      URL.revokeObjectURL(url);
      toast("Свежая резервная копия создана");
    } catch (error) { toast(errorMessage(error), "error"); }
    finally { setBackupBusy(false); }
  }
  async function downloadVaultFile() {
    setBackupBusy(true);
    try {
      const { blob, disposition } = await api.downloadVaultFile();
      const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? "personal.volt";
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url; link.download = filename; link.click();
      URL.revokeObjectURL(url);
      toast("Переносимый personal.volt создан");
    } catch (error) { toast(errorMessage(error), "error"); }
    finally { setBackupBusy(false); }
  }
  async function chooseRestore(file: File | null) {
    if (!file) return;
    setBackupBusy(true);
    try { setRestoreFile(file); setInspection(await api.inspectBackup(file)); }
    catch (error) { setRestoreFile(null); toast(errorMessage(error), "error"); }
    finally { setBackupBusy(false); }
  }
  async function restore() {
    if (!restoreFile || !inspection || restorePhrase !== "RESTORE") return;
    setBackupBusy(true);
    try { await api.restoreBackup(restoreFile, inspection.digest); toast("Резервная копия восстановлена"); onLocked(); }
    catch (error) { toast(errorMessage(error), "error"); }
    finally { setBackupBusy(false); }
  }
  async function saveNeptune(enabled: boolean) {
    setNeptuneBusy(true);
    try { await api.neptuneSchedule(enabled, neptuneInterval); await loadNeptune(); toast(enabled ? "Автоматические копии включены" : "Автоматические копии отключены"); }
    catch (error) { toast(errorMessage(error), "error"); }
    finally { setNeptuneBusy(false); }
  }
  async function runNeptune() {
    setNeptuneBusy(true);
    try { await api.neptuneRun(); await loadNeptune(); toast("Neptune принял резервную копию в очередь"); }
    catch (error) { toast(errorMessage(error), "error"); }
    finally { setNeptuneBusy(false); }
  }
  async function checkNeptune() {
    setNeptuneBusy(true);
    try { setNeptuneUpdate(await api.neptuneCheckUpdate()); }
    catch (error) { toast(errorMessage(error), "error"); }
    finally { setNeptuneBusy(false); }
  }
  async function installNeptune() {
    if (!neptuneUpdate?.available_version) return;
    setNeptuneBusy(true);
    try { await api.neptuneInstallUpdate(neptuneUpdate.available_version); setNeptuneUpdate(null); await loadNeptune(); toast("Neptune обновлён"); }
    catch (error) { toast(errorMessage(error), "error"); }
    finally { setNeptuneBusy(false); }
  }
  return <><div className="page settings-page"><section className="page-intro"><div><span className="eyebrow">КОНФИГУРАЦИЯ</span><h1>Настройки</h1><p>Доступ, внешний вид и эксплуатационные параметры Volt.</p></div></section><div className="settings-grid"><section className="setting-card"><span className="eyebrow">ИНТЕРФЕЙС</span><h2>Оформление</h2><p>Тема хранится внутри Volt и применяется после входа.</p><div className="theme-picker"><button className={appearance === "dark" ? "selected" : ""} onClick={() => theme("dark")}><span className="theme-swatch dark" />Тёмная</button><button className={appearance === "light" ? "selected" : ""} onClick={() => theme("light")}><span className="theme-swatch light" />Светлая</button></div></section><section className="setting-card"><span className="eyebrow">ДОСТУП</span><h2>Изменить Access Key</h2><p>После изменения все активные операторские сессии будут закрыты, а master key внутри personal.volt будет переобёрнут.</p><form onSubmit={changeKey} className="form-grid"><label className="control-label">Новый Access Key<input type="password" minLength={12} value={key} onChange={(event) => setKey(event.target.value)} /></label><label className="control-label">Повторите Access Key<input type="password" minLength={12} value={confirm} onChange={(event) => setConfirm(event.target.value)} /></label><button className="button" disabled={!key || !confirm}>Сменить ключ</button></form></section><section className="setting-card wide-setting"><span className="eyebrow">PERSONAL.VOLT · BACKUP · NEPTUNE</span><h2>Перенос и резервные копии</h2><p><code>personal.volt</code> открывается офлайн с Access Key. ZIP остаётся логической серверной копией для restore и Neptune.</p><div className="neptune-facts"><span>{neptune ? `Neptune ${neptune.version}` : "Neptune недоступен"}</span><span>Последняя копия: {formatDate(neptune?.last_success_at ?? null)}</span>{neptuneError && <span className="danger-text">{neptuneError}</span>}</div><div className="backup-actions"><label className="control-label compact">Интервал, часов<input type="number" min={1} max={8760} value={neptuneInterval} onChange={(event) => setNeptuneInterval(Number(event.target.value))} /></label><button className="button secondary" disabled={neptuneBusy || !neptune} onClick={() => saveNeptune(!(neptune?.project.enabled ?? false))}>{neptune?.project.enabled ? "Отключить авто" : "Включить авто"}</button><button className="button secondary" disabled={neptuneBusy || !neptune} onClick={runNeptune}>Отправить сейчас</button><button className="button ghost" disabled={neptuneBusy || !neptune} onClick={checkNeptune}>Проверить версию</button>{neptuneUpdate?.update_available && neptuneUpdate.available_version && <button className="button" disabled={neptuneBusy} onClick={installNeptune}>Обновить до {neptuneUpdate.available_version}</button>}</div><div className="backup-actions manual-backup"><button className="button" disabled={backupBusy} onClick={downloadVaultFile}>{backupBusy ? "Подождите…" : "Скачать personal.volt"}</button><button className="button secondary" disabled={backupBusy} onClick={downloadBackup}>Создать ZIP backup</button><label className="button secondary file-button">Проверить и восстановить ZIP<input type="file" accept=".zip,application/zip" onChange={(event) => chooseRestore(event.target.files?.[0] ?? null)} /></label></div></section><section className="setting-card wide-setting"><span className="eyebrow">КРИПТОГРАФИЯ</span><h2>Локальная модель защиты</h2><div className="security-facts"><div><b>AES-256-GCM</b><span>отдельный ключ данных для каждой записи</span></div><div><b>Argon2id</b><span>Access Key открывает переносимый master key</span></div><div><b>Dual wrapping</b><span>Access Key для offline и отдельный device key для сервера</span></div></div></section></div></div>{inspection && restoreFile && <dialog open className="modal" aria-labelledby="restore-title"><div className="modal-scrim" onClick={() => setInspection(null)} /><div className="modal-card narrow"><header className="modal-header"><div><span className="eyebrow">REPLACE RESTORE</span><h2 id="restore-title">Восстановить Volt</h2></div><button className="icon-button" onClick={() => setInspection(null)}><Icon name="close" /></button></header><div className="restore-body"><p>Архив проверен. Текущее состояние будет полностью заменено, а все операторские сессии закрыты.</p><dl><div><dt>Файл</dt><dd>{inspection.filename}</dd></div><div><dt>Создан</dt><dd>{formatDate(inspection.manifest.created_at)}</dd></div><div><dt>Версия</dt><dd>{inspection.manifest.source_version}</dd></div><div><dt>Записей</dt><dd>{inspection.manifest.files["data/entries.jsonl"]?.records ?? 0}</dd></div></dl><div className="token-warning">ZIP не содержит ключей. Для независимой офлайн-копии используйте personal.volt.</div><label className="control-label">Введите RESTORE для подтверждения<input autoFocus value={restorePhrase} onChange={(event) => setRestorePhrase(event.target.value)} /></label></div><footer className="modal-footer"><button className="button ghost" onClick={() => setInspection(null)}>Отмена</button><button className="button danger-button" disabled={backupBusy || restorePhrase !== "RESTORE"} onClick={restore}>{backupBusy ? "Восстанавливаем…" : "Заменить состояние"}</button></footer></div></dialog>}</>;
}

export function App() {
  const [ready, setReady] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [appearance, setAppearance] = useState<"dark" | "light">("dark");
  const [page, setPage] = useState<Page>("vault");
  const [toastState, setToastState] = useState<{ message: string; tone: "ok" | "error" } | null>(null);

  useEffect(() => { api.session().then((session) => { setAuthenticated(session.authenticated); setAppearance(session.appearance); document.documentElement.dataset.theme = session.appearance; }).finally(() => setReady(true)); }, []);
  const toast = useCallback<Toast>((message, tone = "ok") => { setToastState({ message, tone }); window.setTimeout(() => setToastState(null), 3200); }, []);
  async function lock() { try { await api.lock(); } finally { setAuthenticated(false); } }

  if (!ready) return <div className="boot-screen"><div className="brand-mark large"><span>V</span></div></div>;
  if (!authenticated) return <Unlock onUnlocked={(theme) => { setAppearance(theme); document.documentElement.dataset.theme = theme; setAuthenticated(true); }} />;

  const pages: Record<Page, React.ReactNode> = {
    vault: <VaultPage toast={toast} />,
    audit: <AuditPage toast={toast} />,
    settings: <SettingsPage appearance={appearance} setAppearance={setAppearance} onLocked={() => setAuthenticated(false)} toast={toast} />,
  };
  const labels: Array<[Page, string, string]> = [["vault", "Записи", "vault"], ["audit", "Аудит", "audit"], ["settings", "Настройки", "settings"]];
  return <div className="app-shell"><aside className="sidebar"><div className="brand"><div className="brand-mark"><span>V</span></div><div><b>VOLT</b><small>value authority</small></div></div><nav aria-label="Основная навигация">{labels.map(([value, label, icon]) => <button key={value} className={page === value ? "active" : ""} onClick={() => setPage(value)}><Icon name={icon} /><span>{label}</span></button>)}</nav><div className="sidebar-footer"><div className="local-state"><span className="status-dot" /><div><b>LOCAL</b><small>зашифровано</small></div></div><button className="icon-button" title="Заблокировать" onClick={lock}><Icon name="lock" /></button></div></aside><main className="content"><header className="topbar"><span>EXOCORTEX</span><div><span className="topbar-status"><i />Хранилище открыто</span><button className="avatar" title="Оператор">OP</button></div></header>{pages[page]}</main>{toastState && <div className={`toast ${toastState.tone}`} role="status">{toastState.tone === "ok" ? "✓" : "!"}<span>{toastState.message}</span></div>}</div>;
}
