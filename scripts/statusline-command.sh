#!/usr/bin/env bash
# Claude Code status line (two-line layout)
# Line 1: model | dir | context bar
# Line 2: 5h usage bar + reset | 7d usage bar + reset
#
# NOTE: Anthropic's usage API rate limits per access token (~5 calls then 429).
# We cache aggressively (10 min) and only retry once to preserve token budget.
# Do NOT auto-refresh OAuth tokens here — it invalidates all running sessions.

input=$(cat)

# --- Parse session JSON ---
model=$(echo "$input" | jq -r '.model.display_name // ""')
cwd=$(echo "$input" | jq -r '.workspace.current_dir // .cwd // ""')
ctx_pct=$(echo "$input" | jq -r '.context_window.used_percentage // 0' | cut -d. -f1)
worktree=$(echo "$input" | jq -r '.worktree.name // empty')
agent_name=$(echo "$input" | jq -r '.agent.name // empty')
# Current logged-in account email (from ~/.claude.json; 253K, ~5ms to parse)
email=$(jq -r '.oauthAccount.emailAddress // empty' "$HOME/.claude.json" 2>/dev/null)
home="$HOME"
cwd="${cwd/#$home/\~}"

# --- ANSI colors ---
DIM='\033[2m'
RST='\033[0m'
GREEN='\033[32m'
YELLOW='\033[33m'
RED='\033[91m'
CYAN='\033[36m'
GRAY='\033[90m'
MAGENTA='\033[35m'

pick_color() {
  local pct=$1
  if [ "$pct" -ge 80 ]; then echo -ne "$RED"
  elif [ "$pct" -ge 50 ]; then echo -ne "$YELLOW"
  else echo -ne "$GREEN"; fi
}

make_bar() {
  local pct=$1 width=10
  local filled=$(( pct * width / 100 ))
  [ "$filled" -gt "$width" ] && filled=$width
  local empty=$(( width - filled ))
  local bar=""
  [ "$filled" -gt 0 ] && bar=$(printf "%${filled}s" | tr ' ' '▓')
  [ "$empty" -gt 0 ] && bar="${bar}$(printf "%${empty}s" | tr ' ' '░')"
  echo -n "$bar"
}

fmt_reset() {
  local iso=$1
  [ -z "$iso" ] || [ "$iso" = "null" ] && { echo -n "?"; return; }
  local reset_epoch
  reset_epoch=$(date -juf "%Y-%m-%dT%H:%M:%S" "${iso%%.*}" +%s 2>/dev/null) || { echo -n "?"; return; }
  local today tomorrow reset_day
  today=$(date +%Y-%m-%d)
  tomorrow=$(date -v+1d +%Y-%m-%d)
  reset_day=$(date -jf "%s" "$reset_epoch" +%Y-%m-%d 2>/dev/null)
  local reset_time
  reset_time=$(date -jf "%s" "$reset_epoch" +%H:%M 2>/dev/null)
  if [ "$reset_day" = "$today" ]; then
    echo -n "today ${reset_time}"
  elif [ "$reset_day" = "$tomorrow" ]; then
    echo -n "tmrw ${reset_time}"
  else
    local weekday
    weekday=$(date -jf "%s" "$reset_epoch" +%a 2>/dev/null)
    echo -n "${weekday} ${reset_time}"
  fi
}

# --- Usage API cache ---
CACHE="$HOME/.claude/usage-api-cache.json"
CACHE_MAX_AGE=600  # 10 minutes — conserve the ~5 calls/token budget
LOCK="/tmp/claude-usage-refresh.lock"

