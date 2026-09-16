import { useEffect, useMemo, useRef, useState } from "react";

import packageInfo from "../package.json";
import { SearchField } from "./Ui";

type DocumentationSection = {
  title: string;
  paragraphs?: string[];
  bullets?: string[];
  code?: string;
  note?: string;
  table?: { headings: string[]; rows: string[][] };
};

type DocumentationArticle = {
  id: string;
  group: "Get started" | "Operate" | "Maintain";
  title: string;
  summary: string;
  keywords: string;
  sections: DocumentationSection[];
};

const articles: DocumentationArticle[] = [
  {
    id: "welcome",
    group: "Get started",
    title: "Welcome to Volt",
    summary: "A practical guide to operating the local, versioned secret store used by Exocortex services.",
    keywords: "introduction personal.volt offline local encrypted vault",
    sections: [
      { title: "What Volt stores", paragraphs: ["Volt stores entities in personal.volt. Each entity has a title, zero or more projects, and between 1 and 20 ordered key-value pairs. Every save creates an immutable revision."], bullets: ["Secret values are encrypted and masked in list responses.", "Plain values remain visible and searchable.", "Keys are labels for people; references resolve by value position."] },
      { title: "Portable by design", paragraphs: ["personal.volt is a portable encrypted SQLite container. A copy can be opened on another machine with its exact Access Key; a server device key is not required for offline recovery."], note: "Keep personal.volt and its Access Key in separate protected locations. Possession of both is sufficient to open the vault." },
    ],
  },
  {
    id: "access-key",
    group: "Get started",
    title: "Unlock and Access Key",
    summary: "Unlock Volt, rotate the operator key, and preserve its exact value.",
    keywords: "login unlock access key change rotate length spaces exact password",
    sections: [
      { title: "Unlock", paragraphs: ["Enter the Access Key on the unlock page. Volt does not trim, normalize, change case, truncate, or otherwise rewrite it. There is no minimum or maximum length, character-class rule, entropy rule, or placeholder denylist; the value only needs to be present."], note: "Leading spaces, trailing spaces, line breaks, and case are significant. Store and enter the exact same value." },
      { title: "Change the key", paragraphs: ["Open Settings → Security → Change Access Key. Enter the current value, the new value, and the confirmation. Rotation rewraps the portable master key and closes active sessions without re-encrypting every entity payload."], bullets: ["A mismatch leaves the existing key unchanged.", "An empty new value is rejected.", "After success, unlock again with the new exact value.", "On a server installation Volt also synchronizes the protected startup key file. If that file cannot be written, the key change still succeeds and Volt starts locked after a restart instead of rejecting the new key."] },
    ],
  },
  {
    id: "entries",
    group: "Operate",
    title: "Entries and values",
    summary: "Create, edit, reorder, reveal, and copy the data that belongs to an entity.",
    keywords: "vault entity entry key value secret plain copy reveal 20 drag reorder",
    sections: [
      { title: "Entity anatomy", table: { headings: ["Part", "Behavior"], rows: [["Title", "Required human-readable name."], ["Projects", "Optional grouping labels; one entity may belong to several projects."], ["Key", "Required decorative label; it does not participate in resolution."], ["Value", "The stored content resolved by its 1-based position."], ["Visibility", "Secret masks the value; Plain displays and indexes it."]] } },
      { title: "Work with values", paragraphs: ["An entity contains 1–20 values. Add or remove rows, edit their decorative keys, and drag the four-dot handle to change order. Alt+Arrow provides the keyboard reorder action."], note: "Reordering or deleting a value changes what an existing position-based reference resolves. Check dependent Kernel Register records before saving." },
      { title: "Secret copy behavior", paragraphs: ["Copy retrieves the real secret and writes it to the clipboard immediately without revealing it in the card. The stars remain visible and their count matches the stored character count. Reveal is a separate, explicit action and automatically hides again."], bullets: ["Clipboard success is reported only after the write completes.", "If clipboard access is unavailable, use Reveal and manual selection.", "Copying a reference never copies the decorative key."] },
    ],
  },
  {
    id: "projects-search",
    group: "Operate",
    title: "Projects and search",
    summary: "Group entities with project labels and filter bounded collections without changing stored data.",
    keywords: "project autocomplete suggestion search clear cross vault trash audit",
    sections: [
      { title: "Project suggestions", paragraphs: ["When you type in Projects, a matching known name appears inline in the same field. Press Tab or Right Arrow to accept it, then add the project. Add up to 20 unique project labels or leave the list empty. A single entity may appear under every project assigned to it."], bullets: ["The Vault project selector includes an entity when any assigned project matches.", "Search matches title, all projects, decorative keys, and plain values.", "Secret values are never searched."] },
      { title: "Clear a query", paragraphs: ["A non-empty search field shows a cross inside its right edge. Activate it with pointer or keyboard to clear the complete query and keep focus in the field. Escape performs the same action."], note: "Search is local, immediate, case-insensitive, and does not create audit events." },
    ],
  },
  {
    id: "kernel-register",
    group: "Operate",
    title: "Kernel Register references",
    summary: "Store references in Kernel while keeping actual values inside Volt.",
    keywords: "kernel register volt reference URI position resolve secret only value",
    sections: [
      { title: "Reference format", paragraphs: ["Every current value has a reference formed from the entity ID and its 1-based position."], code: "volt://<entry-id>/<value-position>\n\nvolt://77d4ddb0-c6b5-4e30-b541-b2bd28d11b86/1" },
      { title: "Resolution contract", paragraphs: ["Kernel sends the reference to Volt over the authenticated service endpoint. Volt returns only the stored value plus revision and visibility metadata. The decorative key is never included in the resolved value."], bullets: ["Valid positions are 1 through 20.", "The current revision and current ordering are authoritative.", "A missing entity or position fails resolution instead of returning another field."] },
    ],
  },
  {
    id: "revisions",
    group: "Operate",
    title: "Version history",
    summary: "Inspect earlier entity snapshots and restore one without destroying later history.",
    keywords: "revision history restore previous password snapshot comment",
    sections: [
      { title: "Automatic revisions", paragraphs: ["Every successful edit appends a revision containing the title, projects, ordered keys and values, visibility, and generator metadata. The current card shows only the latest revision."], bullets: ["Open Edit entry to find History inside the same card.", "Select a revision to preview its snapshot.", "Secret values in history are revealed only on request."] },
      { title: "Restore", paragraphs: ["Restoring an earlier snapshot creates a new current revision. The snapshot being replaced and every intermediate revision remain available, so rollback never erases history."], note: "A restore can also change reference results when the restored value order differs from the current order." },
    ],
  },
  {
    id: "trash",
    group: "Operate",
    title: "Trash and deletion",
    summary: "Recover deleted entities during retention or permanently erase them.",
    keywords: "trash delete retention days restore purge permanent settings",
    sections: [
      { title: "Recoverable deletion", paragraphs: ["Delete moves an entity and all of its revisions to Trash. The Trash card shows deletion time, scheduled permanent-deletion time, and remaining days."], bullets: ["Restore returns the entity unchanged to the Vault.", "The retention period is configured in Settings → Security.", "Shortening retention may immediately purge entities older than the new period."] },
      { title: "Permanent deletion", paragraphs: ["Delete now and automatic expiry remove every encrypted revision and the wrapped entity key from personal.volt. This action cannot be undone."], note: "Create and verify a backup before permanent deletion when the entity may be needed later." },
    ],
  },
  {
    id: "generators",
    group: "Operate",
    title: "Value generators",
    summary: "Generate passwords, identifiers, HMAC material, certificates, and RSA pairs.",
    keywords: "password entropy identifier HMAC certificate ECDSA P-256 RSA public private",
    sections: [
      { title: "Available formats", table: { headings: ["Generator", "Output"], rows: [["Password", "Chosen length and character sets; excludes double quote and @; displays entropy."], ["ID", "16 uppercase letters and digits."], ["HMAC", "Random key material in the selected size."], ["Certificate", "Self-signed ECDSA P-256 certificate plus private key."], ["RSA", "Private and public key values at the selected modulus size."]] } },
      { title: "Certificate scope", paragraphs: ["The certificate generator is for local TLS and testing. It creates a self-signed certificate, so browsers and public clients do not trust it automatically. Use a trusted certificate authority for public production endpoints."], note: "Certificate and RSA generation require two free value slots. Private-key output is secret; public certificate or key output may be plain." },
    ],
  },
  {
    id: "settings",
    group: "Maintain",
    title: "Settings and interface",
    summary: "Configure appearance, security, backup, updates, logs, and cryptography information.",
    keywords: "settings appearance accent sidebar security kernel reorder interface",
    sections: [
      { title: "Appearance", paragraphs: ["Accent changes preview immediately. Apply persists the selected color; Reset returns to the baseline accent before applying. Sidebar mode and the order of primary navigation, dashboard cards, entries, and Settings sections are stored as operator presentation state."], bullets: ["Enable Vault activity ranking to raise entries as they are opened, revealed, copied, or edited.", "Manual drag-and-drop remains available. A manual reorder clears accumulated activity scores and establishes the exact new baseline order.", "Disable ranking to use only the saved manual order."] },
      { title: "Security and Kernel", paragraphs: ["Security contains Access Key rotation, Trash retention, and the Kernel connection. The Kernel URL is probed before activation. The write-only service token can be replaced but is never returned to the interface."], bullets: ["Keep Volt and Kernel clocks synchronized.", "Expose Volt only through the trusted HTTPS reverse proxy.", "Do not place actual secret values in URLs, logs, or Register records."] },
    ],
  },
  {
    id: "backup-restore",
    group: "Maintain",
    title: "Backup and restore",
    summary: "Export portable data, create logical recovery archives, and restore verified state.",
    keywords: "backup restore ZIP personal.volt download Neptune mirror RESTORE recovery",
    sections: [
      { title: "Two recovery artifacts", table: { headings: ["Artifact", "Purpose"], rows: [["personal.volt", "Portable encrypted vault opened with its exact Access Key."], ["Volt backup ZIP", "Validated logical state, encrypted revisions, settings, audit data, and a portable snapshot for replace restore."]] } },
      { title: "Replace restore", paragraphs: ["Choose a trusted ZIP, review its metadata, provide the archive Access Key when recovering into a new vault, and enter RESTORE. A successful restore replaces local entries, revisions, settings, and audit events and closes sessions."], bullets: ["Failed inspection or unlock leaves the current state unchanged.", "Create a separate current backup before replacing state.", "Neptune can receive both scheduled ZIP backups and a personal.volt mirror."] },
      { title: "Pre-update protection", paragraphs: ["Before Volt asks the local Updater to apply a release, it builds a complete ZIP containing encrypted logical state and personal.volt. The archive is checksummed, transferred with the update request, verified before replacement, and retained by Updater for automatic rollback."], note: "If backup creation or transfer fails, Volt does not start the service update." },
    ],
  },
  {
    id: "audit-logs",
    group: "Maintain",
    title: "Audit and logs",
    summary: "Review redacted operator activity and download the bounded log archive.",
    keywords: "audit logs events time status redacted download archive filter",
    sections: [
      { title: "Audit page", paragraphs: ["Audit lists time, event, actor, target, and status. Search filters those metadata fields. Secret values are never placed in audit targets or details."], bullets: ["Reveal and resolve operations are recorded without their plaintext.", "The server enforces bounded audit retention.", "Success and failure remain textual as well as colored."] },
      { title: "Settings log stream", paragraphs: ["Settings → Logs shows a compact TYPE, BODY, TIME stream. The viewport is bounded; use the mouse wheel, touch, or keyboard to move through rows without a visible scrollbar. Download log archive creates a timestamped ZIP and keeps Settings open."] },
    ],
  },
  {
    id: "troubleshooting",
    group: "Maintain",
    title: "Troubleshooting",
    summary: "Recover safely from common unlock, clipboard, reference, and restore failures.",
    keywords: "error failure locked clipboard reference not found conflict recovery health",
    sections: [
      { title: "Common checks", table: { headings: ["Symptom", "Check"], rows: [["Access Key rejected", "Verify every character, including spaces and line breaks; do not trim the stored value."], ["Copy unavailable", "Use a secure focused browser context, then retry or explicitly Reveal for manual selection."], ["Reference fails", "Confirm the entity is not in Trash and the requested position still exists."], ["Edit conflict", "Close the editor, reload the current revision, and reapply the intended change."], ["Restore rejected", "Verify the ZIP, digest, and archive Access Key; the current state remains intact on failure."]] } },
      { title: "Service state", paragraphs: ["The liveness endpoint may remain available while a cold runtime is locked. Readiness becomes healthy only after personal.volt has been opened. Use the redacted audit stream and downloadable log archive for diagnosis; never paste secret values into an issue or log message."], code: "GET /health/live\nGET /api/v1/health" },
    ],
  },
];

