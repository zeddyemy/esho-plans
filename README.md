# Esho Plans

Esho Plans is a private hub for HTML plans, grouped by project. The current Worker serves a health check on the app host and rejects other hosts. Storage, sign-in and publishing come in later phases.

## Run locally

Use Node.js 24 and pnpm 11.20.0.

```sh
pnpm install --frozen-lockfile
pnpm dev
```

The health check is at `http://127.0.0.1:8787/healthz`. The dev command enables loopback requests in Wrangler's local runtime.

```sh
pnpm check  # TypeScript
pnpm test   # Worker integration tests
pnpm build  # Bundle locally with Wrangler's dry run
```

The content hostname will be configured once its exact `workers.dev` hostname is known. [Hono on Cloudflare Workers](https://hono.dev/docs/getting-started/cloudflare-workers), [Cloudflare Worker test configuration](https://developers.cloudflare.com/workers/testing/vitest-integration/configuration/).
