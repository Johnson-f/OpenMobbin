# Eagle-only Mobbin pipeline design

Date: 2026-08-27
Status: Approved design
Supersedes: `2026-08-27-mobbin-cloud-pipeline-design.md`

## Goal

Build one local Bun and TypeScript pipeline that reads the authorized Mobbin session from Dia, imports every WebP into Eagle, and stores only metadata and recovery state in this repository.

Eagle is the only long-term image store. The repository must contain no WebP files and no symlink galleries.

## Non-goals

- Do not upload Mobbin images or metadata to R2, Chevereto, or the VPS.
- Do not keep a fallback image directory in this repository.
- Do not preserve every app version as visible folders in Eagle.
- Do not permanently delete recoverable Eagle items during normal scrape or migration operations.
- Do not shut down or delete the existing VPS, R2 buckets, or Chevereto installation as part of this migration.

## Sources of truth

Each kind of data has one owner:

- Eagle owns WebP bytes and the visible `Apps` and `Flows` folder views.
- Tracked JSON under `catalog/` owns Mobbin app, version, flow, screen-reference, hash, order, and Eagle-ID metadata.
- Ignored SQLite under `.mobbin/state.sqlite` owns resumable run state and performance caches. It is rebuildable from Eagle and `catalog/`.
- Dia owns the authenticated Mobbin browser session.

The JSON catalog never depends on SQLite for meaning. Deleting SQLite may make the next command slower, but must not lose catalog or Eagle data.

## Domain model

- **App**: one Mobbin app, identified by Mobbin app ID and a stable slug such as `luma`.
- **Version**: one Mobbin app version, identified by Mobbin version ID.
- **Flow**: one ordered set of screen references, identified by Mobbin flow ID.
- **Screen reference**: a flow position pointing to a Mobbin screen ID and image content.
- **Asset identity**: `SHA-256 + one-based screen position`.
- **Eagle item**: the single Eagle-owned WebP for one asset identity.
- **Managed folder**: an Eagle folder whose ID is recorded as owned by this pipeline.
- **External folder**: any Eagle folder not owned by this pipeline.
- **Current version**: the only version of an app shown in Eagle. Older version metadata remains in `catalog/`.

## Why asset identity includes position

Eagle supports one global item name and global sort fields. Its official API does not expose a different item order for the same item in each folder. A content-only identity would therefore show reused screens in the wrong sequence in some flows.

The asset identity is:

```text
<full-sha256>:<one-based-position>
```

This preserves name-based ordering in every flow while still sharing one Eagle item between:

- the `Apps` and `Flows` views of the same flow;
- different flows that use identical content at the same position;
- different apps that use identical content at the same position.

If identical content appears at different positions, Eagle stores one item per position. This is intentional and not treated as an accidental duplicate.

For the current source snapshot, this maps 11,536 screen references to approximately 10,328 Eagle items. Strict content-only deduplication would use 8,825 items but cannot preserve every flow order.

## Visible Eagle structure

The pipeline owns three top-level folders:

```text
Apps
  luma
    001 — Onboarding
      001 — a1b2c3d4e5f6
      002 — 0123456789ab
    002 — Home

Flows
  onboarding
    luma
      001 — Onboarding

_Mobbin Staging
```

Naming rules:

- App folder: stable Mobbin slug.
- Flow-group folder: normalized lowercase flow name, for example `onboarding`.
- Flow leaf: three-digit flow position, an em dash, and the readable flow name.
- Item: three-digit screen position, an em dash, and the first 12 SHA-256 characters.

The full IDs and full hash remain in JSON and SQLite, not in visible folder names.

The app flow leaf and grouped flow leaf are separate Eagle folders. Their items are the same Eagle item IDs.

Folder reconciliation uses recorded Mobbin IDs and Eagle folder IDs. A rename updates a managed folder instead of creating an unrelated duplicate.

## Managed ownership

The first migration claims the existing managed `Flows` root using the current sync state. It creates `Apps` and `_Mobbin Staging` and records all three root IDs.

After migration, ownership is based on recorded folder IDs, not names alone. The pipeline must refuse to claim an unrelated existing `Apps`, `Flows`, or `_Mobbin Staging` folder without an explicit migration mapping.

The pipeline may change or remove managed folder links. It must preserve every external folder link on an Eagle item.

An item may move to Eagle Trash only when:

