import { env, exports } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import type { D1Migration } from "@cloudflare/vitest-plugin";
import { beforeAll, describe, expect, inject, it, vi } from "vitest";
import { date } from "../src/lib/env";
import { hash, mac, randomToken } from "../src/lib/crypto";

declare module "vitest" {
  interface ProvidedContext {
    migrations: D1Migration[];
  }
}

const app = "https://postplan.esho.dev";
const content = "https://esho-plans.test-account.workers.dev";
const key = "epk_" + randomToken();
const session = randomToken();
const ownerCookie = "__Host-esho_session=" + session;
const fixture = "<!doctype html><html><title>Sandbox fixture</title><p>isolated-fixture-content</p></html>";

const http = (url: string, init?: RequestInit) => exports.default.fetch(url.startsWith("/") ? app + url : url, { redirect: "manual", ...init });

function api(path: string, method = "GET", body?: object, apiKey = key) {
  return http("/api/v1" + path, {
    method,
    headers: { Authorization: "Bearer " + apiKey, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body && JSON.stringify(body),
  });
}

function post(path: string, form: Record<string, string>, origin = app, cookie = ownerCookie) {
  return http(path, { method: "POST", headers: { Origin: origin, Cookie: cookie }, body: new URLSearchParams(form) });
}

async function json<T>(response: Response, status = 200) {
  if (response.status !== status) throw new Error("Expected " + status + ", received " + response.status + ": " + await response.text());
  return response.json<T>();
}

function iframeSource(html: string) {
  const source = /<iframe[^>]* src="([^"]+)"/.exec(html)?.[1];
  expect(source).toMatch(/^https:\/\/esho-plans\.test-account\.workers\.dev\/c\//);
  return source!;
}

function csrfValue(html: string) {
  const value = /name="_csrf" value="([^"]+)"/.exec(html)?.[1];
  expect(value).toBeTruthy();
  return value!;
}

async function snapshot(response: Response) {
  return { status: response.status, headers: [...response.headers], body: await response.text() };
}

async function createProject(name: string) {
  return (await json<{ project: { id: string } }>(await api("/projects", "POST", { name }), 201)).project.id;
}

type Receipt = {
  document: { id: string; visibility: "internal" | "shared"; contentHash: string };
  changed: boolean;
  overwrote: boolean;
  privateUrl: string;
  clientUrl: string | null;
};

async function publish(project: string, title: string, visibility?: string, options: object = {}) {
  return json<Receipt>(await api("/projects/" + project + "/documents", "PUT", {
    docKey: title.toLowerCase().replaceAll(" ", "-") + ".html", title, html: fixture, visibility, ...options,
  }));
}

async function link(project: string, action = "create", passcode?: string) {
  return (await json<{ link: { url: string; lastUsedAt: string | null } }>(
    await api("/projects/" + project + "/link", "POST", { action, passcode }),
  )).link;
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, inject("migrations"));
  await env.DB.batch([
    env.DB.prepare("INSERT INTO api_keys (id, name, prefix, key_hash, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind("fixture-key", "Fixture key", key.slice(0, 11), await mac("fixture-key-pepper", key), date()),
    env.DB.prepare("INSERT INTO sessions (id_hash, github_user_id, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?)")
      .bind(await hash(session), 51033541, date(), date(), date(3600)),
  ]);
});

