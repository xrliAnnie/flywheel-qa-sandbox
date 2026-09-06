#!/usr/bin/env bash
# FLY-2358 E1 · 真二进制:两个 `codex app-server --remote-control` 同时跑在【同一个 CODEX_HOME】里,
# 会不会被 app-server-control/app-server-startup.lock 互斥掉?
# ⛔ 零凭据:实验家里没有 auth.json,只有一份最小 config.toml;不碰 ~/.codex、不碰任何生产家。
# 用法: bash exp-two-appservers-one-home.sh [evidence-dir]
set -uo pipefail
EV="${1:-$(dirname "$0")/exp-evidence}"; mkdir -p "$EV"
ROOT="$(mktemp -d /tmp/f2358e1.XXXX)"          # socket 路径必须 <104 字节,所以放 /tmp 不放 scratchpad
HOME_A="$ROOT/shared"; mkdir -p "$HOME_A"
cat > "$HOME_A/config.toml" <<'TOML'
[features]
memories = true
TOML
BIN="$(command -v codex)"; "$BIN" --version | tee "$EV/e1-codex-version.txt"
start(){ # $1=tag
  CODEX_HOME="$HOME_A" "$BIN" app-server --remote-control --listen "unix://$ROOT/$1.sock" \
    >"$EV/e1-$1.out" 2>"$EV/e1-$1.err" & echo $!
}
PA=$(start a); PB=$(start b)
for i in $(seq 1 40); do [ -S "$ROOT/a.sock" ] && [ -S "$ROOT/b.sock" ] && break; sleep 0.25; done
sleep 6   # 给 startup lock task 足够时间互相撞
{
  echo "socket a: $([ -S "$ROOT/a.sock" ] && echo present || echo MISSING)"
  echo "socket b: $([ -S "$ROOT/b.sock" ] && echo present || echo MISSING)"
  echo "pid a alive: $(kill -0 "$PA" 2>/dev/null && echo yes || echo NO)"
  echo "pid b alive: $(kill -0 "$PB" 2>/dev/null && echo yes || echo NO)"
  echo "lock file: $(ls -la "$HOME_A/app-server-control/" 2>/dev/null | tail -n +2)"
  echo "stderr a (lock/already lines):"; grep -iE "lock|already|refus|exit" "$EV/e1-a.err" | head -5 || true
  echo "stderr b (lock/already lines):"; grep -iE "lock|already|refus|exit" "$EV/e1-b.err" | head -5 || true
  echo "home listing:"; ls -la "$HOME_A" | tail -n +2
} | tee "$EV/e1-result.txt"
# 尺子自检:同一个 socket 路径起第二个 ⇒ 必须失败(证明「起不来」这件事测得出来)
PC=$(CODEX_HOME="$HOME_A" "$BIN" app-server --remote-control --listen "unix://$ROOT/a.sock" >"$EV/e1-c.out" 2>"$EV/e1-c.err" & echo $!)
sleep 3
{ echo "negative control (same socket twice) pid c alive: $(kill -0 "$PC" 2>/dev/null && echo yes-UNEXPECTED || echo no-as-expected)"; head -3 "$EV/e1-c.err"; } | tee -a "$EV/e1-result.txt"
kill "$PA" "$PB" "$PC" 2>/dev/null; wait 2>/dev/null
rm -rf "$ROOT"
