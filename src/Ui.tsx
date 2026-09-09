import { useEffect, useRef, useState } from "react";

import bootLogo from "../.src/ChatGPT Image Sep 8, 2026, 09_38_04 PM.png";
import interfaceLogo from "../.src/ChatGPT Image Sep 8, 2026, 09_40_14 PM.png";
import { Icon } from "./icons";

export function VoltLogo({ size = "sidebar" }: { size?: "sidebar" | "login" | "boot" }) {
  return <img className={`volt-logo volt-logo-${size}`} src={size === "boot" ? bootLogo : interfaceLogo} alt="" draggable={false} />;
}

export function DragDots({ label, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return <button type="button" className="drag-handle" aria-label={label} title={`${label}. Alt+↑/↓ — move`} {...props}>
    <span /><span /><span /><span />
  </button>;
}

export function Modal({
  title,
  eyebrow,
  children,
  footer,
  onClose,
  dirty = false,
  className = "",
}: {
  title: string;
  eyebrow?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  onClose: () => void;
  dirty?: boolean;
  className?: string;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const invokerRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef(onClose);
  const dirtyRef = useRef(dirty);
  const dragRef = useRef<{ x: number; y: number; left: number; top: number; offsetX: number; offsetY: number } | null>(null);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const titleId = useRef(`dialog-${crypto.randomUUID()}`);
  closeRef.current = onClose;
  dirtyRef.current = dirty;

  useEffect(() => {
    invokerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const card = cardRef.current;
    const first = card?.querySelector<HTMLElement>("[data-autofocus]") ?? card?.querySelector<HTMLElement>("input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled])");
    (first ?? titleRef.current)?.focus();
    function keydown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        if (!dirtyRef.current) closeRef.current();
        return;
      }
      if (event.key !== "Tab" || !card) return;
      const focusable = [...card.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])")];
      if (!focusable.length) return;
      const firstItem = focusable[0];
      const lastItem = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === firstItem) { event.preventDefault(); lastItem.focus(); }
      else if (!event.shiftKey && document.activeElement === lastItem) { event.preventDefault(); firstItem.focus(); }
    }
    document.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("keydown", keydown);
      invokerRef.current?.focus();
    };
  }, []);

  function startDrag(event: React.PointerEvent<HTMLElement>) {
    if ((event.target as HTMLElement).closest("button, input, select, textarea, a")) return;
    const card = cardRef.current;
    if (!card) return;
    const rect = card.getBoundingClientRect();
    dragRef.current = { x: event.clientX, y: event.clientY, left: rect.left, top: rect.top, offsetX: offset.x, offsetY: offset.y };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function drag(event: React.PointerEvent<HTMLElement>) {
    const initial = dragRef.current;
    const card = cardRef.current;
    if (!initial || !card) return;
    const rect = card.getBoundingClientRect();
    const nextLeft = Math.min(window.innerWidth - 8 - rect.width, Math.max(8, initial.left + event.clientX - initial.x));
    const nextTop = Math.min(window.innerHeight - 8 - Math.min(rect.height, window.innerHeight - 16), Math.max(8, initial.top + event.clientY - initial.y));
    setOffset({ x: initial.offsetX + nextLeft - initial.left, y: initial.offsetY + nextTop - initial.top });
  }

  return <div className="modal" role="dialog" aria-modal="true" aria-labelledby={titleId.current}>
    <div className="modal-scrim" onPointerDown={() => { if (!dirty) onClose(); }} />
    <div ref={cardRef} className={`modal-card ${className}`} style={{ translate: `${offset.x}px ${offset.y}px` }}>
      <header className="modal-header" onPointerDown={startDrag} onPointerMove={drag} onPointerUp={() => { dragRef.current = null; }}>
        <div>{eyebrow && <span className="eyebrow">{eyebrow}</span>}<h2 ref={titleRef} tabIndex={-1} id={titleId.current}>{title}</h2></div>
        <button className="icon-button" type="button" aria-label="Close" onClick={onClose}><Icon name="close" /></button>
      </header>
      {children}
      {footer && <footer className="modal-footer">{footer}</footer>}
    </div>
  </div>;
}
