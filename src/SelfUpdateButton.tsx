import { useEffect, useState } from "react";

type Job = { id: string; state: string; message?: string };
const key = "exocortex.updater.self-update";
export function SelfUpdateButton({ enabled, start, read }: { enabled: boolean; start: () => Promise<Job>; read: (id: string) => Promise<Job> }) {
  const [job, setJob] = useState<Job | undefined>(() => {
    const id = localStorage.getItem(key); return id && /^component-[a-f0-9]{32}$/.test(id) ? { id, state: "REQUESTED" } : undefined;
  });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const running = job !== undefined && !["COMPLETED", "FAILED"].includes(job.state);
  useEffect(() => {
    if (!job || !running) return;
    let stopped = false;
    const timer = setInterval(() => { void read(job.id).then(value => {
      if (stopped) return;
      setJob(value); if (["COMPLETED", "FAILED"].includes(value.state)) localStorage.removeItem(key);
    }).catch(() => { /* Agent restarts are expected during self-update. */ }); }, 1500);
    return () => { stopped = true; clearInterval(timer); };
  }, [job, read, running]);
  async function install() {
    setPending(true); setError("");
    try { const value = await start(); localStorage.setItem(key, value.id); setJob(value); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "Updater operation failed"); }
    finally { setPending(false); }
  }
  return <div><button className="button section-action" disabled={!enabled || pending || running} onClick={() => void install()}>Install latest signed Updater</button>{job ? <p role="status">{job.state}{job.message ? ` · ${job.message}` : ""}</p> : null}{error ? <p role="alert">{error}</p> : null}</div>;
}
