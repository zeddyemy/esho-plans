import { Hono } from "hono";
import { sandbox, type AppEnv } from "../lib/env";
import { grantedDocument } from "../lib/grants";

export const content = new Hono<AppEnv>();

content.get("/c/:grant", async (context) => {
  const document = await grantedDocument(context.env, context.req.param("grant"));
  if (!document) return context.notFound();

  const appOrigin = context.env.REQUEST_APP_ORIGIN;
  context.header("Cache-Control", "private, no-store");
  context.header("Content-Security-Policy", [
    "sandbox " + sandbox,
    "default-src 'none'",
    "script-src 'unsafe-inline' https://cdn.jsdelivr.net https://unpkg.com https://cdnjs.cloudflare.com",
    "style-src 'unsafe-inline' https:",
    "img-src https: data:",
    "font-src https: data:",
    "media-src https: data:",
    "connect-src 'none'", "form-action 'none'", "frame-src 'none'", "object-src 'none'", "base-uri 'none'",
    "frame-ancestors " + appOrigin,
  ].join("; "));

  return context.html(document.html);
});
