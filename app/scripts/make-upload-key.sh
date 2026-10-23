#!/bin/sh
# One-time: create the Play upload keystore and point Gradle at it.
# The password is typed here, never stored in the repo. Back up the .jks and
# the password somewhere safe — losing them blocks future Play updates.
set -e
KS="$HOME/wingman-upload.jks"
PROPS="$HOME/.gradle/gradle.properties"

if [ -f "$KS" ]; then echo "Keystore already exists: $KS"; exit 1; fi

printf "Choose a keystore password (min 6 chars): "; stty -echo; read -r PW; stty echo; echo
printf "Type it again: "; stty -echo; read -r PW2; stty echo; echo
[ "$PW" = "$PW2" ] || { echo "Passwords don't match."; exit 1; }
[ ${#PW} -ge 6 ] || { echo "Too short."; exit 1; }

keytool -genkeypair -keystore "$KS" -alias upload -keyalg RSA -keysize 2048 -validity 10000 \
  -dname "CN=Wingman, O=Wingman, C=PK" -storepass "$PW" -keypass "$PW"

mkdir -p "$HOME/.gradle"
touch "$PROPS"; chmod 600 "$PROPS"
grep -v '^WINGMAN_' "$PROPS" > "$PROPS.tmp" || true
{
  cat "$PROPS.tmp"
  echo "WINGMAN_STORE_FILE=$KS"
  echo "WINGMAN_STORE_PASSWORD=$PW"
  echo "WINGMAN_KEY_ALIAS=upload"
  echo "WINGMAN_KEY_PASSWORD=$PW"
} > "$PROPS"
rm -f "$PROPS.tmp"
echo "Done: $KS and $PROPS"
