#!/bin/sh
set -eu
TARGET=${1:?usage: ROLLBACK.sh <schema-copy>}
ORIGINAL=${2:?usage: ROLLBACK.sh <original-schema>}
cp "$ORIGINAL" "$TARGET"
printf 'restored %s from %s\n' "$TARGET" "$ORIGINAL"
