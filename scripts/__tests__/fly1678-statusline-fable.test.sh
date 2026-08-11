#!/usr/bin/env bash
# FLY-1678 — statusline renders a third, model-scoped usage bar beside 5h / 7d.
#
# The founder asked for the Fable limit next to the existing two. The data is
# already in the cache the statusline reads: `limits[]` carries a `weekly_scoped`
# entry whose `scope.model.display_name` is literally "Fable", so this costs zero
# extra API calls.
#
# This script renders on EVERY Lead and Runner pane on the founder's machine, so
# the bar for the two contracts is high:
#   * malformed model data must never disturb the existing 5h/7d bytes;
#   * API-controlled text must never reach the terminal as control bytes.
#
# Hermetic: fake HOME, deterministic date/stat/tr shims, curl/security are
# forbidden-call markers. See fixtures/fly1678/harness.sh for why each is needed.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/__tests__/fixtures/fly1678/harness.sh
source "$HERE/fixtures/fly1678/harness.sh"

SCRIPT="$(cd "$HERE/../.." && pwd)/scripts/statusline-command.sh"
SNAPSHOT="$HERE/fixtures/fly1678/cache/live-snapshot-20260810.json"

echo "FLY-1678 statusline model-scoped bar"
echo "  subject : $SCRIPT"
echo "  baseline: $FLY1678_BASELINE"
echo

fly1678_setup
trap fly1678_teardown EXIT

# A valid cache whose 5h/7d halves are FIXED, so any change in those bytes is
# attributable to the new code and nothing else. $1 becomes the `limits` value.
SCOPED_FIXTURE='[{"kind":"weekly_scoped","percent":90,"resets_at":"2026-08-12T07:00:00Z","scope":{"model":{"id":null,"display_name":"Fable"},"surface":null}}]'
cache_with_limits() {
  printf '{"five_hour":{"utilization":19.4,"resets_at":"2026-08-11T00:59:00Z"},'
  printf '"seven_day":{"utilization":4.9,"resets_at":"2026-08-14T05:59:59Z"},'
  printf '"limits":%s}' "$1"
}

# The 5h/7d region of line 2, captured once from a run with NO model data at all.
# Every other case must keep line 2 starting with exactly these bytes.
line2_raw() { sed -n '2p' "$FLY1678_OUT" | perl -0pe 's/\n\z//'; }
# NOTE: head -c counts BYTES while ${#var} counts characters, and the bar glyphs
# are 3 bytes each — comparing the two truncates mid-glyph. Use the byte length.
head_region() { line2_raw | head -c "$GOOD_HEAD_BYTES"; }

# ---------------------------------------------------------------------------
echo "[A] dated snapshot of the real cache renders the model bar"
# Expectations are derived from the SNAPSHOT ITSELF, never hard-coded: this is
# live usage data and it really does move (Fable read 90% when the plan was
# written, 6% by the time the fixture was cut).
exp_name=$(jq -r '[.limits[] | select(.scope.model.display_name != null)][0].scope.model.display_name' "$SNAPSHOT")
exp_pct=$(jq -r '[.limits[] | select(.scope.model.display_name != null)][0].percent | floor' "$SNAPSHOT")
fly1678_render "$SCRIPT" "@$SNAPSHOT"
fly1678_assert_clean_run "A"
fly1678_check "$([ "$(fly1678_line_count)" -eq 2 ] && echo 0 || echo 1)" \
  "A: exactly two lines" "got $(fly1678_line_count)"
line2=$(fly1678_line 2)
case "$line2" in *"$exp_name "*) r=0 ;; *) r=1 ;; esac
fly1678_check "$r" "A: model label '$exp_name' present" "line2=$(printf '%s' "$line2" | cat -v)"
case "$line2" in *" ${exp_pct}%"*) r=0 ;; *) r=1 ;; esac
fly1678_check "$r" "A: percentage ${exp_pct}% (floor of the fixture's own value)"
# The snapshot's scoped reset is 2026-08-14 while the pinned now is 2026-08-11,
# so fmt_reset must take its weekday branch — proving the third bar reuses the
# same formatter as 5h/7d rather than inventing one.
case "$line2" in *"reset Fri 05:59"*) r=0 ;; *) r=1 ;; esac
fly1678_check "$r" "A: reset rendered by the shared fmt_reset (weekday branch)"
fly1678_assert_bar_bytes "A" 4   # ctx + 5h + 7d + model
fly1678_assert_no_stray_control "A"
fly1678_assert_no_forbidden_calls "A"

