import { pendingAgentJob, waitForAgentJob } from "./agent-job";
import { SelfUpdateButton } from "./SelfUpdateButton.js";
import { useCallback, useEffect, useState } from "react";

import { ApiError, api, type InterfaceSettings, type KernelStatus, type NeptuneAvailability, type NeptuneInitializationJob, type TrashSettings, type UpdateCheck, type UpdateJob } from "./api";
import { ConfirmDialog } from "./ConfirmDialog";
import { Icon } from "./icons";
import type { AuditEvent } from "./types";
import { DragDots, Modal } from "./Ui";
import { applyAccent, downloadBlob, errorMessage, formatDate, moveItem, type Toast } from "./ui-helpers";

type SectionId = "appearance" | "security" | "backup" | "updates" | "logs" | "cryptography";
type DropTarget = { id: string; before: boolean } | null;

function StatusRow({ label, text, ok }: { label: string; text: string; ok?: boolean }) {
  return <div className="status-row"><span>{label}</span><strong className={ok === false ? "danger-text" : ok ? "ok-text" : ""}>{text}{ok === undefined ? null : <span className={`status-square${ok ? "" : " offline"}`} />}</strong></div>;
}

const wait = (milliseconds: number) => new Promise((resolve) => window.setTimeout(resolve, milliseconds));

async function waitForNeptuneInitialization(initial: NeptuneInitializationJob) {
  return waitForAgentJob(initial, api.neptuneInitialization);
}

async function waitForUpdate(initial: UpdateJob, onProgress: (job: UpdateJob) => void): Promise<UpdateJob> {
  let job = initial;
  localStorage.setItem("exocortex.volt.update", job.id);
  const terminal = ["COMPLETED", "FAILED", "ROLLED_BACK", "ROLLBACK_FAILED"];
  const deadline = Date.now() + 5 * 60_000;
  while (!terminal.includes(job.state) && Date.now() < deadline) {
    await wait(1_500);
    try {
      job = await api.updateJob(job.id);
      onProgress(job);
    } catch (error) {
      if (error instanceof ApiError && error.status < 500) throw error;
      // The Volt container is replaced during an update, so transient disconnects are expected.
    }
  }
  if (!terminal.includes(job.state)) throw new Error("Volt update is still running. Refresh Settings to continue monitoring it.");
  if (terminal.includes(job.state)) localStorage.removeItem("exocortex.volt.update");
  return job;
}

function SettingCard({ id, index, title, description, children, dragging, dropTarget, onMove, onDragStart, onDragEnd, onDragPosition, onDrop }: {
  id: SectionId;
  index: number;
  title: string;
  description?: string;
  children: React.ReactNode;
  dragging: string | null;
  dropTarget: DropTarget;
  onMove: (direction: -1 | 1) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDragPosition: (before: boolean) => void;
  onDrop: () => void;
}) {
  const [dragReady, setDragReady] = useState(false);
  const dropClass = dropTarget?.id === id ? (dropTarget.before ? " drop-before" : " drop-after") : "";
  return <section className={`setting-card setting-${id} universal-card${dragging === id ? " dragging" : ""}${dropClass}`} draggable={dragReady} onDragStart={(event) => { event.dataTransfer.effectAllowed = "move"; onDragStart(); }} onDragEnd={() => { setDragReady(false); onDragEnd(); }} onDragOver={(event) => { event.preventDefault(); const rect = event.currentTarget.getBoundingClientRect(); onDragPosition(event.clientY < rect.top + rect.height / 2); }} onDrop={(event) => { event.preventDefault(); setDragReady(false); onDrop(); }}>
    <header className="setting-card-head"><span className="card-ordinal">{String(index + 1).padStart(2, "0")}</span><h2>{title}</h2><DragDots label={`Move ${title} section`} onPointerDown={() => setDragReady(true)} onPointerUp={() => setDragReady(false)} onKeyDown={(event) => { if (!event.altKey || !["ArrowUp", "ArrowDown"].includes(event.key)) return; event.preventDefault(); onMove(event.key === "ArrowUp" ? -1 : 1); }} /></header>
    {description && <p className="visually-hidden">{description}</p>}
    <div className="setting-content">{children}</div>
  </section>;
}

function SettingGroup({ title, description, className = "", children }: { title: string; description?: string; className?: string; children: React.ReactNode }) {
  return <div className={`setting-group${className ? ` ${className}` : ""}`}><h3>{title}</h3>{description && <p>{description}</p>}<div className="setting-group-content">{children}</div></div>;
}

