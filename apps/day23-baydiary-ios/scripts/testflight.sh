#!/usr/bin/env bash
set -euo pipefail
signing_dir="$RUNNER_TEMP/baydiary-signing"
keychain="$signing_dir/signing.keychain-db"
keychain_password="$(openssl rand -hex 32)"
trap 'security delete-keychain "$keychain" >/dev/null 2>&1 || true' EXIT
python3 scripts/signing.py
security create-keychain -p "$keychain_password" "$keychain"
security set-keychain-settings -lut 21600 "$keychain"
security unlock-keychain -p "$keychain_password" "$keychain"
security import "$signing_dir/distribution.p12" -P "$DIST_CERT_PASSWORD" -A -t cert -f pkcs12 -k "$keychain" >/dev/null
security list-keychains -d user -s "$keychain" "$HOME/Library/Keychains/login.keychain-db"
security set-key-partition-list -S apple-tool:,apple: -k "$keychain_password" "$keychain" >/dev/null
# signing.py exports to GITHUB_ENV for later steps; read these two non-secret fields here.
export IOS_PROFILE_UUID="$(/usr/libexec/PlistBuddy -c 'Print :provisioningProfiles:com.hiroyaapps.baydiary' "$signing_dir/ExportOptions.plist")"
export IOS_TEAM_ID="$APPLE_TEAM_ID"
node scripts/configure-ios.mjs
xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Release -destination 'generic/platform=iOS' -archivePath build/BayDiary.xcarchive archive
xcodebuild -exportArchive -archivePath build/BayDiary.xcarchive -exportOptionsPlist "$signing_dir/ExportOptions.plist" -exportPath build/export
export API_PRIVATE_KEYS_DIR="$signing_dir/private_keys"
xcrun altool --upload-app -f build/export/*.ipa -t ios --apiKey "$API_KEY_ID" --apiIssuer "$API_ISSUER_ID"
