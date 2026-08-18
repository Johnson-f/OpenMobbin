# Mobbin Sides Exporter

Repeatable local exporter for Mobbin app screens using the authenticated Dia browser session.

This was built from the verified Phantom iOS run. Current verified exports:

- `phantom`: 190 unique full-size screen images, 0 tiny placeholder images.
- `nike`: 284 unique full-size screen images, 0 tiny placeholder images.
- `shopping-pricing`: Shopping-category iOS screens with the Pricing screen pattern.

## Folder Layout

- `scripts/export-mobbin-screens.mjs` - repeatable exporter.
- `scripts/export-mobbin-flows.mjs` - repeatable flow exporter; creates one folder per flow and saves ordered screen images inside it.
- `viewer/` - local React viewer for browsing the exported flow directory.
- `latest-images/<category>/` - latest downloaded screen images for that app/category.
- `latest-reports/<category>/mobbin-screen-downloadables-report.json` - latest JSON evidence report.
- `latest-reports/<category>/mobbin-screen-downloadables.csv` - latest CSV inventory.
- `flows/<flow-action>/<flow-folder>/` - exported flow screen images plus per-flow `flow.json`.

Current categories:

```text
phantom
nike
shopping-pricing
```

## Requirements

- macOS.
- Dia installed and logged into Mobbin.
- Your Dia account must be authorized to access/download the target screens.
- Local tools available:
  - `node`
  - `sqlite3`
  - macOS `security`

No npm dependencies are required.

## Default Run

From this folder:

```bash
cd /Users/user/mobbin-sides
node scripts/export-mobbin-screens.mjs
```

For the safer repeatable workflow, use the bundled skill wrapper:

```bash
node skills/mobbin-screens-exporter/scripts/run-export.mjs \
  --page-url "https://mobbin.com/apps/<app-slug-with-uuid>/<app-version-id>/screens" \
  --category "<category-name>"
```

Or resolve an app by name:

```bash
node skills/mobbin-screens-exporter/scripts/run-export.mjs \
  --query "revolut" \
  --platform "ios" \
  --category "revolut"
```

The wrapper runs the exporter and fails the run if saved files, report counts, unique hashes, or tiny-image checks do not match.

The default target is:

```text
https://mobbin.com/apps/phantom-ios-28f44562-240b-48eb-997f-8a1a731499cb/689aadcf-d2e3-49bb-8ebb-e135252e28bd/screens
```

Outputs are written to:

```text
/Users/user/mobbin-sides/latest-images/phantom
/Users/user/mobbin-sides/latest-reports/phantom
```

## Run Against Another Mobbin App Page

Use a Mobbin app `screens` or `flows` page URL:

```bash
node scripts/export-mobbin-screens.mjs \
  --page-url "https://mobbin.com/apps/<app-slug-with-uuid>/<app-version-id>/screens" \
  --category "<category-name>"
```

The script extracts the app id from the slug and the app version id from the URL.

## Run Search Filters

The exporter can mirror search UI filters. This command exports iOS screens for the Shopping app category with the Pricing screen pattern:

```bash
npm run export:shopping-pricing
```

Equivalent direct command:

```bash
node scripts/export-mobbin-screens.mjs \
  --search-url "https://mobbin.com/search/apps/ios?content_type=apps&sort=popularity&filter=appCategories.Shopping" \
  --app-category "Shopping" \
  --screen-pattern "Pricing" \
  --category "shopping-pricing" \
  --concurrency 8
```

Filter mode first checks Mobbin's screen-search endpoint. If that endpoint advertises more pages but returns an empty next page, the script falls back to the app-search endpoint, walks the matching app pages, filters each app's authenticated screen array locally, and then saves matching screens through `fetch-screen-info -> downloadableSrc`.

## Run All UI Element Filters

Export every visible iOS UI-element filter from the Mobbin UI into one folder per element. The all-filter command crawls app pages once, classifies each screen by its `screenElements`, downloads each unique screen once, and hard-links it into every matching element folder to avoid running 49 separate full crawls.

```bash
npm run export:ui-elements:all
```

Output structure:

```text
/Users/user/mobbin-sides/UI-element/
  accordion/
  button/
  checkbox/
  ...
/Users/user/mobbin-sides/UI-element-reports/
  ui-elements-export-report.json
  accordion/mobbin-screen-downloadables-report.json
  accordion/mobbin-screen-downloadables.csv
  ...
```

Run one element:

```bash
node scripts/export-mobbin-ui-elements.mjs --element "Accordion"
```

Use the optimized crawler for a subset:

```bash
node scripts/export-mobbin-ui-elements-crawl.mjs --element "Accordion"
```

Run a bounded smoke test without downloading the full set:

```bash
node scripts/export-mobbin-ui-elements-crawl.mjs --all --limit-apps 5 --limit-screens 10
```

## Run Flow Filters

The flow exporter mirrors the Mobbin flows filter UI and saves each flow end-to-end in its own folder:

```bash
npm run export:flows:transferring-money
```

Equivalent direct command:

```bash
node scripts/export-mobbin-flows.mjs \
  --flow-action "Transferring Money" \
  --concurrency 10 \
  --screen-concurrency 4
```

Run every visible flow-action filter from the Mobbin flow filter UI:

```bash
npm run export:flows:all
```

Output structure:

