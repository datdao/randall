.PHONY: dev clean

CHROME := /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome
EXT_DIR := $(CURDIR)/extension

# Launch a separate Chrome with extension loaded + extensions page open
dev:
	@echo "🚀 Launching Chrome with Randall extension..."
	@$(CHROME) \
		--load-extension="$(EXT_DIR)" \
		--user-data-dir="/tmp/randall-chrome-dev" \
		--no-first-run \
		--no-default-browser-check \
		"chrome://extensions" &>/dev/null &
	@sleep 2 && echo "✅ Chrome launched — pin the extension from 🧩 menu"

clean:
	@rm -rf /tmp/randall-chrome-dev
	@echo "✅ Cleaned temp Chrome profile"
