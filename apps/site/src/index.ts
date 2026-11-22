import type { ExecutionContext } from "hono";
import { site } from "./app";
import { content } from "./content";
import { notFound, type WorkerBindings } from "./lib/env";

type HostKind = "app" | "content" | "local" | "local-content" | "reject";

function classifyHost(url: URL, env: WorkerBindings): HostKind {
  const { hostname, protocol } = url;
  if (env.LOCAL_DEV === "true" && protocol === "http:") {
    if (hostname === "127.0.0.1") return "local";
    if (hostname === "localhost" && env.CONTENT_HOST === "localhost") return "local-content";
    if (hostname === "localhost") return "local";
  }
  if (protocol !== "https:") return "reject";
  if (env.CONTENT_HOST && env.CONTENT_HOST !== env.APP_HOST && hostname === env.CONTENT_HOST) return "content";
  if (env.APP_HOST && hostname === env.APP_HOST && env.CONTENT_HOST !== env.APP_HOST) return "app";
  return "reject";
}

site.notFound((context) => context.text(notFound, 404));
content.notFound((context) => context.text(notFound, 404));
content.onError((error, context) => {
  console.error("Content request failed", error.name);
  return context.notFound();
});

function dispatch(request: Request, env: WorkerBindings, execution: ExecutionContext, appOrigin: string, contentOrigin: string | null, contentOnly = false) {
  if (contentOnly && request.method !== "GET") return new Response(notFound, { status: 404 });
  const bindings = { ...env, REQUEST_APP_ORIGIN: appOrigin, REQUEST_CONTENT_ORIGIN: contentOrigin };
  return (contentOnly ? content : site).fetch(request, bindings, execution);
}

async function responseFor(request: Request, env: WorkerBindings, execution: ExecutionContext) {
  const url = new URL(request.url);
  const appOrigin = "https://" + env.APP_HOST;
  const contentOrigin = env.CONTENT_HOST ? "https://" + env.CONTENT_HOST : null;
  const localOrigin = "http://127.0.0.1" + (url.port ? ":" + url.port : "");
  switch (classifyHost(url, env)) {
    case "app":
      return dispatch(request, env, execution, appOrigin, contentOrigin);
    case "content":
      return dispatch(request, env, execution, appOrigin, contentOrigin, true);
    case "local": {
      const localContent = env.CONTENT_HOST === "localhost" ? localOrigin.replace("127.0.0.1", "localhost") : null;
      return dispatch(request, env, execution, url.origin, localContent);
    }
    case "local-content":
      return dispatch(request, env, execution, localOrigin, url.origin, true);
    case "reject":
      return new Response(notFound, { status: 404 });
  }
}

export default {
  async fetch(request: Request, env: WorkerBindings, execution: ExecutionContext) {
    const response = await responseFor(request, env, execution);
    const headers = new Headers(response.headers);
    if (!headers.has("Cache-Control")) headers.set("Cache-Control", "no-store");
    headers.set("Referrer-Policy", "no-referrer");
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  },
};
