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

// A mock API that keeps each project's document separately.
async function projectsFixture(context, makeProjects) {
  const { root, plans } = await workspaceFixture(context);
  const plan = ".plans/plan.html";
  const original = "<!doctype html><title>Plan</title><p>Published version</p>";
  await writeFile(join(root, plan), original);
  const state = { offline: false, writes: [], projects: makeProjects(root), documents: {} };
  const server = createServer(async (request, response) => {
    if (state.offline) return request.socket.destroy();
    if (request.url === "/api/v1/projects") return send(response, 200, { projects: state.projects });
    const id = /^\/api\/v1\/projects\/([^/]+)\/documents$/.exec(request.url)?.[1];
    const listed = (project) => ({ id: "doc_" + project, doc_key: "plan.html", content_hash: "sha256:mock",
      updated_at: successReceipt.document.updatedAt, visibility: state.documents[project].visibility });
    if (id && request.method === "GET") return send(response, 200, { documents: state.documents[id] ? [listed(id)] : [] });
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    const patched = /^\/api\/v1\/documents\/doc_(.+)$/.exec(request.url)?.[1];
    if (patched && request.method === "DELETE" && state.dropDelete) return request.socket.destroy();
    if (patched && request.method === "DELETE" && state.documents[patched]) {
      delete state.documents[patched];
      // The server removed it, but the answer never arrives.
      if (state.loseDeleteResponse) return request.socket.destroy();
      return send(response, 200, { removed: { id: "doc_" + patched, title: "Plan", docKey: "plan.html" } });
    }
    if (patched && request.method === "PATCH" && state.documents[patched]) {
      state.documents[patched].visibility = body.visibility;
      return send(response, 200, { document: listed(patched) });
    }
    if (!id || request.method !== "PUT") return send(response, 404, { error: "Missing" });
    state.writes.push({ project: id, ...body });
    const visibility = body.visibility ?? state.documents[id]?.visibility ?? "internal";
    state.documents[id] = { visibility };
    return send(response, 200, {
      ...successReceipt,
      document: { ...successReceipt.document, id: "doc_" + id, visibility, contentHash: fixtureHash(body.html) },
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => new Promise((resolveClose) => server.close(resolveClose)));
  const origin = "http://127.0.0.1:" + server.address().port;
  const cli = (...args) => run(root, origin, goodKey, ...args);
  const pendingFile = join(plans, ".postplan.pending.json");
  return { cli, plan, plans, root, original, state, origin, pendingFile };
}

const named = (id, name) => ({ id, name, repo_hint: null, workspace_hint: null });

test("a choice saved under a project name cannot undo a later choice made by project ID", async (context) => {
  const { cli, plan, root, original, state, origin, pendingFile } = await projectsFixture(context,
    () => [named("prj_alpha", "Alpha"), named("prj_twin_one", "Twin"), named("prj_twin_two", "Twin")]);
  assert.equal((await cli("publish", plan, "--project", "prj_alpha")).code, 0);
  state.offline = true;
  assert.equal((await cli("publish", plan, "--project", "Alpha", "--shared")).code, 4);
  state.offline = false;
  const internal = await cli("publish", plan, "--project", "prj_alpha", "--internal");
  assert.equal(internal.code, 0, internal.stderr);
  assert.equal(state.documents.prj_alpha.visibility, "internal");
  await assert.rejects(readFile(pendingFile), { code: "ENOENT" });

  await writeFile(join(root, plan), original + "<p>Later edit</p>");
  const later = await cli("publish", plan);
  assert.equal(later.code, 0, later.stderr);
  assert.equal(state.writes.at(-1).project, "prj_alpha");
  assert.equal(state.writes.at(-1).visibility, undefined);
  assert.equal(state.documents.prj_alpha.visibility, "internal");

  // A saved name that matches several projects stops the upload.
  await writeFile(join(root, plan), original + "<p>Another edit</p>");
  await writeFile(pendingFile, JSON.stringify({ apiUrl: origin, documents: { "plan.html": [{ visibility: "shared", project: "Twin" }] } }));
  const writes = state.writes.length;
  const unclear = await cli("sync");
  assert.equal(unclear.code, 5);
  assert.match(unclear.stderr, /more than one project/);
  assert.equal(state.writes.length, writes);

  // Naming one of those projects by ID with an explicit visibility settles it, and only that project is written.
  const chosen = await cli("publish", plan, "--project", "prj_twin_one", "--internal");
  assert.equal(chosen.code, 0, chosen.stderr);
  assert.equal(state.writes.length, writes + 1);
  assert.equal(state.writes.at(-1).project, "prj_twin_one");
  assert.equal(state.writes.at(-1).visibility, "internal");
  assert.equal(state.documents.prj_twin_two, undefined);
  await assert.rejects(readFile(pendingFile), { code: "ENOENT" });
});

test("a choice whose project disappears stops the upload until it is replaced or cancelled", async (context) => {
  const { cli, plan, root, original, state, pendingFile } = await projectsFixture(context,
    () => [named("prj_alpha", "Alpha"), named("prj_beta", "Beta")]);
  assert.equal((await cli("publish", plan, "--project", "prj_alpha", "--shared")).code, 0);
  assert.equal(state.documents.prj_alpha.visibility, "shared");
  await writeFile(join(root, plan), original + "<p>Private edit</p>");
  state.offline = true;
  assert.equal((await cli("publish", plan, "--project", "prj_beta", "--internal")).code, 4);
  state.offline = false;
  state.projects = state.projects.filter((item) => item.id !== "prj_beta");
  const waiting = [{ visibility: "internal", project: "prj_beta" }];

  const writes = state.writes.length;
  for (const command of [["publish", plan], ["sync"], ["publish", plan], ["sync"], ["publish", plan, "--internal"]]) {
    const stopped = await cli(...command);
    assert.equal(stopped.code, 5, command.join(" ") + ": " + stopped.stderr);
    assert.match(stopped.stderr, /no longer exists/);
    assert.equal(state.writes.length, writes);
    assert.equal(state.documents.prj_alpha.visibility, "shared");
    assert.deepEqual(JSON.parse(await readFile(pendingFile, "utf8")).documents["plan.html"], waiting);
  }

  // An explicit replacement project and visibility succeeds and writes only there.
  const replaced = await cli("publish", plan, "--project", "prj_alpha", "--internal");
  assert.equal(replaced.code, 0, replaced.stderr);
  assert.equal(state.writes.length, writes + 1);
  assert.equal(state.writes.at(-1).project, "prj_alpha");
  assert.equal(state.writes.at(-1).visibility, "internal");
  assert.equal(state.documents.prj_alpha.visibility, "internal");
  await assert.rejects(readFile(pendingFile), { code: "ENOENT" });

  // Another queued destination is not a recovery decision: with B and C both queued and B gone, nothing is sent.
  state.documents.prj_alpha.visibility = "shared";
  state.projects.push(named("prj_beta", "Beta"), named("prj_gamma", "Gamma"));
  await writeFile(join(root, plan), original + "<p>Second private edit</p>");
  state.offline = true;
  assert.equal((await cli("publish", plan, "--project", "prj_beta", "--internal")).code, 4);
  assert.equal((await cli("publish", plan, "--project", "prj_gamma", "--internal")).code, 4);
  state.offline = false;
  state.projects = state.projects.filter((item) => item.id !== "prj_beta");
  const both = [{ visibility: "internal", project: "prj_beta" }, { visibility: "internal", project: "prj_gamma" }];
  const before = state.writes.length;
  for (const command of [["publish", plan], ["sync"], ["publish", plan, "--project", "prj_gamma"], ["sync"]]) {
    const stopped = await cli(...command);
    assert.equal(stopped.code, 5, command.join(" ") + ": " + stopped.stderr);
    assert.equal(state.writes.length, before);
    assert.equal(state.documents.prj_alpha.visibility, "shared");
    assert.deepEqual(JSON.parse(await readFile(pendingFile, "utf8")).documents["plan.html"], both);
  }

  // Cancelling is local: with A still shared it removes the choices and sends nothing.
  const cancelled = await cli("publish", plan, "--discard-pending", "--json");
  assert.equal(cancelled.code, 0, cancelled.stderr);
  assert.deepEqual(JSON.parse(cancelled.stdout), { discarded: true, published: [] });
  assert.equal(state.writes.length, before);
  assert.equal(state.documents.prj_alpha.visibility, "shared");
  await assert.rejects(readFile(pendingFile), { code: "ENOENT" });
  assert.equal((await cli("publish", plan, "--discard-pending", "--internal")).code, 5);
  assert.equal(state.writes.length, before);
});

test("the newest choice wins when an earlier one is bound to the default project", async (context) => {
  const projects = (root) => [named("prj_default", root.split("/").at(-1)), named("prj_other", "Other")];
  const first = await projectsFixture(context, projects);
  first.state.offline = true;
  assert.equal((await first.cli("publish", first.plan, "--shared")).code, 4);
  first.state.offline = false;
  const internal = await first.cli("publish", first.plan, "--project", "prj_default", "--internal", "--json");
  assert.equal(internal.code, 0, internal.stderr);
  assert.equal(JSON.parse(internal.stdout).document.visibility, "internal");
  assert.equal(first.state.writes.at(-1).visibility, "internal");
  assert.equal(first.state.documents.prj_default.visibility, "internal");
  await assert.rejects(readFile(first.pendingFile), { code: "ENOENT" });

  // The same sequence with set: the older choice must not be replayed by the next publish.
  const second = await projectsFixture(context, projects);
  second.state.documents.prj_default = { visibility: "shared" };
  second.state.offline = true;
  assert.equal((await second.cli("publish", second.plan, "--shared")).code, 4);
  second.state.offline = false;
  const set = await second.cli("set", second.plan, "--project", "prj_default", "--internal");
  assert.equal(set.code, 0, set.stderr);
  assert.equal(second.state.documents.prj_default.visibility, "internal");
  await writeFile(join(second.root, second.plan), second.original + "<p>Edit</p>");
  const next = await second.cli("publish", second.plan);
  assert.equal(next.code, 0, next.stderr);
  assert.equal(second.state.writes.at(-1).project, "prj_default");
  assert.notEqual(second.state.writes.at(-1).visibility, "shared");
  assert.equal(second.state.documents.prj_default.visibility, "internal");
});

test("a choice saved without a project is never applied to an explicit --project", async (context) => {
  const { cli, plan, state, pendingFile } = await projectsFixture(context,
    (root) => [named("prj_default", root.split("/").at(-1)), named("prj_other", "Other")]);
  state.documents.prj_other = { visibility: "internal" };
  state.offline = true;
  assert.equal((await cli("publish", plan, "--shared")).code, 4);
  state.offline = false;
  assert.deepEqual(JSON.parse(await readFile(pendingFile, "utf8")).documents["plan.html"], [{ visibility: "shared" }]);

  // The choice is bound to the workspace's default project and the upload to the other project stops.
  const waiting = [{ visibility: "shared", project: "prj_default" }];
  const override = await cli("publish", plan, "--project", "prj_other");
  assert.equal(override.code, 5, override.stderr);
  assert.match(override.stderr, /another project/);
  assert.equal(state.writes.length, 0);
  assert.equal(state.documents.prj_other.visibility, "internal");
  assert.deepEqual(JSON.parse(await readFile(pendingFile, "utf8")).documents["plan.html"], waiting);

  // An explicit choice for the other project is its own. It leaves the default project's choice waiting, even
  // though this first successful publish records the other project for the workspace.
  const explicit = await cli("publish", plan, "--project", "prj_other", "--internal");
  assert.equal(explicit.code, 0, explicit.stderr);
  assert.equal(state.documents.prj_other.visibility, "internal");
  assert.deepEqual(JSON.parse(await readFile(pendingFile, "utf8")).documents["plan.html"], waiting);

  const retry = await cli("publish", plan);
  assert.equal(retry.code, 0, retry.stderr);
  assert.equal(state.writes.at(-1).project, "prj_default");
  assert.equal(state.writes.at(-1).visibility, "shared");
  assert.equal(state.documents.prj_other.visibility, "internal");
  await assert.rejects(readFile(pendingFile), { code: "ENOENT" });
});

test("a choice saved before the workspace has any project is never handed to a named project", async (context) => {
  const { cli, plan, plans, root, state, pendingFile } = await projectsFixture(context, () => [named("prj_other", "Other")]);
  state.documents.prj_other = { visibility: "internal" };
  state.offline = true;
  assert.equal((await cli("publish", plan, "--shared")).code, 4);
  state.offline = false;
  const waiting = async () => JSON.parse(await readFile(pendingFile, "utf8")).documents["plan.html"];

  // Publishing a different file to a named project would record that project as the workspace default.
  await writeFile(join(root, ".plans/other.html"), "<!doctype html><title>Other</title><p>Other</p>");
  for (const command of [["publish", ".plans/other.html", "--project", "prj_other", "--internal"], ["publish", plan, "--project", "prj_other"],
    ["sync", "--project", "prj_other"], ["set", plan, "--project", "prj_other", "--internal"]]) {
    const stopped = await cli(...command);
    assert.equal(stopped.code, 5, command.join(" ") + ": " + stopped.stderr);
    assert.match(stopped.stderr, /Pending visibility for plan\.html was saved before this workspace had a project/);
  }
  assert.equal(state.writes.length, 0);
  assert.equal(state.documents.prj_other.visibility, "internal");
  await assert.rejects(readFile(join(plans, ".postplan.json")), { code: "ENOENT" });
  assert.equal((await waiting()).some((entry) => entry.visibility === "shared" && !entry.project), true);

  // Stating the file's project and visibility outright replaces the earlier choice.
  const explicit = await cli("publish", plan, "--project", "prj_other", "--internal");
  assert.equal(explicit.code, 0, explicit.stderr);
  assert.match(explicit.stderr, /Replaced an earlier pending visibility choice/);
  assert.equal(state.writes.length, 1);
  assert.equal(state.writes[0].visibility, "internal");
  assert.equal(state.documents.prj_other.visibility, "internal");
  // Only the stopped command's own choice for the other file is still waiting.
  assert.deepEqual(JSON.parse(await readFile(pendingFile, "utf8")).documents,
    { "other.html": [{ visibility: "internal", project: "prj_other" }] });
  const plain = await cli("publish", plan);
  assert.equal(plain.code, 0, plain.stderr);
  assert.equal(state.documents.prj_other.visibility, "internal");
});

test("remove takes a document off the hub, sync leaves it alone, and publish restores it as internal", async (context) => {
  const { cli, plan, plans, root, original, state } = await projectsFixture(context, () => [named("prj_alpha", "Alpha")]);
  assert.equal((await cli("publish", plan, "--project", "prj_alpha", "--shared")).code, 0);
  // The file was renamed after its first publish, so the record carries the document's original key.
  const recordFile = join(plans, ".postplan.json");
  const renamed = JSON.parse(await readFile(recordFile, "utf8"));
  renamed.documents["plan.html"].docKey = "first-name.html";
  await writeFile(recordFile, JSON.stringify(renamed));
  // A shared choice is still waiting, saved under the project's name.
  await writeFile(join(root, plan), original + "<p>Edit</p>");
  state.offline = true;
  assert.equal((await cli("publish", plan, "--project", "Alpha", "--shared")).code, 4);
  state.offline = false;

  const removed = await cli("remove", plan, "--json");
  assert.equal(removed.code, 0, removed.stderr);
  assert.equal(JSON.parse(removed.stdout).removed.id, "doc_prj_alpha");
  assert.equal(state.documents.prj_alpha, undefined);
  assert.equal(await readFile(join(root, plan), "utf8"), original + "<p>Edit</p>");
  await assert.rejects(readFile(join(plans, ".postplan.pending.json")), { code: "ENOENT" });
  assert.match((await cli("status")).stdout, /removed from the hub/);

  // The changed file is not put back by sync, with or without --project, and a second remove fails cleanly.
  const writes = state.writes.length;
  for (const scope of [[], ["--project", "prj_alpha"], ["--project", "Alpha"]]) {
    const syncing = await cli("sync", "--json", ...scope);
    assert.equal(syncing.code, 0, syncing.stderr);
    assert.deepEqual(JSON.parse(syncing.stdout), { published: [], skipped: 1 });
    assert.equal(state.writes.length, writes);
  }
  const again = await cli("remove", plan);
  assert.equal(again.code, 5);
  assert.match(again.stderr, /not found/);

  // Publishing the file by name restores the same document key with no visibility request, so it is internal.
  const back = await cli("publish", plan);
  assert.equal(back.code, 0, back.stderr);
  assert.equal(state.writes.length, writes + 1);
  assert.equal(state.writes.at(-1).docKey, "first-name.html");
  assert.equal(state.writes.at(-1).visibility, "internal");
  assert.equal(state.documents.prj_alpha.visibility, "internal");
  await assert.rejects(readFile(join(plans, ".postplan.removals.json")), { code: "ENOENT" });
  assert.doesNotMatch((await cli("status")).stdout, /removed from the hub/);
});

test("remove keeps a visibility choice that belongs to another project", async (context) => {
  const { cli, plan, state, pendingFile } = await projectsFixture(context, () => [named("prj_alpha", "Alpha"), named("prj_beta", "Beta")]);
  assert.equal((await cli("publish", plan, "--project", "prj_alpha")).code, 0);
  state.offline = true;
  assert.equal((await cli("publish", plan, "--project", "Beta", "--shared")).code, 4);
  assert.equal((await cli("publish", plan, "--project", "Alpha", "--shared")).code, 4);
  state.offline = false;
  assert.equal((await cli("remove", plan)).code, 0);
  assert.deepEqual(JSON.parse(await readFile(pendingFile, "utf8")).documents["plan.html"], [{ visibility: "shared", project: "prj_beta" }]);
});

test("remove by document ID clears the choice waiting for that document's file, with no local record", async (context) => {
  const { cli, plan, plans, state, pendingFile } = await projectsFixture(context, () => [named("prj_alpha", "Alpha")]);
  // The document is on the hub, published from elsewhere. Here only a failed shared publish is waiting.
  state.documents.prj_alpha = { visibility: "internal" };
  state.offline = true;
  assert.equal((await cli("publish", plan, "--project", "prj_alpha", "--shared")).code, 4);
  state.offline = false;
  await assert.rejects(readFile(join(plans, ".postplan.json")), { code: "ENOENT" });
  // The mock's document IDs are short, so pass one in the real format that the mock also serves.
  state.documents.aaaaaaaaaaaaaaaa = state.documents.prj_alpha;
  delete state.documents.prj_alpha;
  state.projects = [named("aaaaaaaaaaaaaaaa", "Alpha")];
  await writeFile(pendingFile, JSON.stringify({ apiUrl: JSON.parse(await readFile(pendingFile, "utf8")).apiUrl,
    documents: { "plan.html": [{ visibility: "shared", project: "aaaaaaaaaaaaaaaa" }] } }));

  const removed = await cli("remove", "doc_aaaaaaaaaaaaaaaa", "--project", "aaaaaaaaaaaaaaaa", "--json");
  assert.equal(removed.code, 0, removed.stderr);
  assert.deepEqual(JSON.parse(removed.stdout).removed, { id: "doc_aaaaaaaaaaaaaaaa", paths: ["plan.html"] });
  await assert.rejects(readFile(pendingFile), { code: "ENOENT" });
  await assert.rejects(readFile(join(plans, ".postplan.json")), { code: "ENOENT" });
  const back = await cli("publish", plan, "--project", "aaaaaaaaaaaaaaaa");
  assert.equal(back.code, 0, back.stderr);
  assert.equal(state.writes.at(-1).visibility, "internal");
  assert.equal(state.documents.aaaaaaaaaaaaaaaa.visibility, "internal");
});

test("a removal whose answer is lost is finished by a retry, and a failed one loses nothing", async (context) => {
  const { cli, plan, root, original, state, pendingFile } = await projectsFixture(context, () => [named("prj_alpha", "Alpha")]);
  assert.equal((await cli("publish", plan, "--project", "prj_alpha", "--shared")).code, 0);
  await writeFile(join(root, plan), original + "<p>Edit</p>");
  state.offline = true;
  assert.equal((await cli("publish", plan, "--internal")).code, 4);
  const waiting = [{ visibility: "internal", project: "prj_alpha" }];

  // The request never reaches the server: nothing is recorded, the document is still shared there, and the
  // internal choice survives, so the next sync publishes the edit as internal.
  assert.equal((await cli("remove", plan)).code, 4);
  state.offline = false;
  assert.equal(state.documents.prj_alpha.visibility, "shared");
  assert.deepEqual(JSON.parse(await readFile(pendingFile, "utf8")).documents["plan.html"], waiting);
  assert.equal(JSON.parse((await cli("sync", "--json")).stdout).published.length, 1);
  assert.equal(state.writes.at(-1).visibility, "internal");

  // Share it again and queue another internal edit.
  assert.equal((await cli("publish", plan, "--shared")).code, 0);
  await writeFile(join(root, plan), original + "<p>Second edit</p>");
  state.offline = true;
  assert.equal((await cli("publish", plan, "--internal")).code, 4);
  state.offline = false;
  const writes = state.writes.length;

  // The server removes it but the answer is lost. The choice still waits until a retry confirms the removal.
  state.loseDeleteResponse = true;
  assert.equal((await cli("remove", plan)).code, 4);
  state.loseDeleteResponse = false;
  assert.equal(state.documents.prj_alpha, undefined);
  assert.deepEqual(JSON.parse(await readFile(pendingFile, "utf8")).documents["plan.html"], waiting);
  const retry = await cli("remove", plan);
  assert.equal(retry.code, 0, retry.stderr);
  await assert.rejects(readFile(pendingFile), { code: "ENOENT" });
  assert.equal((await cli("remove", plan)).code, 5);
  assert.deepEqual(JSON.parse((await cli("sync", "--json")).stdout), { published: [], skipped: 1 });
  assert.equal(state.writes.length, writes);
});

test("a removal that is never confirmed cannot bring the document back shared", async (context) => {
  const { cli, plan, root, original, state, pendingFile } = await projectsFixture(context, () => [named("prj_alpha", "Alpha")]);
  assert.equal((await cli("publish", plan, "--project", "prj_alpha")).code, 0);
  await writeFile(join(root, plan), original + "<p>Edit</p>");
  state.offline = true;
  assert.equal((await cli("publish", plan, "--shared")).code, 4);
  state.offline = false;
  state.loseDeleteResponse = true;
  assert.equal((await cli("remove", plan)).code, 4);
  state.loseDeleteResponse = false;
  await assert.rejects(readFile(pendingFile), { code: "ENOENT" });
  // No retry: the owner publishes the file again instead. The removal was never confirmed, so it goes up as internal.
  const back = await cli("publish", plan);
  assert.equal(back.code, 0, back.stderr);
  assert.equal(state.writes.at(-1).visibility, "internal");
  assert.equal(state.documents.prj_alpha.visibility, "internal");
});

test("a removal that never reached the server is reported and cannot publish an edit as shared", async (context) => {
  const { cli, plan, root, original, state } = await projectsFixture(context, () => [named("prj_alpha", "Alpha")]);
  assert.equal((await cli("publish", plan, "--project", "prj_alpha", "--shared")).code, 0);
  state.dropDelete = true;
  assert.equal((await cli("remove", plan)).code, 4);
  state.dropDelete = false;
  assert.equal(state.documents.prj_alpha.visibility, "shared");
  const retryCommand = /Run esho-plans remove doc_prj_alpha --project prj_alpha/;
  const shown = await cli("status");
  assert.match(shown.stdout, /plan\.html · shared · removal not confirmed/);
  assert.match(shown.stdout, retryCommand);
  // Reported even though the file is unchanged and nothing needs uploading.
  const idle = await cli("sync", "--json");
  assert.equal(idle.code, 5);
  assert.match(idle.stderr, retryCommand);
  assert.equal(JSON.parse(idle.stdout).unconfirmed[0].retry, "esho-plans remove doc_prj_alpha --project prj_alpha");

  // Sync does not upload the edit, says why, and does not report success.
  await writeFile(join(root, plan), original + "<p>Private edit</p>");
  const writes = state.writes.length;
  const syncing = await cli("sync", "--json");
  assert.equal(syncing.code, 5);
  assert.match(syncing.stderr, /removal of plan\.html was not confirmed/);
  assert.match(syncing.stderr, retryCommand);
  assert.deepEqual(JSON.parse(syncing.stdout), { published: [], skipped: 1, unconfirmed: [{ document: "doc_prj_alpha",
    project: "prj_alpha", paths: ["plan.html"], retry: "esho-plans remove doc_prj_alpha --project prj_alpha" }] });
  assert.equal(state.writes.length, writes);

  // Publishing the file anyway sends the edit as internal, although the document is still shared on the hub.
  const published = await cli("publish", plan);
  assert.equal(published.code, 0, published.stderr);
  assert.equal(state.writes.at(-1).visibility, "internal");
  assert.equal(state.documents.prj_alpha.visibility, "internal");
  assert.doesNotMatch((await cli("status")).stdout, /removal/);

  // Asking for shared again is honoured.
  state.dropDelete = true;
  assert.equal((await cli("remove", plan)).code, 4);
  state.dropDelete = false;
  const shared = await cli("publish", plan, "--shared");
  assert.equal(shared.code, 0, shared.stderr);
  assert.equal(state.writes.at(-1).visibility, "shared");
});

test("the retry for an interrupted removal names its own document and project", async (context) => {
  // Real-format IDs, so the printed retry command can be run as given. The mock's document ID is doc_<project>.
  const alpha = "aaaaaaaaaaaaaaaa";
  const beta = "bbbbbbbbbbbbbbbb";
  const { cli, plan, plans, state } = await projectsFixture(context, () => [named(alpha, "Alpha"), named(beta, "Beta")]);
  assert.equal((await cli("publish", plan, "--project", alpha, "--shared")).code, 0);
  assert.equal((await cli("publish", plan, "--project", beta, "--shared")).code, 0);
  state.dropDelete = true;
  assert.equal((await cli("remove", plan, "--project", beta)).code, 4);
  state.dropDelete = false;
  const retry = "esho-plans remove doc_" + beta + " --project " + beta;
  const syncing = await cli("sync", "--project", beta);
  assert.equal(syncing.code, 5);
  assert.ok(syncing.stderr.includes("Run " + retry), syncing.stderr);
  // Running exactly that command removes Beta's document and leaves Alpha's, the workspace default, alone.
  const done = await cli(...retry.split(" ").slice(1));
  assert.equal(done.code, 0, done.stderr);
  assert.equal(state.documents[beta], undefined);
  assert.equal(state.documents[alpha].visibility, "shared");
  assert.equal(JSON.parse(await readFile(join(plans, ".postplan.removals.json"), "utf8")).removals.length, 1);
  assert.equal((await cli("sync")).code, 0);
});

test("an interrupted removal by ID is reported in a workspace with no publish record", async (context) => {
  const alpha = "aaaaaaaaaaaaaaaa";
  const { cli, plans, state } = await projectsFixture(context, () => [named(alpha, "Alpha")]);
  state.documents[alpha] = { visibility: "shared" };
  state.dropDelete = true;
  assert.equal((await cli("remove", "doc_" + alpha, "--project", alpha)).code, 4);
  state.dropDelete = false;
  await assert.rejects(readFile(join(plans, ".postplan.json")), { code: "ENOENT" });
  const shown = await cli("status", "--json");
  assert.equal(shown.code, 0, shown.stderr);
  assert.deepEqual(JSON.parse(shown.stdout).unconfirmed, [{ document: "doc_" + alpha, project: alpha, paths: ["plan.html"],
    retry: "esho-plans remove doc_" + alpha + " --project " + alpha }]);
  assert.match((await cli("status")).stdout, /was not confirmed/);
});

test("restoring a removed document is internal even if it was shared again from elsewhere", async (context) => {
  const { cli, plan, plans, root, original, state } = await projectsFixture(context, () => [named("prj_alpha", "Alpha")]);
  assert.equal((await cli("publish", plan, "--project", "prj_alpha", "--shared")).code, 0);
  assert.equal((await cli("remove", plan)).code, 0);
  // Another computer restores the same document as shared.
  state.documents.prj_alpha = { visibility: "shared" };
  await writeFile(join(root, plan), original + "<p>Private edit</p>");
  const restored = await cli("publish", plan);
  assert.equal(restored.code, 0, restored.stderr);
  assert.equal(state.writes.at(-1).visibility, "internal");
  assert.equal(state.documents.prj_alpha.visibility, "internal");

  // A second, interrupted removal after an earlier confirmed one leaves a single unconfirmed entry.
  assert.equal((await cli("remove", plan)).code, 0);
  state.documents.prj_alpha = { visibility: "shared" };
  state.dropDelete = true;
  assert.equal((await cli("remove", plan)).code, 4);
  state.dropDelete = false;
  const entries = JSON.parse(await readFile(join(plans, ".postplan.removals.json"), "utf8")).removals;
  assert.deepEqual(entries, [{ project: "prj_alpha", document: "doc_prj_alpha", keys: ["plan.html"] }]);
  assert.match((await cli("status")).stdout, /plan\.html · \w+ · removal not confirmed/);
});

test("a removed file that can no longer be read does not stop sync for other plans", async (context) => {
  const { cli, plan, root, state } = await projectsFixture(context, () => [named("prj_alpha", "Alpha"), named("prj_beta", "Beta")]);
  assert.equal((await cli("publish", plan, "--project", "prj_alpha")).code, 0);
  assert.equal((await cli("remove", plan)).code, 0);
  await writeFile(join(root, plan), "x".repeat(1_500_001));
  await writeFile(join(root, ".plans/second.html"), "<!doctype html><title>Second</title><p>Second</p>");
  const writes = state.writes.length;
  const syncing = await cli("sync", "--json");
  assert.equal(syncing.code, 0, syncing.stderr);
  const result = JSON.parse(syncing.stdout);
  assert.equal(result.published.length, 1);
  assert.equal(result.skipped, 1);
  assert.equal(state.writes.length, writes + 1);
  assert.equal(state.writes.at(-1).docKey, "second.html");
  // For a project where the file is not removed, the size limit still applies before anything is uploaded.
  const other = await cli("sync", "--project", "prj_beta");
  assert.equal(other.code, 5);
  assert.match(other.stderr, /limited to 1500000 bytes/);
  assert.equal(state.writes.length, writes + 1);
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