# --- cache -> shell trust boundary -------------------------------------------
# Everything below arrives from an external API and is then fed to Bash 3.2
# arithmetic and to the terminal, so it is all normalised in jq first. This
# matters more than it looks: `utilization: "09.5"` reaches `$(( ))` as "09",
# which Bash 3.2 reads as OCTAL and aborts make_bar with "value too great for
# base" — one malformed response blanks the statusline on every pane at once.
# Valid values still render byte-for-byte as before (`96.0` -> `96` is exactly
# what `${u5%.*}` already produced downstream).
#
# ONE jq invocation for all seven fields, newline-delimited. This command is
# re-read on every frame of every pane, so process spawns dominate. Measured on
# the production Mac against the real 2 KB cache: the previous four separate
# reads cost ~125 ms of jq per frame, and this single combined parse costs
# ~35 ms. That saving does NOT make the whole render cheaper than before the
# feature — a third bar means one more make_bar and one more fmt_reset, and
# fmt_reset alone spawns several `date` processes. End to end the render is
# ~11% slower than the pre-FLY-1678 baseline (interleaved A/B, n=40). Hoisting
# fmt_reset's today/tomorrow lookups out of the per-call path would likely
# recover it for all three bars, but that means editing the shared 5h/7d code
# this change deliberately leaves untouched — left as a follow-up.
# Newline framing (not @tsv) because tab is IFS whitespace, so consecutive empty
# tab fields would silently collapse and shift every value left by one.
#
#   pct   — number in range, floored. `. + 0` after floor is not decoration:
#           JSON's signed zero stringifies as "-0", which the shell's digit guard
#           silently drops, so a bar would vanish with no error anywhere.
#   stamp — a complete UTC ISO instant, length-capped, ending at `\z`. UTC only
#           is not fussiness: fmt_reset does `${iso%%.*}` and hands the result to
#           `date -juf ... ` as if it were UTC, so a `+05:00` offset is silently
#           dropped and the bar shows a reset five hours off. Rejecting it renders
#           `?` instead — unknown beats confidently wrong. The API returns
#           `+00:00`, so real data is unaffected. `$` is NOT an
#           absolute anchor in jq's regex engine: it also matches before a final
#           newline, so `"...00Z\n"` passed and injected an extra record, which
#           shifted every field after it — measured as the model bar vanishing
#           and 7d rendering "reset ?". Control characters are rejected outright
#           as a second net, since the newline framing depends on their absence.
#   mname — sanitised by CODE POINT rather than by regex class so this source
#           stays reviewable: a literal bidi-override character in this file
#           would be invisible to the next reader. CJK and emoji names survive.
#           NB `label` is a reserved word in jq, hence `mname`.
u5="" u7="" r5="" r7="" s_name="" s_pct="" s_reset=""

# Worst-case bound on a per-frame command. The cache is written only by this
# script's own refresh and by the quota daemon, both straight from the usage API,
# and the real file is ~2 KB — so a megabyte here means something has gone wrong
# upstream, and parsing it on every frame of every pane would be the bigger
# problem. Skipping it degrades exactly like a missing cache: no second line.
CACHE_MAX_BYTES=1048576

