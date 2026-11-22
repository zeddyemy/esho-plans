import { Hono } from "hono";

type Bindings = {
  APP_HOST: string;
  CONTENT_HOST?: string;
  LOCAL_DEV?: string;
};

type HostKind = "app" | "content" | "local" | "reject";

function classifyHost(hostname: string, env: Bindings): HostKind {
  if (env.CONTENT_HOST && hostname === env.CONTENT_HOST) return "content";
  if (hostname === env.APP_HOST) return "app";
  if (env.LOCAL_DEV === "true" && (hostname === "localhost" || hostname === "127.0.0.1")) {
    return "local";
  }
  return "reject";
}

const app = new Hono<{ Bindings: Bindings }>();

app.use("*", async (context, next) => {
  context.header("Cache-Control", "no-store");
  context.header("Referrer-Policy", "no-referrer");
  context.header("X-Content-Type-Options", "nosniff");
  context.header("X-Robots-Tag", "noindex, nofollow, noarchive");

  const hostname = new URL(context.req.url).hostname;
  switch (classifyHost(hostname, context.env)) {
    case "app":
    case "local":
      return next();
    case "content":
    case "reject":
      return context.notFound();
  }
});

app.get("/healthz", (context) => context.json({ ok: true }));
app.notFound((context) => context.text("Not Found", 404));

export default app;
