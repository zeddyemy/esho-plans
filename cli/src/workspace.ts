import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { open, readFile, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { setTimeout } from "node:timers/promises";
import { type Api, CliError } from "./api.js";

export type Visibility = "internal" | "shared";
export type Project = { id: string; name: string; repo_hint: string | null; workspace_hint: string | null };
export type DocumentMetadata = { id: string; doc_key: string; content_hash: string; visibility: Visibility; updated_at: string };
export type RecordEntry = { id: string; visibility: Visibility; privateUrl: string; contentHash: string; publishedAt: string; docKey?: string };
export type WorkspaceRecord = { apiUrl: string; project: { id: string; name: string }; documents: Record<string, RecordEntry> };

const recordName = ".postplan.json";

export async function workspace(start: string, exact = false) {
  let current = resolve(start);
  for (;;) {
    const plans = join(current, ".plans");
    if ((await stat(plans).catch(() => null))?.isDirectory()) return realpath(current);
    const parent = dirname(current);
    if (exact || parent === current) throw new CliError(5, "Could not find a workspace containing .plans/.");
    current = parent;
  }
}

export async function locate(file: string) {
  const path = await realpath(file).catch(() => { throw new CliError(5, "HTML file not found."); });
  const root = await workspace(dirname(path));
  return { root, path, key: await docKey(root, path) };
}

export async function docKey(root: string, path: string) {
  const planDirectory = join(root, ".plans");
  if (await realpath(planDirectory) !== planDirectory) throw new CliError(5, ".plans must be inside the workspace.");
  const key = relative(planDirectory, path);
  if (!key || isAbsolute(key) || key === ".." || key.startsWith(".." + sep) || !key.endsWith(".html")) {
    throw new CliError(5, "Select an HTML file inside the workspace’s .plans/ directory.");
  }
  return key.split(sep).join("/");
}

export async function htmlFiles(root: string) {
  const files: string[] = [];
  async function walk(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith(".")) await walk(path);
      else if (entry.isFile() && entry.name.endsWith(".html")) files.push(path);
    }
  }
  await walk(join(root, ".plans"));
  return files.sort();
}

export async function readRecord(root: string, origin: string) {
  try {
    const entry = JSON.parse(await readFile(join(root, ".plans", recordName), "utf8")) as WorkspaceRecord;
    if (entry.apiUrl !== origin) throw new CliError(5, "The workspace record is for a different API origin.");
    if (!entry.project?.id || !entry.project.name || !entry.documents || Array.isArray(entry.documents)) {
      throw new CliError(5, "The workspace publish record is invalid.");
    }
    return entry;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (error instanceof CliError) throw error;
    throw new CliError(5, "Could not read the workspace publish record.");
  }
}

export async function writeRecord(root: string, record: WorkspaceRecord) {
  const destination = join(root, ".plans", recordName);
  const temporary = destination + "." + randomUUID() + ".tmp";
  const file = await open(temporary, "wx", 0o600);
  try {
    try {
      await file.writeFile(JSON.stringify(record, null, 2) + "\n");
    } finally {
      await file.close();
    }
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function withRecordLock<T>(root: string, work: () => Promise<T>) {
  const path = join(root, ".plans", ".postplan.lock");
  if (await realpath(dirname(path)) !== dirname(path)) throw new CliError(5, ".plans must be inside the workspace.");
  const until = Date.now() + 20_000;
  for (;;) {
    let file;
    try {
      file = await open(path, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() >= until) throw new CliError(5, "Another publish is using this workspace. Try again when it finishes.");
      await setTimeout(250);
      continue;
    }
    try {
      await file.writeFile(String(process.pid));
      return await work();
    } finally {
      await file.close();
      await rm(path, { force: true });
    }
  }
}

function git(root: string, args: string[]) {
  try {
    return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}

function repoHint(remote: string | null) {
  if (!remote) return null;
  const ssh = /^(?:[^@/]+@)?([a-z0-9.-]+):([\w./-]+)$/i.exec(remote);
  let hostname = ssh?.[1];
  let path = ssh?.[2];
  if (!hostname || !path) {
    try {
      const url = new URL(remote);
      if (url.protocol !== "https:" && url.protocol !== "http:" && url.protocol !== "ssh:") return null;
      hostname = url.hostname;
      path = url.pathname.replace(/^\//, "");
    } catch {
      return null;
    }
  }
  const parts = path.replace(/\.git$/, "").replace(/\/$/, "");
  if (!/^[\w.-]+(?:\/[\w.-]+)+$/.test(parts)) return null;
  return hostname.toLowerCase() === "github.com" ? parts.toLowerCase() : hostname.toLowerCase() + "/" + parts;
}

export function gitMetadata(root: string, file: string) {
  const directory = dirname(file);
  const repository = git(directory, ["rev-parse", "--show-toplevel"]) ? directory : root;
  return {
    branch: git(repository, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
    commit: git(repository, ["rev-parse", "HEAD"]),
    remote: repoHint(git(repository, ["remote", "get-url", "origin"])),
  };
}

export async function projectFor(api: Api, root: string, record: WorkspaceRecord | null, hint?: string, create = false, remote?: string | null) {
  const { projects } = await api<{ projects: Project[] }>("/projects");
  const label = basename(root);
  const workspaceRemote = remote ?? gitMetadata(root, join(root, "workspace")).remote;
  let matches: Project[];
  if (hint) {
    matches = projects.filter((item) => item.id === hint);
    if (!matches.length) matches = projects.filter((item) => item.name.toLowerCase() === hint.toLowerCase());
  } else if (record) {
    matches = projects.filter((item) => item.id === record.project.id);
  } else {
    matches = workspaceRemote ? projects.filter((item) => item.repo_hint === workspaceRemote) : [];
    if (!matches.length) {
      matches = projects.filter((item) => item.name.toLowerCase() === label.toLowerCase());
      if (matches.length === 1 && workspaceRemote && matches[0].repo_hint && matches[0].repo_hint !== workspaceRemote) {
        throw new CliError(2, "A project with this workspace name uses a different Git remote. Choose its ID to use it.",
          matches.map(({ id, name, repo_hint }) => ({ id, name, repo: repo_hint })));
      }
    }
  }
  if (matches.length > 1) {
    throw new CliError(2, "Several projects match. Use --project with an ID.",
      matches.map(({ id, name, repo_hint }) => ({ id, name, repo: repo_hint })));
  }
  if (matches[0]) return { project: matches[0], created: false };
  if (hint || record || !create) throw new CliError(2, "No project matches this workspace. Publish a plan or use --project.",
    projects.map(({ id, name }) => ({ id, name })));
  const idempotencyKey = createHash("sha256").update(workspaceRemote ? "repo:" + workspaceRemote : "workspace:" + root).digest("base64url");
  const { project } = await api<{ project: Project }>("/projects", "POST", { name: label, workspaceHint: label, repoHint: workspaceRemote, idempotencyKey });
  return { project, created: true };
}

export async function planHtml(path: string) {
  const file = await readFile(path);
  if (file.byteLength > 1_500_000) throw new CliError(5, "HTML is limited to 1500000 bytes.");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(file);
  } catch {
    throw new CliError(5, "Use a UTF-8 HTML file.");
  }
}

export function contentHash(html: string) {
  return "sha256:" + createHash("sha256").update(html).digest("base64url");
}
