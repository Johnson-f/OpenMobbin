# Implement the Eagle-only Mobbin pipeline

## Frame

Replace the current local-image and cloud pipeline in `/Users/user/mobbin-sides` with the approved Eagle-only design in `docs/superpowers/specs/2026-08-27-eagle-only-mobbin-pipeline-design.md`.

The finished path is:

```text
Dia-authenticated Mobbin discovery
  -> resumable Bun/TypeScript scrape transaction
  -> temporary WebP validation
  -> Eagle _Mobbin Staging
  -> Eagle Apps + Flows views
  -> tracked JSON catalog + ignored SQLite recovery state
```

In scope:

- implement the five-module Eagle-only TypeScript design in `tooling/`;
- preserve exact flow order with the settled `SHA-256 + screen position` asset identity;
- add `scrape`, `verify`, and resumable `migrate:eagle` commands;
- migrate the current local source and existing Eagle library into `Apps` and `Flows`;
- retain one visible current version per app and all version history in JSON;
- move verified legacy image directories to macOS Trash;
- remove obsolete local-image, gallery, cloud, server, deployment, and exporter code after migration acceptance.

Out of scope:

- shutting down or deleting the VPS, Chevereto, Hostinger DNS, R2 buckets, R2 objects, or cloud credentials;
- permanent deletion of Eagle Trash or macOS Trash;
- changing folders or links outside the managed Eagle roots;
- preserving the abandoned cloud/local/grouped prototype interfaces for compatibility.

Success is observable when `bun run verify` passes against the real `Mobbin.library`, every current catalog reference resolves to correctly ordered items in both Eagle views, the second migration performs zero mutations, no project-owned WebP or symlink gallery remains in the repository, and all legacy source directories remain recoverable from macOS Trash.

## Evidence

- **Settled:** The approved design is `docs/superpowers/specs/2026-08-27-eagle-only-mobbin-pipeline-design.md` at commit `a1083d0`.
- **Settled:** Eagle owns all WebP bytes; `catalog/` owns readable metadata; `.mobbin/state.sqlite` is ignored, operational, and rebuildable.
- **Settled:** Eagle exposes top-level `Apps`, `Flows`, and `_Mobbin Staging`; Eagle shows only each app's current version.
- **Settled:** Asset identity is `<full-sha256>:<one-based-position>`, allowing name sorting while deduplicating identical content used at the same position.
- **Settled:** A scrape requires Eagle and uses owner-only operating-system temporary files; there is no cloud or repository-image fallback.
- **Settled:** Obsolete managed items move to Eagle Trash only when no current or staged reference and no external folder link remains.
- **Verified:** Bun 1.4.0 and strict TypeScript are configured in `tooling/package.json` and `tooling/tsconfig.json`.
- **Verified:** The current Dia reader already proves cookie-copy cleanup, Chromium cookie decryption, Mobbin Flight parsing, source selection, WebP hashing, and dimension validation in `tooling/src/local/` and `tooling/tests/local/mobbin.test.ts`.
- **Verified:** `scripts/sync-screen-flows-to-eagle.mjs` proves Eagle loopback connectivity, folder and item pagination, multi-folder item updates, cached hashing, external-link preservation, Trash, and empty-folder removal, but its pure-hash identity and source-folder contract are superseded.
- **Verified:** Eagle 4.0 currently has `/Users/user/Mobbin.library` open. The library is approximately 854 MiB and the Mac has approximately 147 GiB available.
- **Verified:** The current snapshot contains 2,591 valid flows, 11,536 screen references, 8,825 unique content hashes, and 10,328 required hash-position identities. `.eagle-sync-state.json` records 11,536 source files and 8,825 Eagle items.
- **Verified:** `screen-flows` is approximately 955 MiB; `grouped-flows` contains generated relative symlinks and no independent image bytes.
- **Verified:** The worktree is dirty. `logic/` tracked deletions and unrelated documentation are pre-existing and must remain untouched. `README.md`, `scripts/sync-screen-flows-to-eagle*`, and the untracked `tooling/` tree overlap the superseded prototype and are explicitly owned by this redesign.
- **Assumed:** The current Data volume supports APFS clone copies. If clone creation is unavailable, the migration uses a full copy; available disk is sufficient for the current library.
- **Assumed:** Source counts may change before execution. Every migration gate uses a fresh dry-run rather than treating the counts above as immutable.

## Decisions

### Module seams

Keep the approved small external surface:

