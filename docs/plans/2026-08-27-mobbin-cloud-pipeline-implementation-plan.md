# Implement the Private Mobbin Cloud Pipeline

## Frame

Build the approved private pipeline in `tooling/` and deploy it under `/root/mobbin-data` on `myserver`.

The finished path is:

```text
Dia-authenticated Mac scraper
  -> Cloudflare Access
  -> Bun ingest on the VPS
  -> Chevereto Free
  -> private Cloudflare R2 media

                         -> SQLite control state
                         -> private R2 manifests and backups
```

Scope:

- Rewrite only the proven single-app Mobbin flow path in Bun and TypeScript.
- Keep Dia authentication and all Mobbin requests on the Mac.
- Keep WebP bytes in memory while transferring them.
- Store gallery media through Chevereto in `mobbin-media` R2.
- Store manifests, run reports, and backups in private `mobbin-control` R2.
- Deploy Chevereto, MySQL, ingest, and cloudflared without changing the existing Tradstry Caddy stack.
- Protect gallery and media with one interactive Access application; protect ingest with a separate service-token application.
- Start with no migrated images, Eagle records, or prior exporter state.

Non-goals:

- Multi-app scraping, search-mode exports, Eagle sync, local image reports, or local gallery serving.
- Automatic Chevereto album creation.
- Deleting historical app versions or media.
- Refactoring or deleting the existing scripts in `scripts/`.
- Building a custom gallery to replace Chevereto.

Success is observable when an approved user can log in once, browse a private Chevereto app album, and see a full Mobbin flow whose ordered metadata, hashes, image dimensions, Chevereto IDs, and protected media URLs match SQLite and R2. Re-running the same input must upload no duplicate per-app media and must fetch only missing screens.

## Evidence

- **Settled:** The design is approved in `docs/superpowers/specs/2026-08-27-mobbin-cloud-pipeline-design.md`.
- **Verified:** `tooling/` is a fresh Bun 1.4.0 TypeScript scaffold. It has no application code beyond `index.ts` and no installed runtime dependencies.
- **Verified:** `tooling/CLAUDE.md` requires Bun-native APIs, `Bun.serve`, `bun:sqlite`, and `bun test`.
- **Verified:** `scripts/export-mobbin-flows.mjs` already proves Dia cookie extraction, Mobbin Flight-payload parsing, flow ordering, `/api/screen/fetch-screen-info`, full-size `downloadableSrc` selection, WebP hashing, dimension checks, and bounded concurrency.
- **Verified:** `scripts/export-mobbin-screens.mjs` has successful quality checks for full-size, unique, non-tiny image exports. The new pipeline will preserve the byte, content-type, hash, and dimension checks but intentionally replaces its local path/report contract.
- **Verified:** `myserver` is Ubuntu 24.04 x86_64 with Docker 29.4.2 and Compose 5.1.3. `/root/mobbin-data` does not exist.
- **Verified:** `tradstry-caddy` alone binds VPS ports 80 and 443. The new stack must expose no host ports.
- **Verified:** The chosen upstream versions exist: Chevereto Free 4.5.7, MySQL 8.4.11, and cloudflared 2026.8.2. The local Bun version is 1.4.0.
- **Verified:** Chevereto's upload API accepts a binary file, title, description, tags, and an owned `album_id`; Chevereto Free supports WebP and S3-compatible storage.
- **Verified:** Cloudflare R2 custom domains can be protected by Access, and a concrete multi-domain Access app can eagerly set cookies for both gallery and media.

## Decisions

### Runtime and dependencies

- Use Bun 1.4.0 and strict TypeScript for the Mac CLI and VPS ingest.
- Use `zod` for shared wire validation, `jose` for Cloudflare Access JWT verification, and `@aws-sdk/client-s3` for R2. Use Bun and Web Platform APIs for everything else.
- Move TypeScript from a peer dependency to a pinned development dependency.
- Keep one package and two entry points: local CLI and server.

### Data ownership

- SQLite is the source of truth for app mappings, version/flow/screen relationships, run state, hashes, and Chevereto IDs.
- R2 manifests are immutable evidence derived from completed SQLite state.
- Chevereto owns display metadata and gallery presentation, while its configured external storage owns original and derived media.
- A run has an explicit screen membership table. This is required so limited runs and resumed runs can be completed independently.

### Idempotency and duplicate control

