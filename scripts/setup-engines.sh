#!/usr/bin/env bash
# setup-engines.sh — fetch the external engines Mira does NOT bundle.
#
# n8n and SkyReels-V2 are not redistributed with Mira because their licenses are
# incompatible with Mira's AGPL-3.0 (n8n = fair-code Sustainable Use License;
# SkyReels-V2 = Skywork Community License). You obtain them directly from upstream,
# under upstream's terms. This script clones them into repos/ for local use.
#
# Usage: bash scripts/setup-engines.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPOS="$ROOT/repos"
mkdir -p "$REPOS"

clone_if_missing() {
  local name="$1" url="$2"
  if [ -d "$REPOS/$name/.git" ]; then
    echo "✓ $name already present"
  else
    echo "→ cloning $name from $url"
    git clone --depth 1 "$url" "$REPOS/$name"
  fi
}

echo "Fetching external engines (obtained from upstream under their own licenses):"
clone_if_missing "n8n"         "https://github.com/n8n-io/n8n.git"
clone_if_missing "SkyReels-V2" "https://github.com/SkyworkAI/SkyReels-V2.git"

echo
echo "Done. Review each project's LICENSE — n8n (Sustainable Use License) and"
echo "SkyReels-V2 (Skywork Community License) carry their own terms."
