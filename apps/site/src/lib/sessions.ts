import type { Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { hash, mac, randomToken, verifyMac } from "./crypto";
import { date, sessionSeconds, type AppEnv, type OwnerSession } from "./env";

const sessionCookie = "__Host-esho_session";

export const hostCookie = {
  httpOnly: true,
  secure: true,
  sameSite: "Lax",
  path: "/",
} as const;

export async function createSession(context: Context<AppEnv>, ownerId: number) {
  const token = randomToken();
  const now = date();
  await context.env.DB.prepare(
    "INSERT INTO sessions (id_hash, github_user_id, user_agent, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).bind(await hash(token), ownerId, context.req.header("User-Agent")?.slice(0, 300) ?? null, now, now, date(sessionSeconds)).run();
  setCookie(context, sessionCookie, token, { ...hostCookie, maxAge: sessionSeconds });
}

export async function findSession(context: Context<AppEnv>): Promise<OwnerSession | null> {
  const token = getCookie(context, sessionCookie);
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const idHash = await hash(token);
  const row = await context.env.DB.prepare(
    "SELECT last_seen_at, expires_at FROM sessions WHERE id_hash = ? AND github_user_id = ? AND revoked_at IS NULL AND expires_at > ?",
  ).bind(idHash, Number(context.env.OWNER_GITHUB_ID), date()).first<{ last_seen_at: string; expires_at: string }>();
  if (!row) return null;
  return { token, idHash, lastSeenAt: row.last_seen_at, expiresAt: row.expires_at };
}

export async function refreshSession(context: Context<AppEnv>, session: OwnerSession) {
  const cutoff = date(-86400);
  if (session.lastSeenAt > cutoff) return;
  const now = date();
  const result = await context.env.DB.prepare(
    "UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id_hash = ? AND revoked_at IS NULL AND expires_at > ? AND last_seen_at <= ?",
  ).bind(now, date(sessionSeconds), session.idHash, now, cutoff).run();
  if (result.meta.changes) setCookie(context, sessionCookie, session.token, { ...hostCookie, maxAge: sessionSeconds });
}

export function clearSession(context: Context<AppEnv>) {
  setCookie(context, sessionCookie, "", { ...hostCookie, maxAge: 0 });
}

export function csrf(context: Context<AppEnv>) {
  return mac(context.env.SESSION_KEY, "csrf:" + context.get("owner").token);
}

export function validCsrf(context: Context<AppEnv>, submitted: string) {
  return verifyMac(context.env.SESSION_KEY, "csrf:" + context.get("owner").token, submitted);
}

const returnCookie = "__Host-esho_return";
const returnPath = /^\/(?:settings|cli\/auth|p\/prj_[A-Za-z0-9_-]{16}(?:\/d\/doc_[A-Za-z0-9_-]{16})?)$/;

// Signing in returns the owner to the page they asked for. Only fixed owner paths qualify, so this cannot redirect off-site.
export function rememberReturnPath(context: Context<AppEnv>) {
  if (context.req.method === "GET" && returnPath.test(context.req.path)) {
    setCookie(context, returnCookie, context.req.path, { ...hostCookie, maxAge: 600 });
  }
}

export function takeReturnPath(context: Context<AppEnv>) {
  const path = getCookie(context, returnCookie);
  if (path === undefined) return "/";
  setCookie(context, returnCookie, "", { ...hostCookie, maxAge: 0 });
  return returnPath.test(path) ? path : "/";
}
