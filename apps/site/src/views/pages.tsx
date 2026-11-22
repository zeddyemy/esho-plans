import type { Child } from "hono/jsx";
import { sandbox } from "../lib/env";
import type { DocumentMetadata } from "../lib/documents";
import type { Project } from "../lib/projects";

type Details = { url: string; requiresPasscode: boolean; lastUsedAt: string | null };
type ListedProject = Project & { document_count: number; updated_at: string; link_active: 0 | 1 };

export function Page({ title, children, reader, owner, client }: {
  title: string; children?: Child; reader?: boolean; owner?: boolean; client?: boolean;
}) {
  const preview = "Shared documents · Emmanuel Olowu";
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex, nofollow, noarchive" />
        <meta name="color-scheme" content="dark" />
        {client && <meta property="og:title" content={preview} />}
        {client && <meta property="og:description" content="Shared documents" />}
        {client && <meta name="twitter:title" content={preview} />}
        <title>{client ? preview : title + " · Esho Plans"}</title>
        <link rel="icon" href="/icon.png" type="image/png" />
        {owner && <link rel="manifest" href="/manifest.webmanifest" />}
        <link rel="stylesheet" href="/app.css" />
        <script type="module" src="/app.js" />
      </head>
      <body class={reader ? "reader" : undefined}>{children}</body>
    </html>
  );
}

function DateText({ value }: { value: string }) {
  const parsed = new Date(value);
  return <time dateTime={value}>{parsed.toISOString().slice(0, 10)}</time>;
}

function OwnerNav({ csrf }: { csrf: string }) {
  return <header class="masthead">
    <a class="wordmark" href="/">Esho Plans</a>
    <nav aria-label="Account">
      <a href="/settings">Settings</a>
      <form method="post" action="/auth/logout">
        <input type="hidden" name="_csrf" value={csrf} />
        <button type="submit" class="text-button">Sign out</button>
      </form>
    </nav>
  </header>;
}

function Filter({ label }: { label: string }) {
  return <label class="filter">{label}<input type="search" aria-controls="document-list" data-list-filter placeholder="Type to filter" /></label>;
}

export function SignIn() {
  return <Page title="Sign in">
    <main class="sign-in">
      <h1>Esho Plans</h1>
      <a class="button primary" href="/auth/github">Sign in with GitHub</a>
    </main>
  </Page>;
}

export function ProjectsPage({ projects, csrf }: { projects: ListedProject[]; csrf: string }) {
  return <Page title="Projects" owner>
    <div class="page">
      <OwnerNav csrf={csrf} />
      <main>
        <h1>Projects</h1>
        {projects.length ? <>
          <Filter label="Filter projects" />
          <ul class="entries" id="document-list">{projects.map((project) =>
            <li>
              <a href={"/p/" + project.id}>{project.name}</a>
              <span class="meta">{project.document_count} {project.document_count === 1 ? "document" : "documents"} · {project.link_active ? "Link active" : "Private"} · <DateText value={project.updated_at} /></span>
            </li>
          )}</ul>
          <p class="muted" data-empty-filter hidden>No projects match this filter.</p>
        </> : <p class="muted">Publish a plan with the CLI to create your first project.</p>}
      </main>
    </div>
  </Page>;
}

function LinkForm({ action, project, csrf, label }: { action: string; project: Project; csrf: string; label: string }) {
  return <form method="post" action={"/p/" + project.id + "/link"}>
    <input type="hidden" name="_csrf" value={csrf} />
    <button name="action" value={action}>{label}</button>
  </form>;
}

export function ProjectPage({ project, documents, link, csrf }: {
  project: Project; documents: DocumentMetadata[]; link: Details | null; csrf: string;
}) {
  return <Page title={project.name} owner>
    <div class="page">
      <OwnerNav csrf={csrf} />
      <main>
        <p class="back"><a href="/">All projects</a></p>
        <h1>{project.name}</h1>
        <section class="share" aria-label="Client link">
          <h2>Client link</h2>
          {link ? <>
            <div class="copy-row">
              <input id="client-url" type="url" readOnly value={link.url} aria-label="Client link" />
              <button type="button" data-copy="client-url">Copy link</button>
            </div>
            <p class="muted">{link.requiresPasscode ? "Passcode required" : "Link access"} · {link.lastUsedAt ? <>Last opened <DateText value={link.lastUsedAt} /></> : "Never opened"}</p>
            <div class="actions">
              <LinkForm action="replace" project={project} csrf={csrf} label="Replace link" />
              <LinkForm action="revoke" project={project} csrf={csrf} label="Turn off link" />
            </div>
            <details>
              <summary>Passcode</summary>
              <form method="post" action={"/p/" + project.id + "/link"}>
                <input type="hidden" name="_csrf" value={csrf} />
                <label>New passcode<input name="passcode" type="password" required maxLength={128} autoComplete="new-password" /></label>
                <button name="action" value="passcode">Set passcode</button>
              </form>
              {link.requiresPasscode && <LinkForm action="no-passcode" project={project} csrf={csrf} label="Remove passcode" />}
            </details>
          </> : <LinkForm action="create" project={project} csrf={csrf} label="Create client link" />}
          <span role="status" data-copy-status class="muted" />
        </section>
        <h2>Documents</h2>
        {documents.length ? <>
          <Filter label="Filter documents" />
          <ul class="entries" id="document-list">{documents.map((document) =>
            <li>
              <a href={"/p/" + project.id + "/d/" + document.id}>{document.title}</a>
              <span class="meta"><span data-visibility={document.visibility}>{document.visibility === "shared" ? "Shared" : "Internal"}</span> · <DateText value={document.updated_at} /></span>
            </li>
          )}</ul>
          <p class="muted" data-empty-filter hidden>No documents match this filter.</p>
        </> : <p class="muted">There are no documents in this project.</p>}
      </main>
    </div>
  </Page>;
}

