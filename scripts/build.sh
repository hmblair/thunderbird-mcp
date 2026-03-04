#!/bin/bash
# Build the Thunderbird MCP extension

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
EXTENSION_DIR="$PROJECT_DIR/extension"
DIST_DIR="$PROJECT_DIR/dist"

# Read version from the latest git tag (source of truth), stripping the leading "v"
VERSION=$(git -C "$PROJECT_DIR" describe --tags --abbrev=0 2>/dev/null | sed 's/^v//')
if [ -z "$VERSION" ]; then
  echo "Error: no git tag found. Create one with: git tag v0.1.0" >&2
  exit 1
fi
echo "Building Thunderbird MCP extension v${VERSION}..."

# Inject version into manifest.json and package.json
for JSON_FILE in "$EXTENSION_DIR/manifest.json" "$PROJECT_DIR/package.json"; do
  TMP_FILE=$(mktemp)
  node -e "
    const m = require('$JSON_FILE');
    m.version = '$VERSION';
    process.stdout.write(JSON.stringify(m, null, 2) + '\n');
  " > "$TMP_FILE"
  mv "$TMP_FILE" "$JSON_FILE"
done

# Create dist directory
mkdir -p "$DIST_DIR"

# Remove old XPI to ensure a clean build
rm -f "$DIST_DIR/thunderbird-mcp.xpi"

# Package extension
cd "$EXTENSION_DIR"
zip -r "$DIST_DIR/thunderbird-mcp.xpi" . -x "*.DS_Store" -x "*.git*"

echo "Built: $DIST_DIR/thunderbird-mcp.xpi"