# ---------------------------------------------------------------------------
echo
echo "[B] zero regression — line 1 identical, line 2 keeps its 5h/7d prefix"
fly1678_render "$SCRIPT" "@$SNAPSHOT"
got1=$(fly1678_line 1 | perl -0pe 's/\n\z//')
want1=$(cat "$HERE/fixtures/fly1678/golden/line1.bin")
fly1678_check "$([ "$got1" = "$want1" ] && echo 0 || echo 1)" \
  "B: line 1 byte-identical to the frozen-baseline golden" \
  "got : $(printf '%s' "$got1" | cat -v)" "want: $(printf '%s' "$want1" | cat -v)"

prefix_len=$(wc -c < "$HERE/fixtures/fly1678/golden/line2-prefix.bin" | tr -d ' ')
got2_prefix=$(fly1678_line 2 | head -c "$prefix_len")
want2_prefix=$(cat "$HERE/fixtures/fly1678/golden/line2-prefix.bin")
fly1678_check "$([ "$got2_prefix" = "$want2_prefix" ] && echo 0 || echo 1)" \
  "B: line 2 begins with the exact baseline 5h/7d bytes" \
  "got : $(printf '%s' "$got2_prefix" | cat -v)"
# ...and what follows is the separator, not an accidental substring match.
sep_follows=$(fly1678_line 2 | tail -c "+$((prefix_len + 1))" | head -c 20)
want_sep=$(printf '\033[90m  |  \033[0m')
case "$sep_follows" in "$want_sep"*) r=0 ;; *) r=1 ;; esac
fly1678_check "$r" "B: the baseline prefix is followed by the model separator" \
  "next bytes: $(printf '%s' "$sep_follows" | cat -v)"

# ---------------------------------------------------------------------------
echo
echo "[Contract A] cache JSON valid, model data missing/malformed"
echo "             -> exit 0, exactly two lines, 5h/7d bytes untouched"
fly1678_render "$SCRIPT" "$(cache_with_limits 'null')"
GOOD_HEAD=$(line2_raw)   # reference 5h/7d region: a run with no model data at all
GOOD_HEAD_BYTES=$(printf '%s' "$GOOD_HEAD" | wc -c | tr -d ' ')

contract_a() { # <label> <limits-json>
  fly1678_render "$SCRIPT" "$(cache_with_limits "$2")"
  fly1678_assert_clean_run "$1"
  fly1678_check "$([ "$(fly1678_line_count)" -eq 2 ] && echo 0 || echo 1)" \
    "$1: exactly two lines" "got $(fly1678_line_count)"
  fly1678_check "$([ "$(head_region)" = "$GOOD_HEAD" ] && echo 0 || echo 1)" \
    "$1: 5h/7d region byte-identical" "got: $(head_region | cat -v)"
}
# Returns 0 when line 2 is EXACTLY the 5h/7d region — no model segment appended.
no_model_segment() { [ "$(line2_raw)" = "$GOOD_HEAD" ]; }
assert_no_model() { fly1678_check "$(no_model_segment && echo 0 || echo 1)" "$1: no model bar rendered"; }

contract_a "C limits absent"        'null'
assert_no_model "C"
# `"limits": null` is not the same as the key being missing — cover both.
fly1678_render "$SCRIPT" '{"five_hour":{"utilization":19.4,"resets_at":"2026-08-11T00:59:00Z"},"seven_day":{"utilization":4.9,"resets_at":"2026-08-14T05:59:59Z"}}'
fly1678_assert_clean_run "C2 limits key missing"
fly1678_check "$([ "$(head_region)" = "$GOOD_HEAD" ] && echo 0 || echo 1)" "C2: 5h/7d region byte-identical"

contract_a "D all scope null"       '[{"kind":"session","percent":50,"scope":null},{"kind":"weekly_all","percent":60,"scope":null}]'
assert_no_model "D"
contract_a "E surface-scoped only"  '[{"kind":"weekly_scoped","percent":90,"scope":{"model":null,"surface":{"name":"api"}}}]'
assert_no_model "E"
contract_a "F string percent 09.5"  '[{"percent":"09.5","scope":{"model":{"display_name":"X"}}}]'
assert_no_model "F"
contract_a "G percent -5"           '[{"percent":-5,"scope":{"model":{"display_name":"A"}}}]'
assert_no_model "G"
contract_a "H percent 150"          '[{"percent":150,"scope":{"model":{"display_name":"B"}}}]'
assert_no_model "H"
contract_a "I limits is an object"  '{"a":1}'
assert_no_model "I"
contract_a "J empty display_name"   '[{"percent":90,"scope":{"model":{"display_name":""}}}]'
assert_no_model "J"
contract_a "K whitespace-only name" '[{"percent":90,"scope":{"model":{"display_name":"   "}}}]'
assert_no_model "K"

