#!/usr/bin/env bash
# Add or remove the OPENCODE_CONFIG_DIR export in the user's shell rc file.
#
# Usage: shell-rc.sh install <template-dir> | shell-rc.sh uninstall
# The rc file defaults to ~/.zshrc for zsh users and ~/.bashrc otherwise;
# override with RC_FILE=... . The block is fenced by markers so both
# operations are idempotent and re-installing updates the path.
set -euo pipefail

BEGIN="# >>> opencode-pipeline >>>"
END="# <<< opencode-pipeline <<<"

rc_file() {
  if [[ -n "${RC_FILE:-}" ]]; then
    echo "$RC_FILE"
  elif [[ "$(basename "${SHELL:-bash}")" == "zsh" ]]; then
    echo "$HOME/.zshrc"
  else
    echo "$HOME/.bashrc"
  fi
}

remove_block() {
  local rc="$1"
  [[ -f "$rc" ]] || return 0
  sed -i "/^${BEGIN}\$/,/^${END}\$/d" "$rc"
}

cmd="${1:-}"
rc="$(rc_file)"

case "$cmd" in
  install)
    dir="${2:?template dir missing}"
    [[ -f "$dir/agents/orchestrator.md" ]] || { echo "Not a template dir: $dir" >&2; exit 1; }
    touch "$rc"
    remove_block "$rc"
    printf '%s\nexport OPENCODE_CONFIG_DIR="%s"\n%s\n' "$BEGIN" "$dir" "$END" >>"$rc"
    echo "Installed: OPENCODE_CONFIG_DIR=$dir in $rc"
    echo "Run 'source $rc' or open a new shell to use it."
    ;;
  uninstall)
    if [[ -f "$rc" ]] && grep -qxF "$BEGIN" "$rc"; then
      remove_block "$rc"
      echo "Removed the opencode-pipeline block from $rc"
      echo "Open a new shell (or 'unset OPENCODE_CONFIG_DIR') for it to take effect."
    else
      echo "Nothing to remove in $rc"
    fi
    ;;
  *)
    echo "Usage: $0 install <template-dir> | uninstall" >&2
    exit 2
    ;;
esac
