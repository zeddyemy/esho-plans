import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getDocument, listDocuments } from "../lib/documents";
import { date, type AppEnv } from "../lib/env";
import { grantUrl } from "../lib/grants";
import { createKey } from "../lib/keys";
import { getProject, listProjects } from "../lib/projects";
import { inputText, RequestError, requiredFormText, sameOrigin } from "../lib/request";
import { clearSession, csrf, findSession, refreshSession, rememberReturnPath, validCsrf } from "../lib/sessions";
import { activeLink, changeLink, linkDetails, normalizePasscode, type LinkChange } from "../lib/shares";
import { OwnerReader, ProjectPage, ProjectsPage, PublishKeyPage, SettingsPage, SignIn } from "../views/pages";

export const owner = new Hono<AppEnv>();

owner.get("/", async (context) => {
  const session = await findSession(context);
  if (!session) return context.html(<SignIn />);
  context.set("owner", session);
  await refreshSession(context, session);
  return context.html(<ProjectsPage projects={await listProjects(context.env.DB)} csrf={await csrf(context)} />);
});

owner.use("*", async (context, next) => {
  const session = await findSession(context);
  if (!session) {
    rememberReturnPath(context);
    return context.redirect("/", 303);
  }
  context.set("owner", session);
  const method = context.req.method;
  if (method === "POST") {
    if (!sameOrigin(context)) return context.text("Forbidden", 403);
    const limit = bodyLimit({ maxSize: 8192, onError: (ctx) => ctx.text("Form is too large.", 413) });
    return limit(context, async () => {
      const body = await context.req.parseBody();
      if (!await validCsrf(context, requiredFormText(body, "_csrf"))) {
        context.res = context.text("Forbidden", 403);
        return;
      }
      await next();
    });
  }
  if (method !== "GET" && method !== "HEAD") return context.text("Method Not Allowed", 405);
  await refreshSession(context, session);
  await next();
});

owner.post("/auth/logout", async (context) => {
  await context.env.DB.prepare("UPDATE sessions SET revoked_at = ? WHERE id_hash = ? AND revoked_at IS NULL")
    .bind(date(), context.get("owner").idHash).run();
  clearSession(context);
  return context.redirect("/", 303);
});

owner.get("/p/:projectId", async (context) => {
  const { env } = context;
  const project = await getProject(env.DB, context.req.param("projectId"));
  if (!project) return context.notFound();
  const [documents, link] = await Promise.all([listDocuments(env.DB, project.id), activeLink(env.DB, project.id)]);
  return context.html(<ProjectPage project={project} documents={documents}
    link={await linkDetails(env, context.get("appOrigin"), link)} csrf={await csrf(context)} />);
});

owner.get("/p/:projectId/d/:docId", async (context) => {
  const { env } = context;
  const project = await getProject(env.DB, context.req.param("projectId"));
  const document = project && await getDocument(env.DB, project.id, context.req.param("docId"));
  if (!project || !document) return context.notFound();
  const content = context.get("contentOrigin");
  if (!content) return context.text("The document host is unavailable.", 503);
  const url = await grantUrl(env, content, document, { session: context.get("owner").idHash });
  return context.html(<OwnerReader project={project} document={document} url={url} />);
});

owner.post("/p/:projectId/link", async (context) => {
  const projectId = context.req.param("projectId");
  if (!await getProject(context.env.DB, projectId)) return context.notFound();
  const form = await context.req.parseBody();
  const action = requiredFormText(form, "action");
  let change: LinkChange;
  switch (action) {
    case "create":
    case "replace":
    case "revoke":
      change = { action };
      break;
    case "passcode":
      change = { action, passcode: normalizePasscode(requiredFormText(form, "passcode")) };
      break;
    case "no-passcode":
      change = { action: "passcode", passcode: null };
      break;
    default:
      return context.text("Unknown link action.", 400);
  }
  await changeLink(context.env, projectId, change);
  return context.redirect("/p/" + projectId, 303);
});

owner.get("/settings", async (context) => {
  const { env } = context;
  const [sessions, keys] = await Promise.all([
    env.DB.prepare("SELECT id_hash, user_agent, last_seen_at, expires_at FROM sessions WHERE revoked_at IS NULL AND expires_at > ? ORDER BY last_seen_at DESC")
      .bind(date()).all<{ id_hash: string; user_agent: string | null; last_seen_at: string; expires_at: string }>(),
    env.DB.prepare("SELECT id, name, prefix, last_used_at, expires_at FROM api_keys WHERE revoked_at IS NULL ORDER BY created_at DESC")
      .all<{ id: string; name: string; prefix: string; last_used_at: string | null; expires_at: string | null }>(),
  ]);
  return context.html(<SettingsPage sessions={sessions.results} keys={keys.results}
    current={context.get("owner").idHash} csrf={await csrf(context)} />);
});

owner.get("/cli/auth", async (context) => context.html(<PublishKeyPage csrf={await csrf(context)} />));

owner.post("/settings/keys", async (context) => {
  const form = await context.req.parseBody();
  const action = requiredFormText(form, "action");
  if (action === "revoke") {
    await context.env.DB.prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
      .bind(date(), requiredFormText(form, "key")).run();
    return context.redirect("/settings", 303);
  }
  if (action !== "create") return context.text("Unknown key action.", 400);
  const name = inputText(form.name, "Key name", 120);
  const expires = requiredFormText(form, "expires");
  let expiresAt: string | null = null;
  if (expires) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expires)) throw new RequestError(400, "Enter an expiry date.");
    const time = new Date(expires + "T23:59:59.999Z");
    if (!Number.isFinite(time.valueOf()) || time.toISOString().slice(0, 10) !== expires || time.valueOf() <= Date.now()) {
      throw new RequestError(400, "Expiry must be a future date.");
    }
    expiresAt = time.toISOString();
  }
  const key = await createKey(context, name, expiresAt);
  return context.html(<PublishKeyPage csrf={await csrf(context)} keyValue={key} />);
});

owner.post("/settings/sessions", async (context) => {
  const form = await context.req.parseBody();
  const current = context.get("owner").idHash;
  const action = requiredFormText(form, "action");
  if (action === "others") {
    await context.env.DB.prepare("UPDATE sessions SET revoked_at = ? WHERE id_hash <> ? AND revoked_at IS NULL")
      .bind(date(), current).run();
  } else if (action === "revoke") {
    const id = requiredFormText(form, "session");
    await context.env.DB.prepare("UPDATE sessions SET revoked_at = ? WHERE id_hash = ? AND revoked_at IS NULL")
      .bind(date(), id).run();
    if (id === current) {
      clearSession(context);
      return context.redirect("/", 303);
    }
  } else {
    return context.text("Unknown session action.", 400);
  }
  return context.redirect("/settings", 303);
});