echo
echo "  ...and the malformed entries that SHOULD still render"
contract_a "L scalar members mixed in" '[3,"x",null,{"percent":42,"resets_at":"2026-08-12T07:00:00Z","scope":{"model":{"display_name":"OK"}}}]'
case "$(fly1678_line 2)" in *"OK "*" 42%"*) r=0 ;; *) r=1 ;; esac
fly1678_check "$r" "L: the one valid entry survives scalar neighbours"

contract_a "M percent 9e1" '[{"percent":9e1,"resets_at":null,"scope":{"model":{"display_name":"C"}}}]'
case "$(fly1678_line 2)" in *"C "*" 90%"*) r=0 ;; *) r=1 ;; esac
fly1678_check "$r" "M: exponent form normalises to 90"

# Signed zero is valid JSON and passes a naive 0..100 range check, but
# `floor|tostring` yields the string "-0", which a digit-only shell guard drops —
# the bar would vanish with no error anywhere. Normalisation must produce "0".
for z in "-0" "-0.0"; do
  contract_a "N percent $z" "[{\"percent\":$z,\"resets_at\":\"2026-08-12T07:00:00Z\",\"scope\":{\"model\":{\"display_name\":\"Zed\"}}}]"
  case "$(fly1678_line 2)" in *"Zed "*" 0%"*) r=0 ;; *) r=1 ;; esac
  fly1678_check "$r" "N: signed zero $z normalises to 0 and still renders" \
    "line2=$(fly1678_line 2 | cat -v)"
done

contract_a "O bogus resets_at" '[{"percent":90,"resets_at":"garbage","scope":{"model":{"display_name":"Fable"}}}]'
case "$(fly1678_line 2)" in *"reset ?"*) r=0 ;; *) r=1 ;; esac
fly1678_check "$r" "O: unusable reset falls back to the shared '?' rendering"

contract_a "P name trimmed and capped" '[{"percent":88,"resets_at":"2026-08-12T07:00:00Z","scope":{"model":{"display_name":"  SuperLongModelNameThatGoesOnForever  "}}}]'
case "$(fly1678_line 2)" in *"SuperLongModelNa "*) r=0 ;; *) r=1 ;; esac
fly1678_check "$r" "P: label trimmed and capped at 16 code points"
case "$(fly1678_line 2)" in *"Forever"*) r=1 ;; *) r=0 ;; esac
fly1678_check "$r" "P: the untruncated tail never reaches the terminal"

# ---------------------------------------------------------------------------
echo
echo "[Bounded] at most ONE model bar, even when the API offers several"
contract_a "Q two model entries" '[{"percent":90,"resets_at":"2026-08-12T07:00:00Z","scope":{"model":{"display_name":"Fable"}}},{"percent":30,"resets_at":"2026-08-12T07:00:00Z","scope":{"model":{"display_name":"Opus"}}}]'
case "$(fly1678_line 2)" in *"Fable "*) r=0 ;; *) r=1 ;; esac
fly1678_check "$r" "Q: the first valid entry renders"
case "$(fly1678_line 2)" in *"Opus"*) r=1 ;; *) r=0 ;; esac
fly1678_check "$r" "Q: the second entry does NOT — the line cannot grow unbounded"
fly1678_assert_bar_bytes "Q" 4   # still 4 — the 2nd model entry must NOT add a 5th

contract_a "R invalid first, valid second" '[{"percent":90,"scope":{"model":{"display_name":""}}},{"percent":77,"resets_at":"2026-08-12T07:00:00Z","scope":{"model":{"display_name":"Fable"}}}]'
case "$(fly1678_line 2)" in *"Fable "*" 77%"*) r=0 ;; *) r=1 ;; esac
fly1678_check "$r" "R: 'first' means first VALID, not first raw"

