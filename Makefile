.PHONY: verify inventory

PYTHON ?= python3
NODE ?= node

PY_SCRIPTS := \
	scripts/android/kktkky_wpk_index.py \
	scripts/android/kktkky_thd_index.py \
	scripts/android/arm64_string_xrefs.py \
	scripts/android/kktkky_apk_hashres_map.py \
	scripts/android/kktkky_g18_crypto.py \
	scripts/android/kktkky_local_pet_chain.py \
	scripts/android/kktkky_g18_img.py

JS_SCRIPTS := \
	scripts/android/kktkky-unpack-trace.js \
	scripts/android/kktkky-resource-trace.js \
	scripts/android/kktkky-dex-dump.js \
	scripts/android/kktkky-shapeconfig-probe.js \
	scripts/android/kktkky-decrypt-dump.js \
	scripts/android/kktkky-consent-click.js \
	scripts/android/kktkky-offline-patch-adapt.js \
	scripts/android/kktkky-local-path-probe.js \
	scripts/android/kktkky-thx-filter-bypass.js \
	scripts/android/kktkky-rc4-key-probe.js \
	scripts/android/kktkky-patch-bypass-probe.js \
	scripts/android/kktkky-img-gl-dump.js

verify:
	@set -e; for script in $(PY_SCRIPTS); do $(PYTHON) -m py_compile "$$script"; done
	@set -e; for script in $(JS_SCRIPTS); do $(NODE) --check "$$script"; done
	@git diff --check
	@echo "Repository tools verified. This does not assert that an offline APK is buildable."

inventory:
	@test -n "$(HASHRES_DIR)" || (echo "Set HASHRES_DIR=/absolute/path/to/HashRes" >&2; exit 2)
	@$(PYTHON) scripts/android/kktkky_wpk_index.py --inventory-dir "$(HASHRES_DIR)/data"
	@$(PYTHON) scripts/android/kktkky_thd_index.py --inventory-dir "$(HASHRES_DIR)/thd"
