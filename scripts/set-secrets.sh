#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$repo_dir/apps/site"

node --input-type=module -e '
  import { spawnSync } from "node:child_process";
  import { randomBytes } from "node:crypto";
  const list = spawnSync("pnpm", ["exec", "wrangler", "secret", "list", "--format", "json"], { encoding: "utf8" });
  if (list.status !== 0) {
    process.stderr.write(list.stderr || "Could not list Worker secrets.\n");
    process.exit(1);
  }
  const existing = new Set(JSON.parse(list.stdout).map((entry) => entry.name));
  const secrets = Object.fromEntries(
    ["GRANT_KEY", "LINK_ENC_KEY", "SESSION_KEY", "KEY_PEPPER", "PASSCODE_PEPPER"]
      .filter((name) => !existing.has(name))
      .map((name) => [name, randomBytes(32).toString("hex")])
  );
  if (!Object.keys(secrets).length) {
    console.log("All generated Worker secrets are present.");
    process.exit(0);
  }
  const put = spawnSync("pnpm", ["exec", "wrangler", "secret", "bulk"], {
    input: JSON.stringify(secrets), stdio: ["pipe", "inherit", "inherit"],
  });
  process.exit(put.status ?? 1);
'
