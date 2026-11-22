export type WorkerBindings = {
  DB: D1Database;
  ASSETS: Fetcher;
  APP_HOST: string;
  CONTENT_HOST?: string;
  LOCAL_DEV?: string;
  OWNER_GITHUB_ID?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  SESSION_KEY: string;
  GRANT_KEY: string;
  LINK_ENC_KEY: string;
  KEY_PEPPER: string;
  PASSCODE_PEPPER: string;
};

export type Bindings = WorkerBindings & {
  REQUEST_APP_ORIGIN: string;
  REQUEST_CONTENT_ORIGIN: string | null;
};

export type OwnerSession = {
  token: string;
  idHash: string;
  expiresAt: string;
  lastSeenAt: string;
};

export type AppEnv = {
  Bindings: Bindings;
  Variables: { owner: OwnerSession; appOrigin: string; contentOrigin: string | null };
};

export const notFound = "Not Found";
export const sandbox = "allow-scripts allow-popups allow-popups-to-escape-sandbox";
export const maxHtmlBytes = 1_500_000;
export const sessionSeconds = 30 * 86400;
export const date = (offsetSeconds = 0) => new Date(Date.now() + offsetSeconds * 1000).toISOString();
