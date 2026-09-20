# Mobbin Eagle catalog

Import authorized Mobbin iOS and web app flows into a local Eagle library. The importer reads your signed-in Dia session, downloads screen images, and organizes them by app and flow.

Eagle stores the images. This repository stores the catalog: JSON files describing apps, versions, flows, and their Eagle items. Commands run locally through Bun; there is no web server, Docker service, or cloud storage to start.

## Contents

- [Requirements](#requirements)
- [Local setup](#local-setup)
- [Import or update an app](#import-or-update-an-app)
- [Browse the results](#browse-the-results)
- [Verify an import](#verify-an-import)
- [Configuration](#configuration)
- [Storage and backups](#storage-and-backups)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [Legacy migration](#legacy-migration)

## Requirements

| Requirement | Why it is needed |
| --- | --- |
| macOS | The importer reads Dia's local profile and uses macOS Keychain to unlock its cookies. |
| Bun **1.4.0** | Runs the TypeScript commands, installs dependencies, and runs tests. This is the version declared in `tooling/package.json`. |
| Dia signed into Mobbin | Supplies the session used to access the requested app. Your account must have access to its screens. |
| Eagle running with the intended library open | Receives images through its local API at `http://127.0.0.1:41595` by default. |

The working setup uses `/Users/user/mobbin-sides` for the repository and `/Users/user/Mobbin.library` for Eagle. Adjust these paths for another machine.

## Local setup

### 1. Install dependencies

Run from the `tooling` directory in your checkout:

```bash
cd /Users/user/mobbin-sides/tooling
bun --version
bun install --frozen-lockfile
```

The lockfile keeps dependency versions consistent. Use Bun for the commands below; a separate Node.js installation is not required by this workflow.

### 2. Configure local paths

Create a local settings file only if one does not already exist:

```bash
test -f .env.local || cp .env.example .env.local
```

Edit `tooling/.env.local` to match your machine. The example contains absolute paths for the original workstation, so check every path before using it elsewhere.

```dotenv
DIA_PROFILE_DIR="/Users/user/Library/Application Support/Dia/User Data/Default"
DIA_SAFE_STORAGE_SERVICE="Dia Safe Storage"
EAGLE_LIBRARY_PATH="/Users/user/Mobbin.library"
EAGLE_API_URL="http://127.0.0.1:41595"
MOBBIN_REPOSITORY_ROOT="/Users/user/mobbin-sides"
```

Bun loads `.env.local` when these commands run from `tooling`. Do not `source` the example in your shell: its unquoted paths can contain spaces. This file is ignored by Git. Do not add cookies or Keychain passwords to it; the importer reads those locally when needed.

### 3. Prepare Dia and Eagle

1. Open Dia, sign into Mobbin, and open the app version you want to import.
2. Confirm the account can access the requested screens. Complete any browser login or challenge there.
3. Open Eagle and select the library named in `EAGLE_LIBRARY_PATH`. The path must match the library Eagle reports.
4. If macOS asks for Keychain access during an import, allow the expected access to `Dia Safe Storage`.

### 4. Choose the matching data set

**Continuing the existing collection:** keep the repository's `catalog/`, its `.mobbin/` state directory, and the matching Eagle library together. Then run:

```bash
bun run verify
```

A Git clone alone does not include the images or local state. The checked-in catalog refers to specific Eagle item IDs, so pointing it at an empty library will not recreate the collection.

**Starting a separate collection:** create and open a new Eagle library outside the repository. Give it a separate, initially empty catalog location and state file. For example, set these in `.env.local` alongside the Dia settings:

```dotenv
EAGLE_LIBRARY_PATH="/Users/user/Mobbin-Sandbox.library"
MOBBIN_CATALOG_ROOT="/Users/user/mobbin-sides/.mobbin/sandbox/catalog"
MOBBIN_STATE_PATH="/Users/user/mobbin-sides/.mobbin/sandbox/state.sqlite"
```

The importer creates its catalog and state directories. Let it create the `Apps`, `Flows`, and `_Mobbin Staging` folders in the empty library. This example keeps the separate collection's metadata under ignored `.mobbin/`; it does not update the tracked catalog. To return to the main collection, restore the main library path, remove these two overrides, and open the main library in Eagle.

## Import or update an app

Run all commands in this section from `tooling`.

1. In Mobbin, select the app, platform, and version you want.
2. Open its **Flows** tab and copy the full version URL.
3. Run the import, wait for its completion report, then verify:

```bash
bun run scrape --url "<Mobbin app version flows URL>"
bun run verify
```

The URL must include both the app ID and version ID:

```text
https://mobbin.com/apps/<app>-<platform>-<app-id>/<version-id>/flows
```

Version URLs ending in `/screens` or `/ui-elements` also work; the importer converts them to `/flows` and imports the whole version's flows. An app landing-page URL without a version ID is not sufficient. The command does not automatically select the latest published version.

### iOS example

```bash
bun run scrape --url "https://mobbin.com/apps/luma-ios-bead4230-994f-47c2-9311-5049bf7bcace/0ae0e7e9-c7b7-4ef6-bc80-ddd7d4dfc040/flows"
```

### Web example

```bash
bun run scrape --url "https://mobbin.com/apps/luma-web-1568da8b-52fe-4a00-9170-6558e9f10d74/99c7040b-604e-41e9-975b-f532656753c1/flows"
```

These examples pin specific versions. For a newer update, copy its new version URL from Mobbin.

Web catalog names append `-web`: Luma iOS uses `luma`, while Luma Web uses `luma-web`. Keep the original Mobbin URL unchanged. Mobbin's separate **Sites** collection is not supported.

### What happens during an import

1. Check the open Eagle library and read the Dia session.
2. Discover the selected version's flows and screen order.
3. Reuse known images and stage missing ones in `_Mobbin Staging`.
4. Set up both Eagle folder views and write the version's catalog JSON.
5. Remove obsolete managed folders and move unused managed images to Eagle Trash.

The importer prefers Mobbin's downloadable image, then the largest listed source, then the fallback source. It requires WebP images and does not resize or convert them. Temporary downloads are cleaned up as each screen finishes.

**Run one import at a time.** Eagle item creation is serialized within a process; separate scrape processes do not share that queue. The command can be quiet for several minutes while downloading or updating folders. Wait for the JSON completion report before running verification or another import.

The report includes `completed`, `app`, `flows`, `discovered` (screen appearances across flows), `uniqueReferences` (distinct screen ID and position pairs), and counts of fetched, staged, reused, updated, or trashed items. These counts need not be equal: one image can appear in multiple flows.

Downloads use six workers by default. To reduce concurrent work:

```bash
bun run scrape --url "<Mobbin app version flows URL>" --concurrency 2
```

`--concurrency` accepts integers from 1 to 12. It does not make Eagle item creation parallel.

### Updates and interrupted imports

- To update an app, run the same command with its new version URL. The new import becomes that app's current version; other apps and platforms retain theirs.
- To resume an interrupted import, rerun the **same URL** with the same catalog, state, and library. Keep `.mobbin/` and staged items intact.
- Repeating a completed import with an unchanged flow plan returns without adding duplicates. It still needs working Eagle and Mobbin access.
- A catalog name belonging to another Mobbin app ID or platform stops the import before images are changed.
- Previous version JSON files remain for reference. Eagle's managed views show only the current version; old JSON is not a guarantee that its images remain outside Trash.

## Browse the results

Eagle presents two views over the same images:

```text
Apps/
  luma/
    001 — Onboarding/
      001 — <hash12>.webp
Flows/
  onboarding/
    luma — 001 — Onboarding/
      001 — <hash12>.webp
```

Numbers preserve flow and screen order. `<hash12>` is the first 12 characters of a SHA-256 hash, a fingerprint of the image bytes. Each stored identity combines the full hash with its screen position, so identical content at the same position shares an Eagle item. Identical content at different positions can use separate items to preserve ordering.

Images belong to the numbered flow folders. Parent app folders have no direct image memberships; open a flow to inspect its screens. Flow group names come from normalized flow names, such as `Onboarding` becoming `onboarding`.

You can add imported items to your own Eagle folders. Imports preserve those links. Replaced items with an outside folder link are kept; replaced items with no remaining use are moved to Trash, never permanently deleted by the importer.

## Verify an import

With Eagle open on the configured library:

```bash
bun run verify
```

Verification checks all current apps in the configured catalog, not just the last import. It checks:

- Referenced Eagle items and readable image files with matching hashes.
- Expected item names, both flow-folder memberships, and name-sorted flow folders.
- Empty staging after completion.
- Catalog formatting, database integrity, and record counts rebuilt from catalog history.
- No WebP files or old generated gallery directories in the repository.

Success reports `"ok": true` and `"failures": []`, plus totals for apps, flows, screen references, and current image identities. Failures produce a nonzero exit code and diagnostic messages.

This command does not modify Eagle or fetch from Mobbin. It opens local state and creates a temporary database to check reconstruction, then removes that temporary database. It is a check, not a repair command.

## Configuration

All settings are optional when the defaults match your machine. Use absolute paths for path settings.

| Variable | Default when unset | Purpose |
| --- | --- | --- |
| `DIA_PROFILE_DIR` | `<home>/Library/Application Support/Dia/User Data/Default` | Dia profile containing the `Cookies` database. |
| `DIA_SAFE_STORAGE_SERVICE` | `Dia Safe Storage` | macOS Keychain service used to unlock Dia cookies. |
| `EAGLE_LIBRARY_PATH` | `<home>/Mobbin.library` | Expected open Eagle library. |
| `EAGLE_API_URL` | `http://127.0.0.1:41595` | Eagle's local API address. |
| `MOBBIN_REPOSITORY_ROOT` | Repository root derived from the CLI source location | Base for default data paths and repository checks. |
| `MOBBIN_CATALOG_ROOT` | `<repository>/catalog` | Catalog JSON directory. |
| `MOBBIN_STATE_PATH` | `<repository>/.mobbin/state.sqlite` | Local SQLite state file. |

`<home>` means the current user's home directory. A path explicitly set in `.env.local` overrides the computed default; copying the example does not adapt its `/Users/user/...` paths automatically.

## Storage and backups

| Location | Contains | In Git? |
| --- | --- | --- |
| Eagle library, outside this repository | Image bytes and Eagle's own metadata | No |
| `catalog/apps/<app>/app.json` | App identity, current version ID, and known version IDs | Yes |
| `catalog/apps/<app>/versions/<version-id>.json` | Ordered flows, screen IDs, dimensions, sizes, hashes, and Eagle item IDs | Yes |
| `.mobbin/state.sqlite` and its sidecar files | Import progress, image mappings, and ownership of managed folders | No |
| `tooling/.env.local` | Workstation settings | No |
| `tooling/node_modules/` | Installed dependencies | No |

Keep image exports and generated image-link galleries outside the repository. Git history preserves metadata; it does not back up Eagle images.

To back up or move the working collection:

1. Wait for imports and verification to finish, then quit Eagle.
2. Back up the Eagle library, the catalog, and the entire `.mobbin/` directory together. Include any database sidecar files that exist.
3. On the destination machine, restore that matching set, install dependencies, and update local paths.
4. Open the restored Eagle library, sign into Mobbin in Dia for future imports, and run `bun run verify`.

**Do not delete `.mobbin/state.sqlite` as a routine reset.** The code can reconstruct catalog-derived records for verification, but that reconstruction does not restore managed-folder ownership. There is no general rebuild or repair CLI command. A missing state file can make existing Eagle folders appear unowned; restore the matching state backup before importing again.

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| Cannot connect to Eagle | Open Eagle and check `EAGLE_API_URL`. Run verification again once the library has loaded. |
| `Eagle has ... open; expected ...` | Select the intended library in Eagle or correct `EAGLE_LIBRARY_PATH`. |
| `No Mobbin cookies found` or missing `Cookies` file | Check `DIA_PROFILE_DIR`, then sign into Mobbin in that Dia profile. |
| `Could not read ... from macOS Keychain` | Check `DIA_SAFE_STORAGE_SERVICE` and allow the expected Keychain access. Do not print the stored password. |
| Authentication, access, or browser challenge error | Open the exact version in Dia, complete the login/challenge, and confirm account access before rerunning. |
| `Mobbin rate limited the request` | Wait, then rerun the same URL; use lower `--concurrency` if needed. |
| `Could not parse Mobbin app URL` | Copy a full app version URL, including the version ID and `/flows`. |
| No flows, missing image source, or unexpected image format | Confirm the version loads in Dia. If it persists, investigate the Mobbin reader; the site's response may have changed. |
| Unowned, missing, or changed managed folder | Check that catalog, state, and library belong together. Restore matching backups or investigate the mapping; do not claim folders by name or edit Eagle metadata files manually. |
| Staging is not empty after interruption | Rerun the interrupted import with the same URL, then verify. |
| Missing committed item or image hash mismatch | Restore the affected item from Eagle Trash or a matching backup, then verify. A completed-import replay does not repair missing images. |
| Database integrity or reconstruction-count failure | Keep the database and catalog for diagnosis. Restore a consistent backup or investigate the reported mismatch; deleting state loses folder ownership. |

For verification errors, read the full `failures` list. Wait until an import has completed before treating staging or temporary folder mismatches as failures.

## Development

From `tooling`:

```bash
bun test
bun run typecheck
git diff --check
```

Tests use local fixtures and mocked Mobbin/Eagle responses; they do not need a signed-in browser or the live Eagle library. `typecheck` checks TypeScript without generating a build. Live `scrape` and `verify` commands exercise the real local collection, so run them separately when a change needs that validation.

### Code map

| File or directory | Responsibility |
| --- | --- |
| [`tooling/src/cli.ts`](tooling/src/cli.ts) | Commands, arguments, environment settings, and exit codes. |
| [`tooling/src/scrape.ts`](tooling/src/scrape.ts) | Import sequence, reuse, resuming, catalog commit, and cleanup. |
| [`tooling/src/mobbin.ts`](tooling/src/mobbin.ts) | Mobbin reader and temporary image lifecycle. |
| [`tooling/src/local/`](tooling/src/local/) | Dia authentication, page parsing, screen requests, and source selection. |
| [`tooling/src/catalog.ts`](tooling/src/catalog.ts) | Catalog formats, image identities, JSON writes, and local database state. |
| [`tooling/src/eagle.ts`](tooling/src/eagle.ts) | Managed folders, staged items, shared images, and Trash rules. |
| [`tooling/src/internal/eagle-client.ts`](tooling/src/internal/eagle-client.ts) | Eagle API requests and waiting for library updates. |
| [`tooling/src/verify.ts`](tooling/src/verify.ts) | Checks the catalog, Eagle images, folders, and state. |
| [`tooling/src/migrate.ts`](tooling/src/migrate.ts) | Migration from the former export layout. |
| [`tooling/tests/`](tooling/tests/) | Import, catalog, Eagle, Mobbin, migration, and verification tests. |

Before changing image identities, folder names, catalog formats, or verification rules, read the [output contract](.agents/skills/mobbin-screens-exporter/references/output-contract.md). Keep imports resumable, preserve links to personal Eagle folders, and avoid logging cookies, signed image URLs, or temporary image bytes.

## Legacy migration

`migrate:eagle` is for the former `screen-flows/` export layout and its existing Eagle `Flows` mapping. Those generated legacy exports are not included in the current checkout. It is not part of normal setup, a new import, or recovery from missing current state.

For a workstation that still has those legacy files, inspect the plan first from `tooling`:

```bash
bun run migrate:eagle --dry-run
```

The dry run reads Eagle and legacy files, reports unresolved mappings, and does not apply the migration. Once the required legacy data is present and the plan is understood:

```bash
bun run migrate:eagle
```

The applied migration briefly quits Eagle, makes and checks a library backup beside the original, reopens Eagle, and records progress for resuming. Its internal verification permits legacy source directories. After successful migration, move the old `screen-flows/` and `grouped-flows/` directories and any remaining repository WebPs outside the repository, then run the strict check:

```bash
bun run verify
```

The [Eagle-only design](docs/superpowers/specs/2026-08-27-eagle-only-mobbin-pipeline-design.md) and [implementation plan](docs/plans/2026-08-27-eagle-only-mobbin-pipeline-implementation-plan.md) provide historical context. Current commands and behavior are defined by the source linked above. Older cloud/deployment files are not required for this local workflow; these commands do not manage VPS, R2, Chevereto, or DNS infrastructure.