```text
/Users/user/mobbin-sides/flows/transferring-money/
  flow-export-report.json
  flow-export-report.csv
  001-wise-sending-money-0c5bf5da-674f-474d-8ecc-747e41c486ad/
    001-<screen-id>-downloadableSrc-<hash>.webp
    002-<screen-id>-downloadableSrc-<hash>.webp
    flow.json
```

Run a bounded smoke test:

```bash
node scripts/export-mobbin-flows.mjs \
  --flow-action "Editing Profile" \
  --limit-flows 2
```

Current HTTPS API note: `/api/search/fetch-search-page-flows` advertises the full result count and `hasNextPage`, but for the tested Dia session the next `pageIndex` returned an empty page. The exporter records this in `flow-export-report.json` as `paginationComplete: false` / `stoppedOnEmptyNextPage: true` when it happens. The saved output is still valid for the flows returned by the endpoint.

## Useful Options

```bash
node scripts/export-mobbin-screens.mjs \
  --page-url "https://mobbin.com/apps/phantom-ios-28f44562-240b-48eb-997f-8a1a731499cb/689aadcf-d2e3-49bb-8ebb-e135252e28bd/screens" \
  --category "phantom" \
  --concurrency 6
```

Other options:

- `--category` - subfolder name under `latest-images/` and `latest-reports/`. Default: `phantom`
- `--profile-dir` - Dia profile directory. Default: `/Users/user/Library/Application Support/Dia/User Data/Default`
- `--safe-storage-service` - macOS keychain service for Dia cookie decryption. Default: `Dia Safe Storage`
- `--images-dir` - override the exact images directory instead of using category subfolders.
- `--report-dir` - override the exact report directory instead of using category subfolders.
- `--limit` - export only the first N screens for a test run.

Flow exporter options:

- `--flow-action` - one flow action name, e.g. `Transferring Money` or `Editing Profile`.
- `--flow-actions` - comma-separated flow actions.
- `--platform` - default: `ios`.
- `--out-dir` - default: `/Users/user/mobbin-sides/flows`.
- `--limit-flows` - export only the first N flows for a test run.
- `--limit-screens` - export only the first N screens per flow for a test run.
- `--concurrency` - number of flows to export in parallel.
- `--screen-concurrency` - number of screens to export in parallel inside each flow. Default: `4`.
- `--force` - re-download complete flow folders instead of reusing complete `flow.json` reports.

Monitor the long all-filter run:

```bash
tail -f /Users/user/mobbin-sides/flows/export-all-flows.log
launchctl list | rg mobbin-flows-all
```

Stop the launchd all-filter run:

```bash
launchctl remove com.user.mobbin-flows-all
```

## View Exports Locally

Run the local React viewer:

```bash
cd /Users/user/mobbin-sides/viewer
npm run dev
```

Open:

```text
http://localhost:5177
```

The viewer scans `/Users/user/mobbin-sides/flows`, renders flow-action filters, flow cards, and ordered screen galleries. To point it at a different full export directory:

```bash
MOBBIN_EXPORT_ROOT="/path/to/full/mobbin/export/flows" npm run dev
```

Example test:

```bash
node scripts/export-mobbin-screens.mjs --limit 5
```

## What The Script Does

1. Copies Dia's Chromium cookie database to a temporary file so the live browser database is not disturbed.
2. Reads only Mobbin cookies from the copied DB.
3. Decrypts Dia's Chromium cookie values locally through macOS Keychain.
4. Fetches the authenticated Mobbin app page.
5. Parses the Next.js flight payload to find the app's authenticated `screens` array, or in filter mode fetches matching apps/screens from Mobbin's authenticated search APIs.
6. For each screen, calls:

```text
POST https://mobbin.com/api/screen/fetch-screen-info
```

7. Uses `screenCdnImgSources.downloadableSrc` when available.
8. Saves one image per screen.
9. Writes JSON and CSV reports with hashes, dimensions, response metadata, and local saved paths.

## Verification

After a run:

```bash
find /Users/user/mobbin-sides/latest-images/phantom -type f | wc -l
node -e "const r=require('/Users/user/mobbin-sides/latest-reports/phantom/mobbin-screen-downloadables-report.json'); console.log({screenCount:r.imageCount ?? r.screenCount,saved:r.savedImageCount,unique:r.uniqueSha256Count,tiny:r.tinyImageCount})"
```

Expected for the current Phantom run:

```json
{
  "screenCount": 190,
  "saved": 190,
  "unique": 190,
  "tiny": 0
}
```

## Why `downloadableSrc` Matters

The authenticated page payload can include thumbnail or placeholder CDN URLs for restricted screens. Those may download as tiny `15x32` or `15x33` WebP images.

The correct path is:

```text
/api/screen/fetch-screen-info -> screenCdnImgSources.downloadableSrc
```

That is what this script uses.

## Troubleshooting

If the script says no Mobbin cookies were found:

1. Open Dia.
2. Log into Mobbin.
3. Visit the target Mobbin app page.
4. Run the script again.

If macOS asks for Keychain access, allow access for Dia cookie decryption.

If `tinyImageCount` is not `0`, the script is not getting `downloadableSrc` for some screens. Check the JSON report for the affected `screenId`, then manually verify `/api/screen/fetch-screen-info` returns `screenCdnImgSources.downloadableSrc` for that screen.

## Notes

- The script does not print or store decrypted cookies or access tokens.
- Reports store CDN host and URL path hash, not the full signed CDN URL.
- Images are saved locally because this workflow assumes you are authorized to access and retain this Mobbin content.
