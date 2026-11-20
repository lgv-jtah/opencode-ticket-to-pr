#!/usr/bin/env bash
# Copy the pipeline into a project's own .opencode/, so the project works
# with plain `opencode` and `/ticket` - no OPENCODE_CONFIG_DIR, no template
# checkout needed - and the team gets it through git.
#
# Usage: vendor.sh <template-dir> <project-dir>
# Env:   DRY_RUN=1   show what would change, write nothing
#        FORCE=1     overwrite files that were changed locally or that the
#                    pipeline did not create
#
# Every vendored file is recorded with its sha256 in .opencode/pipeline.manifest.
# Re-running updates the project to the current template: unchanged files are
# replaced, files dropped from the template are removed, and anything edited
# in the project (or not created by this script) stops the run unless FORCE=1.
# The template's global rules (AGENTS.md) become .opencode/pipeline-rules.md,
# loaded via "instructions" in .opencode/opencode.jsonc.
set -euo pipefail

tpl="${1:?template dir missing}"
project="${2:?project dir missing}"
tpl="$(cd "$tpl" && pwd)"
project="$(cd "$project" && pwd)"
root="$(dirname "$tpl")"
dest="$project/.opencode"
manifest="$dest/pipeline.manifest"
rules="pipeline-rules.md"

git -C "$project" rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "Not a git repository: $project" >&2; exit 1; }
[[ "$project" != "$root" ]] || { echo "PROJECT is the template itself" >&2; exit 1; }

# --- Stage the new file set. ---
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT

# Tracked template files only (no node_modules or other local state).
mapfile -t files < <(git -C "$root" ls-files -- .opencode | sed 's#^\.opencode/##' | grep -vxE 'AGENTS\.md|opencode\.jsonc')
for f in "${files[@]}"; do
  mkdir -p "$stage/$(dirname "$f")"
  cp "$tpl/$f" "$stage/$f"
done

# Global rules: replace the intro (about OPENCODE_CONFIG_DIR) with a vendoring note.
{
  echo "# Pipeline rules"
  echo
  echo "Vendored from the opencode ticket-to-PR template - do not edit here, re-run \`make vendor\` in the template to update."
  echo "Loaded through \`instructions\` in \`.opencode/opencode.jsonc\`."
  echo
  sed -n '/^## /,$p' "$tpl/AGENTS.md"
} >"$stage/$rules"

# Config: the template's permissions plus the rules file.
awk -v rules=".opencode/$rules" '
  { print }
  /"\$schema"/ && !done { print "  // Global pipeline rules, vendored from the template."; print "  \"instructions\": [\"" rules "\"],"; done = 1 }
  END { if (!done) exit 1 }
' "$tpl/opencode.jsonc" >"$stage/opencode.jsonc" || { echo "No \$schema line in $tpl/opencode.jsonc" >&2; exit 1; }

version="$(git -C "$root" describe --always --dirty 2>/dev/null || echo unknown)"
mapfile -t new < <(cd "$stage" && find . -type f | sed 's#^\./##' | LC_ALL=C sort)

# --- Compare with what is in the project. ---
declare -A old=()
if [[ -f "$manifest" ]]; then
  while read -r sum path; do
    [[ -z "$sum" || "$sum" == \#* ]] && continue
    old["$path"]="$sum"
  done <"$manifest"
fi
declare -A in_new=()
for f in "${new[@]}"; do in_new["$f"]=1; done

hash() { sha256sum "$1" | cut -d' ' -f1; }

conflicts=() writes=() removes=() same=0
for f in "${new[@]}"; do
  target="$dest/$f"
  if [[ ! -e "$target" ]]; then
    writes+=("add     $f")
  elif [[ "$(hash "$target")" == "$(hash "$stage/$f")" ]]; then
    same=$((same + 1))
  elif [[ -z "${old[$f]:-}" ]]; then
    conflicts+=("$f (exists, not created by the pipeline)")
    writes+=("replace $f")
  elif [[ "$(hash "$target")" != "${old[$f]}" ]]; then
    conflicts+=("$f (changed in the project)")
    writes+=("update  $f")
  else
    writes+=("update  $f")
  fi
done
for f in "${!old[@]}"; do
  [[ -n "${in_new[$f]:-}" ]] && continue
  target="$dest/$f"
  [[ -e "$target" ]] || continue
  [[ "$(hash "$target")" == "${old[$f]}" ]] || conflicts+=("$f (changed in the project, removed from the template)")
  removes+=("remove  $f")
done

echo "Template $version -> $dest"
if [[ ${#writes[@]} -eq 0 && ${#removes[@]} -eq 0 ]]; then
  echo "  already up to date ($same files)"
else
  printf '  %s\n' "${writes[@]}" "${removes[@]}"
  [[ $same -gt 0 ]] && echo "  ($same files unchanged)"
fi

if [[ ${#conflicts[@]} -gt 0 ]]; then
  echo
  echo "Conflicts:"
  printf '  %s\n' "${conflicts[@]}"
  if [[ -z "${FORCE:-}" ]]; then
    echo
    echo "Nothing written. Move your changes elsewhere (e.g. a new agent file or the project's AGENTS.md), or re-run with FORCE=1 to overwrite them."
    exit 1
  fi
  echo "FORCE=1: overwriting them."
fi

if [[ -n "${DRY_RUN:-}" ]]; then
  echo
  echo "DRY_RUN=1: nothing written."
  exit 0
fi

# --- Apply. ---
for f in "${new[@]}"; do
  mkdir -p "$dest/$(dirname "$f")"
  cp "$stage/$f" "$dest/$f"
done
for line in "${removes[@]}"; do
  f="${line#remove  }"
  rm -f "$dest/$f"
  rmdir -p --ignore-fail-on-non-empty "$(dirname "$dest/$f")" 2>/dev/null || true
done
{
  echo "# opencode ticket-to-PR pipeline, vendored by 'make vendor' - do not edit."
  echo "# template: $version"
  (cd "$stage" && for f in "${new[@]}"; do sha256sum "$f"; done)
} >"$manifest"

# Same content opencode writes itself, so its auto-installed plugin deps stay out of git.
if [[ ! -f "$dest/.gitignore" ]]; then
  printf '%s\n' node_modules package.json package-lock.json bun.lock .gitignore >"$dest/.gitignore"
fi

echo
echo "Done. Commit .opencode/ (and AGENTS.md if init changed it) in the project."
