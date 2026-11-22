import { constants } from "node:fs";
import { chmod, mkdir, open, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

const production = "https://postplan.esho.dev";
const credentialsFile = join(homedir(), ".config", "esho-plans", "credentials.json");
export const keyFormat = /^epk_[A-Za-z0-9_-]{43}$/;

export class CliError extends Error {
  constructor(readonly code: 2 | 3 | 4 | 5, message: string, readonly choices?: unknown[]) {
    super(message);
  }
}

export function apiOrigin() {
  const setting = process.env.ESHO_PLANS_API_URL || production;
  try {
    const url = new URL(setting);
    const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    if ((url.protocol === "https:" || (local && url.protocol === "http:")) && url.pathname === "/" &&
      !url.search && !url.hash && !url.username && !url.password) return url.origin;
  } catch {
    // Report a short message without reproducing the input URL.
  }
  throw new CliError(5, "ESHO_PLANS_API_URL must be an HTTPS origin or an HTTP loopback origin.");
}

async function credentials(origin: string) {
  const environment = process.env.ESHO_PLANS_API_KEY;
  if (environment !== undefined) {
    if (!keyFormat.test(environment)) throw new CliError(3, "ESHO_PLANS_API_KEY is invalid.");
    return environment;
  }
  try {
    const file = await open(credentialsFile, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if ((await file.stat()).mode & 0o077) throw new CliError(3, "Publish key file must have mode 0600.");
      const value: { apiUrl?: string; apiKey?: string } = JSON.parse(await file.readFile("utf8"));
      if (value.apiUrl === origin && typeof value.apiKey === "string" && keyFormat.test(value.apiKey)) return value.apiKey;
    } finally {
      await file.close();
    }
  } catch (error) {
    if (error instanceof CliError) throw error;
  }
  throw new CliError(3, "Run esho-plans login to connect this CLI.");
}

export async function saveCredentials(origin: string, key: string) {
  const directory = dirname(credentialsFile);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temp = join(directory, ".credentials-" + randomUUID());
  const file = await open(temp, "wx", 0o600);
  try {
    try {
      await file.writeFile(JSON.stringify({ apiUrl: origin, apiKey: key }) + "\n");
      await file.sync();
    } finally {
      await file.close();
    }
    await chmod(temp, 0o600);
    await rename(temp, credentialsFile);
  } finally {
    await rm(temp, { force: true });
  }
}

export type Api = <T>(path: string, method?: string, body?: object) => Promise<T>;

export async function apiClient(origin: string, provided?: string): Promise<Api> {
  const key = provided ?? await credentials(origin);
  return async function request<T>(path: string, method = "GET", body?: object): Promise<T> {
    let response: Response;
    try {
      response = await fetch(origin + "/api/v1" + path, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
        headers: { Authorization: "Bearer " + key, ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body && JSON.stringify(body),
      });
    } catch {
      throw new CliError(4, "Could not reach Esho Plans.");
    }
    if (response.status === 401) throw new CliError(3, "Publish key rejected. Run esho-plans login.");
    const decoded: unknown = await response.json().catch(() => null);
    if (!response.ok || decoded === null) {
      const message = (decoded as { error?: unknown } | null)?.error;
      throw new CliError(5, typeof message === "string" ? message : "Server rejected the request (" + response.status + ").");
    }
    return decoded as T;
  };
}
