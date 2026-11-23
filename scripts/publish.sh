#!/bin/sh
# Publishes the Cella site and its relayer to Cloudflare Pages.
#   sh scripts/publish.sh [deployments/46630.json] [project-name]
# Needs a one-time `npx wrangler login`. The relayer key is read from
# ~/.config/cella/relayer.key and sent to Cloudflare as a secret; it is never printed.
set -e
cd "$(dirname "$0")/.."
DEPLOYMENT="${1:-deployments/46630.json}"
PROJECT="${2:-cella}"
KEY="$HOME/.config/cella/relayer.key"
[ -f "$KEY" ] || { echo "no relayer key at $KEY"; exit 1; }

npx wrangler whoami >/dev/null 2>&1 || { echo "Not signed in to Cloudflare. Run: npx wrangler login"; exit 1; }
node scripts/build-web.mjs "$DEPLOYMENT" --relayer /api/relayer
npx wrangler pages project list 2>/dev/null | grep -q " $PROJECT " || npx wrangler pages project create "$PROJECT" --production-branch main
npx wrangler pages secret put CELLA_RELAYER_KEY --project-name "$PROJECT" < "$KEY"
npx wrangler pages deploy build/web --project-name "$PROJECT" --branch main --commit-dirty=true
