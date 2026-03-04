VERSION := $(shell git describe --tags --abbrev=0 2>/dev/null | sed 's/^v//')

.PHONY: build clean

build: dist/thunderbird-mcp.xpi

dist/thunderbird-mcp.xpi: extension/**/*
	@test -n "$(VERSION)" || { echo "Error: no git tag found. Create one with: git tag v0.1.0" >&2; exit 1; }
	@echo "Building Thunderbird MCP extension v$(VERSION)..."
	@rm -rf dist/stage
	@mkdir -p dist/stage
	@cp -r extension/* dist/stage/
	@node -e "const m=JSON.parse(require('fs').readFileSync('dist/stage/manifest.json','utf8')); m.version='$(VERSION)'; require('fs').writeFileSync('dist/stage/manifest.json', JSON.stringify(m,null,2)+'\n');"
	@cd dist/stage && zip -r ../thunderbird-mcp.xpi . -x "*.DS_Store" -x "*.git*"
	@rm -rf dist/stage
	@echo "Built: dist/thunderbird-mcp.xpi"

clean:
	rm -rf dist/
