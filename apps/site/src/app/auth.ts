import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { hash, randomToken } from "../lib/crypto";
import { date, type AppEnv } from "../lib/env";
import { createSession, hostCookie, takeReturnPath } from "../lib/sessions";

const oauthCookie = "__Host-esho_oauth";
const oauthSeconds = 600;
const callbackPath = "/auth/github/callback";

export const auth = new Hono<AppEnv>();

auth.get("/github", async (context) => {
  const { env } = context;
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET || !env.OWNER_GITHUB_ID) {
    return context.text("GitHub sign-in is unavailable.", 503);
  }

  const state = randomToken();
  const browser = randomToken();
  const verifier = randomToken();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM oauth_attempts WHERE expires_at <= ?").bind(date()),
    env.DB.prepare("INSERT INTO oauth_attempts (state_hash, browser_hash, verifier, expires_at) VALUES (?, ?, ?, ?)")
      .bind(await hash(state), await hash(browser), verifier, date(oauthSeconds)),
  ]);
  setCookie(context, oauthCookie, browser, { ...hostCookie, maxAge: oauthSeconds });
  const url = new URL("https://github.com/login/oauth/authorize");
  url.search = new URLSearchParams({
    client_id: env.GITHUB_CLIENT_ID,
    redirect_uri: context.get("appOrigin") + callbackPath,
    state,
    scope: "",
    code_challenge_method: "S256",
    code_challenge: await hash(verifier),
  }).toString();
  return context.redirect(url.toString());
});

auth.get("/github/callback", async (context) => {
  const { env } = context;
  const browser = getCookie(context, oauthCookie);
  const state = context.req.query("state");
  const code = context.req.query("code");
  const tokenFormat = /^[A-Za-z0-9_-]{43}$/;
  if (!state || !browser || !tokenFormat.test(state) || !tokenFormat.test(browser) || !code || code.length > 300) {
    return context.text("Invalid or expired sign-in attempt.", 403);
  }
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
    return context.text("GitHub sign-in is unavailable.", 503);
  }
  const attempt = await env.DB.prepare(
    "DELETE FROM oauth_attempts WHERE state_hash = ? AND browser_hash = ? AND expires_at > ? RETURNING verifier",
  ).bind(await hash(state), await hash(browser), date()).first<{ verifier: string }>();
  if (!attempt) return context.text("Invalid or expired sign-in attempt.", 403);
  setCookie(context, oauthCookie, "", { ...hostCookie, maxAge: 0 });

  let profile: { id?: unknown };
  try {
    const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      redirect: "error",
      headers: { Accept: "application/json" },
      body: new URLSearchParams({
        client_id: env.GITHUB_CLIENT_ID,
        client_secret: env.GITHUB_CLIENT_SECRET,
        code,
        code_verifier: attempt.verifier,
        redirect_uri: context.get("appOrigin") + callbackPath,
      }),
    });
    const token = tokenResponse.ok ? await tokenResponse.json<{ access_token?: string }>() : null;
    if (!token?.access_token) return context.text("GitHub could not verify this sign-in.", 403);
    const userResponse = await fetch("https://api.github.com/user", {
      redirect: "error",
      headers: { Accept: "application/vnd.github+json", Authorization: "Bearer " + token.access_token, "User-Agent": "esho-plans" },
    });
    if (!userResponse.ok) return context.text("GitHub could not verify this sign-in.", 403);
    profile = await userResponse.json();
  } catch {
    return context.text("GitHub sign-in is temporarily unavailable.", 503);
  }
  if (typeof profile.id !== "number" || !Number.isSafeInteger(profile.id) || String(profile.id) !== env.OWNER_GITHUB_ID) {
    return context.text("This GitHub account does not have access.", 403);
  }
  await createSession(context, profile.id);
  return context.redirect(takeReturnPath(context), 303);
});
