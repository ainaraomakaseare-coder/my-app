#!/usr/bin/env bash
set -euo pipefail
signing_dir="$RUNNER_TEMP/kaji-signing"
keychain="$signing_dir/signing.keychain-db"
keychain_password="$(openssl rand -hex 32)"
trap 'security delete-keychain "$keychain" >/dev/null 2>&1 || true' EXIT
python3 scripts/signing.py
security create-keychain -p "$keychain_password" "$keychain"
security set-keychain-settings -lut 21600 "$keychain"
security unlock-keychain -p "$keychain_password" "$keychain"
DIST_CERT_PASSWORD="$(printf '%s' "$DIST_CERT_PASSWORD" | tr -d '\n\r' | xargs)"
security import "$signing_dir/distribution.p12" -P "$DIST_CERT_PASSWORD" -t cert -f pkcs12 -k "$keychain" -T /usr/bin/codesign -T /usr/bin/security >/dev/null
security list-keychains -d user -s "$keychain" "$HOME/Library/Keychains/login.keychain-db"
security set-key-partition-list -S apple-tool:,apple:,codesign: -k "$keychain_password" "$keychain" >/dev/null
export IOS_PROFILE_UUID="$(/usr/libexec/PlistBuddy -c 'Print :provisioningProfiles:com.hiroyaapps.uchinokaji' "$signing_dir/ExportOptions.plist")"
export IOS_TEAM_ID="$APPLE_TEAM_ID"
node scripts/configure-ios.mjs
xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Release -destination 'generic/platform=iOS' -archivePath build/UchinoKaji.xcarchive archive
xcodebuild -exportArchive -archivePath build/UchinoKaji.xcarchive -exportOptionsPlist "$signing_dir/ExportOptions.plist" -exportPath build/export
export API_PRIVATE_KEYS_DIR="$signing_dir/private_keys"
xcrun altool --upload-app -f build/export/*.ipa -t ios --apiKey "$API_KEY_ID" --apiIssuer "$API_ISSUER_ID"