- `tooling/src/mobbin.ts`: authenticated discovery and validated fetch-to-temporary-file.
- `tooling/src/eagle.ts`: preflight, inventory, staging, commit, verification, and state reconstruction.
- `tooling/src/catalog.ts`: version schemas, deterministic JSON, SQLite state, atomic commit, and rebuild.
- `tooling/src/scrape.ts`: the single `scrape(url)` transaction.
- `tooling/src/cli.ts`: command parsing, adapter construction, progress, and structured output only.

Implementation-only helpers may live under `tooling/src/internal/`; they are not additional caller interfaces. Tests and production callers use the five public modules.

### Asset reuse

Resolve a screen reference in this order:

1. If catalog history knows the Mobbin screen ID's full hash, derive the required hash-position identity without downloading.
2. Reuse the verified Eagle item when that exact identity exists.
3. When the hash exists in Eagle at another position, create the required positioned item from the verified Eagle-owned source file through staging.
4. Fetch from Mobbin only when no trusted catalog or Eagle source establishes the content.

One existing pure-hash Eagle item may satisfy at most one required position. Migration prefers the numeric prefix already present in its name when that position is required; otherwise it assigns the lowest required position. Other positions become intentional staged copies.

### Eagle ownership and sorting

- Initial migration claims the current `Flows` root by its current state mapping.
- New `Apps` and `_Mobbin Staging` roots must not collide with unrelated existing roots. A collision without a recorded migration mapping is a hard stop.
- New managed folders receive a managed description and their IDs are stored in SQLite; later reconciliation uses IDs, not names alone.
- Leaf folders sort by ascending `NAME` so `NNN — hash12` yields flow order.
- Before bulk migration, a one-item real-Eagle probe must prove create, rename, multi-folder membership, name sorting, staging removal, and Trash recovery behaviour. If Eagle's v2 folder contract cannot set name sorting, isolate the existing script-injection fallback inside the Eagle implementation and prove it with a contract test.
- Item annotation records the full asset identity and managed marker. Visible tags remain minimal (`mobbin-managed`) to avoid tag explosion.

### Catalog and state

- Version JSON schema version starts at `1` and includes full app, version, flow, reference, hash, dimensions, descriptor, asset identity, and Eagle ID data.
- `app.json` contains identity, ordered known versions, and current-version pointer.
- JSON is deterministic and uses sibling temporary-file plus rename.
- SQLite uses explicit migrations and contains `runs`, `run_assets`, `assets`, `screen_hashes`, `managed_folders`, `eagle_cache`, and `migration_checkpoints` concepts with foreign keys, WAL, and a busy timeout.
- Asset and folder mutations are idempotent. A completed catalog can rebuild SQLite into a separate temporary database without mutating the active state.

### Migration safety

- `bun run migrate:eagle -- --dry-run` is read-only and always precedes apply.
- `bun run migrate:eagle` applies the migration and is resumable from named checkpoints.
- Before apply, close Eagle cleanly, make a timestamped sibling clone/copy of `Mobbin.library`, verify the copy's metadata and image count, reopen the original library, and repeat Eagle preflight.
- Snapshot every external folder membership before mutation and compare it after apply.
- Run apply twice before moving legacy source directories; the second run must report zero Eagle, catalog, and state mutations.
- Move `screen-flows` and `grouped-flows` to explicit timestamped paths under the user's macOS Trash. Never empty Trash automatically.
- If any count, hash, backup, external-link, or one-item acceptance gate fails, stop before the next destructive phase.

### Dirty-worktree ownership

- Preserve the pre-existing `logic/` deletions, unrelated `.design/` state, existing cloud design/plan history, and external infrastructure.
- Replace or remove the current uncommitted prototype changes in `README.md`, `scripts/`, and `tooling/` where the approved design supersedes them.
- Do not create commits, branches, pushes, deployments, or external messages during `$ns-work` execution.

## Implementation

### E01 — Establish the Eagle-only project contract

**Outcome:** The package exposes only the intended future commands and has stable catalog/domain contracts for later modules, without yet deleting legacy code needed for migration comparison.

**Files or surfaces:**

- `tooling/package.json`
- `tooling/bun.lock`
- `tooling/tsconfig.json`
- `tooling/.env.example`
- `tooling/.gitignore`
- root `.gitignore`
- `tooling/src/catalog.ts`
- `tooling/tests/catalog.test.ts`

**Dependencies:** Approved specification and recorded dirty-worktree baseline.

**Approach:**