describe("project isolation and revocation over HTTP", () => {
  it("only returns the chosen project's shared documents and uniform 404s for invalid paths", async () => {
    const a = await createProject("Project A");
    const b = await createProject("Project B confidential");
    const shared = await publish(a, "A shared document", "shared");
    const internal = await publish(a, "A private document");
    const bShared = await publish(b, "B shared document", "shared");
    await publish(b, "B private document");
    const aLink = await link(a);
    await link(b);

    const bot = await http(aLink.url, { headers: { "User-Agent": "Slackbot-LinkExpanding 1.0" } });
    expect(await bot.text()).not.toContain("Project A");
    expect((await link(a)).lastUsedAt).toBeNull();

    const body = await (await http(aLink.url)).text();
    expect(body).toContain("A shared document");
    for (const value of ["A private document", "Project B confidential", "B shared document", "B private document", a, b, internal.document.id]) {
      expect(body).not.toContain(value);
    }
    expect((await link(a)).lastUsedAt).not.toBeNull();
    expect((await http(aLink.url + "/d/" + shared.document.id)).status).toBe(200);
    const missing = await snapshot(await http("/s/" + randomToken()));
    expect(missing).toMatchObject({ status: 404, body: "Not Found" });
    for (const url of [aLink.url + "/d/" + internal.document.id, aLink.url + "/d/" + bShared.document.id,
      aLink.url + "/d/doc_missing", aLink.url + "/unknown", aLink.url.slice(0, -1)]) {
      expect(await snapshot(await http(url))).toEqual(missing);
    }
    const headers = { Cookie: "client=" + aLink.url.split("/").at(-1) };
    for (const path of ["/", "/p/" + b, "/settings", "/api/v1/projects"]) {
      const response = await http(path, { headers });
      expect(await response.text()).not.toContain("Project B confidential");
      expect(response.status).toBe(path === "/" ? 200 : path.startsWith("/api/") ? 401 : 303);
    }
  });

  it("invalidates existing grants when links are revoked, replaced, or visibility changes", async () => {
    const project = await createProject("Revocation demo");
    const { document } = await publish(project, "Revocation document", "shared");
    const original = await link(project);
    const originalDoc = original.url + "/d/" + document.id;
    const grant = iframeSource(await (await http(originalDoc)).text());
    expect((await http(grant)).status).toBe(200);
    await json(await api("/projects/" + project + "/link", "DELETE"));
    for (const url of [original.url, originalDoc, grant]) expect((await http(url)).status).toBe(404);

    const next = await link(project);
    const nextGrant = iframeSource(await (await http(next.url + "/d/" + document.id)).text());
    const replacement = await link(project, "replace");
    expect(replacement.url).not.toBe(next.url);
    expect((await http(next.url)).status).toBe(404);
    expect((await http(nextGrant)).status).toBe(404);

    const documentUrl = replacement.url + "/d/" + document.id;
    const replacementGrant = iframeSource(await (await http(documentUrl)).text());
    await json(await api("/documents/" + document.id, "PATCH", { visibility: "internal" }));
    expect((await http(documentUrl)).status).toBe(404);
    expect((await http(replacementGrant)).status).toBe(404);
    expect(await (await http(replacement.url)).text()).not.toContain("Revocation document");
  });

  it("keeps titles behind the passcode, blocks the sixth attempt, and preserves passcodes on rotation", async () => {
    const project = await createProject("Passcode project");
    const { document } = await publish(project, "Client title", "shared");
    const protectedLink = await link(project, "create", "right code");
    const form = await (await http(protectedLink.url + "/d/" + document.id)).text();
    expect(form).not.toContain("Client title");
    expect(form).not.toContain("Passcode project");
    const proof = csrfValue(form);
    for (let count = 1; count <= 5; count++) {
      const response = await post(protectedLink.url + "/unlock", { _csrf: proof, passcode: "wrong" });
      expect(response.status).toBe(count === 5 ? 429 : 403);
    }
    expect((await post(protectedLink.url + "/unlock", { _csrf: proof, passcode: "right code" })).status).toBe(429);
    const rotated = await link(project, "replace");
    const lockedPage = await (await http(rotated.url)).text();
    expect(lockedPage).not.toContain("Client title");
    const unlocked = await post(rotated.url + "/unlock", { _csrf: csrfValue(lockedPage), passcode: "right code" });
    expect(unlocked.status).toBe(303);
    const cookie = unlocked.headers.get("Set-Cookie")!.split(";")[0];
    expect(await (await http(rotated.url, { headers: { Cookie: cookie } })).text()).toContain("Client title");
    const grant = iframeSource(await (await http(rotated.url + "/d/" + document.id, { headers: { Cookie: cookie } })).text());
    await link(project, "passcode", "new code");
    expect((await http(grant)).status).toBe(404);
    expect(await (await http(rotated.url, { headers: { Cookie: cookie } })).text()).not.toContain("Client title");
  });
});

