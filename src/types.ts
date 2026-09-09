export type Visibility = "secret" | "plain";

export interface VoltField {
  id: string;
  key: string;
  value: string | null;
  visibility: Visibility;
  generator: Record<string, unknown> | null;
  masked?: boolean;
}

export interface Entry {
  id: string;
  schema: number;
  title: string;
  project: string | null;
  fields: VoltField[];
  revision: number;
  created_at: string;
  updated_at: string;
}

export interface TrashEntry extends Entry {
  deleted_at: string;
  purge_at: string;
}

export interface Revision {
  id: string;
  revision: number;
  parent_revision_id: string | null;
  source_revision_id: string | null;
  actor: string;
  reason: string | null;
  created_at: string;
  current: boolean;
}

export interface AuditEvent {
  event_id: string;
  actor: string;
  action: string;
  target: string | null;
  status: string;
  details: Record<string, unknown> | null;
  created_at: string;
}

export interface GeneratedValue {
  kind: string;
  values: Array<{ key: string; value: string; visibility: Visibility }>;
  entropy_bits?: number;
  parameters: Record<string, unknown>;
}