- Add canonical `scrape`, `verify`, and `migrate:eagle` entry scripts while keeping temporary legacy scripts callable only until E09.
- Define versioned Zod schemas and deterministic naming helpers for apps, groups, flow leaves, item names, asset identities, app catalogs, and version catalogs.
- Enforce three-digit positions and full lowercase SHA-256 in identities; use only the first 12 characters in visible names.
- Add `.mobbin/` to ignored operational state. Keep `catalog/` tracked.
- Add a repository-media guard used by tests and `verify`; exclude `.git` and dependency caches, not project output paths.
- Remove no server dependency or legacy file in this unit.

**Verification:**

- Run `bun test tests/catalog.test.ts`; valid catalogs round-trip, malformed IDs/hashes/positions fail, and fixed examples produce `onboarding`, `001 — Onboarding`, `001 — a1b2c3d4e5f6`, and the expected full asset identity.
- Run `bun run typecheck`; new public contracts are strict and do not import server or cloud types.
- Run the media guard against a fixture repository; a fixture WebP fails while dependency-cache and `.git` fixtures are ignored.

### E02 — Implement deterministic catalog and resumable SQLite state

**Outcome:** Catalog history commits atomically, active work resumes from SQLite, and state can be rebuilt without image or cloud data.

**Files or surfaces:**

- `tooling/src/catalog.ts`
- `tooling/src/internal/catalog-db.ts`
- `tooling/src/internal/migrations/001_eagle_only.sql`
- `tooling/tests/catalog.test.ts`
- `tooling/tests/fixtures/catalog/`
- `catalog/` generated only in fixture/temp roots until E08
- `.mobbin/state.sqlite` generated and ignored

**Dependencies:** E01.

**Approach:**

- Implement schema migrations, run planning, plan hashing, asset claims, staged/committed states, folder ownership, Eagle cache, and named migration checkpoints.
- Use transactions for state transitions and atomic filesystem replacement for JSON.
- Write version JSON before switching `app.json` current pointer.
- Preserve older immutable version JSON on current-version replacement.
- Provide a rebuild operation that accepts catalog plus Eagle inventory and creates a new database path; swap is outside the operation.

**Verification:**

- `bun test tests/catalog.test.ts` proves migration idempotency, WAL/foreign keys/integrity, identical-plan resume, failed-run resume, deterministic JSON bytes, latest-only pointer changes, preserved version history, and rebuild equivalence.
- Inject a catalog rename failure and verify the former current pointer and valid SQLite state remain recoverable.
- Delete a temporary SQLite database, rebuild it from fixture catalog plus Eagle inventory, and compare runs/assets/folders expected by the public catalog interface.

### E03 — Consolidate the proven Dia and Mobbin module

**Outcome:** `mobbin.ts` produces deterministic version plans and owner-only temporary WebPs without repository image writes.

**Files or surfaces:**

- `tooling/src/mobbin.ts`
- reusable logic from `tooling/src/local/dia-auth.ts`
- reusable logic from `tooling/src/local/mobbin-page.ts`
- reusable logic from `tooling/src/local/mobbin-client.ts`
- reusable logic from `tooling/src/local/screen-source.ts`
- `tooling/tests/mobbin.test.ts`
- sanitized fixtures under `tooling/tests/fixtures/mobbin/`

**Dependencies:** E01 catalog types.

**Approach:**

- Preserve the proven cookie-copy/decrypt and Flight-payload behaviour while exposing one authenticated reader interface.
- Preflight Dia authentication separately from screen fetching.
- Fetch missing screens into a unique `mkdtemp` directory outside the repository, stream bytes to disk, validate WebP type/dimensions/size/hash, and return metadata plus temporary path.
- Use bounded retries only for classified transient network failures. Authentication, challenge, access, and validation errors stop immediately.
- Remove temporary files and directories in `finally`; never serialize cookies or signed CDN URLs.

**Verification:**

- `bun test tests/mobbin.test.ts` retains the existing URL, order, source-selection, cookie, challenge, access, and WebP proofs through the new interface.
- A fixture fetch proves the temporary file is owner-only, hashes to the expected value, exists only outside the repository, and is removed on success and injected failure.
- A preflight-order test proves no Mobbin screen request occurs before Eagle preflight in the orchestration unit E05.

### E04 — Implement the Eagle library module and contract

**Outcome:** One deep Eagle module owns loopback calls, managed roots, staging, hash-position reuse, folder reconciliation, external-link safety, Trash, and inspection.

