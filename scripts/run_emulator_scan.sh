#!/usr/bin/env bash
set -euo pipefail

python3 -m venv .venv-appium
# shellcheck disable=SC1091
source .venv-appium/bin/activate
python -m pip install --disable-pip-version-check --quiet Appium-Python-Client

# Verify APKPure's published SHA-256 and Daraz signer before sideloading split APKs.
python scripts/install_daraz_xapk.py

# Start Appium server cleanly in background and wait until ready
appium --address 127.0.0.1 --port 4723 --log-level error --log /tmp/appium.log >/dev/null 2>&1 &
APPIUM_PID=$!
trap 'kill "$APPIUM_PID" >/dev/null 2>&1 || true' EXIT

for _ in $(seq 1 60); do
  if curl --silent --fail http://127.0.0.1:4723/status >/dev/null; then
    break
  fi
  sleep 2
done
curl --silent --fail http://127.0.0.1:4723/status >/dev/null

python scripts/appium_product_vouchers.py
