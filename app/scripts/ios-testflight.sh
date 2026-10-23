#!/bin/sh
# Build the iOS app and upload it to TestFlight (App Store Connect).
# Needs an App Store Connect API key (Admin) — nobody's Apple ID password:
#   ~/.appstoreconnect/private_keys/AuthKey_<KEY_ID>.p8
#   ASC_KEY_ID=<KEY_ID> ASC_ISSUER_ID=<issuer uuid> sh app/scripts/ios-testflight.sh
# The archive is built unsigned; export signs it with Apple's cloud-managed
# distribution certificate, so no device or local certificate is needed.
# Build numbers are bumped automatically by App Store Connect.
set -e
: "${ASC_KEY_ID:?set ASC_KEY_ID}"; : "${ASC_ISSUER_ID:?set ASC_ISSUER_ID}"
TEAM_ID="${TEAM_ID:-K658QP5726}"
KEY="$HOME/.appstoreconnect/private_keys/AuthKey_${ASC_KEY_ID}.p8"
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${TMPDIR:-/tmp}/wingman-ios"
rm -rf "$OUT" && mkdir -p "$OUT"

cd "$APP_DIR" && npm run build && npx cap sync ios
cd "$APP_DIR/ios/App"
xcodebuild archive -project App.xcodeproj -scheme App -configuration Release \
  -destination 'generic/platform=iOS' -archivePath "$OUT/Wingman.xcarchive" \
  DEVELOPMENT_TEAM="$TEAM_ID" CODE_SIGNING_ALLOWED=NO

cat > "$OUT/ExportOptions.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>upload</string>
  <key>teamID</key><string>$TEAM_ID</string>
  <key>signingStyle</key><string>automatic</string>
  <key>uploadSymbols</key><true/>
  <key>manageAppVersionAndBuildNumber</key><true/>
</dict></plist>
PLIST

xcodebuild -exportArchive -archivePath "$OUT/Wingman.xcarchive" \
  -exportOptionsPlist "$OUT/ExportOptions.plist" -exportPath "$OUT/export" \
  -allowProvisioningUpdates -authenticationKeyPath "$KEY" \
  -authenticationKeyID "$ASC_KEY_ID" -authenticationKeyIssuerID "$ASC_ISSUER_ID"
echo "Uploaded. It shows in TestFlight after Apple finishes processing (5-30 min)."
