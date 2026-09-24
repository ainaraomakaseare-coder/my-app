#!/usr/bin/env bash
set -euo pipefail
mkdir -p build/qa
xcrun simctl list devices available --json > build/qa/devices.json
DEVICE_ID=$(python3 -c 'import json; d=json.load(open("build/qa/devices.json")); candidates=[x for runtime,items in d["devices"].items() if "iOS" in runtime for x in items if x.get("isAvailable") and x["name"].startswith("iPhone")]; candidates.sort(key=lambda x:("17 Pro" not in x["name"],x["name"])); print(candidates[0]["udid"])')
xcrun simctl boot "$DEVICE_ID" || true
xcrun simctl bootstatus "$DEVICE_ID" -b
xcrun simctl status_bar "$DEVICE_ID" override --time '9:41' --batteryState charged --batteryLevel 100
xcrun simctl install "$DEVICE_ID" build/simulator/Build/Products/Debug-iphonesimulator/App.app
xcrun simctl ui "$DEVICE_ID" appearance light
xcrun simctl launch --terminate-running-process "$DEVICE_ID" com.hiroyaapps.baydiary
sleep 5
xcrun simctl io "$DEVICE_ID" screenshot build/qa/iphone-light.png
xcrun simctl ui "$DEVICE_ID" appearance dark
sleep 2
xcrun simctl io "$DEVICE_ID" screenshot build/qa/iphone-dark.png
xcrun simctl spawn "$DEVICE_ID" launchctl list > build/qa/processes.txt
if ! grep -q 'com.hiroyaapps.baydiary' build/qa/processes.txt; then
  echo 'BayDiary is not running after launch' >&2
  exit 1
fi

# Preserve executable bits and framework symlinks when downloading from Actions.
tar -czf build/BayDiary-simulator.tar.gz -C build/simulator/Build/Products/Debug-iphonesimulator App.app
