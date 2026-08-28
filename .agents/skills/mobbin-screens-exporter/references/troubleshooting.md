# Troubleshooting

## Eagle preflight

Open Eagle with `/Users/user/Mobbin.library`. Do not point the importer at another library or claim an unowned `Apps`, `Flows`, or `_Mobbin Staging` root.

## Dia authentication

Sign out of Mobbin in Dia, sign back in, and rerun. Never print decrypted cookie values.

## Mobbin access or challenge

Open the exact app version in Dia. Complete any login or challenge in the browser, then rerun. Authentication, access, and challenge errors are not ordinary network retries.

## Interrupted work

Repeat the same scrape URL. SQLite resumes staged identities and the visible current version remains until the replacement is ready.

## Verification failure

Run `bun run verify` and fix the reported invariant. Verification is read-only; do not edit Eagle library metadata files directly.
