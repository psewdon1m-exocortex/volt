// Service-owned backup controls. Vendored with the same protocol in each head.
function node(tag, text, className) {
  const item = document.createElement(tag);
  if (text !== undefined) item.textContent = String(text);
  if (className) item.className = className;
  return item;
}

export function mountBackupPolicy(root, options) {
  root.classList.add("exo-backup-policy");
  let closed = false, policy, busy = false, loading = false, timer, failure = "", pending;
  const drafts = new Map(), controllers = new Set();
  const key = "exocortex.backup-policy.v1." + options.service;
  try { pending = JSON.parse(localStorage.getItem(key) || "null"); } catch { /* Only an operation hint. */ }
  const remember = value => {
    pending = value;
    try { if (value) localStorage.setItem(key, JSON.stringify(value)); else localStorage.removeItem(key); } catch { /* Server replay is authoritative. */ }
  };
  if (pending && (pending.method !== "PUT" || pending.suffix !== "")) remember(null);
  async function request(suffix = "", method = "GET", body) {
    const controller = new AbortController(); controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), 25000);
    try {
      const response = await fetch(options.base + suffix, {
        method, credentials: "same-origin", cache: "no-store", signal: controller.signal,
        headers: { ...(options.headers?.() ?? {}), ...(body ? { "Content-Type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error((typeof data.error === "string" ? data.error : data.error?.message) || data.message || (typeof data.detail === "string" ? data.detail : "") || "Backup service is unavailable");
        error.status = response.status;
        throw error;
      }
      return data;
    } finally { clearTimeout(timeout); controllers.delete(controller); }
  }
  const stamp = value => value ? new Date(value).toLocaleString(undefined, { hour12: false }) : "Not reported";
  function action(text, run) {
    const button = node("button", text); button.type = "button"; button.disabled = busy;
    button.onclick = () => void run();
    return button;
  }
  function draftFor(kind, current) {
    if (!drafts.has(kind)) drafts.set(kind, { value: String(current), confirmed: current, revision: policy.revision, dirty: false, error: "" });
    const draft = drafts.get(kind);
    if (!draft.dirty) { draft.value = String(current); draft.confirmed = current; draft.revision = policy.revision; }
    return draft;
  }
  const schedule = (enabled, intervalHours, expectedRevision) => ({
    kind: policy.mirror ? "schedule-all" : "schedule",
    ...(policy.mirror ? {} : { pipeline: "archive" }), enabled, intervalHours,
    expectedRevision, requestId: crypto.randomUUID(),
  });
  function render(force = false) {
    if (closed) return;
    // Do not destroy an active text field during background polling.
    if (!force && root.contains(document.activeElement) && document.activeElement.matches("input[type=number]")) return;
    root.replaceChildren();
    const statuses = node("div", undefined, "exo-policy-statuses");
    const statusRow = (label, observed = {}, applied = false) => {
      const online = policy?.observed?.online;
      const unhealthy = Boolean(observed.error) || /error|fail|denied|unavailable/i.test(String(observed.state || ""));
      const ready = online === true && applied && !policy.paused && Boolean(observed.state) && !unhealthy;
      const row = node("div", undefined, "exo-agent-status exo-policy-status");
      row.dataset.state = ready ? "ready" : online === undefined ? "busy" : "unavailable";
      const value = node("strong");
      value.append(node("span", ready ? "Reachability" : policy?.paused ? "Paused" : online === false ? "Unavailable"
        : unhealthy ? "Pipeline error" : !applied ? "Pending application" : "Not verified"), node("i"));
      row.append(node("span", label), value);
      return row;
    };
    root.append(statuses);
    const error = node("p", failure, "exo-agent-error"); error.setAttribute("role", "alert");
    if (!policy) {
      statuses.append(statusRow("Basic pipeline status:"), statusRow("Advanced volt pipeline status:"));
      const controls = node("div", undefined, "exo-policy-controls");
      const toggle = node("label", undefined, "exo-policy-toggle"), checkbox = node("input");
      checkbox.type = "checkbox"; checkbox.disabled = true;
      toggle.append(checkbox, node("span", "Enable automatic backups"));
      const interval = node("label", undefined, "exo-policy-interval"), input = node("input");
      input.type = "number"; input.value = "24"; input.disabled = true;
      interval.append(node("span", "Interval in hours"), input);
      controls.append(toggle, interval);
      root.append(controls);
      root.append(node("p", loading ? "Loading backup policy…" : "Backup policy is unavailable. Initialize Neptune or update it to a compatible version."), error,
        action("Retry policy status", refresh));
      return;
    }
    const applied = !failure && policy.appliedRevision === policy.revision;
    root.append(node("p", policy.paused ? "Restored policy · pending verification. Execution is paused."
      : applied ? "Schedule applied · revision " + policy.revision
      : "Policy saved · pending application (desired " + policy.revision + ", applied " + policy.appliedRevision + ")",
    policy.paused || !applied ? "exo-agent-muted" : "exo-agent-success"));
    if (policy.paused) root.append(action("Verify and resume restored policy", () => mutate({
      kind: "resume", expectedRevision: policy.revision, requestId: crypto.randomUUID(),
    })));
    root.append(error);
    for (const kind of ["archive", "mirror"]) {
      const settings = policy[kind]; if (!settings) continue;
      const current = kind === "mirror" ? settings.intervalMinutes / 60 : settings.intervalHours;
      const group = node("section", undefined, "exo-agent-group");
      const observed = policy.observed?.[kind] ?? {};
      statuses.append(statusRow(kind === "archive" ? policy.mirror ? "Basic pipeline status:" : "Pipeline status:"
        : "Advanced volt pipeline status:", observed, applied));
      if (kind === "archive") {
        const draft = draftFor(kind, current), controls = node("div", undefined, "exo-policy-controls");
        const enableLabel = node("label", undefined, "exo-policy-toggle");
        const checkbox = node("input"); checkbox.type = "checkbox"; checkbox.checked = settings.enabled;
        checkbox.indeterminate = Boolean(policy.mirror && settings.enabled !== policy.mirror.enabled);
        checkbox.disabled = busy || policy.paused; checkbox.setAttribute("aria-label", "Enable automatic backups");
        enableLabel.append(checkbox, node("span", "Enable automatic backups"));
        checkbox.onchange = () => {
          if (policy.mirror && current > 168) { failure = "Choose a shared interval from 1 to 168 hours before changing both pipelines."; render(); return; }
          void mutate(schedule(checkbox.checked, current, policy.revision));
        };
        const intervalLabel = node("label", undefined, "exo-policy-interval");
        const input = node("input"); input.type = "number"; input.min = "1"; input.step = "1";
        input.max = policy.mirror ? "168" : "8760"; input.value = draft.value; input.disabled = busy || policy.paused;
        input.setAttribute("aria-label", "Interval in hours"); input.setAttribute("aria-invalid", String(Boolean(draft.error)));
        const inlineError = node("span", draft.error, "exo-agent-error"); inlineError.setAttribute("role", "alert");
        intervalLabel.append(node("span", "Interval in hours"), input, inlineError);
        input.oninput = () => {
          if (!draft.dirty) draft.revision = policy.revision;
          draft.dirty = true; draft.value = input.value; draft.error = "";
          inlineError.textContent = ""; input.setAttribute("aria-invalid", "false");
        };
        const commit = () => {
          if (busy || !draft.dirty || draft.review) return;
          const value = Number(draft.value), max = policy.mirror ? 168 : 8760;
          if (!draft.value.trim() || !Number.isInteger(value) || value < 1 || value > max) {
            draft.error = "Enter a whole number of hours from 1 to " + max + ".";
            inlineError.textContent = draft.error; input.setAttribute("aria-invalid", "true"); return;
          }
          void mutate(schedule(settings.enabled, value, draft.revision), kind);
        };
        input.onkeydown = event => { if (event.key === "Enter") { event.preventDefault(); commit(); } };
        input.onblur = () => { commit(); if (!busy) render(); };
        controls.append(enableLabel, intervalLabel); group.append(controls);
        if (policy.mirror && (settings.enabled !== policy.mirror.enabled || settings.intervalHours * 60 !== policy.mirror.intervalMinutes))
          group.append(node("p", "The two saved schedules differ. Choose an interval and save it to align both pipelines.", "exo-agent-muted"));
        if (draft.dirty && draft.error) group.append(action("Discard interval draft", () => { drafts.delete(kind); render(); }));
        if (draft.review) {
          group.append(node("p", "Current interval: " + current + " hours. Your proposed interval: " + draft.value + " hours."));
          group.append(action("Apply reviewed interval", () => {
            draft.review = false; draft.revision = policy.revision; commit();
          }));
        }
      }
      if (kind === "mirror" && !Number.isInteger(current))
        group.append(node("p", "Imported interval: " + settings.intervalMinutes + " minutes. It is preserved exactly; enter whole hours only when changing it.", "exo-agent-muted"));
      group.append(node("p", "Next run: " + stamp(observed.nextRunAt) + " · Last successful commitment: " + stamp(observed.lastSuccessAt), "exo-agent-muted"));
      group.append(node("p", "Pipeline state: " + (observed.state || "Not reported") + (observed.error ? " · " + observed.error : "")));
      root.append(group);
    }
  }
  async function mutate(body, draftKind, suffix = "", method = "PUT") {
    if (busy || closed) return;
    busy = true; failure = ""; remember({ body, suffix, method, draftKind });
    // Disable existing controls without losing focus/draft to a re-render.
    root.querySelectorAll("button,input").forEach(control => { control.disabled = true; });
    try {
      const result = await request(suffix, method, body);
      if (closed) return;
      if (!suffix) policy = result;
      if (draftKind) drafts.delete(draftKind);
      remember(null);
      await load();
    } catch (error) {
      if (closed) return;
      failure = error.message;
      if (error.status && error.status < 500) remember(null);
      if (draftKind && drafts.has(draftKind)) {
        drafts.get(draftKind).error = error.status === 409 ? "Policy changed. Your proposed interval is preserved; review before retrying." : error.message;
        drafts.get(draftKind).review = error.status === 409;
      }
      await load().catch(() => {});
    } finally { busy = false; if (!closed) render(true); }
  }
  async function load() {
    const current = await request();
    if (current.schema !== "exocortex.backup.policy.v1") throw new Error("The service-owned backup policy protocol is unavailable");
    policy = current;
  }
  async function refresh() {
    if (loading || busy || closed) return;
    if (pending) { await mutate(pending.body, pending.draftKind, pending.suffix, pending.method); return; }
    loading = true;
    try { await load(); failure = ""; }
    catch (error) { if (!closed) failure = error.message; }
    finally { loading = false; render(); }
  }
  void (async () => {
    if (pending?.body?.requestId && pending.method === "PUT" && pending.suffix === "")
      await mutate(pending.body, pending.draftKind, pending.suffix, pending.method);
    else await refresh();
  })();
  timer = setInterval(() => void refresh(), 5000);
  render();
  return () => { closed = true; clearInterval(timer); controllers.forEach(controller => controller.abort()); };
}
