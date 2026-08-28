# Mobbin Eagle catalog

This repository scrapes authorized Mobbin flows through the signed-in Dia session and stores every WebP in Eagle. The repository keeps only deterministic JSON metadata and resumable local state.

## Storage

- Eagle owns image bytes in `/Users/user/Mobbin.library`.
- `catalog/apps/` owns readable app and version metadata.
- `.mobbin/state.sqlite` owns ignored, rebuildable operation state.
- No WebP or generated symlink gallery belongs in this repository.

Eagle exposes two views over the same managed items:

```text
Apps/<app>/<numbered flow>
Flows/<flow group>/<app>/<numbered flow>
```

Items use `SHA-256 + screen position` identity so their names preserve flow order while identical content at the same position is shared.

## Commands

```bash
cd /Users/user/mobbin-sides/tooling
bun run scrape --url "<Mobbin flows URL>"
bun run verify
bun run migrate:eagle -- --dry-run
```

Eagle must be open with `Mobbin.library` selected before `scrape` or `verify`.

## Safety

- New images stage in `_Mobbin Staging` before catalog commit.
- Interrupted work resumes from SQLite.
- Managed orphans move to Eagle Trash, never permanent deletion.
- Links outside managed `Apps` and `Flows` folders are preserved.
- VPS, R2, Chevereto, and DNS shutdown are separate operations and are not controlled here.

See [the approved design](docs/superpowers/specs/2026-08-27-eagle-only-mobbin-pipeline-design.md) and [implementation plan](docs/plans/2026-08-27-eagle-only-mobbin-pipeline-implementation-plan.md).
