#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { apiClient, apiOrigin, CliError, keyFormat, saveCredentials, type Api } from "./api.js";
import {
  contentHash, docKey, gitMetadata, htmlFiles, listProjects, locate, pendingFor, planHtml, projectFor, readPendingVisibility,
  readRecord, replacePending, resolvePending, settlePending, unboundChoice, withRecordLock, workspace, writePendingVisibility,
  writeRecord, type DocumentMetadata, type PendingMap, type PendingVisibility, type Project, type Visibility, type WorkspaceRecord,
} from "./workspace.js";

const usage = `Usage
  esho-plans login [--no-browser]
  esho-plans publish <file> [--note <text>] [--shared | --internal] [--project <id|name>] [--title <title>] [--json]
  esho-plans sync [--workspace <dir>] [--project <id|name>] [--json]
  esho-plans status [--workspace <dir>] [--json]
  esho-plans share [--replace | --revoke | --passcode <code> | --no-passcode] [--project <id|name>] [--json]
  esho-plans set <file|docId> --shared | --internal [--document <docId>] [--project <id|name>] [--json]
  esho-plans projects [--json]`;

const common = { help: { type: "boolean", short: "h" }, json: { type: "boolean" } } as const;
const project = { project: { type: "string" } } as const;
const visibility = { shared: { type: "boolean" }, internal: { type: "boolean" } } as const;
const commands = {
  login: { "no-browser": { type: "boolean" } },
  publish: { ...project, ...visibility, note: { type: "string" }, title: { type: "string" } },
  sync: { ...project, workspace: { type: "string" } },
  status: { workspace: { type: "string" } },
  share: { ...project, replace: { type: "boolean" }, revoke: { type: "boolean" }, passcode: { type: "string" }, "no-passcode": { type: "boolean" } },
  set: { ...project, ...visibility, document: { type: "string" } },
  projects: {},
} as const;
type Command = keyof typeof commands;
type Flags = Record<string, unknown>;
type Receipt = {
  document: { id: string; docKey: string; visibility: Visibility; contentHash: string; updatedAt: string };
  changed: boolean; overwrote: boolean; privateUrl: string; clientUrl: string | null;
};

function option(flags: Flags, name: string) {
  const value = flags[name];
  return typeof value === "string" ? value : undefined;
}

function visibilityFlag(flags: Flags) {
  if (flags.shared && flags.internal) throw new CliError(5, "Choose either --shared or --internal.");
  return flags.shared ? "shared" : flags.internal ? "internal" : undefined;
}

function print(value: unknown, lines: string[], json: boolean | undefined) {
  process.stdout.write((json ? JSON.stringify(value) : lines.join("\n")) + "\n");
}