if [ -f "$CACHE" ] && [ "$(wc -c < "$CACHE" 2>/dev/null || echo 0)" -le "$CACHE_MAX_BYTES" ]; then
  # Model-scoped weekly limit (FLY-1678). The response already carries it:
  #   {"kind":"weekly_scoped","percent":90,
  #    "scope":{"model":{"display_name":"Fable"}}, ...}
  # so the third bar costs no extra API call. The label comes from the payload
  # rather than being hard-coded — printing someone else's number under the name
  # "Fable" is precisely the failure this avoids.
  #
  # Three separate bounds keep worst-case work off the hot path, because
  # `first(...)` alone only helps when a VALID entry comes early — an array that
  # is all-invalid, or valid only at the end, still walks every element:
  #   * at most 200 candidate entries are considered (real responses carry 3);
  #   * the raw label is truncated before `explode`, so a megabyte-long name is
  #     never expanded into a million-element array;
  #   * the sanitised label is computed ONCE per candidate, not once per use.
  cache_fields=$(jq -r '
    def pct($v): if ($v|type)=="number" and $v>=0 and $v<=100000
                 then ($v|floor|. + 0|tostring) else "" end;
    def stamp($v): if ($v|type)=="string" and ($v|length)<=64
                      and (($v|test("[[:cntrl:]]")) | not)
                      and ($v|test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?([Zz]|[+-]00:?00)\\z"))
                   then $v else "" end;
    # Unicode Default_Ignorable_Code_Point plus the bidi controls and the
    # line/paragraph separators: all of them can make a label render as blank or
    # visually reordered without ever being a control byte.
    def ignorable($c):
      $c == 173                              # U+00AD    soft hyphen
      or $c == 847                           # U+034F    combining grapheme joiner
      or $c == 1564                          # U+061C    arabic letter mark
      or ($c >= 4447 and $c <= 4448)         # U+115F..  hangul fillers
      or ($c >= 6068 and $c <= 6069)         # U+17B4..  khmer inherent vowels
      or ($c >= 6155 and $c <= 6159)         # U+180B..  mongolian variation selectors
      or ($c >= 8203 and $c <= 8207)         # U+200B..  zero-width, LRM, RLM
      or ($c >= 8232 and $c <= 8238)         # U+2028..  separators, bidi overrides
      or ($c >= 8288 and $c <= 8303)         # U+2060..  invisible operators
      or $c == 12644                         # U+3164    hangul filler
      or ($c >= 65024 and $c <= 65039)       # U+FE00..  variation selectors
      or $c == 65279                         # U+FEFF    BOM
      or $c == 65440                         # U+FFA0    halfwidth hangul filler
      or ($c >= 65520 and $c <= 65528)       # U+FFF0..  unassigned specials
      or ($c >= 113824 and $c <= 113827)     # U+1BCA0.. shorthand format controls
      or ($c >= 119155 and $c <= 119162)     # U+1D173.. musical formatting
      or ($c >= 917504 and $c <= 921599);    # U+E0000.. tags, variation selectors supplement
    # Unicode White_Space beyond ASCII: a label of U+00A0 / U+3000 and friends is
    # not empty, not a control, and not default-ignorable, yet it renders as a
    # blank label above a live quota bar. Normalised to plain spaces so the trim
    # and the non-empty check below can actually see it.
    def unicode_space($c):
      $c == 160                              # U+00A0 no-break space
      or $c == 5760                          # U+1680 ogham space mark
      or ($c >= 8192 and $c <= 8202)         # U+2000..U+200A en/em/thin spaces
      or $c == 8239                          # U+202F narrow no-break space
      or $c == 8287                          # U+205F medium mathematical space
      or $c == 12288;                        # U+3000 ideographic space
    def mname($raw):
      ($raw | .[0:64] | explode
       | map(if   (. < 32)                then 32   # C0 controls
             elif (. >= 127 and . <= 159) then 32   # DEL + C1 controls
             elif (. == 92)               then 32   # backslash
             elif ignorable(.)            then 32
             elif unicode_space(.)        then 32   # so the trim below can see it
             else . end)
       | implode
       | sub("^ +";"") | sub(" +$";"") | .[0:16]);
    def scoped:
      first(
        (if (.limits|type)=="array" then .limits[0:200][] else empty end)
        | select(type=="object")
        | select((.scope|type)=="object" and (.scope.model|type)=="object")
        | select((.scope.model.display_name|type)=="string")
        | . as $e
        | (mname($e.scope.model.display_name)) as $n
        | select(($n|length) > 0)
        | select(($e.percent|type)=="number" and $e.percent>=0 and $e.percent<=100)
        | [ $n, ($e.percent|floor|. + 0|tostring), stamp($e.resets_at) ]
      ) // ["","",""];
    scoped as $m
    | pct(.five_hour.utilization), pct(.seven_day.utilization),
      stamp(.five_hour.resets_at), stamp(.seven_day.resets_at),
      $m[0], $m[1], $m[2]' "$CACHE" 2>/dev/null)

  # Every field is either empty or free of newlines by construction above, so
  # line position is a reliable index. `<<EOF` rather than a pipeline keeps the
  # assignments in THIS shell.
  {
    IFS= read -r u5; IFS= read -r u7
    IFS= read -r r5; IFS= read -r r7
    IFS= read -r s_name; IFS= read -r s_pct; IFS= read -r s_reset
  } <<EOF
$cache_fields
EOF
fi

# Background refresh — single attempt, no token refresh
refresh_cache() {
  if [ -f "$LOCK" ]; then
    lock_age=$(( $(date +%s) - $(stat -f %m "$LOCK" 2>/dev/null || echo 0) ))
    [ "$lock_age" -lt 120 ] && return
  fi
  (
    touch "$LOCK"
    trap 'rm -f "$LOCK"' EXIT

    token=$(security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null | jq -r '.claudeAiOauth.accessToken // empty' 2>/dev/null)
    [ -z "$token" ] && exit 1

    resp=$(curl -sf -w "\n%{http_code}" \
      --connect-timeout 3 --max-time 5 \
      "https://api.anthropic.com/api/oauth/usage" \
      -H "Accept: application/json" \
      -H "Content-Type: application/json" \
      -H "Authorization: Bearer $token" \
      -H "anthropic-beta: oauth-2025-04-20" 2>/dev/null)

    http_code=$(echo "$resp" | tail -1)
    body=$(echo "$resp" | sed '$d')

    if [ "$http_code" = "200" ]; then
      echo "$body" | jq . > "$CACHE.tmp" 2>/dev/null && mv "$CACHE.tmp" "$CACHE"
    fi
    rm -f "$CACHE.tmp"
  ) &
}

if [ ! -f "$CACHE" ]; then
  refresh_cache
else
  cache_age=$(( $(date +%s) - $(stat -f %m "$CACHE" 2>/dev/null || echo 0) ))
  [ "$cache_age" -gt "$CACHE_MAX_AGE" ] && refresh_cache
fi

# --- Effort level from settings ---
effort=$(jq -r '.effortLevel // empty' "$HOME/.claude/settings.json" 2>/dev/null)
if [ -z "$effort" ]; then
  model_id=$(echo "$input" | jq -r '.model.id // ""')
  if echo "$model_id" | grep -qi "opus-4-6\|opus-4\.6"; then
    effort="medium"
  fi
fi

# === LINE 1: session info ===
printf "${DIM}%s${RST}" "$model"
if [ -n "$effort" ]; then
  case "$effort" in
    high)  effort_color="$RED" ;;
    medium|med) effort_color="$YELLOW" ;;
    low)   effort_color="$GREEN" ;;
    *)     effort_color="$DIM" ;;
  esac
  printf "${GRAY}/${RST}${effort_color}%s${RST}" "$effort"
