━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 📦 Plugin update: v1.14.5 → v1.60.4 (minor)
**Multi-runtime install fix (Tier-2 bundles)** - follow-up to 1.60.3. The same Claude-only `model:` frontmatter directive is now stripped from the Tier-2 marketplace distribution bundles, not just the Tier-1 file-drop command files.

### Fixed

- **`model:` frontmatter stripped from Tier-2 marketplace bundles** (`scripts/lib/install/converters/codex-plugin.cjs`, `scripts/lib/install/converters/cursor-marketplace.cjs`). These converters copied the `skills/` tree verbatim, so `model: inherit` stil
 Install: /gdd:update   Dismiss: /gdd:check-update --dismiss
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
