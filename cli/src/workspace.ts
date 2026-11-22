import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdtemp, open, readFile, readdir, realpath, rename, rm, rmdir, stat, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { setTimeout } from "node:timers/promises";
import { type Api, CliError } from "./api.js";

export type Visibility = "internal" | "shared";
export type Project = { id: string; name: string; repo_hint: string | null; workspace_hint: string | null };
export type DocumentMetadata = { id: string; doc_key: string; content_hash: string; visibility: Visibility; updated_at: string };
// `removed` marks a document taken off the hub. The entry stays so that sync leaves the file alone and an
// explicit publish restores the same document, including one whose file was renamed (docKey).
export type RecordEntry = {
  id: string; visibility: Visibility; privateUrl: string; contentHash?: string; publishedAt?: string; docKey?: string; removed?: true;
};
export type WorkspaceRecord = { apiUrl: string; project: { id: string; name: string }; documents: Record<string, RecordEntry> };
export type PendingVisibility = { visibility: Visibility; project?: string };
// One file can have a pending choice for more than one project, so each file keeps a list.
export type PendingMap = Map<string, PendingVisibility[]>;

const recordName = ".postplan.json";
const pendingName = ".postplan.pending.json";

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

async function writeJson(destination: string, value: unknown) {
  const temporary = destination + "." + randomUUID() + ".tmp";
  const file = await open(temporary, "wx", 0o600);
  try {
    try {
      await file.writeFile(JSON.stringify(value, null, 2) + "\n");
    } finally {
      await file.close();
    }
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

export function writeRecord(root: string, record: WorkspaceRecord) {
  return writeJson(join(root, ".plans", recordName), record);
}

export async function readPendingVisibility(root: string, origin: string) {
  try {
    const value = JSON.parse(await readFile(join(root, ".plans", pendingName), "utf8"));
    if (value.apiUrl !== origin) throw new CliError(5, "The pending publish record is for a different API origin.");
    if (!value.documents || typeof value.documents !== "object" || Array.isArray(value.documents)) {
      throw new Error("Invalid document map.");
    }
    const pending: PendingMap = new Map();
    for (const [key, stored] of Object.entries(value.documents)) {
      // Earlier versions stored a single choice per file.
      const entries = (Array.isArray(stored) ? stored : [stored]) as PendingVisibility[];
      for (const entry of entries) {
        if (!entry || (entry.visibility !== "internal" && entry.visibility !== "shared") ||
          (entry.project !== undefined && (typeof entry.project !== "string" || !entry.project.trim()))) {
          throw new Error("Invalid pending visibility.");
        }
      }
      if (entries.length) pending.set(key, entries);
    }
    return pending;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map() as PendingMap;
    if (error instanceof CliError) throw error;
    throw new CliError(5, "Could not read the pending publish record.");
  }
}

export function pendingFor(pending: PendingMap, key: string, matches: (entry: PendingVisibility) => boolean) {
  // The most recent matching choice wins.
  return pending.get(key)?.filter(matches).at(-1);
}

/** Removes the matching choices for a file and optionally records one in their place. Other projects' choices stay. */
export function replacePending(pending: PendingMap, key: string, matches: (entry: PendingVisibility) => boolean, next?: PendingVisibility) {
  const current = pending.get(key) ?? [];
  const kept = current.filter((entry) => !matches(entry));
  if (next) kept.push(next);
  if (kept.length) pending.set(key, kept);
  else pending.delete(key);
  return !!next || kept.length !== current.length;
}

/**
 * Settles every saved choice on one exact project, in the order the choices were made.
 *
 * - A choice with no project belongs to the workspace's default project (`home`) and is bound to it when known.
 * - A project name becomes that project's ID.
 * - A name that matches several projects stays and marks the file ambiguous. A name or ID that matches no
 *   project stays and marks the file as missing its destination. Dropping either would let a retry fall back
 *   to another project and keep that project's visibility.
 * - Only `replacement` clears those: the file whose choice the current command just saved with an explicit
 *   project and visibility. An ambiguous name gives way when that choice names one of its projects, a missing
 *   destination when it names any existing project. Choices saved earlier never count as a replacement.
 * - For each project the most recent choice wins.
 */
export function resolvePending(pending: PendingMap, projects: Project[], home?: string, replacement?: string) {
  let changed = false;
  const ambiguous = new Set<string>();
  const missing = new Set<string>();
  for (const [key, entries] of [...pending]) {
    const settled: { entry: PendingVisibility; slot: string; twins?: string[]; gone?: true }[] = [];
    for (const entry of entries) {
      let project = entry.project ?? home;
      let twins: string[] | undefined;
      if (project !== undefined && !projects.some((item) => item.id === project)) {
        const name = project.toLowerCase();
        const named = projects.filter((item) => item.name.toLowerCase() === name);
        if (named.length === 1) project = named[0].id;
        else if (named.length > 1) twins = named.map((item) => item.id);
        else {
          settled.push({ entry, slot: "gone:" + name, gone: true });
          continue;
        }
      }
      settled.push({
        entry: project === entry.project ? entry : { ...entry, project },
        slot: twins ? "name:" + project!.toLowerCase() : project === undefined ? "default" : "id:" + project,
        twins,
      });
    }
    const latest = new Map<string, PendingVisibility>();
    // The command's own choice is the last one saved for its file.
    const newest = replacement === key ? settled.at(-1) : undefined;
    const chosen = newest && !newest.twins && !newest.gone ? newest.entry.project : undefined;
    settled.forEach((item) => {
      if (chosen !== undefined && (item.gone || item.twins?.includes(chosen))) return;
      if (item.twins) ambiguous.add(key);
      if (item.gone) missing.add(key);
      latest.delete(item.slot);
      latest.set(item.slot, item.entry);
    });
    const next = [...latest.values()];
    if (next.length !== entries.length || next.some((entry, index) => entry !== entries[index])) {
      if (next.length) pending.set(key, next);
      else pending.delete(key);
      changed = true;
    }
  }
  return { changed, ambiguous, missing };
}

/** Finds the workspace's default project without creating one, then settles the saved choices against it. */
export async function settlePending(api: Api, root: string, record: WorkspaceRecord | null, pending: PendingMap, projects: Project[], remote?: string | null, replacement?: string) {
  let home: Project | undefined;
  try {
    home = (await projectFor(api, root, record, undefined, false, remote, projects)).project;
  } catch (error) {
    if (!(error instanceof CliError && error.code === 2)) throw error;
  }
  return { home, ...resolvePending(pending, projects, home?.id, replacement) };
}

export const unboundChoice = (entry: PendingVisibility) => !entry.project;

export function writePendingVisibility(root: string, origin: string, pending: PendingMap) {
  const path = join(root, ".plans", pendingName);
  return pending.size ? writeJson(path, { apiUrl: origin, documents: Object.fromEntries(pending) }) : rm(path, { force: true });
}

function processIsGone(pid: string) {
  if (!/^[1-9]\d*$/.test(pid)) return false;
  try {
    process.kill(Number(pid), 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

async function removeLockMarker(path: string, marker: string) {
  await unlink(join(path, marker)).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
  });
}

async function removeEmptyLock(path: string) {
  await rmdir(path).catch((error: NodeJS.ErrnoException) => {
    if (!["ENOENT", "ENOTDIR", "ENOTEMPTY", "EEXIST"].includes(error.code ?? "")) throw error;
  });
}

async function reclaimLock(path: string) {
  const lock = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!lock) return;
  if (lock.isDirectory()) {
    const markers = await readdir(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return [];
      throw error;
    });
    if (markers.length > 1) return;
    if (markers.length === 1) {
      const pid = /^([1-9]\d*)-[\da-f-]{36}$/.exec(markers[0])?.[1];
      if (!pid || !processIsGone(pid)) return;
      await removeLockMarker(path, markers[0]);
    }
    // rmdir only removes an empty directory. A contender may already have taken over.
    await removeEmptyLock(path);
  } else if (lock.isFile()) {
    // Older CLI versions left a file with a PID, or an empty file if killed before writing it.
    const pid = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "EISDIR") return null;
      throw error;
    });
    if (pid === null || (!processIsGone(pid.trim()) && (pid !== "" || Date.now() - lock.mtimeMs < 20_000))) return;
    const current = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (current?.isFile() && current.ino === lock.ino && current.dev === lock.dev) {
      await unlink(path).catch((error: NodeJS.ErrnoException) => {
        if (!["ENOENT", "EISDIR", "EPERM"].includes(error.code ?? "")) throw error;
      });
    }
  }
}