# ---------------------------------------------------------------------------
echo
echo "[Fill] the model bar shows the RIGHT fill, not merely 'a bar'"
# Counting glyph runs is not enough — forcing this call to make_bar 0 once left
# the entire suite green, because ten empty cells is still ten cells.
for pair in "0:0" "6:0" "50:5" "90:9" "100:10"; do
  pctv=${pair%%:*}; fill=${pair##*:}
  contract_a "U pct=$pctv" "[{\"percent\":$pctv,\"resets_at\":\"2026-08-12T07:00:00Z\",\"scope\":{\"model\":{\"display_name\":\"Fable\"}}}]"
  fly1678_assert_model_bar "U pct=$pctv" "$fill"
done

# ---------------------------------------------------------------------------
echo
echo "[Legacy] the EXISTING 5h/7d values are normalised too"
# Same trust boundary, same Bash 3.2 octal trap: before this change a cache with
# five_hour.utilization "09.5" exited 1 with a bash error and lost line 2 entirely.
legacy_case() { # <label> <cache-json> <expected-line-count>
  fly1678_render "$SCRIPT" "$2"
  fly1678_assert_clean_run "$1"
  fly1678_check "$([ "$(fly1678_line_count)" -eq "$3" ] && echo 0 || echo 1)" \
    "$1: $3 line(s) rendered" "got $(fly1678_line_count)"
}
legacy_case "V 5h percent is a string" \
  '{"five_hour":{"utilization":"09.5","resets_at":"2026-08-11T00:59:00Z"},"seven_day":{"utilization":4.9,"resets_at":"2026-08-14T05:59:59Z"}}' 1
legacy_case "W 7d percent non-numeric" \
  '{"five_hour":{"utilization":19.4,"resets_at":"2026-08-11T00:59:00Z"},"seven_day":{"utilization":"abc","resets_at":"2026-08-14T05:59:59Z"}}' 1
legacy_case "X 5h resets_at is 100 KB" \
  "$(python3 -c 'import json;print(json.dumps({"five_hour":{"utilization":19.4,"resets_at":"2026-08-11T00:59:00"+"9"*100000},"seven_day":{"utilization":4.9,"resets_at":"2026-08-14T05:59:59Z"}}))')" 2
legacy_case "Y valid fractional values still render" \
  '{"five_hour":{"utilization":19.4,"resets_at":"2026-08-11T00:59:00Z"},"seven_day":{"utilization":4.9,"resets_at":"2026-08-14T05:59:59Z"}}' 2

echo
echo "[Bounded work] pathological sizes must not stall a per-frame render"
contract_a "Z1 model resets_at 100 KB" \
  "$(python3 -c 'import json;print(json.dumps([{"percent":50,"resets_at":"2026-08-12T07:00:00"+"9"*100000,"scope":{"model":{"display_name":"Big"}}}]))')"
case "$(fly1678_line 2)" in *"Big "*"reset ?"*) r=0 ;; *) r=1 ;; esac
fly1678_check "$r" "Z1: oversized timestamp falls back to '?', bar still renders"

# The shape above is rejected by the anchored pattern alone. THIS one is not:
# a 100 KB fractional-seconds part is structurally a valid ISO instant, so only
# the explicit length cap keeps it out. Without that cap this case renders a
# timestamp; the cap is load-bearing, not decoration.
contract_a "Z1b model resets_at with a 100 KB fractional part" \
  "$(python3 -c 'import json;print(json.dumps([{"percent":50,"resets_at":"2026-08-12T07:00:00."+"9"*100000+"Z","scope":{"model":{"display_name":"Frac"}}}]))')"
case "$(fly1678_line 2)" in *"Frac "*"reset ?"*) r=0 ;; *) r=1 ;; esac
fly1678_check "$r" "Z1b: structurally-valid but oversized timestamp is still rejected"
# 8,000 entries (~0.8 MB) — large enough to make a materialising traversal hurt,
# small enough to stay under the byte ceiling so the parse actually happens.
contract_a "Z2 600-entry limits array" \
  "$(python3 -c 'import json;e={"percent":90,"resets_at":"2026-08-12T07:00:00Z","scope":{"model":{"display_name":"Fable"}}};print(json.dumps([e]*600))')"
case "$(fly1678_line 2)" in *"Fable "*" 90%"*) r=0 ;; *) r=1 ;; esac
fly1678_check "$r" "Z2: lazy traversal still finds the first entry"

# Cost gate. The traversal and label bounds produce identical OUTPUT — the shell
# reads one record whatever the shape — so they can only be checked on cost, and
# only by timing the jq boundary alone: measuring a whole render let the fixed
# process-spawn cost swamp the signal, and a materialising variant slipped
# through a "4x a normal render" budget on a loaded host.
#
# This gate targets the RAW LABEL cap specifically, because that is the bound
# with no behavioural witness. Measured on an 600-entry array, the candidate
# cap is worth 428ms -> 43ms while lazy first() adds only 43 -> 33, so a timing
# ratio cannot separate first() from a materialising cascade once the cap is in
# place — and the cap itself already has a behavioural test (Z5). A 20,000-character
# display_name, by contrast, is only cheap because the raw string is truncated
# BEFORE `explode`; without that, it becomes a half-million-element array.
JQ_PROG=$(sed -n "/def pct(\$v)/,/\$m\[0\], \$m\[1\], \$m\[2\]/p" "$SCRIPT" \
  | sed "s|' \"\$CACHE\" 2>/dev/null)\$||")
