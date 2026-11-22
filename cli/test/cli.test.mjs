import { strict as assert } from "node:assert";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { withRecordLock } from "../dist/workspace.js";

const executable = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const goodKey = "epk_" + randomBytes(32).toString("base64url");
const project = { id: "prj_fixture", name: "fixture", repo_hint: null, workspace_hint: null };
const successReceipt = {
  document: { id: "doc_fixture", docKey: "plan.html", visibility: "internal", contentHash: "sha256:initial", updatedAt: "2026-11-22T00:00:00.000Z" },
  changed: true, overwrote: false, privateUrl: "https://example.test/p/prj_fixture/d/doc_fixture", clientUrl: null,
};

function run(cwd, apiUrl, key, ...args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [executable, ...args], {
      cwd,
      env: { ...process.env, ESHO_PLANS_API_URL: apiUrl, ESHO_PLANS_API_KEY: key },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (part) => { stdout += part; });
    child.stderr.on("data", (part) => { stderr += part; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function send(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
}

test("publish, status, permission errors and offline retries over HTTP", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "esho-cli-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".plans"));
  const relativeFile = ".plans/plan.html";
  const html = "<!doctype html><title>Plan &amp; guide</title><p>Contents</p>";
  await writeFile(join(root, relativeFile), html);
  const requests = [];
  const server = createServer(async (request, response) => {
    if (request.headers.authorization !== "Bearer " + goodKey) return send(response, 401, { error: "Revoked" });
    if (request.url === "/api/v1/projects") return send(response, 200, { projects: [project] });
    if (request.method === "PUT" && request.url === "/api/v1/projects/prj_fixture/documents") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      requests.push(body);
      return send(response, 200, { ...successReceipt, changed: requests.length === 1 });
    }
    return send(response, 404, { error: "Missing" });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const apiUrl = "http://127.0.0.1:" + server.address().port;
  context.after(() => { if (server.listening) server.close(); });

  const first = await run(root, apiUrl, goodKey, "publish", relativeFile, "--project", project.id, "--json");
  assert.equal(first.code, 0);
  assert.equal(JSON.parse(first.stdout).privateUrl, successReceipt.privateUrl);
  assert.equal(requests[0].docKey, "plan.html");
  assert.equal(requests[0].html, html);
  assert.equal(requests[0].title, "Plan & guide");
  assert.equal(requests[0].visibility, undefined);
  const second = await run(root, apiUrl, goodKey, "publish", relativeFile, "--json");
  assert.equal(second.code, 0);
  assert.equal(JSON.parse(second.stdout).changed, false);
  assert.equal(requests[1].expectedHash, successReceipt.document.contentHash);
  const record = JSON.parse(await readFile(join(root, ".plans/.postplan.json"), "utf8"));
  assert.equal(record.project.id, project.id);
  assert(!JSON.stringify(record).includes("clientUrl"));
  assert.equal((await run(root, apiUrl, goodKey, "status", "--json")).code, 0);
  const revoked = await run(root, apiUrl, "epk_" + randomBytes(32).toString("base64url"), "publish", relativeFile);
  assert.equal(revoked.code, 3);
  await writeFile(join(root, ".plans/large.html"), "x".repeat(1_500_001));
  assert.equal((await run(root, apiUrl, goodKey, "publish", ".plans/large.html")).code, 5);

  await new Promise((resolve) => server.close(resolve));
  const offline = await run(root, apiUrl, goodKey, "publish", relativeFile);
  assert.equal(offline.code, 4);
  assert.match(offline.stderr, /Saved locally/);
  assert.equal(await readFile(join(root, relativeFile), "utf8"), html);
});

async function workspaceFixture(context) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "esho-cli-")));
  context.after(() => rm(root, { recursive: true, force: true }));
  const plans = join(root, ".plans");
  await mkdir(plans);
  return { root, plans };
}