export async function withRecordLock<T>(root: string, work: () => Promise<T>) {
  const path = join(root, ".plans", ".postplan.lock");
  if (await realpath(dirname(path)) !== dirname(path)) throw new CliError(5, ".plans must be inside the workspace.");
  const candidate = await mkdtemp(path + "-");
  const marker = process.pid + "-" + randomUUID();
  const until = Date.now() + 20_000;
  try {
    await (await open(join(candidate, marker), "wx", 0o600)).close();
    for (;;) {
      try {
        // Install a directory that already contains its owner marker as one operation.
        await rename(candidate, path);
        break;
      } catch (error) {
        if (!["EEXIST", "ENOTEMPTY", "ENOTDIR", "EISDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        await reclaimLock(path);
        if (Date.now() >= until) throw new CliError(5, "Another publish is using this workspace. Try again when it finishes.");
        await setTimeout(250);
      }
    }
    try {
      return await work();
    } finally {
      await removeLockMarker(path, marker);
      await removeEmptyLock(path);
    }
  } finally {
    await rm(candidate, { recursive: true, force: true });
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

export async function listProjects(api: Api) {
  return (await api<{ projects: Project[] }>("/projects")).projects;
}

export async function projectFor(api: Api, root: string, record: WorkspaceRecord | null, hint?: string, create = false, remote?: string | null, known?: Project[]) {
  const projects = known ?? await listProjects(api);
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
  if (matches[0]) return { project: matches[0], created: false, projects };
  if (hint || record || !create) throw new CliError(2, "No project matches this workspace. Publish a plan or use --project.",
    projects.map(({ id, name }) => ({ id, name })));
  const idempotencyKey = createHash("sha256").update(workspaceRemote ? "repo:" + workspaceRemote : "workspace:" + root).digest("base64url");
  const { project } = await api<{ project: Project }>("/projects", "POST", { name: label, workspaceHint: label, repoHint: workspaceRemote, idempotencyKey });
  return { project, created: true, projects: [...projects, project] };
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
