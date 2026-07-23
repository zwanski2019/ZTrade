#!/usr/bin/env bash
#
# Publishes docs/wiki/ to the GitHub wiki.
#
# GitHub only creates the wiki's git repository after the FIRST page is made in
# the web UI. There is no API for it. So the one-time manual step is:
#
#   1. https://github.com/zwanski2019/ZTrade/wiki  →  "Create the first page"
#   2. Save it with any content at all
#   3. Run this script
#
set -euo pipefail

REPO="${1:-zwanski2019/ZTrade}"
WIKI_URL="https://github.com/${REPO}.wiki.git"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/docs/wiki"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "→ cloning $WIKI_URL"
if ! git clone --quiet "$WIKI_URL" "$TMP/wiki" 2>/dev/null; then
  cat >&2 <<'EOF'
✗ The wiki repository does not exist yet.

  GitHub creates it only after the first page is saved in the web UI:
    1. Open https://github.com/zwanski2019/ZTrade/wiki
    2. Click "Create the first page" and save it
    3. Re-run this script

EOF
  exit 1
fi

echo "→ copying $(ls "$SRC" | wc -l) pages"
cp "$SRC"/*.md "$TMP/wiki/"

cd "$TMP/wiki"
if git diff --quiet && git diff --cached --quiet && [ -z "$(git status --porcelain)" ]; then
  echo "✓ wiki already up to date"
  exit 0
fi

git add -A
git commit --quiet -m "docs: sync wiki from docs/wiki"
git push --quiet origin HEAD
echo "✓ published → https://github.com/${REPO}/wiki"
