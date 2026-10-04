import type { AuditEvent, Entry, GeneratedValue, Revision, TrashEntry } from "./types";

export class ApiError extends Error {
  code: string;
  status: number;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export type NeptuneStatus = {
  version: string;
  client_instance_id: string;
  active: boolean;
  last_success_at?: string | null;
  latest_error?: string | null;
  latest_run_state?: string | null;
  mirror_active?: boolean;
  project: {
    enabled: boolean;
    interval_hours: number;
    next_run_at?: string | null;
    mirror?: null | {
      root: string;
      mode: string;
      enabled: boolean;
      interval_minutes: number;
      next_run_at?: string | null;
    };
  };
};

export type NeptuneAvailability = Partial<NeptuneStatus> & {
  installed: boolean | null;
  linked: boolean | null;
  state: "linked" | "unlinking" | "unlinked" | "unavailable" | "authorization_failed";
  version?: string | null;
};

export type NeptuneInitializationJob = {
  id: string;
  state: "REQUESTED" | "INSTALLING" | "ENROLLING" | "COMPLETED" | "FAILED";
  message?: string;
  updated_at: string;
  finished_at?: string;
};

export type UpdateCheck = {
  service: string;
  repository_url: string;
  installed_version: string;
  available_version: string | null;
  update_available: boolean;
  release_url: string | null;
  published_at: string | null;
  backup_required: boolean;
};

export type UpdateJob = {
  id: string;
  request_id: string;
  head_id: string;
  service: string;
  version?: string;
  state: "REQUESTED" | "BACKUP_VERIFIED" | "ARTIFACT_VERIFIED" | "PULLING" | "APPLYING" | "HEALTH_CHECK" | "COMPLETED" | "FAILED" | "ROLLING_BACK" | "ROLLED_BACK" | "ROLLBACK_FAILED";
  message?: string;
  installed_version?: string;
  rollback_available: boolean;
  updated_at: string;
  finished_at?: string;
};

export type InterfaceSettings = {
  accent: string;
  sidebar_mode: "fixed" | "auto";
  activity_ranking_enabled: boolean;
  navigation_order: string[];
  settings_order: string[];
  dashboard_order: string[];
};

export type ShareRecord = {
  id: string;
  entry_id: string;
  title: string;
  revision: number | null;
  field_names: string[];
  field_count: number;
  password_required: boolean;
  created_at: string;
  updated_at: string;
  expires_at: string;
  status: "active" | "expired" | "unavailable";
};

export type SharedEntry = {
  title: string;
  revision: number;
  fields: Array<{ id: string; key: string; visibility: "secret" | "plain"; value: string | null; length?: number }>;
};

export type DashboardStats = {
  measured_at: string;
  entries: number;
  cpu: { percent: number | null; logical_cores: number };
  memory: { used_bytes: number; total_bytes: number; percent: number | null };
  disk: { used_bytes: number; total_bytes: number; percent: number | null } | null;
  uptime_seconds: number;
};

export type KernelStatus = {
  configured: boolean;
  url: string;
  reachable: boolean;
  identity: string | null;
  checked_at: string;
  error: string | null;
};

export type TrashSettings = {
  retention_days: number;
  min_days: number;
  max_days: number;
  purged_entries?: number;
};

export async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    credentials: "same-origin",
    headers: typeof init?.body === "string" ? { "Content-Type": "application/json", ...init.headers } : init?.headers,
  });
  if (response.status === 204) return undefined as T;
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(response.status, body?.error?.code ?? "REQUEST_FAILED", body?.error?.message ?? "Request failed");
  return body as T;
}

