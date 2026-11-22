# Esho Plans

A private hub for standalone HTML plans. Sign in with GitHub to see your projects, read internal documents, and manage the link for each client. Documents load from a separate Cloudflare Workers origin inside a sandboxed frame.

## Publish a plan

Build the CLI with `pnpm --filter @esho-plans/cli build`. Run `./scripts/install-skills.sh --dry-run` to preview which local skills and executable it will link. The installer verifies a backup before changing any of the five targets. Use `--copy` to install copies of the skills and `--uninstall` to restore the last installation's backup.

```sh
esho-plans login
esho-plans publish .plans/payment-flow.html --note "Clarified the retry window"
esho-plans status
esho-plans sync --workspace /path/to/workspace
```

New documents start as internal. Publishing again with the same path updates the same URL. `--shared` makes a document visible through the project's client link. `--internal` moves it back. Pass `--project <id|name>` to choose a different project for one command. The CLI writes private URLs and content hashes to `.plans/.postplan.json`. For a renamed file, `esho-plans set .plans/renamed.html --document <docId> --internal` keeps the existing document ID and visibility you select.

If a publish with an explicit visibility fails, the CLI records that choice locally, per project, and applies it when the file is retried for the same project. A choice saved before the workspace had a project belongs to the workspace's default project and is never applied to a `--project` override. When the CLI stops because a choice is waiting for another project, retry that file with `publish` for its own project first. If the saved project no longer exists or its name matches several projects, nothing is uploaded until you retry the file with `--project <id>` and `--shared` or `--internal`, or cancel the choice with `esho-plans publish <file> --discard-pending`. Cancelling only removes the saved choice; it uploads nothing.

### Publish using the API

With the key available as `ESHO_PLANS_API_KEY` in your environment and the project ID as `project_id`, run the following from the workspace. The response contains the private URL and, for a shared document with an active link, a client URL.

```sh
jq -n --rawfile html .plans/payment-flow.html \
  '{docKey: "payment-flow.html", title: "Payment flow", note: "Updated", html: $html}' |
  curl --fail-with-body --silent --show-error \
    --config <(printf 'header = "Authorization: Bearer %s"\n' "$ESHO_PLANS_API_KEY") \
    -H 'Content-Type: application/json' --request PUT --data-binary @- \
    "https://postplan.esho.dev/api/v1/projects/${project_id}/documents"
```

## Read, change or remove a document

A document's private URL shows the document and nothing else, with one small link in the corner back to its project. Changes are commands:

```sh
esho-plans set .plans/payment-flow.html --shared      # or --internal
esho-plans remove .plans/payment-flow.html            # takes it off the hub; the local file stays
```

`sync` leaves a removed file alone. Publishing it by name (`esho-plans publish <file>`) restores the same URL as internal, and any visibility choice that was still waiting for it is dropped. Removals are kept in `.plans/.postplan.removals.json`; if a removal is not confirmed, `status` and `sync` say so and `sync` exits with an error; run `esho-plans remove` again to finish it. Publishing that file before then sends it as internal unless you pass `--shared`. Keep the revision history inside the plan itself; the hub shows only the latest version.

## Share or revoke

Open a project in the owner view. In **Client link**, choose **Create client link**, then **Copy link**. Only documents marked **Shared** appear to the client. **Replace link** issues a new link and invalidates the old one. **Turn off link** revokes it immediately. Set a passcode in the same panel if the client should need both the URL and a passcode.

```sh
esho-plans set .plans/payment-flow.html --shared
esho-plans share
esho-plans share --replace
esho-plans share --revoke
```

## Development and verification

Use Node.js 24 and pnpm 11.20.0. The built CLI requires Node.js 20 or later.

```sh
pnpm install --frozen-lockfile
pnpm --filter @esho-plans/site exec wrangler d1 migrations apply DB --local
pnpm dev
pnpm check
pnpm test
pnpm build
```

The app listens on `http://127.0.0.1:8787` and serves local documents from `http://localhost:8787`. Use the exact address for each origin. `pnpm dev` runs the `dev` environment in `apps/site/wrangler.jsonc`, which has no route so that Wrangler keeps these loopback hostnames. Deploy without `--env`. Configure local secrets in `apps/site/.dev.vars` using the example as a list of names. For local OAuth, configure a development OAuth app with the exact callback URL for the local app origin. The test suite provides its own bindings and GitHub responses.

With `ESHO_PLANS_API_KEY` set to a key for the chosen environment, run `./scripts/verify.sh <base-url>` for an HTTP smoke test. It creates two verification projects, exercises publishing and both origins, and revokes the test links on exit. Project IDs are printed so the fixtures can be identified.

## Deployment

The deployment uses Workers and D1 on Cloudflare's Free plan. The app domain is `postplan.esho.dev`. The content origin is `esho-plans.zeddyemy.workers.dev`. Set the GitHub OAuth callback to `https://postplan.esho.dev/auth/github/callback`.

From the repository root, use the following deploy command for production Workers Builds. Set `main` as the production branch and turn off non-production builds.

```sh
pnpm --filter @esho-plans/site exec wrangler d1 migrations apply DB --remote &&
  pnpm --filter @esho-plans/site exec wrangler deploy
```

- Put `GITHUB_CLIENT_SECRET` in the Worker with `wrangler secret put GITHUB_CLIENT_SECRET` from `apps/site`.
- Run `./scripts/set-secrets.sh` to populate missing Worker secrets for grants, links, sessions, publish keys and passcodes.
- The CLI stores the publish key in `~/.config/esho-plans/credentials.json` with mode 0600. `ESHO_PLANS_API_KEY` can supply a key for an individual run.
- Revoke publish keys or owner sessions from the owner's **Settings** page.
