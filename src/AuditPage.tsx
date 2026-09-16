import { useEffect, useMemo, useState } from "react";

import { api } from "./api";
import type { AuditEvent } from "./types";
import { SearchField } from "./Ui";
import { errorMessage, formatDate, type Toast } from "./ui-helpers";

export function AuditPage({ toast }: { toast: Toast }) {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [query, setQuery] = useState("");
  useEffect(() => { api.audit().then((result) => setEvents(result.events)).catch((error) => toast(errorMessage(error), "error")); }, [toast]);
  const visible = useMemo(() => events.filter((event) => !query || `${event.actor} ${event.action} ${event.target ?? ""} ${event.status}`.toLowerCase().includes(query.toLowerCase())), [events, query]);
  return <div className="page audit-page">
    <div className="collection-command-bar audit-command-bar" role="search" aria-label="Search audit log"><SearchField label="Search events" value={query} onChange={setQuery} placeholder="Filter by event, actor, or target" /><div className="collection-information"><strong>{visible.length}</strong><span>events</span><small>Secret values are never logged</small></div></div>
    <div className="audit-table" role="table"><div className="audit-row audit-head" role="row"><span>Time</span><span>Event</span><span>Actor</span><span>Target</span><span>Status</span></div>{visible.map((event) => <div className="audit-row" role="row" key={event.event_id}><span>{formatDate(event.created_at)}</span><code>{event.action}</code><span>{event.actor}</span><code>{event.target ?? "—"}</code><span className={`status-badge ${event.status === "success" ? "active" : "revoked"}`}>{event.status}</span></div>)}</div>
  </div>;
}
