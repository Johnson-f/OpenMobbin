---
name: mobbin-screens-exporter
description: Repeatable Mobbin app screen export workflow for authorized Mobbin sessions. Use when exporting Mobbin screens or flows from Dia/Chromium-authenticated pages into categorized latest-images and latest-reports folders, verifying unique full-size images, preventing duplicate downloads, avoiding tiny placeholder images, and producing JSON/CSV evidence reports.
---

# Mobbin Screens Exporter

## Core Workflow

Use this skill for authorized Mobbin screen exports from `/Users/user/mobbin-sides`.

Prefer the bundled wrapper:

```bash
node /Users/user/mobbin-sides/skills/mobbin-screens-exporter/scripts/run-export.mjs \
  --page-url "<mobbin app screens or flows URL>" \
  --category "<folder-name>"
```

For app-name requests, resolve the Mobbin URL through authenticated Mobbin search:

```bash
node /Users/user/mobbin-sides/skills/mobbin-screens-exporter/scripts/run-export.mjs \
  --query "<app-name>" \
  --platform "ios" \
  --category "<folder-name>"
```

If the user provides a Dia appshot, extract the Mobbin app URL from the appshot. Convert `/flows` to `/screens` only when the user asks for all screens; the exporter can parse either route when the authenticated payload includes the app screens.

If `--category` is omitted, derive it from the app slug. Example: `nike-ios-...` becomes `nike`.

## Required Preconditions

- Confirm the user has authorization to retain the target screen bytes when that is not already established.
- Use the Dia profile at `/Users/user/Library/Application Support/Dia/User Data/Default` unless the user specifies another profile.
- Use `/Users/user/mobbin-sides/scripts/export-mobbin-screens.mjs` as the source exporter.
- Do not print, write, or summarize decrypted cookie values, auth tokens, or signed CDN URLs.

## Output Contract

Default outputs:

```text
/Users/user/mobbin-sides/latest-images/<category>/
/Users/user/mobbin-sides/latest-reports/<category>/mobbin-screen-downloadables-report.json
/Users/user/mobbin-sides/latest-reports/<category>/mobbin-screen-downloadables.csv
```

The wrapper verifies:

- `savedImageCount === screenCount`
- filesystem image count equals `savedImageCount`
- `uniqueSha256Count === savedImageCount`
- `tinyImageCount === 0`

Read `references/output-contract.md` before changing folder layout, report schema, or acceptance checks.

## Commands

Run Nike again:

```bash
node /Users/user/mobbin-sides/skills/mobbin-screens-exporter/scripts/run-export.mjs \
  --page-url "https://mobbin.com/apps/nike-ios-03eab082-d557-423b-92f8-797b18bc1f36/f1257fae-f105-498b-8a5c-92f9c2e2b5b0/screens" \
  --category "nike"
```

Run Revolut by name:

```bash
node /Users/user/mobbin-sides/skills/mobbin-screens-exporter/scripts/run-export.mjs \
  --query "revolut" \
  --platform "ios" \
  --category "revolut"
```

Run Phantom again:

```bash
node /Users/user/mobbin-sides/skills/mobbin-screens-exporter/scripts/run-export.mjs \
  --page-url "https://mobbin.com/apps/phantom-ios-28f44562-240b-48eb-997f-8a1a731499cb/689aadcf-d2e3-49bb-8ebb-e135252e28bd/screens" \
  --category "phantom"
```

Smoke test without touching latest output folders:

```bash
node /Users/user/mobbin-sides/skills/mobbin-screens-exporter/scripts/run-export.mjs \
  --page-url "https://mobbin.com/apps/phantom-ios-28f44562-240b-48eb-997f-8a1a731499cb/689aadcf-d2e3-49bb-8ebb-e135252e28bd/screens" \
  --category "skill-smoke" \
  --limit 1 \
  --images-dir "/Users/user/Documents/Codex/2026-08-12/i/work/mobbin-skill-smoke/images" \
  --report-dir "/Users/user/Documents/Codex/2026-08-12/i/work/mobbin-skill-smoke/reports"
```

## Troubleshooting

Read `references/troubleshooting.md` when:

- cookie parsing fails
- Mobbin returns a generic/not-found payload
- duplicate hashes appear
- tiny placeholder images appear
- the page has flows but no embedded `screenCdnImgSources`

Patch the main exporter only when the wrapper shows the exporter itself is the failing layer. Keep fixes scoped and re-run the wrapper after every change.