1. no current catalog screen reference requires it;
2. no staged run requires it; and
3. it has no external folder links.

Normal operations never permanently erase Eagle items.

## Repository layout

```text
tooling/
  package.json
  src/
    cli.ts
    scrape.ts
    mobbin.ts
    eagle.ts
    catalog.ts
  tests/

catalog/
  apps/
    luma/
      app.json
      versions/
        <mobbin-version-id>.json

.mobbin/
  state.sqlite
```

The TypeScript modules are deep modules with small interfaces:

- `mobbin.ts` exposes authenticated discovery and validated screen fetching.
- `eagle.ts` exposes preflight, staging, commit, verification, and recovery behaviour while hiding Eagle API and folder-reconciliation details.
- `catalog.ts` exposes version staging, atomic commit, and state rebuilding while hiding JSON and SQLite details.
- `scrape.ts` exposes the end-to-end `scrape(url)` operation.
- `cli.ts` parses commands, constructs adapters, prints results, and contains no domain logic.

Tests use the same module interfaces as production callers. Fake Mobbin and Eagle adapters replace production adapters at those seams.

## JSON catalog

`catalog/apps/<slug>/app.json` contains:

- schema version;
- app slug and display name;
- Mobbin app ID;
- platform;
- current Mobbin version ID;
- ordered list of known version IDs.

`catalog/apps/<slug>/versions/<version-id>.json` contains:

- schema version and generation time;
- app and version identity;
- publication time;
- ordered flows;
- each flow's Mobbin ID, name, normalized group, and flow position;
- each screen reference's Mobbin screen ID, one-based position, full SHA-256, dimensions, bytes, descriptor, asset identity, and Eagle item ID.

JSON output is deterministic: stable key order, stable array order, two-space indentation, and a trailing newline. Writes use a sibling temporary file followed by atomic rename.

## SQLite recovery state

SQLite records:

- active and completed run IDs;
- discovered plan hashes;
- staged asset identities and Eagle item IDs;
- managed Eagle folder IDs and their Mobbin identities;
- cached Eagle item hashes and metadata timestamps;
- the catalog commit associated with each completed run;
- migration checkpoints and verification results.

SQLite uses WAL mode, foreign keys, a busy timeout, and explicit migrations. All mutating operations are idempotent.

## Scrape transaction

`bun run scrape --url <Mobbin flows URL>` performs:

1. Verify Eagle is running, `Mobbin.library` is open, and managed roots are usable.
2. Verify Dia authentication before fetching images.
3. Discover the complete app version and create a deterministic desired plan.
4. Compare the plan with SQLite, Eagle, and the current catalog.
5. Reuse every verified Eagle item matching the required asset identity.
6. Fetch only missing content into a unique operating-system temporary directory.
7. Validate WebP content type, dimensions, byte count, and SHA-256.
8. Import the file into `_Mobbin Staging` using Eagle's local-file import.
9. Confirm the Eagle item exists and record its ID before deleting the temporary file.
10. After all desired assets are ready, reconcile the new `Apps` and `Flows` folder memberships.
11. Remove staging membership from committed items.
12. Atomically commit version JSON and update `app.json`.
13. Move unused managed items with no external links to Eagle Trash.
14. Remove empty managed folders.
15. Verify catalog references, Eagle item identities, folder memberships, and the repository WebP ban.
16. Print a structured summary.

Temporary files are always outside the repository. Cleanup runs in `finally` blocks after success, failure, or interruption handling.

## Latest-only Eagle behaviour

Eagle shows only the current version of each app. When a newer version is committed:

- `Apps/<app>` is reconciled to the new version's flows;
- corresponding `Flows/<group>/<app>` leaves are reconciled;
- older JSON version files remain unchanged;
- assets still required by another current app or flow remain active;
- assets no longer required anywhere follow the Trash rule.

The old visible version remains unchanged until all assets for the replacement are staged.

## Failure and recovery

- Preflight failure: stop before Mobbin image downloads.
- Mobbin discovery failure: write no catalog changes and make no Eagle changes.
- Screen fetch or validation failure: retain verified staged items, record failure, and leave current visible folders unchanged.
- Eagle import failure: retain run state and resume on the next identical command.
- Folder-commit interruption: use the desired plan and recorded IDs to idempotently finish reconciliation.
- Catalog-write failure: Eagle items remain staged or reconcilable; retry the atomic catalog commit.
- Cleanup failure: the catalog and desired folders remain valid; extra staging links or obsolete items are reported by `verify` and cleaned on retry.

