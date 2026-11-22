#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { apiClient, apiOrigin, CliError, keyFormat, saveCredentials, type Api } from "./api.js";
import {
  contentHash, docKey, gitMetadata, htmlFiles, listProjects, locate, pendingFor, planHtml, projectFor, readPendingVisibility,
  readRecord, readRemovals, replacePending, resolvePending, settlePending, unboundChoice, withRecordLock, workspace, writePendingVisibility,
  writeRecord, writeRemovals, type DocumentMetadata, type PendingMap, type PendingVisibility, type Project, type Removal, type Visibility, type WorkspaceRecord,
} from "./workspace.js";

const usage = `Usage
  esho-plans login [--no-browser]
  esho-plans publish <file> [--note <text>] [--shared | --internal] [--project <id|name>] [--title <title>]
                     [--discard-pending] [--json]
  esho-plans sync [--workspace <dir>] [--project <id|name>] [--json]
  esho-plans status [--workspace <dir>] [--json]
  esho-plans share [--replace | --revoke | --passcode <code> | --no-passcode] [--project <id|name>] [--json]
  esho-plans set <file|docId> --shared | --internal [--document <docId>] [--project <id|name>] [--json]
  esho-plans remove <file|docId> [--project <id|name>] [--json]
  esho-plans projects [--json]`;

