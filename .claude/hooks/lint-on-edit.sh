#!/usr/bin/env bash
# Lint TypeScript files after Claude edits them.
# Exit 0: linting passed (or not applicable). Exit 2: linting failed.

set -euo pipefail

if ! command -v jq >/dev/null 2>&1; then
  echo "lint-on-edit: jq is not installed; skipping lint hook" >&2
  exit 0
fi

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

if [ -z "$FILE_PATH" ]; then
  exit 0
fi

if [[ "$FILE_PATH" == *.sh ]]; then
  cd "${CLAUDE_PROJECT_DIR:-.}"
  if command -v shellcheck >/dev/null 2>&1; then
    shellcheck "$FILE_PATH" >&2 || { echo "shellcheck: $FILE_PATH has issues" >&2; exit 2; }
  else
    echo "lint-on-edit: shellcheck not installed; skipping lint for $FILE_PATH" >&2
  fi
elif [[ "$FILE_PATH" == *.ts || "$FILE_PATH" == *.js ]]; then
  cd "${CLAUDE_PROJECT_DIR:-.}"
  if pnpm exec biome --version >/dev/null 2>&1; then
    pnpm exec biome check "$FILE_PATH" >&2 || { echo "biome: $FILE_PATH has issues" >&2; exit 2; }
  else
    echo "lint-on-edit: biome not installed; skipping lint for $FILE_PATH" >&2
  fi
fi

exit 0
