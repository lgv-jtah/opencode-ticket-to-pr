#!/usr/bin/env bash
# Check that everything the pipeline needs is in place.
# Prints whether credentials are set, never their values.
#
# Usage: doctor.sh <template-dir>
# Exit code 1 if a required item is missing.
set -uo pipefail

dir="${1:?template dir missing}"
failed=0

ok()   { printf '  [ok]   %s\n' "$1"; }
warn() { printf '  [warn] %s\n' "$1"; }
fail() { printf '  [FAIL] %s\n' "$1"; failed=1; }

is_set() { [[ -n "${!1:-}" ]]; }

echo "Tools"
if command -v opencode >/dev/null; then ok "opencode $(opencode --version 2>/dev/null)"; else fail "opencode not found in PATH"; fi
if command -v git >/dev/null; then ok "$(git --version)"; else fail "git not found in PATH"; fi
if command -v node >/dev/null; then ok "node $(node --version) (only needed for 'make test')"; else warn "node not found (only needed for 'make test')"; fi

echo "Template"
if [[ "${OPENCODE_CONFIG_DIR:-}" == "$dir" ]]; then
  ok "OPENCODE_CONFIG_DIR points to this template"
elif [[ -n "${OPENCODE_CONFIG_DIR:-}" ]]; then
  warn "OPENCODE_CONFIG_DIR points elsewhere ($OPENCODE_CONFIG_DIR); 'make ticket' still works"
else
  warn "OPENCODE_CONFIG_DIR not set: run 'make install' to use /ticket everywhere ('make ticket' works without it)"
fi
global="$HOME/.config/opencode"
if [[ -f "$global/tools/jira.ts" ]]; then
  warn "old global Jira tools in $global/tools/jira.ts duplicate the template's - remove them"
fi
if [[ -f "$global/AGENTS.md" ]]; then
  warn "$global/AGENTS.md is ignored while OPENCODE_CONFIG_DIR is set - move its rules to $dir/AGENTS.md"
fi
if command -v opencode >/dev/null; then
  resolved="$(cd "$dir/.." && OPENCODE_CONFIG_DIR="$dir" timeout 60 opencode debug agent orchestrator 2>/dev/null)"
  missing=()
  for t in pr_create jira_get jira_transition jira_comment task question; do
    grep -Eq "\"$t\": *true" <<<"$resolved" || missing+=("$t")
  done
  if [[ ${#missing[@]} -eq 0 ]]; then ok "orchestrator loads with all its tools"; else fail "orchestrator is missing tools: ${missing[*]}"; fi
fi

echo "Credentials"
if is_set JIRA_EMAIL && is_set JIRA_API_TOKEN; then ok "Jira (JIRA_EMAIL, JIRA_API_TOKEN)"; else fail "Jira: export JIRA_EMAIL and JIRA_API_TOKEN"; fi
if is_set JIRA_BASE_URL; then ok "Jira instance: $JIRA_BASE_URL"; else ok "Jira instance: default from lib/jira-core.ts ($(grep -oP 'DEFAULT_BASE_URL = "\K[^"]+' "$dir/lib/jira-core.ts"))"; fi
if is_set GITHUB_TOKEN || is_set GH_TOKEN; then ok "GitHub (GITHUB_TOKEN / GH_TOKEN)"; else warn "GitHub: GITHUB_TOKEN not set (needed for GitHub repos)"; fi
if is_set BITBUCKET_EMAIL && is_set BITBUCKET_API_TOKEN; then ok "Bitbucket (BITBUCKET_EMAIL, BITBUCKET_API_TOKEN)"; else warn "Bitbucket: BITBUCKET_EMAIL / BITBUCKET_API_TOKEN not set (needed for Bitbucket repos)"; fi
if is_set GITLAB_TOKEN; then ok "GitLab (GITLAB_TOKEN)"; else warn "GitLab: GITLAB_TOKEN not set (needed for GitLab repos)"; fi
if is_set GITLAB_URL; then ok "GitLab instance: $GITLAB_URL (plus gitlab.com)"; else ok "GitLab instance: gitlab.com only (set GITLAB_URL for a self-hosted one)"; fi

echo
if [[ $failed -eq 0 ]]; then echo "All required checks passed."; else echo "Some required checks failed."; fi
exit $failed
