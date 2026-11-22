import { seal, unseal } from "./crypto";
import type { DocumentMetadata } from "./documents";
import { date, type Bindings } from "./env";
import type { ShareLink } from "./shares";

type Audience = { session: string } | { link: string; version: number };
type Grant = {
  doc: string;
  hash: string;
  exp: number;
  audience: Audience;
};

export async function grantUrl(env: Bindings, contentOrigin: string, document: DocumentMetadata, audience: Audience) {
  const grant: Grant = { doc: document.id, hash: document.content_hash, exp: Date.now() + 300_000, audience };
  return contentOrigin + "/c/" + await seal(env.GRANT_KEY, grant);
}

export function shareAudience(link: ShareLink) {
  return { link: link.id, version: link.policy_version };
}

export async function grantedDocument(env: Bindings, token: string) {
  const claims = await unseal<Grant>(env.GRANT_KEY, token);
  if (!claims || claims.exp <= Date.now() || !claims.doc || !claims.hash || !claims.audience) return null;

  const documentFilter = `
    FROM documents d JOIN projects p ON p.id = d.project_id
    WHERE d.id = ?1 AND d.content_hash = ?2 AND d.deleted_at IS NULL AND p.archived_at IS NULL
  `;
  const audience = claims.audience;
  const query = "session" in audience
    ? env.DB.prepare(`
      SELECT d.content ${documentFilter}
      AND EXISTS (SELECT 1 FROM sessions WHERE id_hash = ?3 AND github_user_id = ?4 AND expires_at > ?5 AND revoked_at IS NULL)
    `).bind(claims.doc, claims.hash, audience.session, Number(env.OWNER_GITHUB_ID), date())
    : env.DB.prepare(`
      SELECT d.content ${documentFilter}
      AND d.visibility = 'shared'
      AND EXISTS (SELECT 1 FROM share_links WHERE id = ?3 AND policy_version = ?4
        AND project_id = d.project_id AND revoked_at IS NULL)
    `).bind(claims.doc, claims.hash, audience.link, audience.version);
  const document = await query.first<{ content: string }>();
  return document && { html: document.content };
}
