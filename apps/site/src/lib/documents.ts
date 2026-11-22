import { hash, randomToken } from "./crypto";
import { date, maxHtmlBytes } from "./env";
import { inputText, optionalText, RequestError } from "./request";

export type Visibility = "internal" | "shared";
export type DocumentMetadata = {
  id: string;
  project_id: string;
  doc_key: string;
  title: string;
  visibility: Visibility;
  content_hash: string;
  updated_at: string;
  bytes: number;
};

const fields = "id, project_id, doc_key, title, visibility, content_hash, updated_at, bytes";

export async function listDocuments(db: D1Database, projectId: string) {
  return (await db.prepare("SELECT " + fields + " FROM documents WHERE project_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC, id")
    .bind(projectId).all<DocumentMetadata>()).results;
}

export async function listClientDocuments(db: D1Database, projectId: string) {
  return (await db.prepare(`
    SELECT id, title, updated_at FROM documents
    WHERE project_id = ? AND deleted_at IS NULL AND visibility = 'shared'
    ORDER BY updated_at DESC, id
  `).bind(projectId).all<Pick<DocumentMetadata, "id" | "title" | "updated_at">>()).results;
}

export function getDocument(db: D1Database, projectId: string, documentId: string) {
  return db.prepare("SELECT " + fields + " FROM documents WHERE project_id = ? AND id = ? AND deleted_at IS NULL")
    .bind(projectId, documentId).first<DocumentMetadata>();
}

export function parseVisibility(input: unknown): Visibility {
  if (input === "internal" || input === "shared") return input;
  throw new RequestError(400, "Visibility must be internal or shared.");
}

export async function publish(db: D1Database, projectId: string, body: Record<string, unknown>) {
  const key = inputText(body.docKey, "Document path", 500);
  if (!key.endsWith(".html") || key.includes("\\") || key.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new RequestError(400, "Use an HTML path relative to .plans.");
  }
  const title = inputText(body.title, "Title", 300);
  if (typeof body.html !== "string" || !body.html.trim()) throw new RequestError(400, "HTML content is required.");
  const bytes = new TextEncoder().encode(body.html).byteLength;
  if (bytes > maxHtmlBytes) throw new RequestError(413, "HTML is limited to " + maxHtmlBytes + " bytes.");
  const visibility = body.visibility === undefined ? null : parseVisibility(body.visibility);
  const note = optionalText(body.note, "Change note", 500) ?? "Updated";
  const expectedHash = optionalText(body.expectedHash, "Expected content hash", 80);
  if (expectedHash && !/^sha256:[A-Za-z0-9_-]{43}$/.test(expectedHash)) throw new RequestError(400, "Invalid expected content hash.");
  const git = body.git;
  if (git != null && (typeof git !== "object" || Array.isArray(git))) throw new RequestError(400, "Invalid Git metadata.");
  const branch = optionalText((git as Record<string, unknown> | undefined)?.branch, "Git branch", 200);
  const commit = optionalText((git as Record<string, unknown> | undefined)?.commit, "Git commit", 64);
  const contentHash = "sha256:" + await hash(body.html);
  const id = "doc_" + randomToken(12);
  const changeId = "chg_" + randomToken(12);
  const now = date();

  // The first select observes the prior version inside the same transaction as the upsert.
  const [, wrote, , receipt] = await db.batch<DocumentMetadata & { overwrote: 0 | 1 }>([
    db.prepare(`
      INSERT INTO document_changes (id, document_id, note, content_hash, bytes, git_branch, git_commit, created_at)
      SELECT ?1, id, CASE WHEN ?4 IS NOT NULL AND content_hash <> ?4 THEN ?3 || ' (overwrote another published version)' ELSE ?3 END,
        ?2, ?5, ?6, ?7, ?8
      FROM documents WHERE project_id = ?9 AND doc_key = ?10 AND (content_hash <> ?2 OR deleted_at IS NOT NULL)
    `).bind(changeId, contentHash, note, expectedHash, bytes, branch, commit, now, projectId, key),
    db.prepare(`
      INSERT INTO documents (id, project_id, doc_key, title, visibility, content, content_hash, bytes, created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, COALESCE(?5, 'internal'), ?6, ?7, ?8, ?9, ?9)
      ON CONFLICT (project_id, doc_key) DO UPDATE SET
        title = excluded.title,
        visibility = COALESCE(?5, CASE WHEN documents.deleted_at IS NULL THEN documents.visibility ELSE 'internal' END),
        content = excluded.content, content_hash = excluded.content_hash, bytes = excluded.bytes,
        updated_at = excluded.updated_at, deleted_at = NULL
      WHERE documents.deleted_at IS NOT NULL OR documents.content_hash <> excluded.content_hash
        OR documents.title <> excluded.title OR (?5 IS NOT NULL AND documents.visibility <> ?5)
    `).bind(id, projectId, key, title, visibility, body.html, contentHash, bytes, now),
    db.prepare(`
      INSERT INTO document_changes (id, document_id, note, content_hash, bytes, git_branch, git_commit, created_at)
      SELECT ?1, id, ?2, content_hash, bytes, ?3, ?4, ?5 FROM documents WHERE id = ?6
    `).bind(changeId, note, branch, commit, now, id),
    db.prepare(`
      SELECT ${fields}, EXISTS (SELECT 1 FROM document_changes WHERE document_id = documents.id AND id = ?1 AND note = ?2) AS overwrote
      FROM documents WHERE project_id = ?3 AND doc_key = ?4
    `).bind(changeId, note + " (overwrote another published version)", projectId, key),
  ]);
  const row = receipt.results[0];
  if (!row) throw new Error("Document upsert did not return a row");
  const { overwrote, ...document } = row;
  return { document, changed: wrote.meta.changes !== 0, overwrote: overwrote === 1 };
}

export async function editDocument(db: D1Database, documentId: string, update: { visibility?: Visibility; title?: string; remove?: boolean }) {
  const now = date();
  return db.prepare(`
    UPDATE documents SET visibility = COALESCE(?1, visibility), title = COALESCE(?2, title),
      updated_at = ?3, deleted_at = CASE WHEN ?4 = 1 THEN ?3 ELSE NULL END
    WHERE id = ?5 AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM projects WHERE id = project_id AND archived_at IS NULL)
    RETURNING ${fields}
  `).bind(update.visibility ?? null, update.title ?? null, now, update.remove ? 1 : 0, documentId).first<DocumentMetadata>();
}

export function documentUrl(origin: string, projectId: string, documentId: string) {
  return origin + "/p/" + projectId + "/d/" + documentId;
}
