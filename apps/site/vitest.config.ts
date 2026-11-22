import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { provide: { migrations: await readD1Migrations("./migrations") } },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: { bindings: {
        CONTENT_HOST: "esho-plans.test-account.workers.dev",
        GITHUB_CLIENT_ID: "fixture-oauth-app",
        GITHUB_CLIENT_SECRET: "fixture-oauth-secret",
        SESSION_KEY: "fixture-session",
        GRANT_KEY: "fixture-grant",
        LINK_ENC_KEY: "fixture-link-encryption",
        KEY_PEPPER: "fixture-key-pepper",
        PASSCODE_PEPPER: "fixture-passcode-pepper",
      } },
    }),
  ],
});