fi
if [ -n "$agent_name" ]; then
  printf "${GRAY} | ${CYAN}⚡%s${RST}" "$agent_name"
fi
if [ -n "$worktree" ]; then
  printf "${GRAY} | ${GREEN}🌿%s${RST}" "$worktree"
fi
if [ -n "$email" ]; then
  printf "${GRAY} | ${MAGENTA}👤%s${RST}" "$email"
fi
printf "${GRAY} | ${RST}%s" "$cwd"
printf "${GRAY} | ${RST}"
pick_color "$ctx_pct"
printf "ctx %d%% " "$ctx_pct"
make_bar "$ctx_pct"
printf "${RST}"
echo ""

# === LINE 2: usage limits ===
if [ -n "$u5" ] && [ -n "$u7" ]; then
  u5i=${u5%.*}; u7i=${u7%.*}

  printf "${DIM}5h ${RST}"
  pick_color "$u5i"
  make_bar "$u5i"
  printf " %d%%${RST}" "$u5i"
  printf "${GRAY} reset $(fmt_reset "$r5")${RST}"

  printf "${GRAY}  |  ${RST}"

  printf "${DIM}7d ${RST}"
  pick_color "$u7i"
  make_bar "$u7i"
  printf " %d%%${RST}" "$u7i"
  printf "${GRAY} reset $(fmt_reset "$r7")${RST}"

  # Third bar: the model-scoped weekly limit, styled exactly like the two above.
  # Deliberately at most ONE — the founder asked for a third bar, and rendering
  # every future model limit would let the line grow without bound.
  # Nested inside the 5h/7d guard so a missing or rejected scoped entry leaves
  # the existing two bars byte-for-byte untouched.
  if [ -n "$s_name" ]; then
    case "$s_pct" in
      ''|*[!0-9]*) ;;   # jq already guarantees a decimal integer; belt and braces
      *)
        s_pcti=$((10#$s_pct))   # force base 10 in case a leading zero ever slips through

        # Constant format strings: API text is always an argument, never a
        # format, so a '%' or backslash in a model name stays inert.
        printf '%b  |  %b' "$GRAY" "$RST"
        printf '%b%s %b' "$DIM" "$s_name" "$RST"
        pick_color "$s_pcti"
        make_bar "$s_pcti"
        printf ' %d%%%b' "$s_pcti" "$RST"
        printf '%b reset %s%b' "$GRAY" "$(fmt_reset "$s_reset")" "$RST"
        ;;
    esac
  fi
  echo ""
fi
