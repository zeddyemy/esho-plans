import type { Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { decryptToken, encryptToken, hash, mac, randomToken, seal, unseal, verifyMac } from "./crypto";
import { date, type AppEnv, type Bindings } from "./env";
import { inputText, RequestError } from "./request";

export type ShareLink = {
  id: string;
  project_id: string;
  token_enc: string;
  passcode_mac: string | null;
  policy_version: number;
  failed_attempts: number;
  locked_until: string | null;
  last_used_at: string | null;
};

export type LinkChange = { action: "create" | "replace" | "revoke" | "passcode"; passcode?: string | null };

export function activeLink(db: D1Database, projectId: string) {
  return db.prepare("SELECT * FROM share_links WHERE project_id = ? AND revoked_at IS NULL").bind(projectId).first<ShareLink>();
}

export async function findLink(db: D1Database, token: string) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  return db.prepare(`
    SELECT l.*, p.name AS project_name FROM share_links l JOIN projects p ON p.id = l.project_id
    WHERE l.token_hash = ? AND l.revoked_at IS NULL AND p.archived_at IS NULL
  `).bind(await hash(token)).first<ShareLink & { project_name: string }>();
}

export async function linkDetails(env: Bindings, origin: string, link: ShareLink | null) {
  if (!link) return null;
  return {
    url: origin + "/s/" + await decryptToken(env.LINK_ENC_KEY, link.token_enc, link.id),
    requiresPasscode: link.passcode_mac !== null,
    lastUsedAt: link.last_used_at,
  };
}

function passcodeInput(projectId: string, passcode: string) {
  return "passcode:" + projectId + "\0" + passcode;
}

export function normalizePasscode(input: unknown) {
  return input === null ? null : inputText(input, "Passcode", 128);
}

export async function changeLink(env: Bindings, projectId: string, change: LinkChange) {
  const { DB } = env;
  if (change.action === "revoke") {
    await DB.prepare("UPDATE share_links SET revoked_at = ? WHERE project_id = ? AND revoked_at IS NULL")
      .bind(date(), projectId).run();
    return null;
  }
  const requestedMac = typeof change.passcode === "string"
    ? await mac(env.PASSCODE_PEPPER, passcodeInput(projectId, change.passcode))
    : change.passcode;

  if (change.action === "passcode") {
    const link = await DB.prepare(`
      UPDATE share_links SET passcode_mac = ?, policy_version = policy_version + 1, failed_attempts = 0, locked_until = NULL
      WHERE project_id = ? AND revoked_at IS NULL RETURNING *
    `).bind(requestedMac ?? null, projectId).first<ShareLink>();
    if (!link) throw new RequestError(409, "Create a client link before setting its passcode.");
    return link;
  }

  const id = "lnk_" + randomToken(12);
  const token = randomToken();
  const tokenHash = await hash(token);
  const encrypted = await encryptToken(env.LINK_ENC_KEY, token, id);
  const now = date();
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await activeLink(DB, projectId);
    if (current && change.action === "create") return current;
    if (current) {
      const [, inserted] = await DB.batch<ShareLink>([
        DB.prepare("UPDATE share_links SET revoked_at = ? WHERE id = ? AND policy_version = ? AND revoked_at IS NULL")
          .bind(now, current.id, current.policy_version),
        DB.prepare(`
          INSERT INTO share_links (id, project_id, token_hash, token_enc, passcode_mac, created_at)
          SELECT ?, project_id, ?, ?, ?, ? FROM share_links
          WHERE id = ? AND revoked_at = ? AND policy_version = ?
            AND NOT EXISTS (SELECT 1 FROM share_links active WHERE active.project_id = ? AND active.revoked_at IS NULL)
          RETURNING *
        `).bind(id, tokenHash, encrypted, requestedMac === undefined ? current.passcode_mac : requestedMac, now,
          current.id, now, current.policy_version, projectId),
      ]);
      if (inserted.results[0]) return inserted.results[0];
    } else {
      const inserted = await DB.prepare(`
        INSERT INTO share_links (id, project_id, token_hash, token_enc, passcode_mac, created_at)
        VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(project_id) WHERE revoked_at IS NULL DO NOTHING RETURNING *
      `).bind(id, projectId, tokenHash, encrypted, requestedMac ?? null, now).first<ShareLink>();
      if (inserted) return inserted;
    }
  }
  throw new RequestError(409, "The client link changed. Try again.");
}

