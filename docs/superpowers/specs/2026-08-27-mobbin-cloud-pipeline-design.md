# Private Mobbin Cloud Pipeline Design

## Goal

Replace local image persistence and Eagle synchronization with a private cloud media pipeline.

The Mac remains the only scraping environment because it owns the signed-in Dia session. It fetches Mobbin metadata and WebP bytes, then sends them to a private VPS ingest service. Chevereto Free catalogs the images and stores media in Cloudflare R2. Full Mobbin manifests, run reports, and SQLite backups use a separate private R2 bucket.

Existing local exports are not migrated. The cloud library starts empty.

## System Context

```text
Mac
  Dia session
      ↓
  Bun scraper
      ↓ Cloudflare Access service token + ingest bearer token

Cloudflare
  ingest.tradstry.com ─────── Cloudflare Tunnel ──┐
  gallery.tradstry.com ────── Cloudflare Tunnel ──┤
  media.tradstry.com ──────── R2 custom domain    │
                                                  ↓

VPS /root/mobbin-data
  mobbin-cloudflared
  mobbin-ingest ── SQLite ── mobbin-control R2
  mobbin-chevereto ── MySQL ── mobbin-media R2
```

The existing Tradstry Caddy stack is not changed. The new system exposes no VPS host ports.

## Repository Shape

```text
tooling/
  src/
    local/
      cli.ts
      scrape-app.ts
      dia-auth.ts
      mobbin-client.ts
      upload-client.ts
    server/
      index.ts
      database.ts
      chevereto.ts
      r2.ts
      backup.ts
    shared/
      schemas.ts
      hashing.ts
      errors.ts
  tests/
  Dockerfile
  package.json
  tsconfig.json
```

The same Bun project builds the local CLI and the VPS ingest container. Shared request and manifest schemas live in `src/shared`.

## VPS Shape

```text
/root/mobbin-data/
  compose.yaml
  .env
  data/
    mysql/
    mobbin-control.sqlite
  backups/
  scripts/
    deploy.sh
    backup.sh
    restore.sh
  cloudflared/
```

`.env` has mode `0600`. MySQL, SQLite, Chevereto, and ingest services have no public host port.

## Containers

### mobbin-cloudflared

- Runs a pinned `cloudflare/cloudflared` image.
- Uses a named tunnel scoped to this project.
- Routes `gallery.tradstry.com` to `mobbin-chevereto`.
- Routes `ingest.tradstry.com` to `mobbin-ingest`.
- Makes outbound connections only.

### mobbin-chevereto

- Runs a pinned Chevereto Free image.
- Uses the `chevereto` MySQL database.
- Owns searchable media records, albums, tags, users, and gallery behavior.
- Uploads originals and derived images to the `mobbin-media` R2 bucket using Chevereto S3-compatible storage.

Chevereto officially supports WebP, API uploads, S3-compatible storage, albums, tags, search, private site mode, and duplicate controls in the Free edition. Its upload API accepts binary files plus title, description, tags, and an existing `album_id`.

### mobbin-mysql

- Runs a pinned MySQL 8 release.
- Serves Chevereto only.
- Uses a bind-mounted data directory.
- Is not used for pipeline control state.

### mobbin-ingest

- Runs the Bun TypeScript server built from `tooling/Dockerfile`.
- Owns the ingest API, album mapping, idempotency, retry state, manifests, and backups.
- Mounts `/root/mobbin-data/data/mobbin-control.sqlite`.
- Calls Chevereto with a VPS-only API key.
- Writes private artifacts to the `mobbin-control` R2 bucket.

All containers use health checks, `restart: unless-stopped`, pinned versions, and bounded Docker log rotation.

## Cloudflare Resources

### R2 buckets

`mobbin-media`:

- Stores Chevereto originals, thumbnails, and medium images.
- Uses `media.tradstry.com` as its custom domain.
- Has `r2.dev` disabled.
- Uses a bucket-scoped Object Read & Write token available only to Chevereto.

`mobbin-control`:

- Stores manifests, run reports, and SQLite backups.
- Has no public domain or development URL.
- Uses a separate bucket-scoped Object Read & Write token available only to ingest.

Cloudflare R2 uses the S3 endpoint `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` and region `auto`.

### Access applications

Create two Access applications. Do not use a wildcard covering existing Tradstry services.

Gallery application:

- Includes the concrete domains `gallery.tradstry.com` and `media.tradstry.com`.
- Uses interactive login and allows only approved user emails.
- Enables eager redirect cookies so one gallery login authorizes both domains before images load.
- Keeps direct image URLs private.

`ingest.tradstry.com`:

- Service-token policy for the local Bun client.
- Ingest also requires its own bearer token.

The Mac stores only `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`, and `INGEST_API_TOKEN`. Chevereto, MySQL, and R2 credentials remain on the VPS.

