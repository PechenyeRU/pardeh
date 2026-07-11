#!/bin/bash
# Build script for Pardeh.
# Packages the extension for Chrome (zip) and Firefox (xpi) from the single
# source tree in the repository root. The Firefox manifest is generated on
# the fly (MV2 event page: Firefox MV3 host permissions are opt-in, which
# would silently disable the content script on install).

set -euo pipefail
cd "$(dirname "$0")"

DIST_DIR="dist"
NAME="pardeh"
VERSION="$(python3 -c "import json; print(json.load(open('manifest.json'))['version'])")"

# Files shipped inside the packages (keep in sync with manifest.json).
FILES=(
  background.js
  crypto.js
  state-machine.js
  i18n.js
  content.js
  composer.html
  composer.js
  popup.html
  popup.js
  icon.png
)

rm -rf "$DIST_DIR"
mkdir -p "$DIST_DIR/chrome" "$DIST_DIR/firefox"

# --- Chrome (MV3, source manifest as-is) ---
cp manifest.json "${FILES[@]}" "$DIST_DIR/chrome/"
(cd "$DIST_DIR/chrome" && zip -q -r "../${NAME}-${VERSION}-chrome.zip" .)

# --- Firefox (MV2 transform) ---
cp "${FILES[@]}" "$DIST_DIR/firefox/"
python3 - "$DIST_DIR/firefox/manifest.json" <<'PY'
import json
import sys

with open("manifest.json") as f:
    m = json.load(f)

m["manifest_version"] = 2
m.pop("minimum_chrome_version", None)
m.pop("key", None)          # Chrome-only: fixes the extension ID; Firefox uses gecko.id
m.pop("update_url", None)   # Chrome-only self-host update URL (Firefox uses gecko.update_url)

host_permissions = m.pop("host_permissions", [])
permissions = [p for p in m.get("permissions", []) if p != "scripting"]
m["permissions"] = permissions + host_permissions

# The event page loads the shared modules from the manifest; the Chrome
# service worker pulls them in via importScripts instead.
m["background"] = {
    "scripts": ["crypto.js", "state-machine.js", "background.js"],
    "persistent": False,
}

m["browser_action"] = m.pop("action")

# MV2 takes a flat list of paths instead of match-scoped objects.
m["web_accessible_resources"] = [
    path
    for entry in m["web_accessible_resources"]
    for path in entry["resources"]
]

m["browser_specific_settings"] = {
    "gecko": {
        "id": "pardeh@e2e-encryption.bale.ai",
        "strict_min_version": "115.0",
    }
}

with open(sys.argv[1], "w") as f:
    json.dump(m, f, indent=2, ensure_ascii=False)
    f.write("\n")
PY
(cd "$DIST_DIR/firefox" && zip -q -r "../${NAME}-${VERSION}-firefox.xpi" .)

rm -rf "$DIST_DIR/chrome" "$DIST_DIR/firefox"

echo "Built:"
echo "  $DIST_DIR/${NAME}-${VERSION}-chrome.zip"
echo "  $DIST_DIR/${NAME}-${VERSION}-firefox.xpi"
echo ""
echo "Chrome: chrome://extensions -> Developer mode -> Load unpacked (repo root),"
echo "        or drop the zip on the page."
echo "Firefox: about:debugging -> This Firefox -> Load Temporary Add-on -> pick the xpi."