SMALL_JSON="$FLY1678_SANDBOX/small.json"; BIG_JSON="$FLY1678_SANDBOX/biglabel.json"
cache_with_limits "$SCOPED_FIXTURE" > "$SMALL_JSON"
python3 -c 'import json,sys
json.dump({"five_hour":{"utilization":19.4,"resets_at":"2026-08-11T00:59:00Z"},
           "seven_day":{"utilization":4.9,"resets_at":"2026-08-14T05:59:59Z"},
           "limits":[{"percent":90,"resets_at":"2026-08-12T07:00:00Z",
                      "scope":{"model":{"display_name":"F"*50000}}}]},
          open(sys.argv[1],"w"))' "$BIG_JSON"
jq_ms() { # <file>
  python3 -c "
import subprocess,sys,time,statistics
prog=open(sys.argv[1]).read(); f=sys.argv[2]
ts=[]
for _ in range(3):
    t=time.perf_counter()
    subprocess.run(['jq','-r',prog,f],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    ts.append((time.perf_counter()-t)*1000)
print(int(statistics.median(ts)))" "$FLY1678_SANDBOX/prog.jq" "$1"
}
printf '%s' "$JQ_PROG" > "$FLY1678_SANDBOX/prog.jq"
# Positive control for the measuring instrument. Without this the extraction can
# silently drag the surrounding shell syntax in, both runs fail to compile in
# microseconds, and the ratio passes while measuring nothing at all — which is
# exactly what happened the first time this was written.
JQ_PROBE=$(jq -r -f "$FLY1678_SANDBOX/prog.jq" "$SMALL_JSON" 2>&1 | head -1)
fly1678_check "$([ "$JQ_PROBE" = "19" ] && echo 0 || echo 1)" \
  "Z3-control: the extracted jq program compiles and yields the 5h value" \
  "first line was: $JQ_PROBE"
SMALL_MS=$(jq_ms "$SMALL_JSON"); BIG_MS=$(jq_ms "$BIG_JSON")
# Budget calibrated against the mutant it must kill, not picked by feel. Measured:
# shipping 54ms, cap-removed 844ms, baseline 42ms. `small*3+50` = 176ms leaves
# shipping 3.3x of headroom while the mutant overshoots by 4.8x. An earlier
# `small*5+100` with a smaller fixture let the mutant through at 232 vs 250 —
# a gate that separates nothing.
fly1678_check "$([ "$BIG_MS" -lt $((SMALL_MS * 3 + 50)) ] && echo 0 || echo 1)" \
  "Z3: a 50,000-character display_name stays within 3x (raw label truncated before explode)" \
  "small=${SMALL_MS}ms big=${BIG_MS}ms budget=$((SMALL_MS * 3 + 50))ms"

# ...and it must still render correctly, not merely quickly.
fly1678_render "$SCRIPT" "@$BIG_JSON"
fly1678_assert_clean_run "Z3b huge label"
case "$(fly1678_line 2)" in *"FFFFFFFFFFFFFFFF "*" 90%"*) r=0 ;; *) r=1 ;; esac
fly1678_check "$r" "Z3b: the huge label renders truncated to 16 code points"
fly1678_assert_model_bar "Z3b" 9

# The bounds must hold for the shapes first() cannot help with, too.
contract_a "Z4 600 entries, all invalid" \
  "$(python3 -c 'import json;e={"percent":"nope","scope":{"model":{"display_name":"X"}}};print(json.dumps([e]*600))')"
assert_no_model "Z4"
contract_a "Z5 valid entry beyond the 200-candidate bound" \
  "$(python3 -c 'import json;bad={"percent":50,"scope":None};good={"percent":90,"resets_at":"2026-08-12T07:00:00Z","scope":{"model":{"display_name":"Late"}}};print(json.dumps([bad]*500+[good]))')"