- A canonical SHA-256 of the exact response bytes identifies media within one app.
- `UNIQUE(app_id, sha256)` prevents normal per-app duplicate media.
- `UNIQUE(app_id, version_id, plan_sha256)` makes an identical run plan reusable.
- A short-lived SQLite upload claim serializes concurrent requests for the same `(app_id, sha256)`. Contenders receive a retryable conflict instead of uploading again.
- The final `media` row is written only after Chevereto succeeds. An expired claim is recoverable.
- Chevereto duplicate uploads must be enabled because identical bytes may legitimately belong to different app albums.
- The unavoidable crash window between Chevereto success and the SQLite commit is recorded as an operational risk; a reconciliation report must identify a suspected orphan before a retry is allowed to create another copy.

### Run state

Use these states:

```text
planned -> running -> awaiting_manifest -> completed
                    -> failed
```

Each selected run screen uses `planned | uploading | completed | failed`. `POST /v1/runs/:id/complete` moves a fully uploaded run to `awaiting_manifest`, publishes manifests, then moves it to `completed`. Calling complete again retries publication without re-uploading images.

### Security boundary

- The Mac sends `CF-Access-Client-Id`, `CF-Access-Client-Secret`, and the ingest bearer token.
- Cloudflare rejects invalid service tokens at the edge.
- Ingest also validates `Cf-Access-Jwt-Assertion` against the Access JWKS and expected audience, then compares the bearer token in constant time.
- Only cloudflared reaches Chevereto and ingest from outside Docker. No service publishes a host port.
- Local `.env.local` and VPS `/root/mobbin-data/.env` are never committed or logged.

### Exact container baseline

- `ghcr.io/chevereto/chevereto:4.5.7`
- `mysql:8.4.11`
- `cloudflare/cloudflared:2026.8.2`
- ingest built from `oven/bun:1.4.0-alpine`

Use these exact tags in the first deployment. Record the resolved image digests in the deployment report before later upgrades.

## Implementation

### P01 — Establish the Bun project contract

**Outcome:** `tooling/` has stable commands, dependency pins, configuration parsing, shared schemas, and a test harness.

**Files or surfaces:**

- `tooling/package.json`
- `tooling/bun.lock`
- `tooling/tsconfig.json`
- `tooling/.env.example`
- `tooling/src/shared/config.ts`
- `tooling/src/shared/schemas.ts`
- `tooling/src/shared/errors.ts`
- `tooling/src/shared/hashing.ts`
- `tooling/src/shared/image.ts`
- `tooling/tests/shared/*.test.ts`

**Dependencies:** Approved design only.

**Approach:**

- Add scripts for `test`, `typecheck`, `scrape`, `album:set`, `serve`, `db:migrate`, `backup`, and `restore:check`.
- Replace the placeholder `index.ts` with explicit entry points; do not keep an ambiguous default command.
- Validate local and server environment variables separately so the Mac never requires VPS-only secrets.
- Define versioned Zod schemas for app registration, run planning, screen metadata, upload responses, manifests, and structured errors.
- Accept only `image/webp` in version one, cap uploads at 64 MiB, and reject dimensions below 100 by 100 pixels.
- Keep secrets and signed URLs out of error serialization.

**Verification:**

- `bun install --frozen-lockfile` succeeds after the lockfile is generated.
- `bun run typecheck` succeeds.
- `bun test tests/shared` proves valid payloads pass, malformed IDs and oversized/non-WebP metadata fail, hashes are deterministic, and error JSON contains no configured secrets.

### P02 — Port the proven Dia and Mobbin reader

**Outcome:** The local library can turn one authenticated Mobbin app URL into ordered app/version/flow/screen metadata and fetch full-size WebP bytes without writing images.

**Files or surfaces:**

- `tooling/src/local/dia-auth.ts`
- `tooling/src/local/mobbin-page.ts`
- `tooling/src/local/mobbin-client.ts`
- `tooling/src/local/screen-source.ts`
- `tooling/tests/local/*.test.ts`
- `tooling/tests/fixtures/mobbin/*.json`

**Dependencies:** P01.

**Approach:**

