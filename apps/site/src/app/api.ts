import { Hono } from "hono";
import { documentUrl, editDocument, listDocuments, parseVisibility, publish } from "../lib/documents";
import { maxHtmlBytes, type AppEnv } from "../lib/env";
import { authenticateKey } from "../lib/keys";
import { createProject, getProject, listProjects } from "../lib/projects";
import { inputText, jsonObject, optionalText, RequestError } from "../lib/request";
import { activeLink, changeLink, linkDetails, normalizePasscode, type LinkChange } from "../lib/shares";

export const api = new Hono<AppEnv>();

api.use("*", async (context, next) => {
  const key = await authenticateKey(context);
  if (!key) {
    context.header("WWW-Authenticate", 'Bearer realm="esho-plans"');
    return context.json({ error: "A valid publish key is required." }, 401);
  }
  await next();
});

api.get("/whoami", (context) => context.json({ ok: true, maxHtmlBytes }));

api.get("/projects", async (context) => context.json({ projects: await listProjects(context.env.DB) }));

api.post("/projects", async (context) => {
  const body = await jsonObject(context);
  const project = await createProject(context.env.DB,
    inputText(body.name, "Project name", 120), optionalText(body.workspaceHint, "Workspace name", 200),
    optionalText(body.repoHint, "Git remote", 300), optionalText(body.idempotencyKey, "Idempotency key", 80));
  return context.json({ project }, 201);
});

api.get("/projects/:id/documents", async (context) => {
  const id = context.req.param("id");
  if (!await getProject(context.env.DB, id)) throw new RequestError(404, "Project not found.");
  return context.json({ documents: await listDocuments(context.env.DB, id) });
});

api.put("/projects/:id/documents", async (context) => {
  const id = context.req.param("id");
  const { env } = context;
  if (!await getProject(env.DB, id)) throw new RequestError(404, "Project not found.");
  // A control character can take six JSON bytes for each decoded HTML byte.
  const body = await jsonObject(context, 6 * maxHtmlBytes + 8192);
  const result = await publish(env.DB, id, body);
  const { document } = result;
  const app = context.get("appOrigin");
  const share = document.visibility === "shared" ? await linkDetails(env, app, await activeLink(env.DB, id)) : null;
  return context.json({
    document: {
      id: document.id, docKey: document.doc_key, title: document.title, visibility: document.visibility,
      contentHash: document.content_hash, updatedAt: document.updated_at,
    },
    changed: result.changed,
    overwrote: result.overwrote,
    privateUrl: documentUrl(app, id, document.id),
    clientUrl: share ? share.url + "/d/" + document.id : null,
  });
});

api.patch("/documents/:id", async (context) => {
  const body = await jsonObject(context);
  const update = {
    title: body.title === undefined ? undefined : inputText(body.title, "Title", 300),
    visibility: body.visibility === undefined ? undefined : parseVisibility(body.visibility),
  };
  if (update.title === undefined && update.visibility === undefined) throw new RequestError(400, "Send a title or visibility.");
  const document = await editDocument(context.env.DB, context.req.param("id"), update);
  if (!document) throw new RequestError(404, "Document not found.");
  return context.json({ document });
});

api.delete("/documents/:id", async (context) => {
  const document = await editDocument(context.env.DB, context.req.param("id"), { remove: true });
  if (!document) throw new RequestError(404, "Document not found.");
  return context.json({ removed: { id: document.id, title: document.title, docKey: document.doc_key } });
});

api.get("/projects/:id/link", async (context) => {
  const id = context.req.param("id");
  if (!await getProject(context.env.DB, id)) throw new RequestError(404, "Project not found.");
  return context.json({ link: await linkDetails(context.env, context.get("appOrigin"), await activeLink(context.env.DB, id)) });
});

api.post("/projects/:id/link", async (context) => {
  const id = context.req.param("id");
  if (!await getProject(context.env.DB, id)) throw new RequestError(404, "Project not found.");
  const body = await jsonObject(context);
  const action = body.action ?? "create";
  if (action !== "create" && action !== "replace" && action !== "passcode") throw new RequestError(400, "Invalid link action.");
  const change: LinkChange = { action };
  if (body.passcode !== undefined) change.passcode = normalizePasscode(body.passcode);
  if (action === "passcode" && change.passcode === undefined) throw new RequestError(400, "Send a passcode or null.");
  const link = await changeLink(context.env, id, change);
  return context.json({ link: await linkDetails(context.env, context.get("appOrigin"), link) });
});

api.delete("/projects/:id/link", async (context) => {
  const id = context.req.param("id");
  if (!await getProject(context.env.DB, id)) throw new RequestError(404, "Project not found.");
  await changeLink(context.env, id, { action: "revoke" });
  return context.json({ link: null });
});
