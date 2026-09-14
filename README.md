# Mobbin Eagle catalog

This repository scrapes authorized Mobbin iOS and web app flows through the signed-in Dia session and stores every WebP in Eagle. The repository keeps only deterministic JSON metadata and resumable local state.

## Storage

- Eagle owns image bytes in `/Users/user/Mobbin.library`.
- `catalog/apps/` owns readable app and version metadata.
- `.mobbin/state.sqlite` owns ignored, rebuildable operation state.
- No WebP or generated symlink gallery belongs in this repository.

Eagle exposes two views over the same managed items:

```text
Apps/<app>/<numbered flow>
Flows/<flow group>/<app> — <numbered flow>
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

## Web apps

Use the same command with a Mobbin web app version URL:

```bash
bun run scrape --url "https://mobbin.com/apps/luma-web-1568da8b-52fe-4a00-9170-6558e9f10d74/99c7040b-604e-41e9-975b-f532656753c1/flows"
```

Web app catalog names append `-web` to the source app name: Luma Web is stored under `catalog/apps/luma-web/` and `Apps/luma-web/`, while existing Luma iOS remains `luma`. Grouped folders use `Flows/onboarding/luma-web — 001 — Onboarding`.

Updates replace only the matching app and platform. A catalog name already occupied by a different Mobbin app ID or platform stops the import before image changes. Repeating a completed version reuses the existing import. Images retain the largest available source; no resize or conversion is applied.

Web apps use Mobbin `/apps/...-web-...` URLs. Mobbin's separate Sites collection is outside this pipeline. Dia must have access to the requested web app.

## Safety

- New images stage in `_Mobbin Staging` before catalog commit.
- Interrupted work resumes from SQLite.
- Managed orphans move to Eagle Trash, never permanent deletion.
- Links outside managed `Apps` and `Flows` folders are preserved.
- VPS, R2, Chevereto, and DNS shutdown are separate operations and are not controlled here.

See [the approved design](docs/superpowers/specs/2026-08-27-eagle-only-mobbin-pipeline-design.md) and [implementation plan](docs/plans/2026-08-27-eagle-only-mobbin-pipeline-implementation-plan.md).