# Deliberate, documented trade: past 200 candidates we stop looking rather than
# walk an unbounded array on every frame. Real responses carry three. Degrading
# to "no third bar" is the acceptable failure; a multi-second stall is not.
assert_no_model "Z5"
# Exact witnesses, so the test pins the DOCUMENTED bound of 200 rather than
# "somewhere between 151 and 500": index 199 must render, index 200 must not.
contract_a "Z6 valid entry at index 199 (last in bounds)" \
  "$(python3 -c 'import json;bad={"percent":50,"scope":None};good={"percent":90,"resets_at":"2026-08-12T07:00:00Z","scope":{"model":{"display_name":"Last"}}};print(json.dumps([bad]*199+[good]))')"
case "$(fly1678_line 2)" in *"Last "*" 90%"*) r=0 ;; *) r=1 ;; esac
fly1678_check "$r" "Z6: index 199 — the last in-bounds candidate — is found"
contract_a "Z6b valid entry at index 200 (first out of bounds)" \
  "$(python3 -c 'import json;bad={"percent":50,"scope":None};good={"percent":90,"resets_at":"2026-08-12T07:00:00Z","scope":{"model":{"display_name":"Past"}}};print(json.dumps([bad]*200+[good]))')"
assert_no_model "Z6b"

echo
echo "[Byte ceiling] an absurdly large cache degrades, it does not stall"
BIG_CACHE_FILE="$FLY1678_SANDBOX/oversized.json"
# One oversized string rather than tens of thousands of objects: the ceiling is
# about BYTES, and a 1.2 MB literal is far cheaper to build and parse than an
# equivalent-sized array of dictionaries.
python3 -c 'import json,sys
json.dump({"five_hour":{"utilization":19.4,"resets_at":"2026-08-11T00:59:00Z"},
           "seven_day":{"utilization":4.9,"resets_at":"2026-08-14T05:59:59Z"},
           "note":"x"*1200000}, open(sys.argv[1],"w"))' "$BIG_CACHE_FILE"
fly1678_check "$([ "$(wc -c < "$BIG_CACHE_FILE")" -gt 1048576 ] && echo 0 || echo 1)" \
  "Z7: the fixture really is over the 1 MB ceiling" "$(wc -c < "$BIG_CACHE_FILE") bytes"
fly1678_render "$SCRIPT" "@$BIG_CACHE_FILE"
fly1678_assert_clean_run "Z7"
fly1678_check "$([ "$(fly1678_line_count)" -eq 1 ] && echo 0 || echo 1)" \
  "Z7: degrades to line 1 only, exactly like a missing cache" "got $(fly1678_line_count)"

echo
echo "[Invisible] characters that corrupt a line without being control bytes"
inv_case() { # <label> <display_name-as-python-literal> <expect-rendered 0|1>
  local cache; cache=$(python3 -c "
import json,sys
print(json.dumps([{'percent':50,'resets_at':'2026-08-12T07:00:00Z',
                   'scope':{'model':{'display_name':$2}}}]))")
  contract_a "$1" "$cache"
}
inv_case "AA bidi override U+202E" "'Fa\\u202eble'"
case "$(fly1678_line 2)" in *"Fa ble "*) r=0 ;; *) r=1 ;; esac
fly1678_check "$r" "AA: the override is neutralised, the name still shows"
inv_case "AB zero-width only name" "'\\u200b\\u200b'"
assert_no_model "AB"
inv_case "AC backslash in name" "'a\\\\b'"
case "$(fly1678_line 2)" in *'a b '*) r=0 ;; *) r=1 ;; esac
fly1678_check "$r" "AC: no doubled backslash reaches the terminal"

# Default-ignorable code points are not control bytes and survive a naive filter,
# yet they render as nothing — so an all-invisible name would show a labelless
# segment, and a bidi mark can reorder what the founder reads.
for pair in "U+061C ALM:'Fa\\u061cble'" "U+034F CGJ:'Fa\\u034fble'" \
            "U+180E MVS:'Fa\\u180eble'" "U+FE0F VS16:'Fa\\ufe0fble'"; do
  inv_case "AD-${pair%%:*}" "${pair#*:}"
  case "$(fly1678_line 2)" in *"Fa ble "*) r=0 ;; *) r=1 ;; esac
  fly1678_check "$r" "AD-${pair%%:*}: neutralised to a space, name still legible"