**Files or surfaces:**

- `tooling/src/eagle.ts`
- `tooling/src/internal/eagle-client.ts`
- `tooling/src/internal/eagle-plan.ts`
- reusable behaviour from `scripts/sync-screen-flows-to-eagle.mjs`
- `tooling/tests/eagle.test.ts`
- `tooling/tests/fixtures/eagle/`

**Dependencies:** E01 identity/naming contracts and E02 state interface.

**Approach:**

- Port pagination and the tested v2 multi-folder item contracts into strict TypeScript; keep loopback base URL configurable only for tests.
- Preflight exact library path, writable library metadata, root ownership, and staging cleanliness before returning success.
- Inventory items and folders with cached hash validation; derive Eagle-owned file paths only inside the verified library root.
- Stage a new item from a temporary or verified Eagle-owned source path, confirm its metadata/hash, then record its Eagle ID before caller cleanup.
- Build both desired folder views from one plan and reconcile membership only after all assets are staged.
- Preserve external links, batch Trash operations, remove only empty managed folders, and never permanently erase.
- Set ascending name order on all managed flow leaves and prove the behaviour with a focused runtime probe before migration.

**Verification:**

- `bun test tests/eagle.test.ts` uses the public module with a fake Eagle adapter to prove preflight rejection, root collision refusal, exact hierarchy, item naming, same-position reuse, different-position copies, staging resume, latest-only replacement, external-link preservation, Trash rules, empty-folder cleanup, and idempotent replay.
- HTTP contract tests prove the real v2 request shapes, pagination, error handling, and batching without opening Eagle.
- Path-confinement tests reject any computed item path outside the verified library root.

### E05 — Implement the scrape transaction and CLI

**Outcome:** `bun run scrape --url ...` completes or resumes one app version directly into Eagle and catalog with no repository WebPs or cloud calls.

**Files or surfaces:**

- `tooling/src/scrape.ts`
- `tooling/src/cli.ts`
- `tooling/tests/scrape.test.ts`
- `tooling/package.json`
- `tooling/.env.example`

**Dependencies:** E02, E03, and E04.

**Approach:**

- Construct production adapters in `cli.ts`; keep business behaviour in `scrape(url)`.
- Enforce operation order: Eagle preflight, Dia preflight, discovery/plan, state resume, asset resolution/staging, folder commit, catalog commit, obsolete cleanup, verification summary.
- Resolve known screen IDs and Eagle-owned hashes before Mobbin fetching as decided above.
- Bound active fetch/import work to a configurable default of six and serialize state transitions that claim the same asset identity.
- Leave the former current app version visible until all desired assets are staged.
- Print counts for discovered references, reused exact identities, copied Eagle identities, Mobbin fetches, staged items, folder changes, Trash moves, and failures. Print no secrets or signed URLs.

**Verification:**

- `bun test tests/scrape.test.ts` proves preflight ordering, no cloud calls, bounded concurrency, exact resume after each injected failure point, no duplicate asset claims, latest-only commit, unchanged old tree before staging completes, temporary cleanup, and no repository WebPs.
- Run `bun run typecheck` and the complete test suite before any real Eagle acceptance.

### E06 — Implement read-only verification

**Outcome:** `bun run verify` provides authoritative, non-mutating evidence for catalog, Eagle, state, folder, hash, ordering, external-link, staging, and repository cleanliness invariants.

**Files or surfaces:**

- `tooling/src/verify.ts` as an internal implementation imported by `cli.ts`
- `tooling/src/cli.ts`
- `tooling/tests/verify.test.ts`
- `tooling/package.json`

**Dependencies:** E02 and E04; E05 command wiring.

**Approach:**

- Verify the exact open library and full managed inventory.
- Cross-check every current screen reference's asset identity, Eagle ID, full file hash, name, and both leaf memberships.
- Confirm ascending visible names, empty staging for completed runs, external-link snapshot preservation, JSON schemas/formatting, SQLite integrity, and rebuild equivalence into a temporary database.
- Scan project-owned files for forbidden WebPs and generated symlink galleries without following `.git` or dependency caches.
- Return structured failures and a non-zero exit; perform no repairs.

**Verification:**

- `bun test tests/verify.test.ts` injects one failure per invariant and proves the reported code identifies the exact mismatch without mutation.
- A clean fake catalog/Eagle/state fixture returns success twice with byte-identical inputs.

### E07 — Implement resumable dry-run and applied migration