export const api = {
  session: () => request<{ authenticated: boolean; appearance: "dark"; interface: InterfaceSettings }>("/api/v1/session"),
  unlock: (accessKey: string) => request<{ authenticated: boolean; appearance: "dark"; interface: InterfaceSettings }>("/api/v1/session", {
    method: "POST", body: JSON.stringify({ access_key: accessKey }),
  }),
  lock: () => request<void>("/api/v1/session", { method: "DELETE" }),
  overview: () => request<{ entries: number; revisions: number; appearance: "dark"; interface: InterfaceSettings }>("/api/v1/overview"),
  dashboard: () => request<DashboardStats>("/api/v1/dashboard"),
  entries: () => request<{ entries: Entry[] }>("/api/v1/entries"),
  shares: () => request<{ shares: ShareRecord[] }>("/api/v1/shares"),
  createShare: (body: { entry_id: string; field_ids: string[]; expected_revision: number; password?: string | null; expires_at: string }) => request<{ id: string; path: string }>("/api/v1/shares", { method: "POST", body: JSON.stringify(body) }),
  shareLink: (id: string) => request<{ path: string }>(`/api/v1/shares/${id}/link`),
  updateShare: (id: string, body: { expires_at?: string; password?: string | null; revoke?: true }) => request<{ updated: true }>(`/api/v1/shares/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  publicSharePolicy: (id: string) => request<{ password_required: boolean; accent: string }>(`/public/shares/${id}/policy`),
  publicShareEntry: (id: string) => request<SharedEntry>(`/public/shares/${id}/entry`),
  publicShareSession: (id: string, token: string, password?: string) => request<{ expires_at: string }>(`/public/shares/${id}/session`, { method: "POST", body: JSON.stringify({ token, password }) }),
  publicShareReveal: (id: string, fieldId: string) => request<{ value: string }>(`/public/shares/${id}/fields/${fieldId}/reveal`, { method: "POST", body: "{}" }),
  createEntry: (payload: unknown) => request<Entry>("/api/v1/entries", { method: "POST", body: JSON.stringify(payload) }),
  updateEntry: (id: string, payload: unknown) => request<Entry>(`/api/v1/entries/${id}`, { method: "PUT", body: JSON.stringify(payload) }),
  deleteEntry: (id: string) => request<void>(`/api/v1/entries/${id}`, { method: "DELETE" }),
  trash: () => request<{ entries: TrashEntry[]; retention_days: number }>("/api/v1/trash"),
  restoreEntry: (id: string) => request<Entry>(`/api/v1/trash/${id}/restore`, { method: "POST", body: "{}" }),
  purgeEntry: (id: string) => request<void>(`/api/v1/trash/${id}`, { method: "DELETE" }),
  reorderEntries: (ids: string[]) => request<void>("/api/v1/entries/reorder", { method: "POST", body: JSON.stringify({ ids }) }),
  recordEntryInteraction: (id: string, action: "open" | "copy.value" | "copy.reference" | "reveal") => request<{ recorded: boolean }>(`/api/v1/entries/${id}/interactions`, { method: "POST", body: JSON.stringify({ action }) }),
  reveal: (entryId: string, fieldId: string, revision?: number) => request<{ value: string; revision: number }>(
    `/api/v1/entries/${entryId}/fields/${fieldId}/reveal`,
    { method: "POST", body: JSON.stringify({ revision }) },
  ),
  revisions: (entryId: string) => request<{ revisions: Revision[] }>(`/api/v1/entries/${entryId}/revisions`),
  revision: (entryId: string, revision: number) => request<Entry>(`/api/v1/entries/${entryId}/revisions/${revision}`),
  restoreRevision: (entryId: string, revision: number) => request<Entry>(`/api/v1/entries/${entryId}/revisions/${revision}/restore`, { method: "POST", body: "{}" }),
  generate: (options: Record<string, unknown>) => request<GeneratedValue>("/api/v1/generate", { method: "POST", body: JSON.stringify(options) }),
  audit: () => request<{ events: AuditEvent[] }>("/api/v1/audit?limit=250"),
  interfaceSettings: () => request<InterfaceSettings>("/api/v1/settings/interface"),
  updateInterface: (update: Partial<InterfaceSettings>) => request<InterfaceSettings>("/api/v1/settings/interface", { method: "PUT", body: JSON.stringify(update) }),
  trashSettings: () => request<TrashSettings>("/api/v1/settings/trash"),
  updateTrashSettings: (retentionDays: number) => request<TrashSettings>("/api/v1/settings/trash", { method: "PUT", body: JSON.stringify({ retention_days: retentionDays }) }),
  changeAccessKey: (currentAccessKey: string, newAccessKey: string) => request<{ changed: true; startup_key_updated: boolean | null }>("/api/v1/settings/access-key", { method: "PUT", body: JSON.stringify({ current_access_key: currentAccessKey, new_access_key: newAccessKey }) }),
  kernelAccess: () => request<KernelStatus>("/api/v1/settings/kernel-access"),
  setKernelAccess: (update: { token?: string; url?: string }) => request<KernelStatus>("/api/v1/settings/kernel-access", { method: "PUT", body: JSON.stringify(update) }),
  kernelServiceAccess: () => request<KernelStatus>("/api/v1/settings/kernel-service-access"),
  setKernelServiceAccess: (token: string, url: string) => request<KernelStatus>("/api/v1/settings/kernel-service-access", { method: "PUT", body: JSON.stringify({ token, url }) }),
  updateStatus: () => request<{ installed_version: string; mechanism: string; updater: { reachable: boolean; version: string | null; error: string | null } }>("/api/v1/update/status"),
  checkUpdate: () => request<UpdateCheck>("/api/v1/update/check", { method: "POST", body: "{}" }),
  installUpdate: (version: string) => request<UpdateJob>("/api/v1/update/install", { method: "POST", body: JSON.stringify({ version }) }),
  updateJob: (jobId: string) => request<UpdateJob>(`/api/v1/update/jobs/${encodeURIComponent(jobId)}`),
  rollbackUpdate: (jobId: string) => request<UpdateJob>(`/api/v1/update/jobs/${encodeURIComponent(jobId)}/rollback`, { method: "POST", body: "{}" }),
  downloadVaultFile: async () => {
    const response = await fetch("/api/v1/vault-file", { credentials: "same-origin" });
    if (!response.ok) throw new ApiError(response.status, "VAULT_EXPORT_FAILED", "Could not create personal.volt");
    return { blob: await response.blob(), disposition: response.headers.get("content-disposition") ?? "" };
  },
  downloadBackup: async () => {
    const response = await fetch("/api/v1/backup", { credentials: "same-origin" });
    if (!response.ok) throw new ApiError(response.status, "BACKUP_FAILED", "Could not create backup");
    return { blob: await response.blob(), disposition: response.headers.get("content-disposition") ?? "" };
  },
  inspectVaultFile: (file: File) => {
    const form = new FormData();
    form.append("file", file);
    return request<{
      digest: string;
      filename: string;
      bytes: number;
      info: {
        format: string;
        format_version: number;
        current_format_version: number;
        schema_version: number;
        vault_id: string;
        created_at: string;
        has_device_wrapper: boolean;
      };
    }>("/api/v1/vault-file/inspect", { method: "POST", body: form });
  },
  restoreVaultFile: (file: File, digest: string, accessKey: string) => {
    const form = new FormData();
    form.append("file", file);
    form.append("digest", digest);
    form.append("access_key", accessKey);
    return request<{ restored: boolean }>("/api/v1/vault-file/restore", { method: "POST", body: form });
  },
  downloadLogs: async () => {
    const response = await fetch("/api/v1/logs/archive", { credentials: "same-origin" });
    if (!response.ok) throw new ApiError(response.status, "LOG_EXPORT_FAILED", "Could not export logs");
    return { blob: await response.blob(), disposition: response.headers.get("content-disposition") ?? "" };
  },
  inspectBackup: (file: File) => {
    const form = new FormData();
    form.append("file", file);
    return request<{ digest: string; filename: string; bytes: number; manifest: { created_at: string; source_version: string; restore_mode: string; files: Record<string, { records: number }> } }>("/api/v1/backup/inspect", { method: "POST", body: form });
  },
  restoreBackup: (file: File, digest: string, accessKey = "") => {
    const form = new FormData();
    form.append("file", file);
    form.append("digest", digest);
    if (accessKey) form.append("access_key", accessKey);
    return request<{ restored: boolean }>("/api/v1/backup/restore", { method: "POST", body: form });
  },
  neptuneStatus: () => request<NeptuneStatus>("/api/v1/neptune/status"),
  neptuneAvailability: () => request<NeptuneAvailability>("/api/v1/neptune/availability"),
  initializeNeptune: (enrollmentCode: string, requestId?: string) => request<NeptuneInitializationJob>("/api/v1/neptune/initialize", { method: "POST", body: JSON.stringify({ enrollment_code: enrollmentCode, request_id: requestId }) }),
  unlinkNeptune: () => request<{ id: string }>("/api/v1/neptune/unlink", { method: "POST", body: "{}" }),
  neptuneInitialization: (jobId: string) => request<NeptuneInitializationJob>(`/api/v1/neptune/initializations/${encodeURIComponent(jobId)}`),
};
