CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  workspace_hint TEXT,
  repo_hint TEXT,
  create_key TEXT UNIQUE,
  created_at TEXT NOT NULL,
  archived_at TEXT
);
CREATE INDEX projects_repo ON projects(repo_hint) WHERE archived_at IS NULL;

CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  doc_key TEXT NOT NULL,
  title TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'internal' CHECK (visibility IN ('internal', 'shared')),
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  bytes INTEGER NOT NULL CHECK (bytes BETWEEN 1 AND 1500000),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  UNIQUE (project_id, doc_key)
);
CREATE INDEX documents_project_date ON documents(project_id, updated_at DESC) WHERE deleted_at IS NULL;

CREATE TABLE document_changes (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id),
  note TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  git_branch TEXT,
  git_commit TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX document_changes_date ON document_changes(document_id, created_at DESC);

CREATE TABLE share_links (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  token_hash TEXT NOT NULL UNIQUE,
  token_enc TEXT NOT NULL,
  passcode_mac TEXT,
  policy_version INTEGER NOT NULL DEFAULT 0,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);
CREATE UNIQUE INDEX one_active_link ON share_links(project_id) WHERE revoked_at IS NULL;

CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  last_used_at TEXT,
  revoked_at TEXT
);
CREATE INDEX api_keys_prefix ON api_keys(prefix) WHERE revoked_at IS NULL;

CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,
  github_user_id INTEGER NOT NULL,
  user_agent TEXT,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE TABLE oauth_attempts (
  state_hash TEXT PRIMARY KEY,
  browser_hash TEXT NOT NULL,
  verifier TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX oauth_attempts_expiry ON oauth_attempts(expires_at);
