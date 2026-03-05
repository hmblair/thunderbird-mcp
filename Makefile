VERSION := $(shell node -p "require('./package.json').version")

.PHONY: build clean tag install uninstall

build: dist/thunderbird-mcp.xpi

dist/thunderbird-mcp.xpi: extension/**/*
	@echo "Building Thunderbird MCP extension v$(VERSION)..."
	@rm -rf dist/stage
	@mkdir -p dist/stage
	@cp -r extension/* dist/stage/
	@node -e "const m=JSON.parse(require('fs').readFileSync('dist/stage/manifest.json','utf8')); m.version='$(VERSION)'; require('fs').writeFileSync('dist/stage/manifest.json', JSON.stringify(m,null,2)+'\n');"
	@cd dist/stage && zip -r ../thunderbird-mcp.xpi . -x "*.DS_Store" -x "*.git*"
	@rm -rf dist/stage
	@echo "Built: dist/thunderbird-mcp.xpi"

tag:
	@git tag -a "v$(VERSION)" -m "v$(VERSION)"
	@echo "Tagged v$(VERSION)"

install:
	@node scripts/install.cjs

uninstall:
	@node scripts/install.cjs uninstall

clean:
	rm -rf dist/