- Port the relevant single-app logic from `scripts/export-mobbin-flows.mjs`; leave the existing exporter unchanged.
- Normalize `/screens` input URLs to the corresponding `/flows` page.
- Copy Dia's cookie database to a unique temporary directory, query the copy with `bun:sqlite`, obtain the Safe Storage password through `security`, decrypt only Mobbin cookies, and always remove the temporary directory in `finally`.
- Preserve the existing Chromium `v10` AES-CBC handling and host-hash stripping.
- Parse the authenticated Next.js Flight payload into app, version, flows, ordered screens, restrictions, and publish timestamps.
- Fetch `/api/screen/fetch-screen-info` only when the server says a screen is missing. Prefer `downloadableSrc`, then the largest `srcSet`, then `src`.
- Classify `401`, `403`, `429`, login redirects, missing authenticated payloads, and challenge pages as auth/rate-limit stops rather than ordinary retries.
- Build sanitized fixtures from response shapes only; fixtures must contain no cookie values or live signed CDN URLs.

**Verification:**

- Fixture tests reproduce app/version IDs, all flow IDs, flow names, screen order, and source selection from the existing parser.
- A temporary test cookie database proves copy/query/decrypt cleanup without printing values.
- Mock responses prove CAPTCHA, login redirect, and rate-limit signals stop the run before image fetching.
- A one-screen live smoke test is deferred to P10 because it requires the user's active Dia session.

### P03 — Implement SQLite migrations and repositories

**Outcome:** Ingest has transactional, resumable control state with explicit run membership and concurrent-upload claims.

**Files or surfaces:**

- `tooling/src/server/database.ts`
- `tooling/src/server/migrations.ts`
- `tooling/src/server/migrations/001_initial.sql`
- `tooling/src/server/repositories/*.ts`
- `tooling/tests/server/database.test.ts`
- `tooling/tests/server/runs.test.ts`

**Dependencies:** P01.

**Approach:**

- Create `schema_migrations`, `apps`, `app_versions`, `flows`, `screens`, `media`, `runs`, `run_screens`, and `upload_claims`.
- Preserve the approved core constraints and add:
  - `runs.plan_sha256` with `UNIQUE(app_id, version_id, plan_sha256)`;
  - nullable `screens.media_id` until upload completes;
  - `UNIQUE(run_id, screen_id)` in `run_screens`;
  - `UNIQUE(app_id, sha256)` in both final media and active claims;
  - claim owner, expiry, attempts, and sanitized last error.
- Enable `WAL`, foreign keys, and a 5-second busy timeout at every database open.
- Use immediate transactions for run planning, state changes, media linking, and claim acquisition.
- Reuse media for a previously completed Mobbin screen ID in the same app without asking the Mac to fetch it again.
- Keep migrations forward-only and safe to re-run.

**Verification:**

- Run repository tests against a temporary real SQLite file.
- Prove migrations are idempotent, constraints reject duplicates, foreign keys reject invalid links, and a second connection respects the busy timeout.
- Prove identical plans reuse one run, different limited plans get distinct runs, completed screen IDs are skipped, failed screens resume, active claims block a contender, and expired claims can be reclaimed.

### P04 — Build Chevereto and R2 adapters

**Outcome:** Ingest can upload one in-memory WebP to a registered Chevereto album and publish validated JSON artifacts to the private control bucket.

**Files or surfaces:**

- `tooling/src/server/chevereto.ts`
- `tooling/src/server/r2.ts`
- `tooling/src/server/manifests.ts`
- `tooling/tests/server/chevereto.test.ts`
- `tooling/tests/server/r2.test.ts`
- `tooling/tests/server/manifests.test.ts`

**Dependencies:** P01 and P03.

**Approach:**

- Send multipart uploads to `/api/1/upload` with `X-API-Key`, `album_id`, deterministic title, description, and comma-separated tags.
- Include app, platform, version, and every flow known to reference that screen in the current plan when first uploading it.
- Validate Chevereto's HTTP status, `status_code`, image ID, dimensions, size, direct URL, and viewer URL before committing media.
- Configure the S3 client with R2 endpoint, region `auto`, and bucket-scoped credentials.
- Write canonical JSON with stable key ordering and `application/json`; add SHA-256 as object metadata.
- Use the approved manifest keys and add `schemaVersion: 1`.
- Never include Dia cookies, source image URLs, Access headers, API keys, or raw upstream error bodies.

**Verification:**

- Mock HTTP tests inspect the exact multipart fields and headers and prove Chevereto failures create no final media row.
- R2 tests against a fake S3 server prove object keys, content type, hash metadata, overwrite behavior for the same completed plan, and secret redaction.
- Manifest tests prove screen order, dimensions, per-app hashes, Chevereto IDs, and protected media URLs match SQLite fixtures.

### P05 — Implement the authenticated ingest API

