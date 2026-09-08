#!/usr/bin/env bash
set -euo pipefail

TARGET_ROOT="${1:?usage: ROLLBACK.sh TARGET_ROOT}"
SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"

restore() {
  local relative="$1"
  local backup_name="${relative//\//_}"
  mkdir -p "$TARGET_ROOT/$(dirname -- "$relative")"
  cp "$SCRIPT_DIR/original/$backup_name" "$TARGET_ROOT/$relative"
}

restore docs/openapi.yaml
restore src/api/schema.d.ts
restore src/api/contracts.ts
restore src/api/mockData.ts
restore src/api/mockSkillApi.ts
restore src/App.tsx
restore backend/src/routes/catalog.route.ts
restore backend/src/repositories/catalog.repository.ts
restore backend/src/services/catalog.service.ts
printf 'restored original item-1 files under %s\n' "$TARGET_ROOT"
