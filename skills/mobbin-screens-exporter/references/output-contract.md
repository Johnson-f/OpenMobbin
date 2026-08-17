# Output Contract

Canonical project root:

```text
/Users/user/mobbin-sides
```

Canonical categorized outputs:

```text
latest-images/<category>/
latest-reports/<category>/mobbin-screen-downloadables-report.json
latest-reports/<category>/mobbin-screen-downloadables.csv
```

Compatibility note: `latest-report` may exist as a symlink to `latest-reports`; keep `latest-reports` canonical in new code and documentation.

Successful reports must satisfy:

```text
screenCount > 0
savedImageCount == screenCount
filesystem image count == savedImageCount
uniqueSha256Count == savedImageCount
tinyImageCount == 0
```

Known verified exports:

```text
phantom: 190 screens, 190 saved, 190 unique, 0 tiny
nike: 284 screens, 284 saved, 284 unique, 0 tiny
```

Report files intentionally include hashes, dimensions, response metadata, selected source descriptors, and local saved paths. They must not include decrypted cookies, auth tokens, or signed CDN URLs.
