#!/bin/bash
# Build the Thunderbird MCP extension

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
EXTENSION_DIR="$PROJECT_DIR/extension"
DIST_DIR="$PROJECT_DIR/dist"

# Read version from package.json (source of truth)
VERSION=$(node -e "process.stdout.write(require('$PROJECT_DIR/package.json').version)")
echo "Building Thunderbird MCP extension v${VERSION}..."

# Inject version into manifest.json
MANIFEST="$EXTENSION_DIR/manifest.json"
TMP_MANIFEST=$(mktemp)
node -e "
  const m = require('$MANIFEST');
  m.version = '$VERSION';
  process.stdout.write(JSON.stringify(m, null, 2) + '\n');
" > "$TMP_MANIFEST"
mv "$TMP_MANIFEST" "$MANIFEST"

# Create dist directory
mkdir -p "$DIST_DIR"

# Remove old XPI to ensure a clean build
rm -f "$DIST_DIR/thunderbird-mcp.xpi"

# Package extension
cd "$EXTENSION_DIR"
zip -r "$DIST_DIR/thunderbird-mcp.xpi" . -x "*.DS_Store" -x "*.git*"

echo "Built: $DIST_DIR/thunderbird-mcp.xpi"
