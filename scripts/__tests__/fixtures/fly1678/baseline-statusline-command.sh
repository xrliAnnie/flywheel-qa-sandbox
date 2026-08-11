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

u5="" u7="" r5="" r7=""
if [ -f "$CACHE" ]; then
  u5=$(jq -r '.five_hour.utilization // empty' "$CACHE" 2>/dev/null)
  u7=$(jq -r '.seven_day.utilization // empty' "$CACHE" 2>/dev/null)
  r5=$(jq -r '.five_hour.resets_at // empty' "$CACHE" 2>/dev/null)
  r7=$(jq -r '.seven_day.resets_at // empty' "$CACHE" 2>/dev/null)
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
  echo ""
fi
