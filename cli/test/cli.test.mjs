import { strict as assert } from "node:assert";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { test } from "node:test";

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