**Outcome:** The legacy source and pure-hash Eagle layout can be safely planned, backed up, migrated, resumed, and replayed into the approved model.

**Files or surfaces:**

- `tooling/src/migrate.ts` as an internal implementation imported by `cli.ts`
- `tooling/src/cli.ts`
- `tooling/tests/migration.test.ts`
- legacy source readers for `screen-flows/**/flow.json`, WebPs, and `.eagle-sync-state.json`
- `tooling/package.json`

**Dependencies:** E02, E04, E05 transaction primitives, and E06 verification.

**Approach:**

- Dry-run validates every flow manifest and WebP, derives all asset identities and both folder trees, inventories existing Eagle items and external links, and reports exact reuse/import/rename/folder/Trash/catalog counts without writing.
- Applied migration uses persisted checkpoints for backup, catalog staging, asset staging, folder commit, catalog commit, obsolete cleanup, verification, and completed state.
- Close Eagle for the library clone/copy, verify backup metadata and image count, reopen the original, and repeat preflight before mutation.
- Reuse each current pure-hash item for one decided position, import only additional positions, and verify every staged item before source cleanup.
- Make interruption after any checkpoint safe to resume; re-running a completed migration returns zero mutations.
- Keep legacy source directories in place throughout E07 tests and dry-run.

**Verification:**

- `bun test tests/migration.test.ts` characterizes representative legacy manifests and state, proves expected hash-position expansion, backup-gate refusal, root-collision refusal, external-link preservation, checkpoint resume at every phase, catalog equivalence, and zero-mutation replay.
- Run `bun run migrate:eagle -- --dry-run` against the real source. Expected baseline is 2,591 flows, 11,536 references, 8,825 hashes, and 10,328 identities unless the fresh report explains drift.
- Do not apply if any source file, Eagle cached item, external-link snapshot, or expected identity is unresolved.

### E08 — Run real Eagle acceptance and migration

**Outcome:** The real `Mobbin.library` and generated catalog satisfy the approved design, with a verified recoverable backup and untouched legacy sources until idempotency passes.

**Files or surfaces:**

- `/Users/user/Mobbin.library`
- timestamped sibling Eagle backup path
- `catalog/apps/**`
- `.mobbin/state.sqlite`
- `.eagle-sync-state.json` retained as migration input/backup until E09
- `screen-flows/` and `grouped-flows/` retained until final E08 gate

**Dependencies:** E01-E07 green, fresh dry-run green, no active scrape/export/sync process, and Eagle currently opening the expected library.

**Approach:**

- Run the one-item acceptance against a disposable managed probe path and remove or Trash only its managed probe artifacts after verification.
- Capture baseline root IDs, item IDs, folder memberships, external links, counts, and hashes.
- Create and verify the Eagle backup while Eagle is closed; reopen and revalidate the original.
- Run applied migration as a background-capable resumable command with periodic progress, never parallelize Eagle mutations, and continue until verification completes.
- Run full `verify`, then run migration again. Require zero new items, folder changes, catalog changes, Trash moves, and source reads beyond validation.
- Compare external memberships exactly with the baseline.
- Only after both passes succeed, move `screen-flows` and `grouped-flows` to timestamped paths under macOS Trash and run `verify` again.

**Verification:**

- `bun run verify` passes before and after source-directory removal.
- Current catalog reference count equals the fresh source reference count; active managed item count equals required asset-identity count.
- Every current flow exists in both `Apps/<app>/<flow>` and `Flows/<group>/<app>/<flow>` with ascending names.
- `_Mobbin Staging` is empty for completed work; external links are unchanged; second migration reports zero mutations.
- The backup and both trashed source directories exist and are readable/recoverable; Trash is not emptied.

### E09 — Remove superseded code and finish repository cleanup

**Outcome:** The working tree contains only the Eagle-only pipeline, catalog metadata, relevant tests/docs, and preserved unrelated user changes.

**Files or surfaces:**

- remove `tooling/src/server/**`
- remove `tooling/deploy/**`
- remove cloud-only `tooling/docs/**` runbooks and `tooling/Dockerfile`
- remove superseded `tooling/src/local/**`, `tooling/src/shared/**`, and old tests after their proven behaviour is represented in E01-E07 tests
- remove `scripts/*.mjs` and their tests
- remove `mobbin-authorized-screen-exporter/`
- remove `viewer/`
- remove or replace root `package.json` if it contains only obsolete exporter commands
- move `.eagle-sync-state.json` to a timestamped macOS Trash path after migration replay and retain the Eagle backup as the recovery source
- update `tooling/package.json`, `tooling/bun.lock`, `tooling/README.md`, root `README.md`, root `.gitignore`, and `.agents/skills/mobbin-screens-exporter/**`
- preserve approved and historical `docs/superpowers/specs/**` and `docs/plans/**`
- preserve pre-existing `logic/` deletions and unrelated `.design/` files