function titleFor(html: string, path: string) {
  const title = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html)?.[1].replace(/\s+/g, " ").trim();
  const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return title?.replace(/&(amp|quot|apos|lt|gt|nbsp|#39);/g, (_, name: string) => entities[name] ?? "'")
    || basename(path, ".html").replaceAll("-", " ");
}

function warnScriptHosts(html: string, path: string) {
  const allowed = new Set(["cdn.jsdelivr.net", "unpkg.com", "cdnjs.cloudflare.com"]);
  const hosts = new Set<string>();
  const sources = html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']|\b(?:from\s+|import\s+|import\(\s*)["'](https?:\/\/[^"']+)["']/gi);
  for (const match of sources) {
    const url = match[1] ?? match[2];
    try {
      const parsed = new URL(url.startsWith("//") ? "https:" + url : url);
      if (parsed.protocol !== "https:" || !allowed.has(parsed.hostname)) hosts.add(parsed.hostname || parsed.protocol);
    } catch {
      hosts.add("relative script URLs");
    }
  }
  if (hosts.size) console.error("Some scripts in " + basename(path) + " may be blocked: " + [...hosts].join(", "));
}

async function publishFile(api: Api, root: string, path: string, key: string, html: string, record: WorkspaceRecord, flags: Flags, visibility?: Visibility) {
  const previous = record.documents[key];
  const git = gitMetadata(root, path);
  warnScriptHosts(html, path);
  const receipt = await api<Receipt>("/projects/" + record.project.id + "/documents", "PUT", {
    docKey: previous?.docKey ?? key,
    title: option(flags, "title") ?? titleFor(html, path),
    html,
    visibility,
    note: option(flags, "note"),
    git: { branch: git.branch, commit: git.commit },
    expectedHash: previous?.contentHash,
  });
  record.documents[key] = {
    id: receipt.document.id, visibility: receipt.document.visibility, privateUrl: receipt.privateUrl,
    contentHash: receipt.document.contentHash, publishedAt: receipt.document.updatedAt,
    ...(receipt.document.docKey === key ? {} : { docKey: receipt.document.docKey }),
  };
  return receipt;
}

function receiptLines(receipt: Receipt) {
  return [
    (receipt.changed ? "Published" : "Already current") + " (" + receipt.document.visibility + ") " + receipt.privateUrl,
    ...(receipt.clientUrl ? ["Client link " + receipt.clientUrl] : []),
    ...(receipt.overwrote ? ["Warning: this overwrote a version published elsewhere."] : []),
  ];
}

// A choice with no project belongs to the workspace's default project. Publishing to a named project while that
// default is unknown could record the named project as the default and hand it every such choice.
function stopForUnboundChoice(pending: PendingMap, namedProject: boolean) {
  if (!namedProject) return;
  for (const [key, entries] of pending) {
    if (entries.some(unboundChoice)) {
      throw new CliError(5, "Pending visibility for " + key + " was saved before this workspace had a project. Retry that publish without --project first, or give it --project with --shared or --internal.");
    }
  }
}

function recordFor(origin: string, remote: Project, previous: WorkspaceRecord | null) {
  if (previous?.project.id === remote.id) return previous;
  return { apiUrl: origin, project: { id: remote.id, name: remote.name }, documents: {} } satisfies WorkspaceRecord;
}

async function runPublish(origin: string, command: "publish" | "sync", flags: Flags, file?: string) {
  const target = file ? await locate(file) : null;
  const root = target?.root ?? await workspace(option(flags, "workspace") ?? process.cwd(), flags.workspace !== undefined);
  const files = target ? [target.path] : await htmlFiles(root);
  if (!files.length) {
    print({ published: [], skipped: 0 }, ["There are no HTML plans to publish."], !!flags.json);
    return;
  }
  return withRecordLock(root, async () => {
    const previous = await readRecord(root, origin);
    const pending = await readPendingVisibility(root, origin);
    const projectHint = option(flags, "project")?.trim() || undefined;
    const selectedVisibility = visibilityFlag(flags);
    if (target && selectedVisibility) {
      // Saved before any network request, so the choice survives a failed publish. With no --project it goes to
      // the project of the file's only waiting choice, else to the workspace's recorded project.
      const waiting = pending.get(target.key) ?? [];
      const project = projectHint ?? (waiting.length === 1 ? waiting[0].project : undefined) ?? previous?.project.id;
      replacePending(pending, target.key, (entry) => entry.project === project, { visibility: selectedVisibility, project });
      await writePendingVisibility(root, origin, pending);
    }
    const candidates: { path: string; key: string; html: string }[] = [];
    let skipped = 0;
    for (const path of files) {
      const key = await docKey(root, path);
      const html = await planHtml(path);
      if (command === "sync" && !projectHint && !pending.has(key) && previous?.documents[key]?.contentHash === contentHash(html)) {
        skipped += 1;
      } else {
        candidates.push({ path, key, html });
      }
    }
    if (!candidates.length) {
      print({ published: [], skipped }, ["All plans are current."], !!flags.json);
      return;
    }
    if (!target && !projectHint && !previous && candidates.some(({ key }) => pending.get(key)?.some((entry) => entry.project))) {
      throw new CliError(5, "Select the pending publish's project with --project or retry that file with publish.");
    }
    const api = await apiClient(origin);
    const gitRemote = gitMetadata(root, candidates[0].path).remote;
    const projects = await listProjects(api);
    // Settle every saved choice on one exact project before choosing where this command publishes.
    const settled = await settlePending(api, root, previous, pending, projects, gitRemote);
    let changed = settled.changed;
    for (const notice of settled.discarded) console.error(notice);
    // A retry with no --project goes to the project of the file's only waiting choice.
    const waiting = target && !settled.ambiguous.has(target.key) ? pending.get(target.key) ?? [] : [];
    const lookup = projectHint ?? (waiting.length === 1 ? waiting[0].project : undefined);
    const { project: remote, created } = await projectFor(api, root, previous, lookup, true, gitRemote, projects);
    if (!lookup && !settled.home) {
      // This command resolved or created the workspace's default project.
      changed = resolvePending(pending, [...projects, remote], remote.id).changed || changed;
    } else if (!settled.home && projectHint && target && selectedVisibility && pendingFor(pending, target.key, unboundChoice)) {
      // The workspace has no default project yet, and this command states the file's project and visibility outright.
      replacePending(pending, target.key, unboundChoice);
      console.error("Replaced an earlier pending visibility choice for " + target.key + " that had no project.");
      changed = true;
    }
    if (changed) await writePendingVisibility(root, origin, pending);
    stopForUnboundChoice(pending, !!lookup);
    const forThisProject = (entry: PendingVisibility) => entry.project === remote.id;
    for (const { key } of candidates) {
      if (settled.ambiguous.has(key)) {
        throw new CliError(5, "Pending visibility for " + key + " names more than one project. Retry that file with --project <project ID> and --shared or --internal.");
      }
      if (pending.has(key) && !pendingFor(pending, key, forThisProject)) {
        throw new CliError(5, "Pending visibility for " + key + " belongs to another project. Retry that publish for its own project first.");
      }
    }
    const record = recordFor(origin, remote, previous);
    const canSave = !previous || previous.project.id === remote.id;
    const published: Receipt[] = [];
    if (created) console.error("Created project " + remote.name + " (" + remote.id + ").");
    for (const { path, key, html } of candidates) {
      const intent = pendingFor(pending, key, forThisProject);
      const receipt = await publishFile(api, root, path, key, html, record, flags, intent?.visibility);
      if (canSave) await writeRecord(root, record);
      // Clear only the choice that was just applied.
      if (replacePending(pending, key, forThisProject)) await writePendingVisibility(root, origin, pending);
      published.push(receipt);
      if (command === "sync" && !flags.json) console.log(receiptLines(receipt).join("\n"));
    }
    if (command === "publish") print(published[0], receiptLines(published[0]), !!flags.json);
    else if (flags.json) print({ published, skipped }, [], true);
  });
}

async function status(origin: string, flags: Flags) {
  const root = await workspace(option(flags, "workspace") ?? process.cwd(), flags.workspace !== undefined);
  const record = await readRecord(root, origin);
  if (!record) {
    print({ project: null, documents: [] }, ["This workspace has no published plans."], !!flags.json);
    return;
  }
  const documents = await Promise.all(Object.entries(record.documents).map(async ([path, entry]) => {
    const file = await readFile(resolve(root, ".plans", path), "utf8").catch(() => null);
    const state = file === null ? "missing locally" : contentHash(file.replace(/^\uFEFF/, "")) === entry.contentHash ? "current" : "local changes";
    return { path, ...entry, state };
  }));
  print({ project: record.project, documents }, [
    record.project.name, ...documents.map((entry) => entry.path + " · " + entry.visibility + " · " + entry.state + " · " + entry.privateUrl),
  ], !!flags.json);
}

async function share(api: Api, origin: string, flags: Flags) {
  const actions = ["replace", "revoke", "passcode", "no-passcode"].filter((flag) => flags[flag] !== undefined);
  if (actions.length > 1) throw new CliError(5, "Choose one link action.");
  const root = await workspace(process.cwd());
  const { project: remote } = await projectFor(api, root, await readRecord(root, origin), option(flags, "project"));
  const endpoint = "/projects/" + remote.id + "/link";
  type Result = { link: { url: string; requiresPasscode: boolean; lastUsedAt: string | null } | null };
  let result: Result;
  switch (actions[0]) {
    case "revoke":
      result = await api<Result>(endpoint, "DELETE");
      break;
    case "replace":
      result = await api<Result>(endpoint, "POST", { action: "replace" });
      break;
    case "passcode":
    case "no-passcode":
      result = await api<Result>(endpoint, "POST", { action: "passcode", passcode: option(flags, "passcode") ?? null });
      break;
    default:
      result = await api<Result>(endpoint);
      if (!result.link) result = await api<Result>(endpoint, "POST", { action: "create" });
      break;
  }
  print(result, result.link ? [result.link.url, ...(result.link.requiresPasscode ? ["Passcode required."] : [])] : ["Client link revoked."], !!flags.json);
}

async function setVisibility(api: Api, origin: string, target: string, flags: Flags) {
  const next = visibilityFlag(flags);
  if (!next) throw new CliError(5, "Use --shared or --internal.");
  const suppliedId = /^doc_[A-Za-z0-9_-]{16}$/.test(target);
  const targetFile = suppliedId ? null : await locate(target);
  const alias = option(flags, "document");
  if (alias && (!targetFile || !/^doc_[A-Za-z0-9_-]{16}$/.test(alias))) throw new CliError(5, "Use --document with a file and an existing document ID.");
  const root = targetFile?.root ?? await workspace(process.cwd());
  await withRecordLock(root, async () => {
    const previous = await readRecord(root, origin);
    const pending = await readPendingVisibility(root, origin);
    const projectHint = option(flags, "project")?.trim() || undefined;
    const projects = await listProjects(api);
    const settled = await settlePending(api, root, previous, pending, projects);
    for (const notice of settled.discarded) console.error(notice);
    if (settled.changed) await writePendingVisibility(root, origin, pending);
    const { project: remote } = await projectFor(api, root, previous, projectHint, false, undefined, projects);
    stopForUnboundChoice(pending, !!projectHint);
    const record = recordFor(origin, remote, previous);
    const { documents } = await api<{ documents: DocumentMetadata[] }>("/projects/" + remote.id + "/documents");
    const key = targetFile?.key;
    const matchId = alias ?? (suppliedId ? target : key && record.documents[key]?.id);
    const match = documents.find((document) => matchId ? document.id === matchId : document.doc_key === key);
    if (!match) throw new CliError(5, "Document not found in this project.");
    const entries = key ? [key] : Object.keys(record.documents).filter((path) => record.documents[path].id === match.id);
    let updatedPending = false;
    for (const entry of entries) {
      const forThisProject = (intent: PendingVisibility) => intent.project === remote.id;
      if (pendingFor(pending, entry, forThisProject)) {
        replacePending(pending, entry, forThisProject, { visibility: next, project: remote.id });
        updatedPending = true;
      }
    }
    if (updatedPending) await writePendingVisibility(root, origin, pending);
    const { document } = await api<{ document: DocumentMetadata }>("/documents/" + match.id, "PATCH", { visibility: next });
    const privateUrl = origin + "/p/" + remote.id + "/d/" + document.id;
    for (const entry of entries) {
      const known = record.documents[entry];
      record.documents[entry] = {
        id: document.id, visibility: document.visibility, privateUrl,
        ...(known?.id === document.id ? { contentHash: known.contentHash, publishedAt: known.publishedAt } : {}),
        ...(document.doc_key === entry ? {} : { docKey: document.doc_key }),
      };
    }
    if (entries.length && (!previous || previous.project.id === remote.id)) await writeRecord(root, record);
    print({ document, privateUrl }, ["Updated (" + document.visibility + ") " + privateUrl], !!flags.json);
  });
}

async function readKey() {
  if (!process.stdin.isTTY) {
    const input = createInterface({ input: process.stdin, terminal: false });
    try {
      for await (const line of input) return line.trim();
      return "";
    } finally {
      input.close();
    }
  }
  process.stderr.write("Paste your publish key: ");
  const wasRaw = process.stdin.isRaw;
  process.stdin.setRawMode(true);
  try {
    return await new Promise<string>((resolveKey, reject) => {
      let key = "";
      function finish() {
        process.stdin.off("data", onData);
        process.stdin.pause();
      }
      function onData(buffer: Buffer) {
        for (const character of buffer.toString()) {
          if (character === "\x03" || character === "\x04") {
            finish();
            reject(new CliError(3, "Login cancelled."));
            return;
          }
          if (character === "\r" || character === "\n") {
            finish();
            resolveKey(key.trim());
            return;
          }
          if (character === "\x7f") key = key.slice(0, -1);
          else if (key.length < 256) key += character;
        }
      }
      process.stdin.on("data", onData);
      process.stdin.resume();
    });
  } finally {
    process.stdin.setRawMode(wasRaw);
    process.stderr.write("\n");
  }
}

async function login(origin: string, flags: Flags) {
  const url = origin + "/cli/auth";
  console.error("Create a publish key at " + url);
  if (!flags["no-browser"] && process.stdin.isTTY) {
    const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
    const child = spawn(opener, [url], { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  }
  const key = await readKey();
  if (!keyFormat.test(key)) throw new CliError(3, "Invalid publish key.");
  const api = await apiClient(origin, key);
  await api("/whoami");
  await saveCredentials(origin, key);
  print({ ok: true }, ["Publish key saved."], !!flags.json);
}

const [command, ...args] = process.argv.slice(2);
try {
  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log(usage);
  } else {
    if (!Object.hasOwn(commands, command)) throw new CliError(5, "Unknown command. Run esho-plans --help.");
    const name = command as Command;
    const { values, positionals } = parseArgs({ args, options: { ...common, ...commands[name] }, allowPositionals: true });
    const flags: Flags = values;
    if (flags.help) {
      console.log(usage);
    } else {
      const required = name === "publish" || name === "set";
      if (positionals.length !== (required ? 1 : 0)) throw new CliError(5, "Check the arguments with esho-plans --help.");
      const origin = apiOrigin();
      switch (name) {
        case "login": await login(origin, flags); break;
        case "publish":
        case "sync": await runPublish(origin, name, flags, positionals[0]); break;
        case "status": await status(origin, flags); break;
        case "share": await share(await apiClient(origin), origin, flags); break;
        case "set": await setVisibility(await apiClient(origin), origin, positionals[0], flags); break;
        case "projects": {
          const { projects } = await (await apiClient(origin))<{ projects: Project[] }>("/projects");
          print({ projects }, projects.length ? projects.map((item) => item.id + "  " + item.name) : ["There are no projects."], !!flags.json);
          break;
        }
      }
    }
  }
} catch (cause) {
  const error = cause instanceof CliError ? cause : new CliError(5, cause instanceof Error ? cause.message : "The command failed.");
  if (error.code === 2) console.error(JSON.stringify({ error: error.message, choices: error.choices ?? [] }));
  else if (error.code === 4 && (command === "publish" || command === "sync")) console.error("Saved locally. Publishing stopped because Esho Plans could not be reached.");
  else console.error(error.message);
  process.exitCode = error.code;
}
