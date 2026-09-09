import { useCallback, useEffect, useMemo, useState } from "react";

import { api, type DashboardStats, type InterfaceSettings } from "./api";
import { DragDots } from "./Ui";
import { dropItem, errorMessage, moveItem, type Toast } from "./ui-helpers";

type MetricId = "cpu" | "memory" | "disk" | "uptime" | "entities";

function bytes(value: number | undefined) {
  if (value == null) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let current = value;
  let index = 0;
  while (current >= 1024 && index < units.length - 1) { current /= 1024; index += 1; }
  return `${current >= 10 || index === 0 ? current.toFixed(0) : current.toFixed(1)} ${units[index]}`;
}

function duration(seconds: number | undefined) {
  if (seconds == null) return "—";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return days ? `${days}d ${hours}h` : hours ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function MetricCard({ id, index, title, value, detail, progress, dragging, dropTarget, onMove, onDragStart, onDragEnd, onDragPosition, onDrop }: {
  id: string;
  index: number;
  title: string;
  value: string;
  detail: string;
  progress?: number | null;
  dragging: string | null;
  dropTarget: { id: string; before: boolean } | null;
  onMove: (direction: -1 | 1) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDragPosition: (before: boolean) => void;
  onDrop: () => void;
}) {
  const [dragReady, setDragReady] = useState(false);
  const dropClass = dropTarget?.id === id ? (dropTarget.before ? " drop-before" : " drop-after") : "";
  return <article className={`metric-card universal-card${id === "entities" ? " metric-card-wide" : ""}${dragging === id ? " dragging" : ""}${dropClass}`} draggable={dragReady} onDragStart={(event) => { event.dataTransfer.effectAllowed = "move"; onDragStart(); }} onDragEnd={() => { setDragReady(false); onDragEnd(); }} onDragOver={(event) => { event.preventDefault(); const rect = event.currentTarget.getBoundingClientRect(); onDragPosition(event.clientY < rect.top + rect.height / 2); }} onDrop={(event) => { event.preventDefault(); setDragReady(false); onDrop(); }}>
    <header className="card-rail"><span>{String(index + 1).padStart(2, "0")}</span><DragDots label={`Move ${title} card`} onPointerDown={() => setDragReady(true)} onPointerUp={() => setDragReady(false)} onKeyDown={(event) => { if (!event.altKey || !["ArrowUp", "ArrowDown"].includes(event.key)) return; event.preventDefault(); onMove(event.key === "ArrowUp" ? -1 : 1); }} /></header>
    <div className="metric-body"><span className="eyebrow">{title}</span><div className="metric-value"><strong>{value}</strong>{detail && <><span aria-hidden="true">–</span><span>{detail}</span></>}</div>{progress != null && <div className="meter" aria-label={`${Math.round(progress)} percent`}><i style={{ width: `${Math.max(0, Math.min(100, progress))}%` }} /></div>}</div>
  </article>;
}

export function DashboardPage({ settings, onSettings, toast }: { settings: InterfaceSettings; onSettings: (settings: InterfaceSettings) => void; toast: Toast }) {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; before: boolean } | null>(null);
  const load = useCallback(() => api.dashboard().then(setStats).catch((error) => toast(errorMessage(error), "error")), [toast]);
  useEffect(() => { void load(); const timer = window.setInterval(load, 5000); return () => window.clearInterval(timer); }, [load]);

  const cards = useMemo<Record<MetricId, { title: string; value: string; detail: string; progress?: number | null }>>(() => ({
    cpu: { title: "CPU Usage", value: stats?.cpu.percent == null ? "unavailable" : `${Math.round(stats.cpu.percent)}%`, detail: `${stats?.cpu.logical_cores ?? "—"} logical cores`, progress: stats?.cpu.percent },
    memory: { title: "RAM Usage", value: stats?.memory.percent == null ? "unavailable" : `${Math.round(stats.memory.percent)}%`, detail: `${bytes(stats?.memory.used_bytes)} of ${bytes(stats?.memory.total_bytes)}`, progress: stats?.memory.percent },
    disk: { title: "Disk Usage", value: stats?.disk?.percent == null ? "unavailable" : `${Math.round(stats.disk.percent)}%`, detail: stats?.disk ? `${bytes(stats.disk.used_bytes)} of ${bytes(stats.disk.total_bytes)}` : "data unavailable", progress: stats?.disk?.percent },
    uptime: { title: "Uptime", value: `Active: ${duration(stats?.uptime_seconds)}`, detail: "" },
    entities: { title: "Vault entities", value: stats?.entries == null ? "unavailable" : String(stats.entries), detail: "active entries" },
  }), [stats]);

  async function reorder(index: number, direction: -1 | 1) {
    const order = moveItem(settings.dashboard_order, index, direction);
    if (order === settings.dashboard_order) return;
    onSettings({ ...settings, dashboard_order: order });
    try { onSettings(await api.updateInterface({ dashboard_order: order })); toast(`Dashboard order saved: position ${index + direction + 1}`); }
    catch (error) { onSettings(settings); toast(errorMessage(error), "error"); }
  }

  async function dropCard(target: string, before: boolean) {
    if (!dragging) return;
    const order = dropItem(settings.dashboard_order, settings.dashboard_order.indexOf(dragging), settings.dashboard_order.indexOf(target), before);
    setDragging(null); setDropTarget(null);
    if (order === settings.dashboard_order) return;
    const previous = settings;
    onSettings({ ...settings, dashboard_order: order });
    try { onSettings(await api.updateInterface({ dashboard_order: order })); toast(`Dashboard order saved: position ${order.indexOf(dragging) + 1}`); }
    catch (error) { onSettings(previous); toast(errorMessage(error), "error"); }
  }

  return <div className="page dashboard-page">
    <div className="dashboard-grid">{settings.dashboard_order.map((id, index) => {
      const card = cards[id as MetricId];
      return <MetricCard key={id} id={id} index={index} {...card} dragging={dragging} dropTarget={dropTarget} onMove={(direction) => reorder(index, direction)} onDragStart={() => setDragging(id)} onDragEnd={() => { setDragging(null); setDropTarget(null); }} onDragPosition={(before) => setDropTarget({ id, before })} onDrop={() => dropCard(id, dropTarget?.id === id ? dropTarget.before : true)} />;
    })}</div>
  </div>;
}
