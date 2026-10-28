#!/usr/bin/env bash
# 署名してTestFlightへアップロードする（GitHub ActionsのmacOSで実行）。プロファイルはAPIで用意する
set -euo pipefail
signing_dir="$RUNNER_TEMP/gohan-signing"
mkdir -p -m 700 "$signing_dir"
keychain="$signing_dir/signing.keychain-db"
keychain_password="$(openssl rand -hex 32)"
trap 'security delete-keychain "$keychain" >/dev/null 2>&1 || true' EXIT
DIST_CERT_PASSWORD="$(printf '%s' "$DIST_CERT_PASSWORD" | tr -d '\n\r' | xargs)"
export DIST_CERT_PASSWORD
# 配信証明書のシリアル番号から、その証明書入りの配信用プロファイルを探す（無ければ作る）
printf '%s' "$DIST_CERT_BASE64" | base64 --decode > "$signing_dir/check.p12"
serial="$( (openssl pkcs12 -in "$signing_dir/check.p12" -nokeys -passin env:DIST_CERT_PASSWORD 2>/dev/null || openssl pkcs12 -legacy -in "$signing_dir/check.p12" -nokeys -passin env:DIST_CERT_PASSWORD) | openssl x509 -noout -serial)"
rm -f "$signing_dir/check.p12"
node scripts/asc.mjs profile "$serial" "$signing_dir/api.mobileprovision"
PROFILE_BASE64="$(base64 < "$signing_dir/api.mobileprovision" | tr -d '\n')"
export PROFILE_BASE64
python3 scripts/signing.py
security create-keychain -p "$keychain_password" "$keychain"
security set-keychain-settings -lut 21600 "$keychain"
security unlock-keychain -p "$keychain_password" "$keychain"
security import "$signing_dir/distribution.p12" -P "$DIST_CERT_PASSWORD" -t cert -f pkcs12 -k "$keychain" -T /usr/bin/codesign -T /usr/bin/security >/dev/null
security list-keychains -d user -s "$keychain" "$HOME/Library/Keychains/login.keychain-db"
security set-key-partition-list -S apple-tool:,apple: -k "$keychain_password" "$keychain" >/dev/null
export IOS_PROFILE_UUID="$(/usr/libexec/PlistBuddy -c 'Print :provisioningProfiles:com.hiroyaapps.gohanashiato' "$signing_dir/ExportOptions.plist")"
export IOS_TEAM_ID="$APPLE_TEAM_ID"
node scripts/configure-ios.mjs
xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Release -destination 'generic/platform=iOS' -archivePath build/GohanAshiato.xcarchive archive
xcodebuild -exportArchive -archivePath build/GohanAshiato.xcarchive -exportOptionsPlist "$signing_dir/ExportOptions.plist" -exportPath build/export
export API_PRIVATE_KEYS_DIR="$signing_dir/private_keys"
xcrun altool --upload-app -f build/export/*.ipa -t ios --apiKey "$API_KEY_ID" --apiIssuer "$API_ISSUER_ID"