done
inv_case "AE all-invisible name" "'\\u034f\\u061c\\ufe0f'"
assert_no_model "AE"
inv_case "AE2 unicode-whitespace-only name" "'\\u00a0\\u2007\\u202f\\u205f\\u3000'"
assert_no_model "AE2"
inv_case "AE3 name padded with unicode whitespace" "'\\u3000Fable\\u00a0'"
case "$(fly1678_line 2)" in *"Fable "*) r=0 ;; *) r=1 ;; esac
fly1678_check "$r" "AE3: unicode padding trimmed, the real name survives"
inv_case "AF CJK name survives" "'\\u901a\\u4e49\\u5343\\u95ee'"
case "$(fly1678_line 2)" in *"通义千问 "*) r=0 ;; *) r=1 ;; esac
fly1678_check "$r" "AF: a legitimate non-ASCII name is NOT mangled by the filter"

# ---------------------------------------------------------------------------
echo
echo "[Framing] a trailing newline in ANY timestamp must not shift the fields"
# jq's `$` is a LINE anchor, not an absolute one: it also matches before a final
# newline. With newline-delimited framing that accepted LF injected an extra
# record and shifted every field after it — observed as the model bar vanishing
# and 7d rendering "reset ?". The pattern now ends at \z and control characters
# are rejected outright.
lf_case() { # <label> <which: r5|r7|model>
  local c
  c=$(python3 -c "
import json
r5 = '2026-08-11T00:59:00Z'; r7 = '2026-08-14T05:59:59Z'; rm = '2026-08-12T07:00:00Z'
which = '$2'
if which == 'r5': r5 += '\n'
if which == 'r7': r7 += '\n'
if which == 'model': rm += '\n'
print(json.dumps({'five_hour':{'utilization':19.4,'resets_at':r5},
                  'seven_day':{'utilization':4.9,'resets_at':r7},
                  'limits':[{'percent':90,'resets_at':rm,
                             'scope':{'model':{'display_name':'Fable'}}}]}))")
  fly1678_render "$SCRIPT" "$c"
  fly1678_assert_clean_run "$1"
  fly1678_check "$([ "$(fly1678_line_count)" -eq 2 ] && echo 0 || echo 1)" \
    "$1: still exactly two lines" "got $(fly1678_line_count)"
  case "$(fly1678_line 2)" in *"Fable "*" 90%"*) r=0 ;; *) r=1 ;; esac
  fly1678_check "$r" "$1: the model segment is still there — fields did not shift" \
    "line2=$(fly1678_line 2 | cat -v)"
}
lf_case "AD trailing LF in 5h resets_at"    r5
lf_case "AE trailing LF in 7d resets_at"    r7
lf_case "AF trailing LF in model resets_at" model
# The offending timestamp itself is rejected, so it renders '?' rather than a
# half-parsed instant.
case "$(fly1678_line 2)" in *"reset ?"*) r=0 ;; *) r=1 ;; esac
fly1678_check "$r" "AF: the newline-bearing timestamp itself is rejected"

# ---------------------------------------------------------------------------
echo
echo "[Timestamp forms] the boundary must admit only what fmt_reset renders truly"
# fmt_reset takes ${iso%%.*} and hands it to `date -juf ...` AS UTC, so a
# non-zero offset is silently dropped and the bar would show a reset hours off.
# Rejecting it renders '?' — unknown beats confidently wrong.
stamp_case() { # <label> <model resets_at> <expected fragment>
  # jq, not a nested python -c: quoting python inside $( ) inside " " ate the
  # dict braces and produced `json.dumps(['percent':90])`.
  contract_a "$1" "$(jq -nc --arg r "$2" '[{percent:90, resets_at:$r, scope:{model:{display_name:"Fable"}}}]')"
  case "$(fly1678_line 2)" in *"$3"*) r=0 ;; *) r=1 ;; esac
  fly1678_check "$r" "$1: renders '$3'" "line2=$(fly1678_line 2 | cat -v)"
}
stamp_case "AL fractional +00:00 (the real API form)" "2026-08-12T07:00:00.123456+00:00" "reset tmrw 07:00"
stamp_case "AM bare Z, no fraction"                   "2026-08-12T07:00:00Z"             "reset tmrw 07:00"
stamp_case "AN explicit +00:00, no fraction"          "2026-08-12T07:00:00+00:00"        "reset tmrw 07:00"
stamp_case "AO NON-ZERO offset is refused"            "2026-08-12T07:00:00.123+05:00"    "reset ?"
stamp_case "AP -00:00 is still UTC"                   "2026-08-12T07:00:00-00:00"        "reset tmrw 07:00"
# The suffix is MANDATORY, not merely restricted: a timezone-less value names no
# instant, and calling it UTC is the same confident guess the offset rejection
# exists to prevent.
stamp_case "AQ timezone-less value is refused"        "2026-08-12T07:00:00"              "reset ?"

