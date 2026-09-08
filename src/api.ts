import type { AuditEvent, Entry, GeneratedValue, Revision } from "./types";

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
  project: { enabled: boolean; interval_hours: number; next_run_at?: string | null };
};

export type NeptuneUpdate = {
  installed_version: string;
  available_version?: string | null;
  update_available: boolean;
};

async function request<T>(url: string, init?: RequestInit): Promise<T> {
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
  session: () => request<{ authenticated: boolean; appearance: "dark" | "light" }>("/api/v1/session"),
  unlock: (accessKey: string) => request<{ authenticated: boolean; appearance: "dark" | "light" }>("/api/v1/session", {
    method: "POST", body: JSON.stringify({ access_key: accessKey }),
  }),
  lock: () => request<void>("/api/v1/session", { method: "DELETE" }),
  overview: () => request<{ entries: number; revisions: number; appearance: "dark" | "light" }>("/api/v1/overview"),
  entries: () => request<{ entries: Entry[] }>("/api/v1/entries"),
  createEntry: (payload: unknown) => request<Entry>("/api/v1/entries", { method: "POST", body: JSON.stringify(payload) }),
  updateEntry: (id: string, payload: unknown) => request<Entry>(`/api/v1/entries/${id}`, { method: "PUT", body: JSON.stringify(payload) }),
  deleteEntry: (id: string) => request<void>(`/api/v1/entries/${id}`, { method: "DELETE" }),
  reorderEntries: (ids: string[]) => request<void>("/api/v1/entries/reorder", { method: "POST", body: JSON.stringify({ ids }) }),
  reveal: (entryId: string, fieldId: string, revision?: number) => request<{ value: string; revision: number }>(
    `/api/v1/entries/${entryId}/fields/${fieldId}/reveal`,
    { method: "POST", body: JSON.stringify({ revision }) },
  ),
  revisions: (entryId: string) => request<{ revisions: Revision[] }>(`/api/v1/entries/${entryId}/revisions`),
  revision: (entryId: string, revision: number) => request<Entry>(`/api/v1/entries/${entryId}/revisions/${revision}`),
  restoreRevision: (entryId: string, revision: number) => request<Entry>(`/api/v1/entries/${entryId}/revisions/${revision}/restore`, { method: "POST", body: "{}" }),
  generate: (options: Record<string, unknown>) => request<GeneratedValue>("/api/v1/generate", { method: "POST", body: JSON.stringify(options) }),
  audit: () => request<{ events: AuditEvent[] }>("/api/v1/audit?limit=250"),
  appearance: (appearance: "dark" | "light") => request<{ appearance: "dark" | "light" }>("/api/v1/settings/appearance", { method: "PUT", body: JSON.stringify({ appearance }) }),
  changeAccessKey: (accessKey: string) => request<void>("/api/v1/settings/access-key", { method: "PUT", body: JSON.stringify({ access_key: accessKey }) }),
  downloadVaultFile: async () => {
    const response = await fetch("/api/v1/vault-file", { credentials: "same-origin" });
    if (!response.ok) throw new ApiError(response.status, "VAULT_EXPORT_FAILED", "Не удалось создать personal.volt");
    return { blob: await response.blob(), disposition: response.headers.get("content-disposition") ?? "" };
  },
  downloadBackup: async () => {
    const response = await fetch("/api/v1/backup", { credentials: "same-origin" });
    if (!response.ok) throw new ApiError(response.status, "BACKUP_FAILED", "Не удалось создать резервную копию");
    return { blob: await response.blob(), disposition: response.headers.get("content-disposition") ?? "" };
  },
  inspectBackup: (file: File) => {
    const form = new FormData();
    form.append("file", file);
    return request<{ digest: string; filename: string; bytes: number; manifest: { created_at: string; source_version: string; restore_mode: string; files: Record<string, { records: number }> } }>("/api/v1/backup/inspect", { method: "POST", body: form });
  },
  restoreBackup: (file: File, digest: string) => {
    const form = new FormData();
    form.append("file", file);
    form.append("digest", digest);
    return request<{ restored: boolean }>("/api/v1/backup/restore", { method: "POST", body: form });
  },
  neptuneStatus: () => request<NeptuneStatus>("/api/v1/neptune/status"),
  neptuneSchedule: (enabled: boolean, intervalHours: number) => request<void>("/api/v1/neptune/schedule", { method: "PUT", body: JSON.stringify({ enabled, interval_hours: intervalHours }) }),
  neptuneRun: () => request<void>("/api/v1/neptune/runs", { method: "POST", body: "{}" }),
  neptuneCheckUpdate: () => request<NeptuneUpdate>("/api/v1/neptune/update/check", { method: "POST", body: "{}" }),
  neptuneInstallUpdate: (version: string) => request<void>("/api/v1/neptune/update/install", { method: "POST", body: JSON.stringify({ version }) }),
};