export function previewBot(context: Context<AppEnv>) {
  return /Slackbot|Discordbot|WhatsApp|facebookexternalhit|Twitterbot|TelegramBot|LinkedInBot|SkypeUriPreview/i
    .test(context.req.header("User-Agent") ?? "");
}

export async function markOpened(db: D1Database, link: ShareLink) {
  const cutoff = date(-60);
  if (link.last_used_at && link.last_used_at > cutoff) return;
  await db.prepare(`
    UPDATE share_links SET last_used_at = ? WHERE id = ? AND revoked_at IS NULL AND (last_used_at IS NULL OR last_used_at <= ?)
  `).bind(date(), link.id, cutoff).run();
}

function unlockCookie(link: ShareLink) {
  return "esho_unlock_" + link.id;
}

type Unlock = { link: string; v: number; exp: number };

export async function isUnlocked(context: Context<AppEnv>, link: ShareLink) {
  if (!link.passcode_mac) return true;
  const grant = await unseal<Unlock>(context.env.PASSCODE_PEPPER, getCookie(context, unlockCookie(link)));
  return !!grant && grant.link === link.id && grant.v === link.policy_version && grant.exp > Date.now();
}

export function unlockCsrf(context: Context<AppEnv>, link: ShareLink) {
  return mac(context.env.PASSCODE_PEPPER, "unlock:" + link.id + ":" + link.policy_version);
}

export function validUnlockCsrf(context: Context<AppEnv>, link: ShareLink, proof: string) {
  return verifyMac(context.env.PASSCODE_PEPPER, "unlock:" + link.id + ":" + link.policy_version, proof);
}

export async function tryUnlock(context: Context<AppEnv>, link: ShareLink, token: string, passcode: string) {
  const now = date();
  if (!link.passcode_mac) return "unlocked";
  if (link.locked_until && link.locked_until > now) return "locked";
  const correct = passcode.length <= 128
    && await verifyMac(context.env.PASSCODE_PEPPER, passcodeInput(link.project_id, passcode.trim()), link.passcode_mac);
  if (!correct) {
    const attempts = await context.env.DB.prepare(`
      UPDATE share_links SET
        failed_attempts = CASE WHEN locked_until IS NULL THEN failed_attempts + 1 ELSE 1 END,
        locked_until = CASE WHEN locked_until IS NULL AND failed_attempts >= 4 THEN ?1 ELSE NULL END
      WHERE id = ?2 AND revoked_at IS NULL AND policy_version = ?3 AND (locked_until IS NULL OR locked_until <= ?4)
      RETURNING locked_until
    `).bind(date(900), link.id, link.policy_version, now).first<{ locked_until: string | null }>();
    return !attempts || attempts.locked_until ? "locked" : "incorrect";
  }
  const result = await context.env.DB.prepare(`
    UPDATE share_links SET failed_attempts = 0, locked_until = NULL
    WHERE id = ? AND revoked_at IS NULL AND policy_version = ? AND (locked_until IS NULL OR locked_until <= ?)
  `).bind(link.id, link.policy_version, now).run();
  if (!result.meta.changes) return "locked";
  const seconds = 12 * 3600;
  const value = await seal(context.env.PASSCODE_PEPPER, { link: link.id, v: link.policy_version, exp: Date.now() + seconds * 1000 });
  setCookie(context, unlockCookie(link), value, {
    httpOnly: true, secure: true, sameSite: "Lax", path: "/s/" + token, maxAge: seconds,
  });
  return "unlocked";
}