## Chevereto Organization

- One manually created album per app.
- Album slug matches the pipeline app slug, such as `anz-plus`.
- Album IDs are registered through the ingest API and stored in SQLite.
- Flow names become tags, such as `onboarding` and `settings`.
- Every image also receives the app slug, platform, and app-version tag.
- Titles use `<App> — <Flow> — Screen <position>`.
- Historical app versions remain available.

Chevereto upload API keys are generated for the owning private user. The public guest upload key is not used.

## SQLite Configuration

Database path:

```text
/root/mobbin-data/data/mobbin-control.sqlite
```

Startup settings:

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
```

All state-changing requests use transactions. The ingest service is the only database writer.

## SQLite Schema

### apps

```text
id
slug UNIQUE
name
chevereto_album_id UNIQUE
created_at
updated_at
```

### app_versions

```text
id
app_id
mobbin_version_id UNIQUE
published_at
metadata_json
```

### runs

```text
id
app_id
version_id
status: planned | running | completed | failed
started_at
completed_at
error
```

### flows

```text
id
app_id
version_id
mobbin_flow_id
name
metadata_json
UNIQUE(version_id, mobbin_flow_id)
```

### media

```text
id
app_id
sha256
chevereto_image_id UNIQUE
chevereto_url
bytes
width
height
created_at
UNIQUE(app_id, sha256)
```

Deduplication is per app. Identical bytes in different app albums are stored separately so every image remains visible in the correct album.

### screens

```text
id
flow_id
mobbin_screen_id
position
media_id
metadata_json
UNIQUE(flow_id, mobbin_screen_id)
UNIQUE(flow_id, position)
```

## Ingest API

Every endpoint requires valid Cloudflare Access service-token headers and `Authorization: Bearer <INGEST_API_TOKEN>`.

### GET /healthz

Returns process, SQLite, Chevereto, and R2 dependency health without sensitive values.

### POST /v1/apps

Registers or updates an app album mapping.

```json
{
  "slug": "anz-plus",
  "name": "ANZ Plus",
  "cheveretoAlbumId": "AbC123"
}
```

### GET /v1/apps/:slug

Returns the registered app and album mapping. Unknown apps return `404 APP_NOT_REGISTERED`.

### POST /v1/runs

Plans a scrape run from app, version, flow, and screen metadata. It creates or resumes the version and returns the screen IDs still missing.

### POST /v1/runs/:runId/screens

Accepts one multipart WebP plus screen metadata and SHA-256.

The server verifies content type, byte size, and SHA-256 before lookup or upload. Existing `(app_id, sha256)` media is linked without a Chevereto upload. New media is uploaded to Chevereto with the registered app album and tags.

### POST /v1/runs/:runId/complete

Requires every planned screen to be present. It marks the run complete, writes flow manifests and a run report to R2, and returns final counts. Incomplete runs return a conflict with missing screen IDs.

## Local CLI

### Register an app album

```bash
bun run album:set --app anz-plus --name "ANZ Plus" --album-id AbC123
```

### Scrape one app

```bash
bun run scrape --url "<mobbin-app-flow-url>"
```

Supported controls:

```text
--concurrency 6
--limit-flows <n>
--limit-screens <n>
```

One command handles one app. Multi-app batching is outside the first version.

## Local Scrape Sequence

1. Copy Dia's Chromium cookie database to a temporary directory.
2. Decrypt only Mobbin cookies locally through macOS Keychain.
3. Fetch the app and flow metadata once.
4. Send discovered metadata to `POST /v1/runs`.
5. Fetch only screen IDs returned as missing.
6. Keep each WebP in memory, compute SHA-256, and upload it to ingest.
7. Run at most six screen operations concurrently.
8. Retry temporary HTTP failures three times with bounded backoff.
9. Stop on CAPTCHA or rate-limit signals without completing the run.
10. Complete the run and print discovered, skipped, uploaded, reused, and failed counts.

No WebP is permanently written to the Mac or VPS. A failed screen is fetched again on resume.

## Chevereto Upload Sequence

For new per-app media:

1. Validate the registered album.
2. POST the WebP to `/api/1/upload` using `X-API-Key`.
3. Send `album_id`, title, description, and comma-separated tags.
4. Validate the Chevereto success response.
5. Commit the returned image ID and URLs to SQLite.

The SQLite media row is created only after Chevereto succeeds. Failed uploads leave the screen missing and resumable. Chevereto credentials and raw failure bodies are never returned to the Mac.

## R2 Manifest Layout

```text
manifests/v1/apps/<app>/versions/<version>/flows/<flow-id>.json
run-reports/<run-id>.json
sqlite-backups/<year>/<month>/<day>/mobbin-control.sqlite
sqlite-backups/monthly/<year>/<month>/mobbin-control.sqlite
```

Flow manifests contain app/version/flow IDs, flow name, ordered screens, screen IDs, per-app hashes, dimensions, Chevereto image IDs, and protected media URLs.

Manifests never contain Dia cookies, Cloudflare credentials, Chevereto keys, R2 keys, or signed Mobbin source URLs.

## Historical Versions

- App versions are append-only.
- New runs never delete older versions or Chevereto images.
- Images receive a `version:<mobbin-version-id>` tag.
- Re-running a completed version is idempotent.
- Latest-only cleanup is outside scope.

## Backups

- Run a SQLite online backup daily and before every deployment.
- Upload backups to the private control bucket.
- Keep 30 daily backups and 12 monthly backups.
- Prune only after a new backup is verified in R2.
- Test a restore into a temporary SQLite path monthly.
- MySQL backup follows Chevereto's own database backup procedure and remains separate from pipeline SQLite backup.

## Failure Handling

- Unknown app album: reject the run before fetching images.
- Dia cookie failure: stop locally and make no cloud changes.
- CAPTCHA or rate limit: stop locally and leave the run resumable.
- Hash mismatch: reject the screen and retain no bytes.
- Chevereto failure: mark the screen failed and do not create media state.
- R2 manifest failure: retain completed SQLite state and retry manifest publication.
- SQLite busy: wait up to five seconds, then return a retryable error.
- Incomplete run: never publish a completed manifest.

## Observability

- Structured JSON logs from ingest.
- Request ID and run ID on every log line.
- No credentials, cookies, signed URLs, or image bytes in logs.
- `/healthz` checks SQLite, Chevereto, and both R2 buckets.
- Docker logs rotate with bounded size and file count.
- Run reports record counts and sanitized failures.

## Deployment

1. Create the two R2 buckets and scoped tokens.
2. Connect the media bucket to `media.tradstry.com`; disable `r2.dev`.
3. Create Access applications and policies for gallery, media, and ingest.
4. Create the dedicated Cloudflare Tunnel.
5. Create `/root/mobbin-data` and its protected environment file.
6. Start MySQL and Chevereto.
7. Complete Chevereto setup and configure S3-compatible R2 storage.
8. Build and start ingest and cloudflared.
9. Create the first app album and register it.
10. Run a one-screen smoke test, one-flow test, then one full app.
11. Run backup and restore tests.

## Testing and Acceptance

Automated tests:

- Dia cookie parsing and non-secret decryption vectors.
- Mobbin metadata parsing.
- Access and bearer-token rejection.
- Album registration and unknown-app rejection.
- Run planning and resume.
- Per-app hash deduplication.
- Cross-app duplicate separation.
- Chevereto request formatting and error handling.
- R2 manifest keys and secret redaction.
- Run completion conflict when screens are missing.
- SQLite migration, WAL, transaction, and backup restore.
- Concurrency never exceeds six.

End-to-end acceptance:

1. Unauthorized gallery, media, and ingest requests are blocked.
2. One gallery login pre-authorizes media and images load without a second login.
3. A registered app can start a run.
4. One WebP reaches Chevereto and resolves through protected R2 media.
5. Its SQLite rows and R2 manifest match the source metadata and hash.
6. Re-uploading the same app image reuses media.
7. The same bytes under another app create separate album media.
8. A failed run resumes only missing screens.
9. Completing one flow preserves screen order.
10. Completing one full app produces searchable Chevereto tags and album contents.
11. SQLite restore reproduces app mappings and run state.

## Non-Goals

- Migrating existing local images or Eagle data.
- Running Dia or Mobbin scraping on the VPS.
- Multi-app batch scraping in the first version.
- Automatic Chevereto album creation through unsupported internal APIs.
- Public gallery or media access.
- Modifying the existing Tradstry Caddy stack.
- Deleting historical app versions.

## Primary Sources

- [Chevereto file upload API](https://v4-docs.chevereto.com/api/1/file-upload.html)
- [Chevereto upload storage](https://v4-admin.chevereto.com/features/upload-storage.html)
- [Chevereto edition comparison](https://v4-docs.chevereto.com/introduction/editions/compare.html)
- [Chevereto installation](https://v4-docs.chevereto.com/application/installing/installation.html)
- [Chevereto MySQL role](https://v4-docs.chevereto.com/application/stack/mysql-server.html)
- [Cloudflare R2 S3 compatibility](https://developers.cloudflare.com/r2/api/s3/api/)
- [Cloudflare R2 authentication](https://developers.cloudflare.com/r2/api/s3/tokens/)
- [Cloudflare R2 public buckets](https://developers.cloudflare.com/r2/buckets/public-buckets/)
- [Cloudflare Access authorization cookies](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/)
