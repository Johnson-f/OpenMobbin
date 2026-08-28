# Eagle-only Mobbin tooling

## Setup

```bash
bun install --frozen-lockfile
cp .env.example .env.local
```

The defaults target Dia's default profile and `/Users/user/Mobbin.library`.

## Scrape an app version

Open Eagle and sign into Mobbin in Dia, then run:

```bash
bun run scrape --url "https://mobbin.com/apps/<app>/<version>/flows"
```

The command preflights Eagle and Dia, reuses cataloged hashes, stages only missing identities, reconciles `Apps` and `Flows`, commits JSON, and moves true managed orphans to Eagle Trash.

## Verify

```bash
bun run verify
```

Verification checks Eagle hashes, item names, both folder memberships, folder sorting, empty staging, catalog formatting, SQLite integrity/rebuild, and the repository media ban.

## Migration recovery

```bash
bun run migrate:eagle -- --dry-run
bun run migrate:eagle
```

Migration is checkpointed and idempotent. Applied migration closes Eagle briefly to make a verified library backup before mutation.

## Development

```bash
bun run typecheck
bun test
```
