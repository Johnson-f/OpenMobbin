# Mobbin Sides Viewer

Local React viewer for the Mobbin export folders under `/Users/user/mobbin-sides/flows`.

## Run

```bash
cd /Users/user/mobbin-sides/viewer
npm run dev
```

Open:

```text
http://localhost:5177
```

No npm install is required. The local Node server scans the export directory and the browser imports React from an ESM CDN.

## Use another export directory

```bash
MOBBIN_EXPORT_ROOT="/path/to/full/mobbin/export/flows" npm run dev
```

The directory should contain action folders like:

```text
flows/
  transferring-money/
    flow-export-report.json
    001-wise-sending-money-.../
      flow.json
      001-...webp
```

## Local APIs

```text
GET /api/catalog
GET /api/flow?action=<action-slug>&folder=<flow-folder>
GET /assets/<path-under-export-root>
```

The server only serves files inside `MOBBIN_EXPORT_ROOT`; path traversal is blocked.