function searchableText(article: DocumentationArticle) {
  return `${article.group} ${article.title} ${article.summary} ${article.keywords} ${JSON.stringify(article.sections)}`.toLocaleLowerCase("en-US");
}

export function DocumentationPage() {
  const [query, setQuery] = useState("");
  const [activeId, setActiveId] = useState(articles[0].id);
  const contentRef = useRef<HTMLDivElement>(null);
  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("en-US");
    return needle ? articles.filter((article) => searchableText(article).includes(needle)) : articles;
  }, [query]);
  const groups = (["Get started", "Operate", "Maintain"] as const)
    .map((group) => ({ group, articles: visible.filter((article) => article.group === group) }))
    .filter((group) => group.articles.length);

  useEffect(() => {
    if (contentRef.current) contentRef.current.scrollTop = 0;
    setActiveId(visible[0]?.id ?? "");
  }, [query, visible]);

  function navigateTo(articleId: string) {
    const owner = contentRef.current;
    const target = document.getElementById(`documentation-${articleId}`);
    if (!owner || !target) return;
    const top = owner.scrollTop + target.getBoundingClientRect().top - owner.getBoundingClientRect().top - 30;
    owner.scrollTo({
      top: Math.max(0, top),
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    });
    setActiveId(articleId);
  }

  function updateActiveArticle() {
    const owner = contentRef.current;
    if (!owner || !visible.length) return;
    const threshold = owner.getBoundingClientRect().top + 31;
    let next = visible[0].id;
    for (const article of visible) {
      const target = document.getElementById(`documentation-${article.id}`);
      if (!target || target.getBoundingClientRect().top > threshold) break;
      next = article.id;
    }
    setActiveId((current) => current === next ? current : next);
  }

  return <div className="page docs-page">
    <div className="docs-layout">
      <aside className="docs-navigation" aria-label="Documentation navigation">
        <SearchField label="Search documentation" value={query} onChange={setQuery} placeholder="Search documentation" />
        <nav aria-label="Documentation sections">
          {groups.map(({ group, articles: grouped }) => <section key={group}>
            <h2>{group}</h2>
            {grouped.map((article) => <button type="button" key={article.id} className={activeId === article.id ? "active" : ""} aria-current={activeId === article.id ? "location" : undefined} aria-controls={`documentation-${article.id}`} onClick={() => navigateTo(article.id)}>{article.title}</button>)}
          </section>)}
        </nav>
      </aside>
      <div className="docs-article" ref={contentRef} role="document" aria-label="Volt operator guide" tabIndex={0} onScroll={updateActiveArticle}>
        <header className="docs-guide-header">
          <div className="docs-kicker">Volt {packageInfo.version} / Operator guide</div>
          <h1>Volt Operator Guide</h1>
          <p>Versioned operating instructions for the local encrypted vault, its recovery paths, Kernel references, and service maintenance.</p>
        </header>
        {visible.length ? visible.map((article, articleIndex) => <article id={`documentation-${article.id}`} className="docs-topic" key={article.id} data-last={articleIndex === visible.length - 1 ? "true" : undefined}>
          <h2>{article.title}</h2>
          <p className="docs-summary">{article.summary}</p>
          {article.sections.map((section) => <section className="docs-subsection" key={section.title}>
            <h3>{section.title}</h3>
            {section.paragraphs?.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
            {section.bullets && <ul>{section.bullets.map((item) => <li key={item}>{item}</li>)}</ul>}
            {section.table && <div className="docs-table-wrap"><table><thead><tr>{section.table.headings.map((heading) => <th key={heading}>{heading}</th>)}</tr></thead><tbody>{section.table.rows.map((row) => <tr key={row.join("|")}>{row.map((cell, index) => <td key={`${index}-${cell}`}>{cell}</td>)}</tr>)}</tbody></table></div>}
            {section.code && <pre><code>{section.code}</code></pre>}
            {section.note && <aside className="docs-note"><strong>Note</strong><span>{section.note}</span></aside>}
          </section>)}
        </article>) : <section className="docs-no-results" aria-live="polite"><h2>No results</h2><p>Change the query. Search checks topic titles, summaries, keywords, and rendered body text.</p></section>}
      </div>
    </div>
  </div>;
}