describe("content host and owner controls", () => {
  it("enforces both sandboxes and the content CSP, and shows the document with no controls", async () => {
    const project = await createProject("Sandbox fixture project");
    const { privateUrl } = await publish(project, "Owner sandbox fixture");
    const reader = await http(privateUrl, { headers: { Cookie: ownerCookie } });
    expect(reader.status).toBe(200);
    expect(reader.headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
    const html = await reader.text();
    expect(html).not.toContain("isolated-fixture-content");
    expect(html).toContain('sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"');
    const url = iframeSource(html);
    const response = await http(url);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(fixture);
    expect(response.headers.get("Set-Cookie")).toBeNull();
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect((await http(url, { method: "HEAD" })).status).toBe(404);
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(response.headers.get("Content-Security-Policy")).toBe([
      "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox", "default-src 'none'",
      "script-src 'unsafe-inline' https://cdn.jsdelivr.net https://unpkg.com https://cdnjs.cloudflare.com",
      "style-src 'unsafe-inline' https:", "img-src https: data:", "font-src https: data:", "media-src https: data:",
      "connect-src 'none'", "form-action 'none'", "frame-src 'none'", "object-src 'none'", "base-uri 'none'",
      "frame-ancestors " + app,
    ].join("; "));
    const missing = await snapshot(await http(content + "/c/" + randomToken()));
    for (const path of ["/", "/healthz", "/settings", "/auth/github", "/api/v1/projects", "/app.css", "/sitemap.xml"]) {
      expect(await snapshot(await http(content + path))).toEqual(missing);
    }
    expect((await http(app + new URL(url).pathname)).status).toBe(303);
    // The reader page is the document frame and one link back to the project, with no controls.
    expect(html.match(/<body[^>]*>([\s\S]*)<\/body>/)![1].replace(/<iframe[^>]*><\/iframe>/, "FRAME"))
      .toBe('FRAME<a class="reader-home" href="/p/' + project + '">Sandbox fixture project</a>');
    expect(html).not.toMatch(/<form|<button|_csrf/);
    for (const gone of ["/download", "/open"]) {
      expect((await http(privateUrl + gone, { headers: { Cookie: ownerCookie } })).status).toBe(404);
    }
  });

  it("requires CSRF and same origin for owner mutations and refuses an expired session", async () => {
    const project = await createProject("Owner controls");
    const path = "/p/" + project;
    const response = await http(path, { headers: { Cookie: ownerCookie } });
    expect(response.status).toBe(200);
    const proof = csrfValue(await response.text());
    expect((await post(path + "/link", { action: "create" })).status).toBe(403);
    expect((await post(path + "/link", { action: "create", _csrf: proof }, content)).status).toBe(403);
    for (const site of ["cross-site", "same-origin"]) {
      const navigation = await http(path + "/link", {
        method: "POST", headers: { Origin: "null", "Sec-Fetch-Site": site, Cookie: ownerCookie },
        body: new URLSearchParams({ action: "create", _csrf: proof }),
      });
      expect(navigation.status).toBe(site === "same-origin" ? 303 : 403);
    }
    expect((await post(path + "/link", { action: "create", _csrf: proof })).status).toBe(303);
    const expired = randomToken();
    await env.DB.prepare("INSERT INTO sessions (id_hash, github_user_id, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?)")
      .bind(await hash(expired), 51033541, date(-40), date(-30), date(-1)).run();
    expect((await http(path, { headers: { Cookie: "__Host-esho_session=" + expired } })).status).toBe(303);
  });

  it("issues a fresh grant when the reader is reloaded after its grant expires", async () => {
    const project = await createProject("Reload fixture");
    const { privateUrl } = await publish(project, "Reload document");
    const headers = { Cookie: ownerCookie };
    const oldGrant = iframeSource(await (await http(privateUrl, { headers })).text());
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 301_000);
    try {
      expect((await http(oldGrant)).status).toBe(404);
      const reloaded = await http(privateUrl, { headers });
      expect(reloaded.headers.get("Cache-Control")).toBe("no-store");
      const freshGrant = iframeSource(await reloaded.text());
      expect(freshGrant).not.toBe(oldGrant);
      const response = await http(freshGrant);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(fixture);
    } finally {
      now.mockRestore();
    }
  });

  it("removes a document through the API only, and cuts off its reader, client page and grants", async () => {
    const project = await createProject("Removal fixture");
    const { document, privateUrl } = await publish(project, "Removable", "shared");
    const shared = await link(project);
    const headers = { Cookie: ownerCookie };
    const ownerGrant = iframeSource(await (await http(privateUrl, { headers })).text());
    const clientGrant = iframeSource(await (await http(shared.url + "/d/" + document.id)).text());
    const proof = csrfValue(await (await http("/p/" + project, { headers })).text());
    // The owner pages no longer change documents.
    expect((await post("/d/" + document.id, { action: "delete", _csrf: proof })).status).toBe(404);
    expect((await http(privateUrl, { headers })).status).toBe(200);
    expect((await http("/api/v1/documents/" + document.id, { method: "DELETE", headers })).status).toBe(401);

    const removed = await json<{ removed: { id: string } }>(await api("/documents/" + document.id, "DELETE"));
    expect(removed.removed.id).toBe(document.id);
    expect((await api("/documents/" + document.id, "DELETE")).status).toBe(404);
    for (const url of [shared.url + "/d/" + document.id, ownerGrant, clientGrant]) expect((await http(url)).status).toBe(404);
    expect((await http(privateUrl, { headers })).status).toBe(404);
    expect(await (await http(shared.url)).text()).not.toContain("Removable");

    // Publishing the same path again restores the same URL as internal.
    const restored = await publish(project, "Removable");
    expect(restored.privateUrl).toBe(privateUrl);
    expect(restored.document.visibility).toBe("internal");
    expect((await http(shared.url + "/d/" + document.id)).status).toBe(404);
  });

  it("validates state and PKCE before permitting only the numeric GitHub owner", async () => {
    const begin = async () => {
      const response = await http("/auth/github");
      const authorize = new URL(response.headers.get("Location")!);
      const cookie = response.headers.get("Set-Cookie")!.split(";")[0];
      return { authorize, cookie };
    };
    const callback = (state: string, cookie: string) => http("/auth/github/callback?code=fixture-code&state=" + state, {
      headers: { Cookie: cookie },
    });
    const wrong = await begin();
    expect((await callback(randomToken(), wrong.cookie)).status).toBe(403);
    let user = 42;
    let challenge = wrong.authorize.searchParams.get("code_challenge");
    let redirected = "";
    const outbound = vi.fn(async (url: string, init: RequestInit) => {
      // Building the request makes the runtime check the options, as a real fetch would.
      expect(new Request(url, init).redirect).toBe("manual");
      if (url === redirected) return new Response(null, { status: 302, headers: { Location: "https://example.com/" } });
      if (url === "https://github.com/login/oauth/access_token") {
        const body = init.body as URLSearchParams;
        expect(await hash(body.get("code_verifier")!)).toBe(challenge);
        return Response.json({ access_token: "fixture-token" });
      }
      expect(url).toBe("https://api.github.com/user");
      return Response.json({ id: user });
    });
    vi.stubGlobal("fetch", outbound);
    try {
      const forbidden = await callback(wrong.authorize.searchParams.get("state")!, wrong.cookie);
      expect(forbidden.status).toBe(403);
      expect(forbidden.headers.getSetCookie().some((cookie) => cookie.startsWith("__Host-esho_session="))).toBe(false);
      expect((await callback(wrong.authorize.searchParams.get("state")!, wrong.cookie)).status).toBe(403);
      user = 51033541;
      const correct = await begin();
      challenge = correct.authorize.searchParams.get("code_challenge");
      const signedIn = await callback(correct.authorize.searchParams.get("state")!, correct.cookie);
      expect(signedIn.status).toBe(303);
      const cookie = signedIn.headers.getSetCookie().find((value) => value.startsWith("__Host-esho_session="))!;
      expect(cookie).toBeTruthy();
      for (const flag of ["Secure", "HttpOnly", "SameSite=Lax", "Path=/"]) expect(cookie).toContain(flag);
      expect(cookie).not.toMatch(/Domain=/i);
      expect(signedIn.headers.get("Location")).toBe("/");

      // A redirect from either GitHub endpoint is refused, not followed.
      for (const endpoint of ["https://github.com/login/oauth/access_token", "https://api.github.com/user"]) {
        const attempt = await begin();
        challenge = attempt.authorize.searchParams.get("code_challenge");
        redirected = endpoint;
        const refused = await callback(attempt.authorize.searchParams.get("state")!, attempt.cookie);
        expect(refused.status).toBe(403);
        expect(refused.headers.getSetCookie().some((value) => value.startsWith("__Host-esho_session="))).toBe(false);
      }
      redirected = "";

      // A signed-out visit to an owner page is remembered. Anything else falls back to the project list.
      const asked = await http("/cli/auth");
      expect(asked.status).toBe(303);
      expect(asked.headers.get("Location")).toBe("/");
      const remembered = asked.headers.getSetCookie().find((value) => value.startsWith("__Host-esho_return="))!.split(";")[0];
      expect((await http("/unknown/page")).headers.getSetCookie()).toHaveLength(0);
      for (const [returnCookie, destination] of [
        [remembered, "/cli/auth"], ["__Host-esho_return=https://example.com/", "/"], ["__Host-esho_return=//example.com", "/"],
      ]) {
        const again = await begin();
        challenge = again.authorize.searchParams.get("code_challenge");
        const returned = await callback(again.authorize.searchParams.get("state")!, again.cookie + "; " + returnCookie);
        expect(returned.status).toBe(303);
        expect(returned.headers.get("Location")).toBe(destination);
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("publish API", () => {
  it("keeps a stable URL, skips identical revisions, and records overwrites", async () => {
    const project = await createProject("Publish behaviour");
    const first = await publish(project, "Revision fixture");
    const second = await publish(project, "Revision fixture");
    expect(first.document.visibility).toBe("internal");
    expect(first.clientUrl).toBeNull();
    expect(second.privateUrl).toBe(first.privateUrl);
    expect(second.changed).toBe(false);
    const changes = await env.DB.prepare("SELECT COUNT(*) AS count FROM document_changes WHERE document_id = ?")
      .bind(first.document.id).first<number>("count");
    expect(changes).toBe(1);
    const update = await publish(project, "Revision fixture", "shared", { html: fixture + "changed", expectedHash: "sha256:" + randomToken() });
    expect(update.overwrote).toBe(true);
    expect(update.privateUrl).toBe(first.privateUrl);
    expect((await publish(project, "Revision fixture", undefined, { html: fixture + "changed" })).document.visibility).toBe("shared");
    const metadata = await api("/projects/" + project + "/documents");
    expect(await metadata.text()).not.toContain("isolated-fixture-content");
    const oversize = await api("/projects/" + project + "/documents", "PUT", {
      docKey: "large.html", title: "Large", html: "x".repeat(1_500_001),
    });
    expect(oversize.status).toBe(413);
  });

  it("rejects a revoked key and refuses API authentication with an owner session", async () => {
    const disposable = "epk_" + randomToken();
    await env.DB.prepare("INSERT INTO api_keys (id, name, prefix, key_hash, created_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind("revoked-fixture", "Revoked", disposable.slice(0, 11), await mac("fixture-key-pepper", disposable), date(), date()).run();
    expect((await api("/whoami", "GET", undefined, disposable)).status).toBe(401);
    expect((await http("/api/v1/whoami", { headers: { Cookie: ownerCookie } })).status).toBe(401);
  });
});