**Outcome:** A private Bun server exposes health, album mapping, run planning, idempotent screen ingest, and completion endpoints.

**Files or surfaces:**

- `tooling/src/server/index.ts`
- `tooling/src/server/auth.ts`
- `tooling/src/server/routes/health.ts`
- `tooling/src/server/routes/apps.ts`
- `tooling/src/server/routes/runs.ts`
- `tooling/src/server/services/ingest.ts`
- `tooling/tests/server/api.test.ts`
- `tooling/tests/server/auth.test.ts`

**Dependencies:** P03 and P04.

**Approach:**

- Use `Bun.serve()` and the approved `/healthz`, `/v1/apps`, `/v1/apps/:slug`, `/v1/runs`, `/v1/runs/:runId/screens`, and `/v1/runs/:runId/complete` routes.
- Add a process-only `/livez` probe for Docker. It exposes no dependency or configuration data; external requests still pass through Cloudflare Access because the service has no public host port.
- Validate the Access JWT issuer, signature, expiry, and application audience. Then validate the separate bearer token.
- Give every request a request ID and emit structured JSON logs with request ID and run ID.
- Reject an unknown app mapping before accepting a run.
- Plan all selected flows/screens in one transaction and return only unresolved screen IDs.
- For a screen upload, stream the multipart body into bounded memory, verify content type, byte count, dimensions, and claimed SHA-256, then reuse media or acquire a claim and call Chevereto.
- Return the stored result for a repeated completed screen request. Return `409` plus `Retry-After` for an active competing claim.
- Publish manifests only when every `run_screen` is completed. Keep `awaiting_manifest` state if R2 publication fails and retry on the next complete call.
- Authenticated `/healthz` reports `ok | degraded` for process, SQLite, Chevereto, media R2, and control R2 without exposing configuration.

**Verification:**

- API tests cover missing/invalid JWT, wrong audience, wrong bearer token, bad schemas, unknown app, invalid WebP, hash mismatch, duplicate requests, concurrent claims, partial completion, manifest retry, and successful completion.
- A test with six parallel requests proves one Chevereto upload occurs for one per-app hash.
- Logs captured in tests contain request/run IDs but no configured secret or image bytes.

### P06 — Implement the local commands and transfer loop

**Outcome:** The user can register an album and scrape one Mobbin app with short Bun commands and no permanent local WebP.

**Files or surfaces:**

- `tooling/src/local/cli.ts`
- `tooling/src/local/ingest-client.ts`
- `tooling/src/local/scrape-app.ts`
- `tooling/src/local/progress.ts`
- `tooling/tests/local/cli.test.ts`
- `tooling/tests/local/scrape-app.test.ts`
- `tooling/README.md`

**Dependencies:** P02 and P05.

**Approach:**

- Support:
  - `bun run album:set --app <slug> --name <name> --album-id <id>`
  - `bun run scrape --url <mobbin-app-url>`
  - optional `--concurrency`, `--limit-flows`, and `--limit-screens`.
- Default to six concurrent screen operations and reject non-positive or unsafe limits.
- Resolve the app slug and verify its album mapping before fetching image bytes.
- Send all selected metadata to run planning, then fetch and upload only returned screen IDs.
- Retry network errors, `408`, `409` claim contention, `425`, `429`, and `5xx` up to three times with bounded jitter. Do not retry auth failures, invalid data, CAPTCHA, or Chevereto validation errors.
- Keep each response body only until its upload finishes; never write it to the project, `/tmp`, or the VPS filesystem from the local code.
- Print one final JSON summary with discovered, skipped, uploaded, reused, and failed counts. Never print signed image URLs.

**Verification:**

- CLI tests prove argument validation and exit codes.
- Orchestration tests prove a missing album stops before image fetch, only missing screens are fetched, concurrency never exceeds six, retry policy is bounded, an interrupted run resumes, and no image-write API is called.
- `tooling/README.md` documents environment setup and the two primary commands without embedding secret examples.

### P07 — Create the isolated VPS deployment

**Outcome:** The repository contains a reproducible Compose stack that installs under `/root/mobbin-data` without touching Caddy or publishing host ports.

**Files or surfaces:**

- `tooling/Dockerfile`
- `tooling/.dockerignore`
- `tooling/deploy/compose.yaml`
- `tooling/deploy/.env.example`
- `tooling/deploy/cloudflared/config.yml.example`
- `tooling/deploy/scripts/bootstrap.sh`
- `tooling/deploy/scripts/deploy.sh`
- `tooling/deploy/scripts/preflight.sh`
- `tooling/docs/vps-runbook.md`
- VPS `/root/mobbin-data/**`

