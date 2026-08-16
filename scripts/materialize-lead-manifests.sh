#!/bin/bash
# FLY-650: materialize-lead-manifests.sh — deterministic clean-host Lead manifests
# (WI-4; Codex R1#2 / R2#5).
#
# On a clean host, Lead manifests do not exist, and the launchd/systemd wrapper
# exits if one is missing. This command reads projects.json and writes the
# canonical pre-launch manifest without starting any Lead, so `supervisor
# install <lead>` is deterministic on both macOS and Linux.
#
# The v2 wrapper adds runtime-only `pid` and `socketPath` fields after launch.
# Model and leadBackend.backendId are carried from projects.json when present;
# absent stays absent (never injected).
#
# Idempotent: create-if-absent (a live manifest from a running Lead is NOT
# clobbered); pass --force to overwrite.
set -uo pipefail

HOME_DIR="${HOME:-}"
PROJECTS=""
MANIFEST_DIR=""
FORCE=0

usage() {
  cat <<EOF
Usage: materialize-lead-manifests.sh [options]
  --home DIR           target home (default: \$HOME)
  --projects FILE      projects.json (default: <home>/.flywheel/projects.json)
  --manifests-dir DIR  output dir (default: <home>/.flywheel/manifests)
  --force              overwrite existing manifests
  -h, --help           this help
Writes one <projectName>-<agentId>.json per Lead. Starts nothing.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --home) HOME_DIR="$2"; shift 2 ;;
    --projects) PROJECTS="$2"; shift 2 ;;
    --manifests-dir) MANIFEST_DIR="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "materialize: unknown arg: $1" >&2; usage; exit 2 ;;
  esac
done

[ -n "$PROJECTS" ] || PROJECTS="$HOME_DIR/.flywheel/projects.json"
[ -n "$MANIFEST_DIR" ] || MANIFEST_DIR="$HOME_DIR/.flywheel/manifests"

command -v jq >/dev/null 2>&1 || { echo "materialize: jq required" >&2; exit 2; }
[ -f "$PROJECTS" ] || { echo "materialize: no projects.json at $PROJECTS" >&2; exit 2; }
jq empty "$PROJECTS" 2>/dev/null || { echo "materialize: projects.json is not valid JSON" >&2; exit 1; }

mkdir -p "$MANIFEST_DIR"

# resolve a (possibly home-relative) project root to an absolute path.
resolve_dir() {
  case "$1" in /*) printf '%s' "$1" ;; *) printf '%s' "$HOME_DIR/$1" ;; esac
}

written=0; skipped=0
# Stream one compact JSON object per lead: {projectName, projectRoot, leads:[...]}.
while IFS= read -r proj; do
  pname="$(jq -r '.projectName' <<<"$proj")"
  proot="$(jq -r '.projectRoot' <<<"$proj")"
  pdir="$(resolve_dir "$proot")"
  while IFS= read -r lead; do
    [ -z "$lead" ] && continue
    lid="$(jq -r '.agentId' <<<"$lead")"
    [ -z "$lid" ] || [ "$lid" = "null" ] && continue
    model="$(jq -r '.model // ""' <<<"$lead")"
    backend="$(jq -r '.backend // ""' <<<"$lead")"
    out="$MANIFEST_DIR/${pname}-${lid}.json"
    if [ -f "$out" ] && [ "$FORCE" -ne 1 ]; then
      echo "materialize: keeping existing $out (use --force to overwrite)"
      skipped=$((skipped+1)); continue
    fi
    tmp="${out}.tmp.$$"
    # Canonical pre-launch shape; wrapper-v2 adds runtime identity fields.
    jq -n \
      --arg leadId "$lid" \
      --arg projectDir "$pdir" \
      --arg projectName "$pname" \
	  --arg projectsFile "$PROJECTS" \
      --arg workspace "$pdir" \
      --arg model "$model" \
      --arg backendId "$backend" \
      '{
         leadId: $leadId, projectDir: $projectDir, projectName: $projectName,
		 projectsFile: $projectsFile, subdir: "", workspace: $workspace,
		 mcpExclude: ""
       }
       | (if $model != "" then . + {model: $model} else . end)
       | (if $backendId != "" then . + {leadBackend: {backendId: $backendId}} else . end)' \
      > "$tmp" \
      && jq empty "$tmp" 2>/dev/null \
      && mv "$tmp" "$out" \
      || { rm -f "$tmp"; echo "materialize: FAILED writing $out" >&2; exit 1; }
    echo "materialize: wrote $out"
    written=$((written+1))
  done < <(jq -c '.leads[]?' <<<"$proj")
done < <(jq -c '.[]' "$PROJECTS")

echo "materialize: done ($written written, $skipped kept)"