Rerunning the same Mobbin version resumes the existing run rather than creating new items.

## Commands

```bash
bun run scrape --url "<Mobbin flows URL>"
bun run verify
bun run migrate:eagle
bun run migrate:eagle -- --dry-run
```

- `scrape` imports or updates one app version.
- `verify` is read-only and checks Eagle, catalog, SQLite, temporary-state cleanliness, and the repository WebP ban.
- `migrate:eagle --dry-run` prints the exact existing-to-new mapping and expected counts without changing Eagle or files.
- `migrate:eagle` executes the approved one-time migration with checkpoints and verification.

There are no cloud, R2, gallery, or local-image mode flags.

## One-time migration

Migration is resumable and ordered as follows:

1. Verify no scrape, exporter, or Eagle sync is running.
2. Create a timestamped APFS clone or full recoverable copy of `Mobbin.library` and verify it can be read.
3. Back up the current sync state and record source counts.
4. Read all current `flow.json` files and WebPs.
5. Produce a dry-run mapping from 11,536 references and 8,825 content hashes to required asset identities.
6. Generate staged JSON catalog files without committing `app.json` current pointers.
7. Reuse current Eagle items when hash and position match.
8. Import only missing asset identities into `_Mobbin Staging`.
9. Build and verify the new `Apps` and `Flows` trees.
10. Commit catalog current pointers.
11. Preserve external links and move true obsolete managed items to Eagle Trash.
12. Verify every source reference resolves to the expected Eagle item and both leaf folders.
13. Move `screen-flows` and `grouped-flows` to macOS Trash only after verification passes.
14. Remove obsolete exporters, sync scripts, cloud modules, deployment files, and cloud configuration from the repository.
15. Run the complete test and verification suite again.

The VPS, Chevereto installation, and R2 buckets remain untouched until a separate shutdown decision.

## Verification and acceptance

`bun run verify` must fail if any of these conditions is false:

- the expected Eagle library is open;
- every current catalog screen reference has an existing Eagle item;
- each Eagle item matches its full SHA-256 and position identity;
- every current screen reference is linked to its expected `Apps` and `Flows` leaves;
- item names sort in screen-position order;
- no current item remains in `_Mobbin Staging`;
- no managed item marked obsolete retains only managed links outside Trash;
- no external folder link was removed;
- every JSON file passes its schema and deterministic-format check;
- SQLite integrity is `ok` and can be rebuilt from catalog plus Eagle;
- no project-owned or tracked `.webp` exists inside the repository; dependency caches and `.git` object storage are excluded;
- no temporary migration directory remains.

Migration acceptance additionally requires:

- source reference counts equal catalog reference counts;
- required asset-identity counts equal active managed Eagle item counts;
- all current apps and flows exist in both visible views;
- a second migration run makes zero mutations;
- `screen-flows` and `grouped-flows` are recoverable from macOS Trash until the user chooses to empty it.

## Test strategy

- Domain tests for slugging, naming, asset identity, ordering, and desired folder plans.
- Catalog tests for deterministic JSON, atomic writes, schema validation, history, and rebuildable SQLite.
- Eagle adapter contract tests against a fake adapter for staging, reuse, reconciliation, external-link preservation, Trash, and recovery.
- Scrape tests for preflight ordering, concurrency bounds, resume behaviour, latest-only replacement, and zero repository WebPs.
- Migration characterization tests using representative existing `flow.json` and Eagle state fixtures.
- One-screen real-Eagle acceptance before full migration.
- Full dry-run, applied migration, read-only verification, and idempotent second run.

## Security and privacy

- Dia cookies remain local and are read from a copied cookie database.
- No Mobbin cookie, WebP, signed URL, or secret is written to logs or JSON.
- Eagle's local API is used only on loopback.
- Catalog metadata contains identifiers and hashes but no credentials.
- Temporary files use owner-only directories and are removed promptly.

## Removal and shutdown boundaries

Repository cloud code is removed only after Eagle migration acceptance. External cloud infrastructure is not deleted by this project. VPS containers, DNS, Chevereto, R2 objects, and credentials require a separate explicit shutdown task.
