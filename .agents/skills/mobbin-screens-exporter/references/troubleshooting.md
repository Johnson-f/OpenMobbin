# Troubleshooting

## Cookie Parsing Fails

Use the exporter path that reads Dia cookies through `sqlite3 -json`.

Do not concatenate SQLite fields with a delimiter when `value` can be `NULL`; it can drop encrypted-cookie rows and silently remove auth cookies.

Never print decrypted cookie values. It is acceptable to print cookie row counts or cookie names when debugging.

## Generic Or Not-Found Mobbin Payload

Check authentication first. A `200` HTML response can still contain a generic fallback payload instead of the authenticated app data.

Verify:

```bash
node /Users/user/mobbin-sides/scripts/export-mobbin-screens.mjs --limit 1 --category auth-check
```

Use `work/` override directories for temporary smoke tests when avoiding latest output folders.

## App Name Resolution

Use wrapper `--query "<app-name>" --platform ios` when the user gives an app name instead of a Mobbin URL.

Resolution path:

```text
POST /api/search-bar/search with { query, experience: "apps", platform }
GET /api/app-hover-card/<appId>
https://mobbin.com/apps/<slugified-name>-<platform>-<appId>/<latest-version-id>/screens
```

Search and hover-card calls require Dia-authenticated Mobbin cookies. Do not print cookies or signed CDN URLs while debugging.

## Duplicate Hashes

Duplicates usually mean the exporter selected carousel thumbnails or repeated preview images instead of one canonical screen per `screen.id`.

Use the wrapper default behavior; it fails when `uniqueSha256Count !== savedImageCount`.

Patch the exporter only after checking the report's `results[*].screenId`, `sha256`, `descriptor`, and dimensions.

## Tiny Placeholder Images

Tiny images are usually restricted placeholders, such as `15x32` or `15x33` WebP files.

The correct source path is:

```text
POST /api/screen/fetch-screen-info -> screenCdnImgSources.downloadableSrc
```

Do not accept a run with `tinyImageCount > 0` unless the user explicitly asks to preserve diagnostic failures.

## Flow Pages

For flow pages, prefer using the corresponding `/screens` URL when exporting every unique app screen. The exporter can still start from `/flows` if the authenticated payload contains the screen array.

When only flow-specific screens are needed, inspect `partialFlows` and confirm whether the request should export all app screens or only screens belonging to selected flows.
