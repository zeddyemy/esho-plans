import { randomToken } from "./crypto";
import { date } from "./env";

export type Project = {
  id: string;
  name: string;
  workspace_hint: string | null;
  repo_hint: string | null;
  created_at: string;
};

export async function listProjects(db: D1Database) {
  return (await db.prepare(`
    SELECT p.id, p.name, p.workspace_hint, p.repo_hint, p.created_at,
      COUNT(d.id) AS document_count, COALESCE(MAX(d.updated_at), p.created_at) AS updated_at,
      EXISTS(SELECT 1 FROM share_links l WHERE l.project_id = p.id AND l.revoked_at IS NULL) AS link_active
    FROM projects p
    LEFT JOIN documents d ON d.project_id = p.id AND d.deleted_at IS NULL
    WHERE p.archived_at IS NULL
    GROUP BY p.id
    ORDER BY updated_at DESC, p.id
  `).all<Project & { document_count: number; updated_at: string; link_active: 0 | 1 }>()).results;
}

export function getProject(db: D1Database, projectId: string) {
  return db.prepare("SELECT id, name, workspace_hint, repo_hint, created_at FROM projects WHERE id = ? AND archived_at IS NULL")
    .bind(projectId).first<Project>();
}

export async function createProject(db: D1Database, name: string, workspace: string | null, repo: string | null, createKey: string | null) {
  const id = "prj_" + randomToken(12);
  const row = await db.prepare(`
    INSERT INTO projects (id, name, workspace_hint, repo_hint, create_key, created_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (create_key) DO UPDATE SET create_key = excluded.create_key
    RETURNING id, name, workspace_hint, repo_hint, created_at
  `).bind(id, name, workspace, repo, createKey, date()).first<Project>();
  if (!row) throw new Error("Project insert did not return a row");
  return row;
}