// The reader is the document and nothing else. One small link leads back to the project.
export function OwnerReader({ project, document, url }: { project: Project; document: DocumentMetadata; url: string }) {
  return <Page title={document.title} reader owner>
    <iframe title={document.title} src={url} sandbox={sandbox} referrerPolicy="no-referrer" />
    <a class="reader-home" href={"/p/" + project.id}>{project.name}</a>
  </Page>;
}

export function ClientPage({ name, token, documents }: {
  name: string; token: string; documents: Pick<DocumentMetadata, "id" | "title" | "updated_at">[];
}) {
  return <Page title="Shared documents" client>
    <div class="page client">
      <header class="masthead"><span class="wordmark">Emmanuel Olowu</span></header>
      <main>
        <h1>{name}</h1>
        {documents.length ? <ul class="entries">{documents.map((document) =>
          <li>
            <a href={"/s/" + token + "/d/" + document.id}>{document.title}</a>
            <span class="meta"><DateText value={document.updated_at} /></span>
          </li>
        )}</ul> : <p class="muted">No documents have been shared yet.</p>}
      </main>
      <footer>Shared with you by Emmanuel Olowu.</footer>
    </div>
  </Page>;
}

export function ClientReader({ title, token, url }: { title: string; token: string; url: string }) {
  return <Page title="Shared document" client reader>
    <iframe title={title} src={url} sandbox={sandbox} referrerPolicy="no-referrer" />
    <a class="reader-home" href={"/s/" + token}>Shared documents</a>
  </Page>;
}

export function Preview() {
  return <Page title="Shared documents" client><main class="page"><h1>Shared documents</h1></main></Page>;
}

export function PasscodePage({ token, csrf, documentId, message }: {
  token: string; csrf: string; documentId?: string; message?: string;
}) {
  return <Page title="Enter passcode" client>
    <main class="page narrow">
      <p class="wordmark">Emmanuel Olowu</p>
      <h1>Enter passcode</h1>
      {message && <p role="alert">{message}</p>}
      <form method="post" action={"/s/" + token + "/unlock"}>
        <input type="hidden" name="_csrf" value={csrf} />
        {documentId && <input type="hidden" name="document" value={documentId} />}
        <label>Passcode<input name="passcode" type="password" required maxLength={128} autoComplete="current-password" /></label>
        <button class="primary">Open shared documents</button>
      </form>
    </main>
  </Page>;
}

type SessionRow = { id_hash: string; user_agent: string | null; last_seen_at: string; expires_at: string };
type KeyRow = { id: string; name: string; prefix: string; last_used_at: string | null; expires_at: string | null };

export function SettingsPage({ sessions, current, keys, csrf }: {
  sessions: SessionRow[]; current: string; keys: KeyRow[]; csrf: string;
}) {
  return <Page title="Settings" owner>
    <div class="page">
      <OwnerNav csrf={csrf} />
      <main>
        <h1>Settings</h1>
        <h2>Publish keys</h2>
        <p><a href="/cli/auth">Create publish key</a></p>
        <ul class="settings-list">{keys.map((key) => <li>
          <div><strong>{key.name}</strong> <code>{key.prefix}</code></div>
          <div class="muted">{key.last_used_at ? <>Last used <DateText value={key.last_used_at} /></> : "Never used"}{key.expires_at && <> · Expires <DateText value={key.expires_at} /></>}</div>
          <form method="post" action="/settings/keys">
            <input type="hidden" name="_csrf" value={csrf} />
            <input type="hidden" name="key" value={key.id} />
            <button name="action" value="revoke">Revoke key</button>
          </form>
        </li>)}</ul>
        <h2>Sessions</h2>
        <ul class="settings-list">{sessions.map((session) => <li>
          <div><strong>{session.id_hash === current ? "This device" : "Device"}</strong></div>
          <div class="muted">{session.user_agent ?? "Unknown browser"}</div>
          <div class="muted">Last seen <DateText value={session.last_seen_at} /> · Expires <DateText value={session.expires_at} /></div>
          <form method="post" action="/settings/sessions">
            <input type="hidden" name="_csrf" value={csrf} />
            <input type="hidden" name="session" value={session.id_hash} />
            <button name="action" value="revoke">End session</button>
          </form>
        </li>)}</ul>
        <form method="post" action="/settings/sessions">
          <input type="hidden" name="_csrf" value={csrf} />
          <button name="action" value="others">End other sessions</button>
        </form>
      </main>
    </div>
  </Page>;
}

export function PublishKeyPage({ csrf, keyValue }: { csrf: string; keyValue?: string }) {
  return <Page title="Publish key" owner>
    <main class="page narrow">
      <p class="back"><a href="/settings">Settings</a></p>
      <h1>{keyValue ? "Your publish key" : "Create publish key"}</h1>
      {keyValue ? <>
        <p>Copy this key into the CLI. This page displays it once.</p>
        <div class="copy-row">
          <input id="publish-key" type="password" readOnly value={keyValue} aria-label="Publish key" />
          <button type="button" data-copy="publish-key">Copy key</button>
        </div>
        <span role="status" data-copy-status class="muted" />
      </> : <form method="post" action="/settings/keys">
        <input type="hidden" name="_csrf" value={csrf} />
        <label>Key name<input name="name" required maxLength={120} placeholder="Laptop" /></label>
        <label>Expiry date (optional)<input name="expires" type="date" /></label>
        <button class="primary" name="action" value="create">Create key</button>
      </form>}
    </main>
  </Page>;
}
