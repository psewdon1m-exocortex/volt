export type Toast = (message: string, tone?: "ok" | "error") => void;

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Could not complete the action";
}

export function formatDate(value: string | null | undefined) {
  if (!value) return "never";
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

export function applyAccent(value: string) {
  document.documentElement.style.setProperty("--accent", value);
}

export function moveItem<T>(items: T[], index: number, direction: -1 | 1) {
  const target = index + direction;
  if (index < 0 || target < 0 || target >= items.length) return items;
  const next = [...items];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

export function dropItem<T>(items: T[], from: number, to: number, before: boolean) {
  if (from < 0 || to < 0 || from === to) return items;
  const next = [...items];
  const [item] = next.splice(from, 1);
  let destination = to + (before ? 0 : 1);
  if (from < destination) destination -= 1;
  next.splice(destination, 0, item);
  return next;
}

export function downloadBlob(blob: Blob, disposition: string, fallback: string) {
  const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? fallback;
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
