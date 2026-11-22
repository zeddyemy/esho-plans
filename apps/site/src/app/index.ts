import { Hono } from "hono";
import type { AppEnv } from "../lib/env";
import { RequestError } from "../lib/request";
import { api } from "./api";
import { auth } from "./auth";
import { client } from "./client";
import { owner } from "./owner";

export const site = new Hono<AppEnv>();

site.use("*", async (context, next) => {
  context.set("appOrigin", context.env.REQUEST_APP_ORIGIN);
  context.set("contentOrigin", context.env.REQUEST_CONTENT_ORIGIN);
  const contentOrigin = context.get("contentOrigin");
  context.header("Cross-Origin-Opener-Policy", "same-origin");
  context.header("Content-Security-Policy", [
    "default-src 'none'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:",
    "manifest-src 'self'", "frame-src " + (contentOrigin ?? "'none'"), "form-action 'self'",
    "base-uri 'none'", "frame-ancestors 'none'", "object-src 'none'",
  ].join("; "));
  await next();
});

site.get("/healthz", (context) => context.json({ ok: true }));

for (const path of ["/app.css", "/app.js", "/icon.png", "/icon-512.png", "/manifest.webmanifest"]) {
  site.get(path, (context) => context.env.ASSETS.fetch(context.req.raw));
}

site.get("/sitemap.xml", (context) => context.notFound());
site.get("/robots.txt", (context) => context.text("User-agent: *\nDisallow:\n"));
site.route("/auth", auth);
site.route("/api/v1", api);
site.route("/s", client);
site.route("/", owner);

site.onError((error, context) => {
  if (error instanceof RequestError) {
    return context.req.path.startsWith("/api/v1/") ? context.json({ error: error.message }, error.status)
      : context.text(error.message, error.status);
  }
  console.error("App request failed", error.name);
  return context.req.path.startsWith("/api/v1/") ? context.json({ error: "Internal Server Error" }, 500)
    : context.text("Internal Server Error", 500);
});
