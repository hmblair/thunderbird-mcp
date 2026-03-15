VERSION := $(shell node -p "require('./package.json').version")

SERVICE = thunderbird-mcp
SERVICE_DIR = ~/.config/systemd/user
BIN_DIR = ~/.local/bin
COMP_DIR = ~/.local/share/zsh/site-functions

.PHONY: build clean tag install uninstall install-headless uninstall-headless start stop restart status

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

install-headless:
	mkdir -p $(BIN_DIR) $(COMP_DIR)
	ln -sf $(CURDIR)/headless/thunderbird-headless $(BIN_DIR)/thunderbird-headless
	ln -sf $(CURDIR)/headless/_thunderbird-headless $(COMP_DIR)/_thunderbird-headless
	ln -sf $(CURDIR)/headless/$(SERVICE).service $(SERVICE_DIR)/$(SERVICE).service
	systemctl --user daemon-reload
	systemctl --user enable $(SERVICE)
	loginctl enable-linger $(USER)

uninstall-headless:
	systemctl --user disable --now $(SERVICE)
	rm -f $(BIN_DIR)/thunderbird-headless
	rm -f $(COMP_DIR)/_thunderbird-headless
	rm -f $(SERVICE_DIR)/$(SERVICE).service
	systemctl --user daemon-reload

start:
	systemctl --user start $(SERVICE)

stop:
	systemctl --user stop $(SERVICE)

restart:
	systemctl --user restart $(SERVICE)

status:
	./headless/thunderbird-headless status

clean:
	rm -rf dist/
