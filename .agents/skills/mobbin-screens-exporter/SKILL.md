---
name: mobbin-screens-exporter
description: Import authorized Mobbin app flows from the signed-in Dia session into the Eagle-only Apps and Flows catalog. Use when scraping, resuming, or verifying Mobbin flows.
---

# Mobbin Eagle importer

## Preconditions

- The user is authorized to retain the requested Mobbin screens.
- Dia is signed into Mobbin using its default profile.
- Eagle is open with `/Users/user/Mobbin.library` selected.
- Never print cookies, signed CDN URLs, or temporary image bytes.

## Import

```bash
cd /Users/user/mobbin-sides/tooling
bun run scrape --url "<Mobbin app version flows URL>"
```

The command preflights Eagle and Dia, stages missing identities, updates both Eagle views, writes deterministic catalog JSON, and removes temporary files. Repeating the same version must make no duplicate item.

## Output

- WebPs exist only in Eagle.
- App metadata is under `catalog/apps/<slug>/`.
- Operational state is under ignored `.mobbin/state.sqlite`.
- Eagle folders are `Apps/<app>/<flow>` and `Flows/<group>/<app>/<flow>`.

Read `references/output-contract.md` before changing identities, folder names, catalog schemas, or verification rules.

## Verification

```bash
cd /Users/user/mobbin-sides/tooling
bun run verify
```

Read `references/troubleshooting.md` when Eagle preflight, Dia authentication, Mobbin access, staging, or verification fails.
