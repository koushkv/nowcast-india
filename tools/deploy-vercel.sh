#!/usr/bin/env bash
# Deploy to Vercel (production) and attach the custom domain.
# Needs VERCEL_TOKEN; set VERCEL_SCOPE to your team slug if the project lives in a team.
# Usage: tools/deploy-vercel.sh [domain]
set -euo pipefail
DOMAIN="${1:-weather.koushikv.site}"
cd "$(dirname "$0")/.."
: "${VERCEL_TOKEN:?Set VERCEL_TOKEN (create one at https://vercel.com/account/tokens)}"
SCOPE=()
if [ -n "${VERCEL_SCOPE:-}" ]; then SCOPE=(--scope "$VERCEL_SCOPE"); fi
V() { npx --yes vercel@latest "$@" --token "$VERCEL_TOKEN" "${SCOPE[@]}"; }
V deploy --prod --yes            # creates/links the "pitwall-weather" project on first run
V domains add "$DOMAIN" pitwall-weather || true   # no-op if already attached
V domains inspect "$DOMAIN" || true               # shows the DNS record Vercel expects
echo "Live at https://$DOMAIN once DNS resolves (instant if koushikv.site uses Vercel DNS)."