**Dependencies:** E08 migration, verification, idempotency, backup, and recoverable Trash gates all green.

**Approach:**

- Remove AWS SDK, `jose`, server entry points, cloud scripts, cloud configuration, and deployment material only now.
- Consolidate the proved Mobbin behaviour under `mobbin.ts`; do not delete a legacy test until equivalent new coverage is green.
- Update the project skill to invoke the new Eagle-only scrape and describe Eagle/catalog outputs.
- Rewrite operating docs around Eagle preflight, scrape, verify, migration recovery, and backup restoration.
- Keep external VPS/R2 shutdown as explicit follow-up work, not a repository command.

**Verification:**

- From `tooling/`, `bun install --frozen-lockfile`, `bun run typecheck`, and `bun test` pass with no cloud packages installed.
- `bun run verify` passes against the real library after a fresh process start.
- `rg` finds no runtime R2, Chevereto, ingest, gallery, cloud mode, local-image export, grouped-flow generation, or legacy exporter references outside historical design/plan documents.
- The repository media guard reports no project-owned WebP and no `screen-flows` or `grouped-flows` directory.
- No legacy `.eagle-sync-state.json` remains active in the repository root.
- `git status --short` still shows the pre-existing unrelated `logic/` deletions unchanged and contains no accidental modification outside owned surfaces.

## Risks and Open Questions

- **Eagle internal v2 compatibility:** Eagle 4.0 currently supports the endpoints used by the old sync, but folder sort mutation is not covered by the public API. The E04 one-item probe is the mandatory runtime gate; the isolated script-injection fallback is permitted only if tested.
- **Live-library backup consistency:** Copying while Eagle is open is unsafe. E07 must prove close/clone-or-copy/reopen checks before E08.
- **Count drift:** Source and Eagle counts may change before execution. Fresh dry-run output is authoritative; unexplained drift blocks apply.
- **Long migration:** Hashing and roughly 1,503 additional positioned imports may take several minutes. The command must persist checkpoints and report progress; it must run without mutation fan-out.
- **Dirty worktree:** Target surfaces contain prior prototype edits and untracked files. E01 records the baseline, and E09's final diff audit distinguishes owned replacements from unrelated deletions.
- **Tracked legacy metadata:** `screen-flows` contains tracked `flow.json` files even though WebPs are ignored. Their deletion is expected only after equivalent catalog JSON exists and E08 verification passes.
- **No blocker remains:** Product behaviour, ownership, identity, folder shape, latest-only policy, failure semantics, migration recovery, and external shutdown boundaries are settled.

## Completion

The work is complete only when all of the following are freshly observed:

- `tooling/` implements the five approved module interfaces and exposes only `scrape`, `verify`, `migrate:eagle`, `test`, and `typecheck` operational commands.
- The tracked `catalog/` contains deterministic app and version JSON for every migrated valid flow and current app.
- `.mobbin/state.sqlite` is healthy, ignored, resumable, and rebuildable into an equivalent temporary database.
- Eagle shows `Apps`, `Flows`, and an empty `_Mobbin Staging`; both visible views contain every current flow with correctly ordered items.
- The number of active managed Eagle items equals the fresh hash-position identity count, and every item's full hash, position, name, and memberships verify.
- Existing external Eagle folder links are byte-for-byte equivalent to the pre-migration snapshot.
- Applied migration and its immediate second run complete, with the second reporting zero mutations.
- A verified Eagle backup exists, while `screen-flows` and `grouped-flows` are absent from the repository and recoverable from macOS Trash.
- No project-owned WebP, symlink gallery, cloud runtime, legacy exporter, or local image viewer remains.
- Full typecheck, tests, and real `bun run verify` pass after cleanup.
- The VPS, Chevereto, DNS, R2 buckets, R2 objects, and credentials remain untouched and are listed as follow-up shutdown work.
- The pre-existing unrelated `logic/` deletions and other user changes are preserved.
- The final result remains an uncommitted, unpushed, undeployed working tree ready for user inspection, as required by `$ns-work`.