**Dependencies:** P05 and P06.

**Approach:**

- Build ingest from `oven/bun:1.4.0-alpine` with production dependencies only and run as a non-root user.
- Define `mobbin-cloudflared`, `mobbin-chevereto`, `mobbin-mysql`, and `mobbin-ingest` with the exact baseline versions.
- Mount explicit paths for MySQL, Chevereto assets, SQLite, and backup staging under `/root/mobbin-data/data` and `/root/mobbin-data/backups`.
- Route tunnel traffic internally to Chevereto port 8080 and ingest port 3000. Media goes directly to the R2 custom domain, not through the tunnel.
- Use ingest `/livez` for its Docker process probe, then add dependency-aware health checks, `restart: unless-stopped`, read-only root filesystems where supported, dropped Linux capabilities where supported, and bounded `json-file` logging.
- Make preflight fail if ports are published, required secrets are missing, permissions are broad, the existing Caddy files changed, or `/root/mobbin-data` resolves unexpectedly.
- Make deploy run a control backup first, copy only deployment inputs, build ingest, run migrations once, start the stack, and wait for health. It must not prune unrelated images or containers.

**Verification:**

- `docker compose -f tooling/deploy/compose.yaml config` succeeds with a test environment.
- A container-level integration test reaches MySQL, SQLite, Chevereto, and fake R2 over internal networks.
- On `myserver`, compare the existing Caddy file checksum before and after deployment, confirm no new host port with `docker ps`, and confirm all four health checks pass.

### P08 — Configure Cloudflare and Chevereto

**Outcome:** DNS, Access, Tunnel, R2, and Chevereto settings match the approved private boundary.

**Files or surfaces:**

- `tooling/docs/cloudflare-runbook.md`
- `tooling/docs/chevereto-runbook.md`
- Cloudflare account resources
- Chevereto admin settings

**Dependencies:** P07. This unit requires user-owned Cloudflare and Chevereto setup values.

**Approach:**

1. Create private `mobbin-media` and `mobbin-control` buckets with separate Object Read & Write tokens.
2. Attach `media.tradstry.com` to `mobbin-media`, disable `r2.dev`, and configure cache behavior for immutable media.
3. Create one interactive Access app containing the concrete `gallery.tradstry.com` and `media.tradstry.com` hostnames; allow only approved emails and enable eager redirect cookies.
4. Create a separate service-token Access app for `ingest.tradstry.com` and record its audience.
5. Create a dedicated Tunnel with only gallery-to-Chevereto and ingest-to-ingest routes.
6. Complete Chevereto setup, make the site private, create the owning user/API key, enable WebP and duplicate uploads, and configure S3-compatible upload storage for `mobbin-media` using region `auto` and the R2 endpoint.
7. Confirm generated original, thumbnail, and medium URLs use `media.tradstry.com`.
8. Create the first app album manually and register its ID with `album:set`.

The runbooks must name each secret, where it is stored, and how to rotate it without displaying a value.

**Verification:**

- Unauthenticated requests to all three domains are denied.
- One gallery login eagerly authorizes media; an album page loads protected thumbnails and originals without a second login.
- A valid service token without the ingest bearer token is rejected by ingest.
- Neither `r2.dev` nor a direct VPS port can bypass Access.
- A Chevereto test WebP is stored in R2 and no permanent upload remains in local Chevereto storage after external-storage processing completes.

### P09 — Add backup, retention, and restore checks

**Outcome:** SQLite and Chevereto MySQL can be recovered from private, verified R2 backups.

**Files or surfaces:**

- `tooling/src/server/backup.ts`
- `tooling/src/server/restore-check.ts`
- `tooling/src/server/scheduler.ts`
- `tooling/deploy/scripts/restore.sh`
- `tooling/tests/server/backup.test.ts`
- `tooling/docs/backup-runbook.md`
- `mobbin-control/sqlite-backups/**`
- `mobbin-control/mysql-backups/**`

**Dependencies:** P04 and P07.

**Approach:**

