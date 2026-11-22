import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getDocument, listClientDocuments } from "../lib/documents";
import { type AppEnv } from "../lib/env";
import { grantUrl, shareAudience } from "../lib/grants";
import { requiredFormText, sameOrigin } from "../lib/request";
import { findLink, isUnlocked, markOpened, previewBot, tryUnlock, unlockCsrf, validUnlockCsrf } from "../lib/shares";
import { ClientPage, ClientReader, PasscodePage, Preview } from "../views/pages";

export const client = new Hono<AppEnv>();

client.get("/:token", async (context) => {
  const token = context.req.param("token");
  const link = await findLink(context.env.DB, token);
  if (!link) return context.notFound();
  if (previewBot(context)) return context.html(<Preview />);
  if (!await isUnlocked(context, link)) return context.html(<PasscodePage token={token} csrf={await unlockCsrf(context, link)} />);
  const documents = await listClientDocuments(context.env.DB, link.project_id);
  if (context.req.method === "GET") await markOpened(context.env.DB, link);
  return context.html(<ClientPage name={link.project_name} token={token} documents={documents} />);
});

client.get("/:token/d/:docId", async (context) => {
  const { token, docId } = context.req.param();
  const link = await findLink(context.env.DB, token);
  const document = link && await getDocument(context.env.DB, link.project_id, docId);
  if (!link || document?.visibility !== "shared") return context.notFound();
  if (previewBot(context)) return context.html(<Preview />);
  if (!await isUnlocked(context, link)) {
    return context.html(<PasscodePage token={token} csrf={await unlockCsrf(context, link)} documentId={docId} />);
  }
  const content = context.get("contentOrigin");
  if (!content) return context.text("The document host is unavailable.", 503);
  const url = await grantUrl(context.env, content, document, shareAudience(link));
  if (context.req.method === "GET") await markOpened(context.env.DB, link);
  return context.html(<ClientReader title={document.title} token={token} url={url} />);
});

client.post("/:token/unlock", bodyLimit({ maxSize: 8192 }), async (context) => {
  const token = context.req.param("token");
  const link = await findLink(context.env.DB, token);
  if (!link || !sameOrigin(context)) return context.notFound();
  const form = await context.req.parseBody();
  if (!await validUnlockCsrf(context, link, requiredFormText(form, "_csrf"))) return context.notFound();
  const documentId = requiredFormText(form, "document");
  if (documentId) {
    const document = await getDocument(context.env.DB, link.project_id, documentId);
    if (document?.visibility !== "shared") return context.notFound();
  }
  const outcome = await tryUnlock(context, link, token, requiredFormText(form, "passcode"));
  if (outcome === "unlocked") return context.redirect("/s/" + token + (documentId ? "/d/" + documentId : ""), 303);
  return context.html(<PasscodePage token={token} csrf={await unlockCsrf(context, link)} documentId={documentId}
    message={outcome === "locked" ? "Too many attempts. Try again in 15 minutes." : "Incorrect passcode."} />,
  outcome === "locked" ? 429 : 403);
});

client.all("*", (context) => context.notFound());
