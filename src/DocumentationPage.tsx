import { useMemo, useState } from "react";

import { Icon } from "./icons";

const articles = [
  { id: "personal-volt", title: "How personal.volt works", body: "personal.volt is a portable encrypted container. The Access Key unlocks the master key, while entries are protected by individual data keys. The file can be saved for a future offline client." },
  { id: "kernel-register", title: "Kernel Register references", body: "Every value has a reference in the form volt://<entry-id>/<value-position>. Positions start at 1 and follow the current value order. Register stores this reference instead of a plaintext secret or a path to an .env file." },
  { id: "revisions", title: "Entry revisions", body: "Every save creates a new revision. Previous values are available only inside the expanded card and never appear in the standard preview. Restoring an earlier snapshot creates another revision without destroying the current history." },
  { id: "trash", title: "Trash and permanent deletion", body: "Deleting an entity moves it to Trash, where its encrypted revisions remain recoverable for the period configured in Settings (30 days by default). Restore returns the unchanged entity to the end of the vault. Delete now, or automatic expiry, removes every revision and the wrapped entity key from personal.volt and cannot be undone." },
  { id: "interface", title: "Interface and ordering", body: "The accent and sidebar mode are configured in Settings. Primary navigation items, dashboard cards, entries, and Settings sections can be moved using the four-dot handle; Alt+Arrow provides the same keyboard action. The order is stored in personal.volt." },
  { id: "security", title: "Security and Kernel", body: "Changing the Access Key requires the current key, a new key, and confirmation, then closes active sessions. The Kernel URL is verified before activation. The Kernel token is entered only when replacing it and is never returned to the interface." },
  { id: "backups", title: "Backups", body: "personal.volt supports independent transfer. A ZIP backup is designed for verified restoration of server state and delivery to Neptune. Restore replaces the state and requires the explicit word RESTORE." },
  { id: "updates-logs", title: "Updates and logs", body: "The update check shows the installed version and availability of the trusted local Updater, but never starts installation without a separate action. Logs provide a limited redacted audit stream; the archive is downloaded as a timestamped ZIP." },
  { id: "generators", title: "Generators", body: "Volt generates passwords, 16-character identifiers, HMAC keys, certificates, and RSA pairs. The certificate option creates a self-signed ECDSA P-256 certificate for local TLS or testing, plus its private key; it is not automatically trusted by browsers or public certificate authorities. Password entropy is calculated and displayed; double quote and @ characters are excluded." },
];

export function DocumentationPage() {
  const [query, setQuery] = useState("");
  const visible = useMemo(() => articles.filter((article) => `${article.title} ${article.body}`.toLowerCase().includes(query.toLowerCase())), [query]);
  return <div className="page docs-page">
    <div className="docs-layout"><aside className="docs-navigation"><label className="search"><Icon name="search" /><input aria-label="Search documentation" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search" /></label><nav aria-label="Documentation sections">{visible.map((article, index) => <a key={article.id} href={`#doc-${article.id}`}><span>{String(index + 1).padStart(2, "0")}</span>{article.title}</a>)}</nav></aside><article className="docs-article"><header><span className="eyebrow">VOLT OPERATOR GUIDE · V1</span><p>Versioned guidance for the current interface and local storage model.</p></header>{visible.length ? visible.map((article) => <section id={`doc-${article.id}`} key={article.id}><h2>{article.title}</h2><p>{article.body}</p>{article.id === "personal-volt" && <aside className="docs-note">Keep the file and Access Key separate. For unattended server startup, the device key remains a separate server secret.</aside>}{article.id === "kernel-register" && <pre><code>{`volt://<entry-id>/<value-position>`}</code></pre>}</section>) : <section><h2>No results</h2><p>Change your query. Search checks article titles and full text.</p></section>}</article></div>
  </div>;
}