- Produce a consistent SQLite byte snapshot with `bun:sqlite` serialization, hash it, upload it, then verify object metadata and length.
- Produce a compressed `mysqldump --single-transaction` through a dedicated read-only backup user and upload it with a hash.
- Schedule one daily backup from the single ingest process and trigger the same operation before deployment.
- Keep 30 verified daily backups and 12 verified monthly backups. Prune only after a new verified backup exists.
- Once monthly, download the latest monthly SQLite backup to a temporary path, run `PRAGMA integrity_check`, apply repository read checks, and delete the temporary file.
- Make production restore require an explicit backup key and confirmation flag, take a fresh safety backup, stop ingest, validate the downloaded database, replace only the named SQLite file, then restart and run health checks.

**Verification:**

- Tests restore a seeded SQLite database and compare app mappings, versions, flows, screens, media, and run state.
- Tests refuse a corrupted or hash-mismatched backup and prove retention never deletes the newest verified daily/monthly copy.
- A VPS drill restores into a temporary path only; the live database is not replaced during acceptance.
- Verify a MySQL dump can initialize a temporary MySQL container and reproduce the Chevereto album/image counts.

### P10 — Prove the complete flow and document operations

**Outcome:** The deployed system passes staged real-data acceptance and has a usable operating guide.

**Files or surfaces:**

- `tooling/tests/integration/**`
- `tooling/docs/operations.md`
- `tooling/README.md`
- R2, SQLite, Chevereto, and Docker runtime state

**Dependencies:** P01–P09.

**Approach:**

- Run verification in this order: mocked integration, one real screen, one limited real flow, then one full app.
- Use one newly created Chevereto album so no previous data can hide duplicate or resume errors.
- Interrupt the limited flow once, resume it, then run it again after completion.
- Compare Mobbin source metadata to SQLite, the flow manifest, the run report, Chevereto, and the protected R2 object.
- Document normal scrape, album registration, health inspection, logs, failed-run resume, secret rotation, backup, restore check, deployment, rollback, and image-version upgrade.
- Record container image digests, Cloudflare application names/audiences without secrets, bucket names, tunnel name, and the first successful run ID.

**Verification:**

- `bun run typecheck` and `bun test` pass locally.
- Container integration tests pass before VPS deployment.
- One-screen acceptance proves exact SHA-256 and dimensions across source bytes, SQLite, manifest, Chevereto, and R2.
- Interrupted flow acceptance fetches only unresolved screen IDs on resume.
- Re-running a completed flow reports zero new Chevereto uploads.
- A full app has the expected ordered screen references, zero missing screens, zero images below 100 by 100, searchable app/version/flow tags for first-seen media, and one Chevereto album.
- No WebP exists under the local project or the VPS ingest data directory after completion.
- Backup and temporary restore checks succeed after the full-app run.

## Risks and Open Questions

- **Execution gate:** Cloudflare bucket tokens, Tunnel token, Access service token/audience, and approved email list must be created or supplied during P08. They are not needed to implement and test earlier units.
- **Execution gate:** The first Chevereto album ID exists only after Chevereto setup. P06 can be tested against mocks before that point.
- **Chevereto/API boundary:** The documented upload API creates media but does not document editing tags later. First upload receives all flow tags known to that run; SQLite and manifests remain authoritative if a later app version reuses that media in a newly named flow.
- **Cross-system crash:** Chevereto and SQLite cannot share one transaction. Upload claims prevent concurrency duplicates, and the reconciliation report handles the narrow crash-after-upload window; exactly-once behavior across that crash is not claimable without a supported Chevereto idempotency key.
- **Upstream parsing:** Mobbin's private page payload can change. Sanitized fixtures and explicit auth/challenge errors keep breakage visible, but a future payload change may require a scoped parser update.

There are no design blockers. The two execution gates require user-owned values only when the deployment reaches P08.

## Completion

The implementation is complete only when all of the following are true:

- P01–P10 verification passes, including local tests, container integration, staged VPS smoke tests, and one full app.
- The Mac holds only Dia, Access, and ingest client credentials; VPS-only credentials never leave `/root/mobbin-data/.env`.
- Gallery and media require one approved-user Access login, ingest requires both service-token Access and its bearer token, and no origin port bypass exists.
- SQLite, manifests, Chevereto records, and R2 objects agree on app/version/flow/screen identity, order, hash, dimensions, and media ID.
- A repeated completed scrape creates zero new per-app media, and an interrupted scrape resumes only missing screens.
- Existing Tradstry Caddy configuration and unrelated containers are unchanged.
- Daily/monthly backup retention and temporary restore checks are operational.
- `tooling/README.md` and the Cloudflare, Chevereto, VPS, backup, and operations runbooks match the deployed commands and state.
