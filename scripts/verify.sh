#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then printf 'Usage: %s <base-url>\n' "$0" >&2; exit 2; fi
node --input-type=module - "$1" <<'JS'
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const base = new URL(process.argv[2]);
const isLocal = ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname);
assert(base.protocol === "https:" || (isLocal && base.protocol === "http:"));
assert.equal(base.pathname, "/");
assert(!base.username && !base.password && !base.search && !base.hash);
let key = process.env.ESHO_PLANS_API_KEY;
if (!key) {
  const credentials = JSON.parse(await readFile(join(homedir(), ".config/esho-plans/credentials.json"), "utf8"));
  assert.equal(credentials.apiUrl, base.origin, "The stored publish key belongs to a different origin.");
  key = credentials.apiKey;
}
assert(typeof key === "string" && /^epk_[A-Za-z0-9_-]{43}$/.test(key), "A valid publish key is required.");

async function http(url, options = {}) {
  return fetch(new URL(url, base), { redirect: "manual", signal: AbortSignal.timeout(20_000), ...options });
}

async function api(path, method = "GET", body, expected = 200) {
  const response = await http("/api/v1" + path, {
    method,
    headers: { Authorization: "Bearer " + key, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body && JSON.stringify(body),
  });
  assert.equal(response.status, expected, method + " " + path);
  return response.json();
}

async function snapshot(url) {
  const response = await http(url);
  const headers = [...response.headers].filter(([name]) => !["date", "cf-ray", "nel", "report-to", "server-timing", "alt-svc"].includes(name));
  return { status: response.status, body: await response.text(), headers };
}

function safeHeaders(response) {
  assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow, noarchive");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
}

const marker = randomUUID().slice(0, 8);
const a = (await api("/projects", "POST", { name: "Verification A " + marker }, 201)).project;
const b = (await api("/projects", "POST", { name: "Verification B " + marker }, 201)).project;
console.log("Verification projects " + a.id + " " + b.id);
const endpoint = (project) => "/projects/" + project.id + "/link";
const html = "<!doctype html><html lang=en><title>Verification</title><p>isolated-smoke-fixture</p></html>";

async function publish(project, slug, visibility) {
  return api("/projects/" + project.id + "/documents", "PUT", { docKey: slug + ".html", title: slug, visibility, html });
}

try {
  const shared = await publish(a, "Visible " + marker, "shared");
  const internal = await publish(a, "Internal " + marker, "internal");
  const other = await publish(b, "Other " + marker, "shared");
  const duplicate = await publish(a, "Visible " + marker, "shared");
  assert.equal(duplicate.privateUrl, shared.privateUrl);
  assert.equal(duplicate.changed, false);
  console.log("PASS identical publishes reused one URL.");

  const link = (await api(endpoint(a), "POST", { action: "create" })).link.url;
  await api(endpoint(b), "POST", { action: "create" });
  const page = await http(link);
  safeHeaders(page);
  assert.equal(page.status, 200);
  const listing = await page.text();
  assert(listing.includes("Visible " + marker));
  for (const value of ["Internal " + marker, "Other " + marker, b.name, a.id, b.id]) assert(!listing.includes(value));
  const baseline = await snapshot(link + "/missing");
  assert.equal(baseline.status, 404);
  for (const url of [link + "/d/" + internal.document.id, link + "/d/" + other.document.id, link.slice(0, -1)]) {
    assert.deepEqual(await snapshot(url), baseline);
  }
  for (const path of ["/", "/p/" + b.id, "/settings", "/api/v1/projects"]) {
    const response = await http(path);
    assert(!((await response.text()).includes(b.name)));
    assert.equal(response.status, path === "/" ? 200 : path.startsWith("/api/") ? 401 : 303);
  }
  console.log("PASS client link exposed only shared documents for its project. Invalid, internal and cross-project paths returned identical 404s.");

  const readUrl = link + "/d/" + shared.document.id;
  const reader = await http(readUrl);
  const readerHtml = await reader.text();
  assert.equal(reader.status, 200);
  assert(!readerHtml.includes("isolated-smoke-fixture"));
  assert(readerHtml.includes('sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"'));
  const frame = /<iframe[^>]* src="([^"]+)"/.exec(readerHtml)?.[1];
  assert(frame);
  const frameUrl = new URL(frame);
  assert.notEqual(frameUrl.origin, base.origin);
  const content = await http(frameUrl);
  safeHeaders(content);
  assert.equal(content.status, 200);
  assert.equal(content.headers.has("set-cookie"), false);
  assert.equal(content.headers.get("cache-control"), "private, no-store");
  const policy = content.headers.get("content-security-policy");
  for (const directive of ["sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox", "frame-ancestors " + base.origin,
    "connect-src 'none'", "form-action 'none'", "frame-src 'none'"]) assert(policy.includes(directive));
  assert(!policy.includes("allow-same-origin"));
  assert.equal(await content.text(), html);
  assert.equal((await http(new URL("/healthz", frameUrl))).status, 404);
  console.log("PASS the content origin returned HTML only for a signed grant and set its sandbox, CSP and privacy headers.");

  await api(endpoint(a), "DELETE");
  for (const url of [link, readUrl, frameUrl]) assert.equal((await http(url)).status, 404);
  console.log("PASS revocation invalidated the client page, document route and previously minted content grant.");
} finally {
  await Promise.allSettled([api(endpoint(a), "DELETE"), api(endpoint(b), "DELETE")]);
}
JS
