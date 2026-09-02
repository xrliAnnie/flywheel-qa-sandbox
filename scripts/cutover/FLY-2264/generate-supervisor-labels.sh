#!/bin/bash
# FLY-2274: enumerate the reviewed Flywheel cutover supervisor scope.
set -euo pipefail

agents_dir="${1:-${HOME}/Library/LaunchAgents}"
case "$agents_dir" in
  /*) ;;
  *) printf 'generate-supervisor-labels: LaunchAgents path must be absolute: %s\n' "$agents_dir" >&2; exit 64 ;;
esac
[ -d "$agents_dir" ] && [ ! -L "$agents_dir" ] || {
  printf 'generate-supervisor-labels: LaunchAgents path is not a real directory: %s\n' "$agents_dir" >&2
  exit 1
}

tmp="$(mktemp -d -t fly2264-labels.XXXXXX)"
trap 'rm -rf "$tmp"' EXIT
: >"$tmp/included"
: >"$tmp/seen"

shopt -s nullglob
plists=("$agents_dir"/com.flywheel.*.plist)
shopt -u nullglob
[ "${#plists[@]}" -gt 0 ] || {
  printf 'generate-supervisor-labels: no com.flywheel.*.plist files found\n' >&2
  exit 1
}

for plist in "${plists[@]}"; do
  filename_label="$(basename "$plist" .plist)"
  if [ -L "$plist" ]; then
    printf 'generate-supervisor-labels: symlink plist rejected: %s\n' "$plist" >&2
    exit 1
  fi
  [ -f "$plist" ] || {
    printf 'generate-supervisor-labels: non-regular plist rejected: %s\n' "$plist" >&2
    exit 1
  }
  label="$(python3 - "$plist" <<'PY'
import plistlib, sys
try:
    with open(sys.argv[1], "rb") as handle:
        value = plistlib.load(handle).get("Label")
except Exception as exc:
    print(f"plist parse failed: {exc}", file=sys.stderr)
    raise SystemExit(1)
if not isinstance(value, str) or not value or "\n" in value or "\r" in value:
    print("plist Label must be a non-empty single-line string", file=sys.stderr)
    raise SystemExit(1)
print(value)
PY
  )" || {
    printf 'generate-supervisor-labels: cannot parse Label: %s\n' "$plist" >&2
    exit 1
  }
  case "$label" in
    *[!A-Za-z0-9._-]*)
      printf 'generate-supervisor-labels: unsafe Label rejected: %s\n' "$label" >&2
      exit 1
      ;;
  esac
  [ "$filename_label" = "$label" ] || {
    printf 'generate-supervisor-labels: label mismatch: filename=%s Label=%s\n' "$filename_label" "$label" >&2
    exit 1
  }
  if grep -Fxq "$label" "$tmp/seen"; then
    printf 'generate-supervisor-labels: duplicate Label: %s\n' "$label" >&2
    exit 1
  fi
  printf '%s\n' "$label" >>"$tmp/seen"
  case "$label" in
    com.flywheel.bridge|com.flywheel.bridge-liveness-probe|com.flywheel.cmux-watcher|com.flywheel.lead.*)
      printf '%s\n' "$label" >>"$tmp/included"
      ;;
    *)
      printf 'excluded: %s\n' "$label" >&2
      ;;
  esac
done

for required in com.flywheel.bridge com.flywheel.bridge-liveness-probe com.flywheel.cmux-watcher; do
  grep -Fxq "$required" "$tmp/included" || {
    printf 'generate-supervisor-labels: missing required label: %s\n' "$required" >&2
    exit 1
  }
done
lead_count="$(grep -c '^com\.flywheel\.lead\.' "$tmp/included" || true)"
[ "$lead_count" -eq 16 ] || {
  printf 'generate-supervisor-labels: expected 16 Lead labels, found %s\n' "$lead_count" >&2
  exit 1
}
[ "$(wc -l <"$tmp/included" | tr -d ' ')" -eq 19 ] || {
  printf 'generate-supervisor-labels: expected 19 in-scope labels\n' >&2
  exit 1
}
LC_ALL=C sort -u "$tmp/included"
