#!/bin/bash
# Build script for Firefox WebExtension
# Packages the extension into a .xpi file

set -e

EXTENSION_DIR="build-firefox"
XPI_FILE="pardeh-firefox.xpi"

echo "Building Firefox extension..."

# Remove existing XPI if it exists
if [ -f "$XPI_FILE" ]; then
    echo "Removing existing $XPI_FILE..."
    rm "$XPI_FILE"
fi

# Package the extension
# Note: XPI is just a ZIP file with a .xpi extension
cd "$EXTENSION_DIR"
zip -r "../$XPI_FILE" .
cd ..

echo "✅ Successfully built: $XPI_FILE"
echo ""
echo "To install in Firefox:"
echo "  1. Open Firefox and go to about:debugging"
echo "  2. Click 'This Firefox' -> 'Load Temporary Add-on'"
echo "  3. Select any file from $XPI_FILE (or unzip and load manifest.json)"
echo ""
echo "Or for permanent installation:"
echo "  1. Rename .xpi to .zip and extract"
echo "  2. Use 'about:debugging' to load unpacked extension"
