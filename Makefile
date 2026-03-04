VERSION := $(shell git describe --tags --abbrev=0 2>/dev/null | sed 's/^v//')

.PHONY: build clean

build: dist/thunderbird-mcp.xpi

dist/thunderbird-mcp.xpi: extension/**/*
	@test -n "$(VERSION)" || { echo "Error: no git tag found. Create one with: git tag v0.1.0" >&2; exit 1; }
	@echo "Building Thunderbird MCP extension v$(VERSION)..."
	@for f in extension/manifest.json package.json; do \
		node -e "const m = require('./'+'$$f'); m.version = '$(VERSION)'; process.stdout.write(JSON.stringify(m, null, 2) + '\n');" > "$$f.tmp" && mv "$$f.tmp" "$$f"; \
	done
	@mkdir -p dist
	@cd extension && zip -r ../dist/thunderbird-mcp.xpi . -x "*.DS_Store" -x "*.git*"
	@echo "Built: dist/thunderbird-mcp.xpi"

clean:
	rm -rf dist/