const common = { help: { type: "boolean", short: "h" }, json: { type: "boolean" } } as const;
const project = { project: { type: "string" } } as const;
const visibility = { shared: { type: "boolean" }, internal: { type: "boolean" } } as const;
const commands = {
  login: { "no-browser": { type: "boolean" } },
  publish: { ...project, ...visibility, note: { type: "string" }, title: { type: "string" }, "discard-pending": { type: "boolean" } },
  sync: { ...project, workspace: { type: "string" } },
  status: { workspace: { type: "string" } },
  share: { ...project, replace: { type: "boolean" }, revoke: { type: "boolean" }, passcode: { type: "string" }, "no-passcode": { type: "boolean" } },
  set: { ...project, ...visibility, document: { type: "string" } },
  remove: { ...project },
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

// Removal attempts the server never confirmed. Each names its own document and project, so the retry cannot
// land on a file of the same name in another project.
function outstandingRemovals(removals: Removal[]) {
  return removals.filter((entry) => !entry.confirmed).map((entry) => ({
    document: entry.document, project: entry.project, paths: entry.keys,
    retry: "esho-plans remove " + entry.document + " --project " + entry.project,
  }));
}

function removalNotice(item: { document: string; paths: string[]; retry: string }) {
  return "The removal of " + (item.paths[0] ?? item.document) + " was not confirmed, so it may still be on the hub. Run " + item.retry;
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
    // An unconfirmed removal is still reported when the workspace has no plans to publish.
    const outstanding = command === "sync" ? outstandingRemovals(await readRemovals(root, origin)) : [];
    print({ published: [], skipped: 0, ...(outstanding.length ? { unconfirmed: outstanding } : {}) },
      ["There are no HTML plans to publish."], !!flags.json);
    for (const item of outstanding) console.error(removalNotice(item));
    if (outstanding.length) process.exitCode = 5;
    return;
  }
  return withRecordLock(root, async () => {
    const previous = await readRecord(root, origin);
    const pending = await readPendingVisibility(root, origin);
    const projectHint = option(flags, "project")?.trim() || undefined;
    const selectedVisibility = visibilityFlag(flags);
    if (flags["discard-pending"]) {
      // Cancelling is local only. It never uploads, so the cancelled edit stays on this computer.
      if (!target || selectedVisibility || projectHint) throw new CliError(5, "Use --discard-pending with a file and no other publish options.");
      const discarded = pending.delete(target.key);
      if (discarded) await writePendingVisibility(root, origin, pending);
      print({ discarded, published: [] }, [discarded
        ? "Discarded the pending visibility choices for " + target.key + ". Nothing was published."
        : "No visibility choice is waiting for " + target.key + ". Nothing was published."], !!flags.json);
      return;
    }
    if (target && selectedVisibility) {
      // Saved before any network request, so the choice survives a failed publish. With no --project it goes to
      // the project of the file's only waiting choice, else to the workspace's recorded project.
      const waiting = pending.get(target.key) ?? [];
      const project = projectHint ?? (waiting.length === 1 ? waiting[0].project : undefined) ?? previous?.project.id;
      replacePending(pending, target.key, (entry) => entry.project === project, { visibility: selectedVisibility, project });
      await writePendingVisibility(root, origin, pending);
    }
    const removals = await readRemovals(root, origin);
    const candidates: { path: string; key: string; html: string; unreadable?: unknown }[] = [];
    let skipped = 0;
    for (const path of files) {
      const key = await docKey(root, path);
      let html = "";
      let unreadable: unknown;
      try {
        html = await planHtml(path);
      } catch (error) {
        // A removed file is not uploaded by sync, so its contents must not stop the other plans. Whether it is
        // removed for this command's project is only known once that project is resolved.
        if (command !== "sync" || !removals.some((entry) => entry.keys.includes(key))) throw error;
        unreadable = error;
      }
      if (!unreadable && command === "sync" && !projectHint && !pending.has(key) && previous?.documents[key]?.contentHash === contentHash(html)) {
        skipped += 1;
      } else {
        candidates.push({ path, key, html, unreadable });
      }
    }
    // Every sync reports removals that are still unconfirmed, even when no file needs uploading.
    const reportUnconfirmed = () => {
      const outstanding = command === "sync" ? outstandingRemovals(removals) : [];
      for (const item of outstanding) console.error(removalNotice(item));
      if (outstanding.length) process.exitCode = 5;
    };
    const unconfirmedJson = () => {
      const outstanding = command === "sync" ? outstandingRemovals(removals) : [];
      return outstanding.length ? { unconfirmed: outstanding } : {};
    };
    if (!candidates.length) {
      print({ published: [], skipped, ...unconfirmedJson() }, ["All plans are current."], !!flags.json);
      reportUnconfirmed();
      return;
    }
    if (!target && !projectHint && !previous && candidates.some(({ key }) => pending.get(key)?.some((entry) => entry.project))) {
      throw new CliError(5, "Select the pending publish's project with --project or retry that file with publish.");
    }
    const api = await apiClient(origin);
    const gitRemote = gitMetadata(root, candidates[0].path).remote;
    const projects = await listProjects(api);
    // Settle every saved choice on one exact project before choosing where this command publishes.
    // Only a command that states the file's project and visibility outright may replace a stale choice for it.
    const replacement = target && selectedVisibility && projectHint ? target.key : undefined;
    const settled = await settlePending(api, root, previous, pending, projects, gitRemote, replacement);
    let changed = settled.changed;
    // A retry with no --project goes to the project of the file's only waiting choice.
    const unclear = !!target && (settled.ambiguous.has(target.key) || settled.missing.has(target.key));
    const waiting = target && !unclear ? pending.get(target.key) ?? [] : [];
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
    // Sync leaves a removed document alone, however the project was chosen. Publishing the file by name restores it.
    // A removal applies to a path only while that path still refers to the removed document. A path that was
    // later assigned to another document (set --document) is that other document's.
    const currentId = (key: string) => previous?.project.id === remote.id ? previous.documents[key]?.id : undefined;
    const removalFor = (key: string) => removals.find((entry) => entry.project === remote.id && entry.keys.includes(key) &&
      (!currentId(key) || currentId(key) === entry.document));
    const removedHere = (key: string) => !!removalFor(key);
    if (command === "sync") {
      const kept = candidates.filter(({ key }) => !removedHere(key));
      skipped += candidates.length - kept.length;
      candidates.splice(0, candidates.length, ...kept);
      if (!candidates.length) {
        print({ published: [], skipped, ...unconfirmedJson() }, ["All plans are current."], !!flags.json);
        reportUnconfirmed();
        return;
      }
    }
    const unread = candidates.find((candidate) => candidate.unreadable);
    if (unread) throw unread.unreadable;
    stopForUnboundChoice(pending, !!lookup);
    const forThisProject = (entry: PendingVisibility) => entry.project === remote.id;
    for (const { key } of candidates) {
      if (settled.ambiguous.has(key)) {
        throw new CliError(5, "Pending visibility for " + key + " names more than one project. Retry that file with --project <project ID> and --shared or --internal.");
      }
      if (settled.missing.has(key)) {
        throw new CliError(5, "Pending visibility for " + key + " was saved for a project that no longer exists. Retry that file with --project <project> and --shared or --internal, or cancel the choice with publish <file> --discard-pending, which uploads nothing.");
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
      // Restoring a document this workspace removed. It may still be on the hub, or back there as shared from
      // another computer, so the edit goes up as internal unless the owner asks for shared.
      const visibility = intent?.visibility ?? (removalFor(key) ? "internal" : undefined);
      const receipt = await publishFile(api, root, path, key, html, record, flags, visibility);
      if (canSave) await writeRecord(root, record);
      // Clear only the choice that was just applied.
      if (replacePending(pending, key, forThisProject)) await writePendingVisibility(root, origin, pending);
      // The document is on the hub again, so it is no longer a removed one.
      // Only the removal of the document that was actually published is cleared.
      const restored = (entry: Removal) => entry.project === remote.id && entry.document === receipt.document.id;
      if (removals.some(restored)) {
        const remaining = removals.filter((entry) => !restored(entry));
        removals.splice(0, removals.length, ...remaining);
        await writeRemovals(root, origin, remaining);
      }
      published.push(receipt);
      if (command === "sync" && !flags.json) console.log(receiptLines(receipt).join("\n"));
    }
    if (command === "publish") print(published[0], receiptLines(published[0]), !!flags.json);
    else if (flags.json) print({ published, skipped, ...unconfirmedJson() }, [], true);
    reportUnconfirmed();
  });
}

async function status(origin: string, flags: Flags) {
  const root = await workspace(option(flags, "workspace") ?? process.cwd(), flags.workspace !== undefined);
  const record = await readRecord(root, origin);
  const removals = await readRemovals(root, origin);
  // Shown whether or not this workspace has a publish record or the file is listed in it.
  const outstanding = outstandingRemovals(removals);
  const notices = outstanding.map(removalNotice);
  if (!record) {
    print({ project: null, documents: [], ...(outstanding.length ? { unconfirmed: outstanding } : {}) },
      ["This workspace has no published plans.", ...notices], !!flags.json);
    return;
  }
  const documents = await Promise.all(Object.entries(record.documents).map(async ([path, entry]) => {
    const file = await readFile(resolve(root, ".plans", path), "utf8").catch(() => null);
    const here = removals.filter((item) => item.project === record.project.id && item.document === entry.id && item.keys.includes(path));
    const state = here.some((item) => !item.confirmed) ? "removal not confirmed"
      : here.length ? "removed from the hub"
      : file === null ? "missing locally" : contentHash(file.replace(/^\uFEFF/, "")) === entry.contentHash ? "current" : "local changes";
    return { path, ...entry, state };
  }));
  print({ project: record.project, documents, ...(outstanding.length ? { unconfirmed: outstanding } : {}) }, [
    record.project.name, ...documents.map((entry) => entry.path + " · " + entry.visibility + " · " + entry.state + " · " + entry.privateUrl),
    ...notices,
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

// Takes a document off the hub. The local file stays. Sync skips it from then on, and publishing the file by
// name puts the same document back as internal.
async function removeDocument(api: Api, origin: string, target: string, flags: Flags) {
  const suppliedId = /^doc_[A-Za-z0-9_-]{16}$/.test(target);
  const targetFile = suppliedId ? null : await locate(target);
  const root = targetFile?.root ?? await workspace(process.cwd());
  await withRecordLock(root, async () => {
    const previous = await readRecord(root, origin);
    const pending = await readPendingVisibility(root, origin);
    const projects = await listProjects(api);
    // Settle saved choices first, so one saved under this project's name is recognised as this project's.
    if ((await settlePending(api, root, previous, pending, projects)).changed) await writePendingVisibility(root, origin, pending);
    const { project: remote } = await projectFor(api, root, previous, option(flags, "project")?.trim() || undefined, false, undefined, projects);
    const known = previous?.project.id === remote.id ? previous.documents : {};
    const { documents } = await api<{ documents: DocumentMetadata[] }>("/projects/" + remote.id + "/documents");
    const key = targetFile?.key;
    const matchId = suppliedId ? target : key && known[key]?.id;
    const match = documents.find((document) => matchId ? document.id === matchId : document.doc_key === key);
    const removals = await readRemovals(root, origin);
    // A path belongs to a document unless the workspace record maps it to a different one (set --document).
    // Another document's path, and the visibility choice waiting for it, are never touched by this removal.
    const ownPath = (documentId: string) => (path: string) => !known[path] || known[path].id === documentId;
    // An earlier attempt that never heard back from the server is finished here once the document is gone.
    let removal = removals.find((entry) => entry.project === remote.id && !entry.confirmed &&
      (match ? entry.document === match.id : entry.document === matchId || (!!key && entry.keys.includes(key))));
    if (!match && !removal) throw new CliError(5, "Document not found in this project.");
    if (match) {
      // Every path this document is known by: local files recorded for it, the file named now, and its key on the hub.
      // A new attempt replaces every earlier entry for this document, confirmed or not, and keeps their paths.
      const earlier = removals.filter((entry) => entry.project === remote.id && entry.document === match.id);
      const keys = new Set([...Object.keys(known).filter((path) => known[path].id === match.id), match.doc_key,
        ...earlier.flatMap((entry) => entry.keys)].filter(ownPath(match.id)));
      if (key && ownPath(match.id)(key)) keys.add(key);
      const others = removals.filter((entry) => !earlier.includes(entry));
      removal = { project: remote.id, document: match.id, keys: [...keys] };
      removals.splice(0, removals.length, ...others, removal);
      // First, a waiting request to share is dropped, so no later publish can bring the document back shared.
      // This comes before the removal is recorded: if either write fails, a share request made before the
      // removal can never be found next to it. Dropping a share request is always safe on its own. A waiting
      // request for internal stays until the removal is confirmed, because dropping it early could publish a
      // private edit to a document that is still shared.
      let unshared = false;
      for (const path of keys) {
        unshared = replacePending(pending, path, (choice) => choice.project === remote.id && choice.visibility === "shared") || unshared;
      }
      if (unshared) await writePendingVisibility(root, origin, pending);
      // Recorded before the request, so a lost response cannot leave this removal unfinished.
      await writeRemovals(root, origin, removals);
      await api("/documents/" + match.id, "DELETE");
    }
    const done = removal!;
    // A visibility choice still waiting for the removed document must not come back with it.
    let cleared = false;
    for (const path of done.keys.filter(ownPath(done.document))) {
      cleared = replacePending(pending, path, (choice) => choice.project === remote.id) || cleared;
    }
    if (cleared) await writePendingVisibility(root, origin, pending);
    done.confirmed = true;
    await writeRemovals(root, origin, removals);
    print({ removed: { id: done.document, paths: done.keys } },
      ["Removed " + (match?.doc_key ?? done.keys[0] ?? done.document) + " from " + remote.name + ". The local file is unchanged."], !!flags.json);
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
      const required = name === "publish" || name === "set" || name === "remove";
      if (positionals.length !== (required ? 1 : 0)) throw new CliError(5, "Check the arguments with esho-plans --help.");
      const origin = apiOrigin();
      switch (name) {
        case "login": await login(origin, flags); break;
        case "publish":
        case "sync": await runPublish(origin, name, flags, positionals[0]); break;
        case "status": await status(origin, flags); break;
        case "share": await share(await apiClient(origin), origin, flags); break;
        case "set": await setVisibility(await apiClient(origin), origin, positionals[0], flags); break;
        case "remove": await removeDocument(await apiClient(origin), origin, positionals[0], flags); break;
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