export function SettingsPage({ settings, onSettings, onLocked, toast }: { settings: InterfaceSettings; onSettings: (settings: InterfaceSettings) => void; onLocked: () => void; toast: Toast }) {
  const [accent, setAccent] = useState(settings.accent);
  const [accessOpen, setAccessOpen] = useState(false);
  const [currentKey, setCurrentKey] = useState("");
  const [newKey, setNewKey] = useState("");
  const [confirmKey, setConfirmKey] = useState("");
  const [kernelOpen, setKernelOpen] = useState(false);
  const [kernel, setKernel] = useState<KernelStatus | null>(null);
  const [kernelUrl, setKernelUrl] = useState("");
  const [kernelToken, setKernelToken] = useState("");
  const [kernelTokenConfirm, setKernelTokenConfirm] = useState("");
  const [trashSettings, setTrashSettings] = useState<TrashSettings | null>(null);
  const [trashRetentionInput, setTrashRetentionInput] = useState("30");
  const [trashConfirmOpen, setTrashConfirmOpen] = useState(false);
  const [restoreFile, setRestoreFile] = useState<File | null>(null);
  const [inspection, setInspection] = useState<Awaited<ReturnType<typeof api.inspectBackup>> | null>(null);
  const [restorePhrase, setRestorePhrase] = useState("");
  const [restoreKey, setRestoreKey] = useState("");
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [version, setVersion] = useState<Awaited<ReturnType<typeof api.updateStatus>> | null>(null);
  const [neptune, setNeptune] = useState<NeptuneAvailability | null>(null);
  const [neptuneOpen, setNeptuneOpen] = useState(false);
  const [neptuneCode, setNeptuneCode] = useState("");
  const [updateOpen, setUpdateOpen] = useState(false);
  const [updateCheck, setUpdateCheck] = useState<UpdateCheck | null>(null);
  const [updaterUpdate, setUpdaterUpdate] = useState<UpdateCheck | null>(null);
  const [updateJob, setUpdateJob] = useState<UpdateJob | null>(null);
  const [updateConfirmOpen, setUpdateConfirmOpen] = useState(false);
  const [rollbackConfirmOpen, setRollbackConfirmOpen] = useState(false);
  const [logs, setLogs] = useState<AuditEvent[]>([]);
  const [busy, setBusy] = useState("");
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget>(null);

  const loadKernel = useCallback(() => api.kernelAccess().then((value) => { setKernel(value); setKernelUrl(value.url); }).catch((error) => toast(errorMessage(error), "error")), [toast]);
  const loadLogs = useCallback(() => { if (!document.hidden) api.audit().then((value) => setLogs(value.events.slice(0, 80))).catch(() => undefined); }, []);
  useEffect(() => {
    void loadKernel();
    api.updateStatus().then(setVersion).catch(() => setVersion(null));
    api.neptuneAvailability().then(setNeptune).catch(() => setNeptune(null));
    api.trashSettings()
      .then((value) => { setTrashSettings(value); setTrashRetentionInput(String(value.retention_days)); })
      .catch((error) => toast(errorMessage(error), "error"));
  }, [loadKernel, toast]);
  useEffect(() => { loadLogs(); const timer = window.setInterval(loadLogs, 5000); document.addEventListener("visibilitychange", loadLogs); return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", loadLogs); }; }, [loadLogs]);
  useEffect(() => setAccent(settings.accent), [settings.accent]);
  useEffect(() => () => applyAccent(settings.accent), [settings.accent]);

  useEffect(() => {
    const job = pendingAgentJob();
    const updateId = localStorage.getItem("exocortex.volt.update");
    if (!job && !updateId) return;
    let stopped = false;
    setBusy(job ? "neptune-initialize" : "update-install");
    void (async () => {
      if (job) {
        await waitForAgentJob(job, api.neptuneInitialization);
        const availability = await api.neptuneAvailability();
        if (!availability.linked || availability.project?.mirror?.root !== "volt" || availability.project.mirror.mode !== "single-file") throw new Error("Neptune did not report both Volt backup pipelines");
        if (!stopped) { setNeptune(availability); toast("Both Neptune pipelines are linked."); }
      } else if (updateId && /^[A-Za-z0-9-]{1,128}$/.test(updateId)) {
        const completed = await waitForUpdate(await api.updateJob(updateId), value => { if (!stopped) setUpdateJob(value); });
        if (!stopped) { setUpdateJob(completed); setVersion(await api.updateStatus()); toast(completed.message || completed.state, ["COMPLETED", "ROLLED_BACK"].includes(completed.state) ? undefined : "error"); }
      }
    })().catch(error => { if (!stopped) toast(errorMessage(error), "error"); }).finally(() => { if (!stopped) setBusy(""); });
    return () => { stopped = true; };
  }, [toast]);

  function closeAccess() { setAccessOpen(false); setCurrentKey(""); setNewKey(""); setConfirmKey(""); }
  function closeKernel() { setKernelOpen(false); setKernelToken(""); setKernelTokenConfirm(""); }
  function closeRestore() { setRestoreOpen(false); setInspection(null); setRestoreFile(null); setRestorePhrase(""); setRestoreKey(""); }
  function closeNeptune() { setNeptuneOpen(false); setNeptuneCode(""); }

  async function initializeNeptune(event: React.FormEvent) {
    event.preventDefault();
    if (!/^[A-Za-z0-9_-]{32}$/.test(neptuneCode)) return toast("Enter the 32-character setup code from Saturn", "error");
    setBusy("neptune-initialize");
    try {
      const accepted = await api.initializeNeptune(neptuneCode);
      setNeptuneCode("");
      const job = await waitForNeptuneInitialization(accepted);
      if (job.state === "FAILED") throw new Error(job.message || "Neptune initialization failed");
      const availability = await api.neptuneAvailability();
      const mirror = availability.project?.mirror;
      if (!availability.linked || mirror?.root !== "volt" || mirror.mode !== "single-file") {
        throw new Error("Neptune did not report both Volt backup pipelines after initialization");
      }
      setNeptune(availability);
      closeNeptune();
      toast("Recovery ZIP and personal.volt mirror are linked to Saturn.");
    } catch (error) { toast(errorMessage(error), "error"); }
    finally { setBusy(""); }
  }

  async function saveInterface(update: Partial<InterfaceSettings>, success = "Setting saved") {
    const optimistic = { ...settings, ...update };
    onSettings(optimistic);
    try { onSettings(await api.updateInterface(update)); toast(success); }
    catch (error) { onSettings(settings); applyAccent(settings.accent); toast(errorMessage(error), "error"); }
  }

  async function saveAccent(value: string) {
    applyAccent(value);
    await saveInterface({ accent: value });
  }

  async function changeKey(event: React.FormEvent) {
    event.preventDefault();
    if (newKey.length < 12) return toast("The new Access Key must contain at least 12 characters", "error");
    if (newKey !== confirmKey) return toast("The new Access Keys do not match", "error");
    setBusy("access");
    try { await api.changeAccessKey(currentKey, newKey); toast("Access Key changed. Active sessions have been closed."); onLocked(); }
    catch (error) { toast(errorMessage(error), "error"); }
    finally { setBusy(""); }
  }

  async function saveKernel(event: React.FormEvent) {
    event.preventDefault();
    if (kernelToken.length < 32) return toast("The Kernel token must contain at least 32 characters", "error");
    if (kernelToken !== kernelTokenConfirm) return toast("The Kernel tokens do not match", "error");
    setBusy("kernel");
    try { setKernel(await api.setKernelAccess({ token: kernelToken })); closeKernel(); toast("New Kernel access token saved"); }
    catch (error) { toast(errorMessage(error), "error"); }
    finally { setBusy(""); }
  }

  async function commitKernelUrl() {
    if (!kernel || kernelUrl === kernel.url) return;
    setBusy("kernel-url");
    try { const saved = await api.setKernelAccess({ url: kernelUrl }); setKernel(saved); setKernelUrl(saved.url); toast("Kernel URL verified and saved"); }
    catch (error) { setKernelUrl(kernel.url); toast(errorMessage(error), "error"); }
    finally { setBusy(""); }
  }

  async function commitTrashRetention(retentionDays: number) {
    setBusy("trash-retention");
    try {
      const saved = await api.updateTrashSettings(retentionDays);
      setTrashSettings(saved);
      setTrashRetentionInput(String(saved.retention_days));
      setTrashConfirmOpen(false);
      toast(saved.purged_entries
        ? `Trash retention saved. ${saved.purged_entries} expired ${saved.purged_entries === 1 ? "entity was" : "entities were"} permanently deleted.`
        : "Trash retention saved");
    } catch (error) { toast(errorMessage(error), "error"); }
    finally { setBusy(""); }
  }

  function saveTrashRetention(event: React.FormEvent) {
    event.preventDefault();
    const retentionDays = Number(trashRetentionInput);
    const minimum = trashSettings?.min_days ?? 1;
    const maximum = trashSettings?.max_days ?? 365;
    if (!Number.isInteger(retentionDays) || retentionDays < minimum || retentionDays > maximum) {
      toast(`Trash retention must be a whole number from ${minimum} to ${maximum} days`, "error");
      return;
    }
    if (retentionDays === trashSettings?.retention_days) return;
    if (trashSettings && retentionDays < trashSettings.retention_days) {
      setTrashConfirmOpen(true);
      return;
    }
    void commitTrashRetention(retentionDays);
  }

  async function getFile(kind: "vault" | "backup" | "logs") {
    setBusy(kind);
    try {
      const result = kind === "vault" ? await api.downloadVaultFile() : kind === "backup" ? await api.downloadBackup() : await api.downloadLogs();
      downloadBlob(result.blob, result.disposition, kind === "vault" ? "personal.volt" : kind === "logs" ? "volt-logs.zip" : "volt-backup.zip");
      toast(kind === "vault" ? "personal.volt downloaded" : kind === "logs" ? "Log archive created" : "ZIP backup created");
    } catch (error) { toast(errorMessage(error), "error"); }
    finally { setBusy(""); }
  }

  async function inspect(file: File | null) {
    if (!file) return;
    setBusy("restore");
    try { setRestoreFile(file); setInspection(await api.inspectBackup(file)); setRestorePhrase(""); }
    catch (error) { setRestoreFile(null); setInspection(null); toast(errorMessage(error), "error"); }
    finally { setBusy(""); }
  }

  async function restore() {
    if (!restoreFile || !inspection || restorePhrase !== "RESTORE") return;
    setBusy("restore");
    try { await api.restoreBackup(restoreFile, inspection.digest, restoreKey); setRestoreKey(""); toast("State restored"); onLocked(); }
    catch (error) { toast(errorMessage(error), "error"); }
    finally { setBusy(""); }
  }

  async function checkUpdate() {
    setBusy("update");
    setUpdateCheck(null);
    try {
      const [runtime, candidate] = await Promise.all([api.updateStatus(), api.checkUpdate()]);
      setVersion(runtime);
      setUpdateCheck(candidate);
      toast(candidate.update_available ? `Volt ${candidate.available_version} is available` : "Volt is up to date");
    }
    catch (error) { toast(errorMessage(error), "error"); }
    finally { setBusy(""); }
  }

  async function checkUpdaterUpdate() {
    setBusy("updater-update");
    setUpdaterUpdate(null);
    try {
      const [runtime, candidate] = await Promise.all([api.updateStatus(), api.checkUpdaterUpdate()]);
      setVersion(runtime);
      setUpdaterUpdate(candidate);
      toast(candidate.update_available ? `Updater ${candidate.available_version} is available` : "Updater is up to date");
    } catch (error) { toast(errorMessage(error), "error"); }
    finally { setBusy(""); }
  }

  async function installUpdate() {
    if (!updateCheck?.available_version) return;
    setBusy("update-install");
    try {
      setUpdateConfirmOpen(false);
      const initial = await api.installUpdate(updateCheck.available_version);
      setUpdateJob(initial);
      const completed = await waitForUpdate(initial, setUpdateJob);
      if (completed.state !== "COMPLETED") throw new Error(completed.message || `Volt update ended in ${completed.state}`);
      setVersion(await api.updateStatus());
      setUpdateCheck(null);
      toast(`Volt ${completed.installed_version ?? updateCheck.available_version} installed`);
    } catch (error) { toast(errorMessage(error), "error"); }
    finally { setBusy(""); }
  }

  async function rollbackUpdate() {
    if (!updateJob?.id) return;
    setBusy("update-rollback");
    try {
      setRollbackConfirmOpen(false);
      const initial = await api.rollbackUpdate(updateJob.id);
      setUpdateJob(initial);
      const completed = await waitForUpdate(initial, setUpdateJob);
      if (completed.state !== "ROLLED_BACK") throw new Error(completed.message || `Volt rollback ended in ${completed.state}`);
      setVersion(await api.updateStatus());
      toast("Volt rollback completed");
    } catch (error) { toast(errorMessage(error), "error"); }
    finally { setBusy(""); }
  }

  async function reorder(index: number, direction: -1 | 1) {
    const order = moveItem(settings.settings_order, index, direction);
    if (order !== settings.settings_order) await saveInterface({ settings_order: order }, `Settings order saved: position ${index + direction + 1}`);
  }

  async function dropSection(target: string, before: boolean) {
    if (!dragging) return;
    const next = [...settings.settings_order];
    const from = next.indexOf(dragging);
    const rawTarget = next.indexOf(target);
    if (from < 0 || rawTarget < 0) return;
    const [item] = next.splice(from, 1);
    let destination = rawTarget + (before ? 0 : 1);
    if (from < destination) destination -= 1;
    next.splice(destination, 0, item);
    setDragging(null); setDropTarget(null);
    await saveInterface({ settings_order: next }, `Settings order saved: position ${next.indexOf(dragging) + 1}`);
  }

  const voltMirrorConfigured = neptune?.project?.mirror?.root === "volt" && neptune.project.mirror.mode === "single-file";
  const neptuneNeedsInitialization = (!neptune?.linked || !voltMirrorConfigured);

  const sections: Record<SectionId, { title: string; eyebrow: string; description?: string; content: React.ReactNode }> = {
    appearance: { title: "Appearance", eyebrow: "APPEARANCE", description: "Accent color and sidebar position.", content: <>
      <SettingGroup className="appearance-color" title="Color correction" description="Changes appear immediately on the unlock screen and in the open vault; use Apply to save them."><div className="accent-controls"><label className="accent-swatch"><span className="accent-swatch-color" style={{ background: accent }} /><span className="visually-hidden">Choose color</span><input type="color" value={accent} onChange={(event) => { setAccent(event.target.value.toUpperCase()); applyAccent(event.target.value); }} /></label><label className="visually-hidden" htmlFor="accent-hex">HEX</label><input id="accent-hex" className="accent-hex" value={accent} pattern="#[0-9A-Fa-f]{6}" maxLength={7} onChange={(event) => { setAccent(event.target.value.toUpperCase()); if (/^#[0-9A-F]{6}$/i.test(event.target.value)) applyAccent(event.target.value); }} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void saveAccent(accent); } }} /><button className="button secondary" onClick={() => { setAccent("#00A8FF"); applyAccent("#00A8FF"); }}>Reset</button><button className="button" onClick={() => saveAccent(accent)}>Apply</button></div></SettingGroup>
      <SettingGroup className="appearance-sidebar" title="Left menu position" description="Reveal the sidebar at the screen edge or keep it permanently open."><label className="sidebar-mode-control"><input type="checkbox" checked={settings.sidebar_mode === "auto"} onChange={(event) => saveInterface({ sidebar_mode: event.target.checked ? "auto" : "fixed" })} /><span>Automatically show and hide the panel on hover</span></label></SettingGroup>
    </> },
    security: { title: "Security", eyebrow: "SECURITY", description: "Access Key, data retention, and trusted Kernel connection.", content: <>
      <SettingGroup className="access-key-group" title="Change Access Key" description="Changing the operator key closes all other active browser sessions."><button className="button secondary reference-action" onClick={() => { setCurrentKey(""); setNewKey(""); setConfirmKey(""); setAccessOpen(true); }}>Change Access Key</button></SettingGroup>
      <SettingGroup className="trash-retention-group" title="Trash retention" description="Applies to entities already in trash. Shortening the period may permanently delete older entities immediately."><form className="trash-retention-control" onSubmit={saveTrashRetention}><label className="control-label compact">Retention, days<input type="number" inputMode="numeric" required min={trashSettings?.min_days ?? 1} max={trashSettings?.max_days ?? 365} step={1} value={trashRetentionInput} disabled={!trashSettings || busy === "trash-retention"} onChange={(event) => setTrashRetentionInput(event.target.value)} /></label><button className="button secondary" disabled={!trashSettings || busy === "trash-retention" || trashRetentionInput === String(trashSettings.retention_days)}>{busy === "trash-retention" ? "Saving…" : "Save"}</button></form></SettingGroup>
      <SettingGroup className="kernel-group" title="Kernel connection"><div className="kernel-connection-row"><label className="visually-hidden" htmlFor="kernel-url">Kernel URL</label><input id="kernel-url" className="kernel-url" type="url" value={kernelUrl} disabled={busy === "kernel-url"} onChange={(event) => setKernelUrl(event.target.value)} onBlur={() => void commitKernelUrl()} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void commitKernelUrl(); } }} /><div className="kernel-reachability"><span>Kernel Core: {kernel?.identity ?? "—"}</span><strong className={kernel == null ? "" : kernel.reachable ? "ok-text" : "danger-text"}>{kernel == null ? "Checking Service" : kernel.reachable ? "Service Reachability" : kernel.error ?? "Service Unavailable"}<span className={`status-square${kernel == null ? " checking" : kernel.reachable ? "" : " offline"}`} /></strong></div></div><button className="button secondary wide-kernel-action" onClick={() => { setKernelToken(""); setKernelTokenConfirm(""); setKernelOpen(true); }}>Change protected Kernel access token{kernel?.configured ? "" : " — not configured"}</button></SettingGroup>
    </> },
    backup: { title: "Backup", eyebrow: "BACKUP", description: "Portable container, ZIP snapshot, and Neptune.", content: <div className="backup-content">
      <SettingGroup title="System snapshot" description="The logical snapshot contains entries, revisions, and settings, but not server device keys."><div className="button-row"><button className="button secondary reference-action" disabled={!!busy} onClick={() => getFile("backup")}><Icon name="download" />Create and download snapshot</button><button className="button secondary portable-vault-action" disabled={!!busy} onClick={() => getFile("vault")}><Icon name="download" />Download personal.volt</button></div></SettingGroup>
      <SettingGroup title="Restore snapshot" description="The selected archive is verified first; replacement proceeds only after explicit confirmation."><button className="button secondary reference-action" disabled={!!busy} onClick={() => setRestoreOpen(true)}>Browse local snapshot archive</button></SettingGroup>
      <SettingGroup className="backup-neptune-group" title="Automatic backup to Saturn"><p>Schedules, remote runs and Neptune fleet state are managed only from Saturn → Synchronization. Manual Volt ZIP and personal.volt downloads remain here.</p><StatusRow label="Local Neptune agent:" text={neptune?.linked ? "Linked to Saturn" : neptune?.installed ? "Detected · not linked" : "Not installed"} ok={neptune?.linked === true} />{neptune?.linked && <><StatusRow label="Recovery ZIP:" text={neptune.project ? `Configured · schedule ${neptune.project.enabled ? "enabled" : "disabled"}` : "Configuration unavailable"} ok={Boolean(neptune.project)} /><StatusRow label="personal.volt mirror:" text={voltMirrorConfigured ? `Configured · schedule ${neptune.project!.mirror!.enabled ? "enabled" : "disabled"}` : "Not configured"} ok={voltMirrorConfigured} /></>}{neptuneNeedsInitialization && <button className="button secondary reference-action" disabled={!!busy || !version?.updater.reachable} onClick={() => setNeptuneOpen(true)}>{neptune?.linked ? "Repair Neptune pipelines" : "Initialize Neptune"}</button>}</SettingGroup>
    </div> },
    updates: { title: "Updates", eyebrow: "UPDATES", description: "Local Updater and trusted release registry.", content: <div className="updates-content"><SettingGroup className="update-pipeline-group" title="Update pipeline" description="Release discovery comes from Kernel Register; replacement and rollback are performed by the local Updater."><p className="installed-version">Current installed version: <strong>v{version?.installed_version ?? "…"}</strong></p><StatusRow label="Local Updater agent:" text={version?.updater.reachable ? "Service Reachability" : version?.updater.error ?? "Service Unavailable"} ok={version?.updater.reachable} /><StatusRow label="Kernel Register:" text={kernel?.reachable ? "Service Reachability" : kernel?.error ?? "Service Unavailable"} ok={kernel?.reachable} />{updateJob && <StatusRow label="Latest update job:" text={`${updateJob.state}${updateJob.message ? ` · ${updateJob.message}` : ""}`} ok={updateJob.state === "COMPLETED" || updateJob.state === "ROLLED_BACK" ? true : ["FAILED", "ROLLBACK_FAILED"].includes(updateJob.state) ? false : undefined} />}<button className="button secondary reference-action update-action" disabled={!!busy} onClick={() => { setUpdateOpen(true); void checkUpdate(); }}>Check for updates</button>{updateJob?.state === "COMPLETED" && updateJob.rollback_available && <button className="button secondary reference-action" disabled={!!busy} onClick={() => setRollbackConfirmOpen(true)}>Rollback latest update</button>}</SettingGroup><SettingGroup className="updater-version-group" title="Updater version"><p>Current installed version: {version?.updater.version ?? "unavailable"}{updaterUpdate?.available_version ? ` · latest ${updaterUpdate.available_version}` : ""}</p><button className="button secondary reference-action" disabled={!!busy || !version?.updater.reachable} onClick={() => void checkUpdaterUpdate()}>{busy === "updater-update" ? "Checking…" : "Check Updater for updates"}</button><SelfUpdateButton enabled={version?.updater.reachable === true} start={api.installUpdater} read={api.updateJob} /></SettingGroup></div> },
    logs: { title: "Logs", eyebrow: "LOGS", description: "A limited operational audit stream without secret contents.", content: <><div className="log-command-band"><p>Compact activity stream without secret values.</p><button className="button secondary" disabled={!!busy} onClick={() => getFile("logs")}><Icon name="download" />Download log archive</button></div><div className="settings-log-table"><header><span>TYPE</span><span>BODY</span><span>TIME</span></header>{logs.map((event) => <div key={event.event_id}><strong className={event.status === "success" ? "ok-text" : "danger-text"}>{event.status === "success" ? "/INFO" : "/ERROR"}</strong><span>{event.action}{event.target ? ` · ${event.target}` : ""}</span><time>{new Intl.DateTimeFormat("en-US", { timeStyle: "medium" }).format(new Date(event.created_at))}</time></div>)}</div></> },
    cryptography: { title: "Cryptography", eyebrow: "CRYPTOGRAPHY", description: "Protection model for the local container.", content: <div className="crypto-grid"><div><strong>AES-256-GCM</strong><span>Individual data key for every entry</span></div><div><strong>Argon2id</strong><span>The Access Key unlocks the portable master key</span></div><div><strong>Dual wrapping</strong><span>Offline Access Key and server device key</span></div></div> },
  };

  return <>
    <div className="page settings-page"><div className="settings-list">{settings.settings_order.map((rawId, index) => {
      const id = rawId as SectionId;
      const section = sections[id];
      return <SettingCard key={id} id={id} index={index} title={section.title} description={section.description} dragging={dragging} dropTarget={dropTarget} onMove={(direction) => reorder(index, direction)} onDragStart={() => setDragging(id)} onDragEnd={() => { setDragging(null); setDropTarget(null); }} onDragPosition={(before) => setDropTarget({ id, before })} onDrop={() => dropSection(id, dropTarget?.id === id ? dropTarget.before : true)}>{section.content}</SettingCard>;
    })}</div></div>

    {accessOpen && <Modal title="Change Access Key" eyebrow="SECURITY" className="narrow" dirty={Boolean(currentKey || newKey || confirmKey)} onClose={closeAccess} footer={<><button className="button ghost" type="button" onClick={closeAccess}>Cancel</button><button className="button" form="access-form" disabled={busy === "access"}>{busy === "access" ? "Saving…" : "Change"}</button></>}><form id="access-form" className="modal-body form-grid" onSubmit={changeKey}><label className="control-label">Current Access Key<input data-autofocus type="password" required autoComplete="current-password" value={currentKey} onChange={(event) => setCurrentKey(event.target.value)} /></label><label className="control-label">New Access Key<input type="password" required minLength={12} autoComplete="new-password" value={newKey} onChange={(event) => setNewKey(event.target.value)} /></label><label className="control-label">Repeat new Access Key<input type="password" required minLength={12} autoComplete="new-password" value={confirmKey} onChange={(event) => setConfirmKey(event.target.value)} /></label></form></Modal>}

    {kernelOpen && <Modal title="Replace Kernel token" eyebrow="KERNEL" className="narrow" dirty={Boolean(kernelToken || kernelTokenConfirm)} onClose={closeKernel} footer={<><button className="button ghost" type="button" onClick={closeKernel}>Cancel</button><button className="button" form="kernel-form" disabled={busy === "kernel"}>{busy === "kernel" ? "Saving…" : "Replace token"}</button></>}><form id="kernel-form" className="modal-body form-grid" onSubmit={saveKernel}><p className="inline-note">Enter the same write-only token configured in Kernel. Volt never reveals the current value.</p><label className="control-label">New VOLT_KERNEL_TOKEN<input data-autofocus type="password" required minLength={32} autoComplete="new-password" value={kernelToken} onChange={(event) => setKernelToken(event.target.value)} /></label><label className="control-label">Repeat token<input type="password" required minLength={32} autoComplete="new-password" value={kernelTokenConfirm} onChange={(event) => setKernelTokenConfirm(event.target.value)} /></label></form></Modal>}

    {trashConfirmOpen && trashSettings && <ConfirmDialog title="Shorten trash retention?" body={<p>Entities deleted more than {trashRetentionInput} {Number(trashRetentionInput) === 1 ? "day" : "days"} ago will be permanently erased immediately. This cannot be undone.</p>} confirmLabel="Save and delete expired" busy={busy === "trash-retention"} danger onClose={() => { if (busy !== "trash-retention") setTrashConfirmOpen(false); }} onConfirm={() => void commitTrashRetention(Number(trashRetentionInput))} />}

    {restoreOpen && <Modal title="Restore Volt" eyebrow="REPLACE RESTORE" className="narrow" dirty={Boolean(restoreFile)} onClose={closeRestore} footer={<><button className="button ghost" onClick={closeRestore}>Cancel</button><button className="button danger-button" disabled={busy === "restore" || !inspection || restorePhrase !== "RESTORE"} onClick={restore}>{busy === "restore" ? "Restoring…" : "Replace state"}</button></>}><div className="modal-body restore-body"><p>Select a trusted ZIP snapshot. After verification, all local entries, revisions, settings, and audit events will be replaced, and operator sessions will be closed. A completed restore cannot be undone; the previous state can only be recovered from a separate backup created beforehand.</p><label className="button secondary file-button align-start">Select ZIP<input data-autofocus type="file" accept=".zip,application/zip" onChange={(event) => inspect(event.target.files?.[0] ?? null)} /></label>{inspection && <><dl><div><dt>File</dt><dd>{inspection.filename}</dd></div><div><dt>Size</dt><dd>{inspection.bytes.toLocaleString("en-US")} bytes</dd></div><div><dt>Created</dt><dd>{formatDate(inspection.manifest.created_at)}</dd></div><div><dt>Version</dt><dd>{inspection.manifest.source_version}</dd></div><div><dt>Entries</dt><dd>{inspection.manifest.files["data/entries.jsonl"]?.records ?? 0}</dd></div></dl><label className="control-label">Archive Access Key (required when recovering into a new vault)<input type="password" autoComplete="off" value={restoreKey} onChange={(event) => setRestoreKey(event.target.value)} /></label><label className="control-label">Enter RESTORE<input value={restorePhrase} onChange={(event) => setRestorePhrase(event.target.value)} /></label></>}</div></Modal>}

    {updateOpen && <Modal title="Check for updates" eyebrow="UPDATES" className="narrow" dirty={["update", "update-install"].includes(busy)} onClose={() => setUpdateOpen(false)} footer={<><button className="button ghost" onClick={() => setUpdateOpen(false)}>Close</button>{updateCheck?.update_available && updateCheck.available_version && <button className="button" disabled={!!busy || !version?.updater.reachable} onClick={() => setUpdateConfirmOpen(true)}>Install {updateCheck.available_version}</button>}</>}><div className="modal-body form-grid"><StatusRow label="Installed Volt" text={`v${version?.installed_version ?? "…"}`} /><StatusRow label="Available Volt" text={updateCheck?.available_version ? `v${updateCheck.available_version}` : updateCheck ? "No newer release" : "Checking…"} ok={updateCheck ? !updateCheck.update_available : undefined} /><StatusRow label="Kernel Register" text={kernel?.reachable ? "Service Reachability" : kernel?.error ?? "Service Unavailable"} ok={kernel?.reachable} /><StatusRow label="Local Updater" text={version?.updater.reachable ? `v${version.updater.version ?? "available"}` : version?.updater.error ?? "checking…"} ok={version?.updater.reachable} />{updateCheck?.release_url && <a href={updateCheck.release_url} target="_blank" rel="noreferrer">Open release notes</a>}{busy === "update" ? <p className="inline-note">Checking the trusted source…</p> : <p className="inline-note">Updater verifies the release manifest, archive checksum and immutable image digest, creates a logical backup, checks health and rolls back automatically on failure.</p>}</div></Modal>}
    {updateConfirmOpen && updateCheck?.available_version && <ConfirmDialog title="Install Volt update?" body={<p>Volt {updateCheck.available_version} will be verified and installed. Persistent data is preserved, and a checksummed logical backup is retained for automatic rollback.</p>} confirmLabel={`Install ${updateCheck.available_version}`} busy={busy === "update-install"} onClose={() => setUpdateConfirmOpen(false)} onConfirm={() => void installUpdate()} />}
    {rollbackConfirmOpen && updateJob && <ConfirmDialog title="Rollback Volt update?" body={<p>Volt will return to the previous image and replace its logical state with the pre-update backup. Changes made after the update will be lost.</p>} confirmLabel="Rollback and restore backup" busy={busy === "update-rollback"} danger onClose={() => setRollbackConfirmOpen(false)} onConfirm={() => void rollbackUpdate()} />}
    {neptuneOpen && <Modal title="Initialize Neptune" eyebrow="BACKUP" className="narrow" dirty={Boolean(neptuneCode)} onClose={closeNeptune} footer={<><button className="button ghost" type="button" disabled={busy === "neptune-initialize"} onClick={closeNeptune}>Cancel</button><button className="button" form="neptune-form" disabled={busy === "neptune-initialize"}>{busy === "neptune-initialize" ? "Linking both pipelines…" : "Initialize"}</button></>}><form id="neptune-form" className="modal-body form-grid" onSubmit={initializeNeptune}><p className="inline-note">In Saturn → Synchronization choose <strong>Volt ZIP + personal.volt mirror</strong>, create its one-time setup code and paste it here. Archive-only and other service codes are rejected. Volt may briefly reconnect while Updater configures both pipelines.</p><label className="control-label">Volt dual-pipeline setup code<input data-autofocus value={neptuneCode} onChange={(event) => setNeptuneCode(event.target.value.trim())} minLength={32} maxLength={32} autoComplete="off" required /></label></form></Modal>}
  </>;
}
