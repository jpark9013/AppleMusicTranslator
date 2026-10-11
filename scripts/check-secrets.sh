#!/bin/bash
# Fails if API keys or tokens appear in tracked files, a .env file is tracked,
# or (with arguments) the given build outputs contain one. Matches are never
# printed in full.
set -euo pipefail
cd "$(dirname "$0")/.."

PATTERN='sk-ant-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{32,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----'
status=0

if git rev-parse --is-inside-work-tree >/dev/null 2>&1 &&
    git ls-files | grep -E '(^|/)\.env($|\.)' | grep -v -E '(^|/)\.env\.example$'; then
    echo "error: a .env file is tracked" >&2
    status=1
fi

scan() {
    grep -a -l -E "$PATTERN" "$@" 2>/dev/null || true
}

if [ "$#" -gt 0 ]; then
    files=$(find "$@" -type f)
else
    files=$(git ls-files)
fi

leaks=$(echo "$files" | tr '\n' '\0' | xargs -0 grep -a -l -E "$PATTERN" 2>/dev/null || true)
if [ -n "$leaks" ]; then
    echo "error: possible secret in:" >&2
    echo "$leaks" | sed 's/^/  /' >&2
    status=1
fi

[ "$status" -eq 0 ] && echo "No secrets found."
exit "$status"