function fixtureHash(html) {
  return "sha256:" + createHash("sha256").update(html).digest("base64url");
}

async function publishFixture(context) {
  const { root, plans } = await workspaceFixture(context);
  const original = "<!doctype html><title>Plan</title><p>Published version</p>";
  const plan = ".plans/plan.html";
  await writeFile(join(root, plan), original);
  const alternate = { ...project, id: "prj_alternate", name: "alternate" };
  const state = {
    offline: false,
    writes: [],
    document: {
      id: "doc_abcd1234ABCD5678", doc_key: "plan.html", visibility: "shared",
      content_hash: fixtureHash(original), updated_at: successReceipt.document.updatedAt,
    },
  };
  const server = createServer(async (request, response) => {
    if (state.offline) return request.socket.destroy();
    if (request.url === "/api/v1/projects") return send(response, 200, { projects: [project, alternate] });
    if (request.method === "GET") return send(response, 200, { documents: [state.document] });
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (request.method === "PATCH") {
      state.document.visibility = body.visibility;
      return send(response, 200, { document: state.document });
    }
    state.writes.push({ url: request.url, ...body });
    const overwrote = !!body.expectedHash && body.expectedHash !== state.document.content_hash;
    state.document.content_hash = fixtureHash(body.html);
    state.document.visibility = body.visibility ?? state.document.visibility;
    return send(response, 200, {
      ...successReceipt, overwrote,
      document: { ...successReceipt.document, id: state.document.id, visibility: state.document.visibility,
        contentHash: state.document.content_hash },
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => new Promise((resolveClose) => server.close(resolveClose)));
  const origin = "http://127.0.0.1:" + server.address().port;
  const cli = (...args) => run(root, origin, goodKey, ...args);
  assert.equal((await cli("publish", plan, "--project", project.id)).code, 0);
  return { cli, plan, plans, root, original, state, alternate };
}

test("sync replays an offline internal publish and keeps an override scoped to its project", async (context) => {
  const { cli, plan, plans, root, original, state, alternate } = await publishFixture(context);
  const edited = original + "<p>Private edit</p>";
  await writeFile(join(root, plan), edited);
  state.offline = true;
  const offline = await cli("publish", plan, "--internal");
  assert.equal(offline.code, 4, offline.stderr);
  state.offline = false;
  const syncing = await cli("sync", "--json");
  assert.equal(syncing.code, 0, syncing.stderr);
  assert.equal(state.writes.at(-1).visibility, "internal");
  assert.equal(state.writes.at(-1).html, edited);
  assert.equal(JSON.parse(syncing.stdout).published[0].document.visibility, "internal");
  await assert.rejects(readFile(join(plans, ".postplan.pending.json")), { code: "ENOENT" });

  state.offline = true;
  assert.equal((await cli("publish", plan, "--project", alternate.id, "--internal")).code, 4);
  state.offline = false;
  const writes = state.writes.length;
  const mismatch = await cli("sync");
  assert.equal(mismatch.code, 5);
  assert.match(mismatch.stderr, /another project/);
  assert.equal(state.writes.length, writes);
  const retry = await cli("publish", plan);
  assert.equal(retry.code, 0, retry.stderr);
  assert.equal(state.writes.at(-1).url, "/api/v1/projects/" + alternate.id + "/documents");
  assert.equal(state.writes.at(-1).visibility, "internal");
});

test("a publish to a second project keeps the first project's pending visibility", async (context) => {
  const { cli, plan, plans, root, original, state, alternate } = await publishFixture(context);
  assert.equal(state.document.visibility, "shared");
  const edited = original + "<p>Private edit</p>";
  await writeFile(join(root, plan), edited);
  state.offline = true;
  assert.equal((await cli("publish", plan, "--internal")).code, 4);
  state.offline = false;

  const second = await cli("publish", plan, "--project", alternate.id, "--internal");
  assert.equal(second.code, 0, second.stderr);
  assert.equal(state.writes.at(-1).url, "/api/v1/projects/" + alternate.id + "/documents");
  const pending = JSON.parse(await readFile(join(plans, ".postplan.pending.json"), "utf8"));
  assert.deepEqual(pending.documents["plan.html"], [{ visibility: "internal", project: project.id }]);

  // The mock keeps one document, so restore the first project's shared copy before syncing it.
  state.document.visibility = "shared";
  const syncing = await cli("sync", "--json");
  assert.equal(syncing.code, 0, syncing.stderr);
  assert.equal(state.writes.at(-1).url, "/api/v1/projects/" + project.id + "/documents");
  assert.equal(state.writes.at(-1).html, edited);
  assert.equal(state.writes.at(-1).visibility, "internal");
  assert.equal(state.document.visibility, "internal");
  await assert.rejects(readFile(join(plans, ".postplan.pending.json")), { code: "ENOENT" });

  // A pending file written by an earlier CLI version holds one choice per file and is still honoured.
  await writeFile(join(root, plan), edited + "<p>Second edit</p>");
  state.document.visibility = "shared";
  const legacy = JSON.stringify({ apiUrl: pending.apiUrl, documents: { "plan.html": { visibility: "internal", project: project.id } } });
  await writeFile(join(plans, ".postplan.pending.json"), legacy);
  assert.equal((await cli("sync")).code, 0);
  assert.equal(state.writes.at(-1).visibility, "internal");
});

test("a visibility change preserves the local content baseline when another copy is newer", async (context) => {
  const { cli, plan, plans, root, original, state } = await publishFixture(context);
  const localHash = fixtureHash(original);
  state.document.content_hash = fixtureHash("<p>Newer remote version</p>");
  state.document.updated_at = "2026-11-22T12:00:00.000Z";
  const visibility = await cli("set", plan, "--internal");
  assert.equal(visibility.code, 0, visibility.stderr);
  const record = JSON.parse(await readFile(join(plans, ".postplan.json"), "utf8"));
  assert.equal(record.documents["plan.html"].visibility, "internal");
  assert.equal(record.documents["plan.html"].contentHash, localHash);
  assert.equal(record.documents["plan.html"].publishedAt, successReceipt.document.updatedAt);
  assert.equal(JSON.parse((await cli("sync", "--json")).stdout).skipped, 1);
  assert.equal(state.writes.length, 1);
  await writeFile(join(root, plan), original + "<p>New local edit</p>");
  const sync = await cli("sync", "--json");
  assert.equal(sync.code, 0, sync.stderr);
  assert.equal(state.writes.at(-1).expectedHash, localHash);
  assert.equal(JSON.parse(sync.stdout).published[0].overwrote, true);
});

test("the workspace lock recovers from a dead owner and excludes a live owner", async (context) => {
  const { root, plans } = await workspaceFixture(context);
  const lock = join(plans, ".postplan.lock");
  const gone = spawn(process.execPath, ["-e", ""]);
  await once(gone, "exit");
  await writeFile(lock, String(gone.pid));
  await withRecordLock(root, async () => {});
  await mkdir(lock);
  await writeFile(join(lock, gone.pid + "-" + randomUUID()), "");

  let acquired;
  const firstAcquired = new Promise((resolve) => { acquired = resolve; });
  let release;
  const releaseFirst = new Promise((resolve) => { release = resolve; });
  const first = withRecordLock(root, async () => {
    acquired();
    await releaseFirst;
  });
  await firstAcquired;
  let contenderEntered = false;
  const contender = withRecordLock(root, async () => { contenderEntered = true; });
  try {
    await setTimeout(350);
    assert.equal(contenderEntered, false);
  } finally {
    release();
    await Promise.all([first, contender]);
  }
  assert.equal(contenderEntered, true);
  await assert.rejects(readFile(lock), { code: "ENOENT" });
});