# ---------------------------------------------------------------------------
echo
echo "[Byte compat] valid legacy 5h/7d values render exactly as the baseline did"
# The other legacy cases assert rejection and line counts. This one asserts the
# promise that matters for zero regression: for values that were always valid,
# the subject's bytes equal the FROZEN BASELINE's bytes — not GOOD_HEAD, which is
# generated by the code under test and could drift with it.
compat_case() { # <label> <5h-value> <7d-value>
  local c
  c=$(printf '{"five_hour":{"utilization":%s,"resets_at":"2026-08-11T00:59:00Z"},"seven_day":{"utilization":%s,"resets_at":"2026-08-14T05:59:59Z"}}' "$2" "$3")
  fly1678_render "$SCRIPT" "$c";           local subj; subj=$(fly1678_line 2 | perl -0pe 's/\n\z//')
  fly1678_render "$FLY1678_BASELINE" "$c"; local base; base=$(fly1678_line 2 | perl -0pe 's/\n\z//')
  fly1678_check "$([ "$subj" = "$base" ] && echo 0 || echo 1)" \
    "$1: line 2 byte-identical to the frozen baseline" \
    "subject : $(printf '%s' "$subj" | cat -v)" "baseline: $(printf '%s' "$base" | cat -v)"
}
compat_case "AG 96.0 / 22.0" 96.0 22.0
compat_case "AH 0 / 0"       0    0
compat_case "AI 100 / 100"   100  100
compat_case "AJ 19.4 / 4.9"  19.4 4.9
compat_case "AK 150 / 99.9"  150  99.9

# ---------------------------------------------------------------------------
echo
echo "[Hostile] API-controlled label cannot inject control bytes or a format string"
NASTY=$(python3 -c '
import json
name = "Fa\tb\nle\x1b[2J%s-tail-that-keeps-going"
print(json.dumps([{"percent": 50, "resets_at": "2026-08-12T07:00:00Z",
                   "scope": {"model": {"display_name": name}}}]))')
contract_a "S hostile label" "$NASTY"
fly1678_assert_no_stray_control "S"
fly1678_assert_bar_bytes "S" 4   # a hostile label cannot add or corrupt a bar
line2=$(fly1678_line 2)
case "$line2" in *'%s'*) r=0 ;; *) r=1 ;; esac
fly1678_check "$r" "S: '%s' appears literally — the label is an argument, not a format"
raw=$(printf '%s' "$line2" | cat -v)
case "$raw" in *'^I'*) r=1 ;; *) r=0 ;; esac
fly1678_check "$r" "S: injected TAB is gone"
case "$raw" in *'^[[2J'*) r=1 ;; *) r=0 ;; esac
fly1678_check "$r" "S: injected screen-clear sequence is gone"
fly1678_check "$([ "$(fly1678_line_count)" -eq 2 ] && echo 0 || echo 1)" \
  "S: injected newline did not add a third line" "got $(fly1678_line_count)"

# ---------------------------------------------------------------------------
echo
echo "[Contract B] wholly invalid cache JSON -> byte-identical to the baseline"
# The 5h/7d values come from that same file, so when it is unparseable the
# baseline renders line 1 only. The new code must not fabricate anything; the
# ruler is what the baseline does, not an invariant it never had.
INVALID='this is definitely not json {{{'
fly1678_render "$SCRIPT" "$INVALID"
cp "$FLY1678_OUT" "$FLY1678_SANDBOX/subject-invalid.bin"
subject_rc=$FLY1678_RC
subject_err_size=$(wc -c < "$FLY1678_ERR" | tr -d ' ')
fly1678_render "$FLY1678_BASELINE" "$INVALID"
fly1678_check "$(cmp -s "$FLY1678_SANDBOX/subject-invalid.bin" "$FLY1678_OUT" && echo 0 || echo 1)" \
  "T: output byte-identical to the baseline on the same invalid input" \
  "subject: $(cat -v "$FLY1678_SANDBOX/subject-invalid.bin")" \
  "baseline: $(cat -v "$FLY1678_OUT")"
fly1678_check "$([ "$subject_rc" -eq 0 ] && echo 0 || echo 1)" "T: exit 0" "got $subject_rc"
fly1678_check "$([ "$subject_err_size" -eq 0 ] && echo 0 || echo 1)" \
  "T: jq diagnostics never leak to stderr" "stderr bytes: $subject_err_size"
fly1678_assert_no_forbidden_calls "T"

fly1678_summary
