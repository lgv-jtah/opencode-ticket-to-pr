#!/usr/bin/env bash
# Add a "## Pipeline" section to a project's AGENTS.md, with the base branch
# and check commands detected from the repository. Never overwrites an
# existing section.
#
# Usage: init-project.sh <project-dir>
# Env:   DRY_RUN=1                 print the section instead of writing it
#        JIRA_REVIEW_STATUS=...    Jira status for the final step (default "In Review")
set -euo pipefail

project="${1:?project dir missing}"
project="$(cd "$project" && pwd)"
agents="$project/AGENTS.md"
status="${JIRA_REVIEW_STATUS:-In Review}"

git -C "$project" rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "Not a git repository: $project" >&2; exit 1; }

if [[ -f "$agents" ]] && grep -q '^## Pipeline' "$agents"; then
  echo "$agents already has a '## Pipeline' section - nothing changed:"
  sed -n '/^## Pipeline/,/^## /p' "$agents" | sed '$ {/^## /d}'
  exit 0
fi

# --- Base branch: local origin/HEAD, else ask the remote, else fall back. ---
base="$(git -C "$project" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##' || true)"
if [[ -z "$base" ]]; then
  base="$(timeout 15 git -C "$project" ls-remote --symref origin HEAD 2>/dev/null | awk '/^ref:/ {sub("refs/heads/", "", $2); print $2}' || true)"
fi
if [[ -z "$base" ]]; then
  base="main"
  echo "warning: could not detect the base branch, using 'main' - check it" >&2
fi

# --- Checks from the stack. ---
checks=()
add_python_checks() { # $1 = runner prefix, e.g. "uv run"
  local py="$project/pyproject.toml"
  checks+=("\`$1 pytest\`")
  grep -qi 'ruff' "$py" 2>/dev/null && checks+=("\`$1 ruff check .\`")
  grep -qi 'mypy' "$py" 2>/dev/null && checks+=("\`$1 mypy .\`")
  return 0
}
if [[ -f "$project/uv.lock" ]]; then
  add_python_checks "uv run"
elif [[ -f "$project/poetry.lock" ]] || grep -q '^\[tool.poetry\]' "$project/pyproject.toml" 2>/dev/null; then
  add_python_checks "poetry run"
fi
if [[ -f "$project/package.json" ]]; then
  for s in test lint; do
    if node -e "process.exit(require(process.argv[1]).scripts?.[process.argv[2]] ? 0 : 1)" "$project/package.json" "$s" 2>/dev/null; then
      if [[ "$s" == "test" ]]; then checks+=("\`npm test\`"); else checks+=("\`npm run lint\`"); fi
    fi
  done
fi
if [[ ${#checks[@]} -eq 0 ]]; then
  checks=("TODO - add the test/lint commands that must pass")
  echo "warning: no known stack detected, fill in the checks by hand" >&2
fi

joined="$(printf '%s, ' "${checks[@]}")"
section="## Pipeline
- Base branch: $base
- Checks: ${joined%, }
- Jira review status: $status"

if [[ -n "${DRY_RUN:-}" ]]; then
  echo "Would add to $agents:"
  echo
  echo "$section"
  exit 0
fi

if [[ -f "$agents" ]]; then
  # Keep exactly one blank line between the existing content and the section.
  [[ -n "$(tail -c1 "$agents")" ]] && echo >>"$agents"
  printf '\n%s\n' "$section" >>"$agents"
else
  printf '# Project rules\n\n%s\n' "$section" >"$agents"
fi
echo "Added to $agents:"
echo
echo "$section"
echo
echo "Review it, adjust if needed, and commit it with the project."
