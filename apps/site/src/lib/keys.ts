import type { Context } from "hono";
import { mac, randomToken, verifyMac } from "./crypto";
import { date, type AppEnv } from "./env";

type Key = { id: string; name: string; prefix: string; key_hash: string; last_used_at: string | null };

export async function authenticateKey(context: Context<AppEnv>) {
  const token = /^Bearer (epk_[A-Za-z0-9_-]{43})$/i.exec(context.req.header("Authorization") ?? "")?.[1];
  if (!token) return null;
  const { DB, KEY_PEPPER } = context.env;
  const candidates = await DB.prepare(`
    SELECT id, name, prefix, key_hash, last_used_at FROM api_keys
    WHERE prefix = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
  `).bind(token.slice(0, 11), date()).all<Key>();
  for (const key of candidates.results) {
    if (await verifyMac(KEY_PEPPER, token, key.key_hash)) {
      if (!key.last_used_at || key.last_used_at <= date(-60)) {
        await DB.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ? AND revoked_at IS NULL").bind(date(), key.id).run();
      }
      return key;
    }
  }
  return null;
}

export async function createKey(context: Context<AppEnv>, name: string, expiresAt: string | null) {
  const { DB, KEY_PEPPER } = context.env;
  const key = "epk_" + randomToken();
  await DB.prepare("INSERT INTO api_keys (id, name, prefix, key_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind("key_" + randomToken(12), name, key.slice(0, 11), await mac(KEY_PEPPER, key), date(), expiresAt).run();
  return key;
}
