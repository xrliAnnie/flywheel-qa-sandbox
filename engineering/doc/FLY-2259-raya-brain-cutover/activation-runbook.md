# FLY-2259 Raya 脑迁入受管常驻体制 — 激活操作手册
Issue: FLY-2259 (https://linear.app/geoforge3d/issue/FLY-2259/cutoverraya-raya-脑迁入受管常驻体制-补三样激活前提注册工作区summary样本pr激活新脑活了再退旧脑2239-的)
日期: 2026-09-03
基于: plan.md

> 本手册只供 flywheel PR 合入并由班车部署后，由 Tadashi 在 founder 在场的安静窗口手工执行。
> 实现/QA runner 不运行本文件里的生产命令。`com.xrli.raya.brain` 是产品语音/会议网关，始终保留；
> “退旧脑”按已裁方案 A 仅指退 `bin-raya-watch.sh` 与手拉 Raya Codex 会话。

所有代码块都在生产 Mac 的同一个 `/bin/bash` 中逐节执行。每次新开 shell 先重跑 §4.0 的变量块。
任一谓词失败时，不继续下一节；按 §4.11 从当前层逆序回滚。“停窗”指回滚验证已绿，不是只停手。

## 4.0 变量、前置物与开窗停止线

### 4.0.1 固定变量和证据目录

先由操作者填入本次真实值；URL 必须来自 FLY-2259 thread，PR 必须是 Tadashi 亲笔 summary PR。

```bash
set -euo pipefail
umask 077

export FLYWHEEL_REPO="$HOME/Dev/flywheel"
export MATERIALS="$FLYWHEEL_REPO/engineering/doc/FLY-2259-raya-brain-cutover/materials"
export WINDOW_ROOT="$HOME/.flywheel/state/FLY-2259-window"
export EVIDENCE="$WINDOW_ROOT/evidence-$(date -u +%Y%m%dT%H%M%SZ)"
export PROJECTS="$HOME/.flywheel/projects.json"
export RECEIPT="$HOME/.flywheel/state/summary-registry/migration-receipt.json"
export RAYA_ENV="$HOME/.flywheel/raya/raya.env"
export RAYA_SHARED_CONFIG="$HOME/.flywheel/raya/codex-home/config.toml"
export RAYA_PLIST="$HOME/Library/LaunchAgents/com.flywheel.lead.raya-raya.plist"
export RAYA_LABEL="com.flywheel.lead.raya-raya"
export PRODUCT_BRAIN_PLIST="$HOME/Library/LaunchAgents/com.xrli.raya.brain.plist"
export PRODUCT_VOICE_PLIST="$HOME/Library/LaunchAgents/com.xrli.raya.voice.plist"
export FLY2259_MERGE_SHA="REPLACE_WITH_40_HEX_MERGE_SHA"
export RAYA_SUMMARY_FIXTURE_PR="REPLACE_WITH_PR_NUMBER"
export FOUNDER_WINDOW_MESSAGE_URL="REPLACE_WITH_DISCORD_MESSAGE_URL"

case "$FLY2259_MERGE_SHA" in *[!a-fA-F0-9]*|'') echo "invalid FLY-2259 merge SHA" >&2; false ;; esac
[ "${#FLY2259_MERGE_SHA}" -eq 40 ]
case "$RAYA_SUMMARY_FIXTURE_PR" in ''|*[!0-9]*|0) echo "invalid summary PR" >&2; false ;; esac
case "$FOUNDER_WINDOW_MESSAGE_URL" in https://discord.com/channels/*) : ;; *) echo "founder window evidence URL is required" >&2; false ;; esac
[ -d "$FLYWHEEL_REPO/.git" ]
[ -f "$MATERIALS/projects.raya-row.json" ]
[ -f "$MATERIALS/assignments.json" ]
[ -f "$MATERIALS/register-codex-lead.py" ]
[ -f "$MATERIALS/edit-raya-env.py" ]
install -d -m 700 "$WINDOW_ROOT" "$EVIDENCE"
printf '%s\n' "$FOUNDER_WINDOW_MESSAGE_URL" >"$EVIDENCE/founder-window-message.url"
```

### 4.0.2 窗口前由 founder 完成独立登录，由 operator 安装同版 standalone

登录必须由 founder 在自己的终端执行；不得复制任何其它 home 的 `auth.json`。

```bash
install -d -m 700 "$HOME/.codex-raya"
CODEX_HOME="$HOME/.codex-raya" codex login
CODEX_HOME="$HOME/.codex-raya" codex login status | tee "$EVIDENCE/codex-login-status.txt"
grep -Fq 'Logged in using ChatGPT' "$EVIDENCE/codex-login-status.txt"
[ "$(stat -f '%Lp %Su' "$HOME/.codex-raya/auth.json")" = '600 xiaorongli' ]
```

安装前后保存全局 Codex link；版本以窗口当刻的 Mufasa/InfraBot 为准，不写死版本号。

```bash
readlink "$HOME/.local/bin/codex" >"$EVIDENCE/global-codex-link.before"
CODEX_HOME="$HOME/.codex-raya" CODEX_INSTALL_DIR="$HOME/.codex-raya/.local/bin" \
  sh -c 'curl -fsSL https://chatgpt.com/codex/install.sh | sh'
readlink "$HOME/.local/bin/codex" >"$EVIDENCE/global-codex-link.after"
cmp "$EVIDENCE/global-codex-link.before" "$EVIDENCE/global-codex-link.after"
"$HOME/.codex-raya/packages/standalone/current/codex" -V >"$EVIDENCE/raya-codex-version.txt"
"$HOME/.codex-mufasa/packages/standalone/current/codex" -V >"$EVIDENCE/mufasa-codex-version.txt"
"$HOME/.codex-infra-bot/packages/standalone/current/codex" -V >"$EVIDENCE/infra-bot-codex-version.txt"
cmp "$EVIDENCE/raya-codex-version.txt" "$EVIDENCE/mufasa-codex-version.txt"
cmp "$EVIDENCE/raya-codex-version.txt" "$EVIDENCE/infra-bot-codex-version.txt"
```

Tadashi 亲笔 summary 已存在且机械核验通过。这里不生成、更新或 merge summary。

```bash
FLYWHEEL_SUMMARY_GRANULARITY=per-lead \
  node "$FLYWHEEL_REPO/packages/flywheel-comm/dist/index.js" summary verify-pr \
  --repo xrliAnnie/raya --pr "$RAYA_SUMMARY_FIXTURE_PR" \
  | tee "$EVIDENCE/summary-verify-pr.json"
jq -e '.verifiedHeadSha | type == "string" and test("^[a-fA-F0-9]{40}$")' \
  "$EVIDENCE/summary-verify-pr.json" >/dev/null
```

### 4.0.3 时窗、部署、覆盖与残留停止线

00:00/12:00 PT 前后 30 分钟不开窗；下式任一退出非零即停止。

```bash
python3 - <<'PY'
from datetime import datetime
minute = datetime.now().hour * 60 + datetime.now().minute
for center in (0, 12 * 60, 24 * 60):
    if abs(minute - center) <= 30:
        raise SystemExit("inside the restart-bus exclusion window")
PY

deployed_sha="$(cat "$HOME/.flywheel/deployed-sha")"
git -C "$FLYWHEEL_REPO" merge-base --is-ancestor "$FLY2259_MERGE_SHA" "$deployed_sha"
[ "$(git -C "$FLYWHEEL_REPO" rev-parse HEAD)" = "$deployed_sha" ]
grep -Fq 'derive_codex_lead_home' "$FLYWHEEL_REPO/packages/teamlead/scripts/run-codex-lead-raya-tui-fullaccess.sh"
grep -Fq 'derive_codex_lead_home' "$FLYWHEEL_REPO/scripts/resident-codex-lead-recover.sh"
grep -Fq 'derive_codex_lead_home' "$HOME/.flywheel/bin/resident-codex-lead-recover.sh"
cmp "$FLYWHEEL_REPO/scripts/lib/lead-address.sh" "$HOME/.flywheel/bin/lib/lead-address.sh"

[ "$(grep -cE '^(CODEX_HOME|FLYWHEEL_CODEX_BIN)=' "$HOME/.flywheel/.env" || true)" -eq 0 ]
[ -z "$(launchctl getenv CODEX_HOME)" ]
[ -z "$(launchctl getenv FLYWHEEL_CODEX_BIN)" ]

for residue in \
  "$HOME/.flywheel/manifests/raya-raya.json" \
  "$HOME/Library/LaunchAgents/com.flywheel.lead.raya-raya.plist" \
  "$HOME/Library/LaunchAgents/com.flywheel.lead.raya-raya.tui.plist" \
  "$HOME/.flywheel/state/codex-lead/raya" \
  "$HOME/.flywheel/logs/lead-raya-raya.log" \
  "$HOME/Dev/raya-lead-workspace/memory" \
  "$HOME/.flywheel/raya/retired-2259/bin-raya-watch.sh"; do
  [ ! -e "$residue" ] && [ ! -L "$residue" ] || { echo "residue blocks window: $residue" >&2; false; }
done

jq -e '[.[] | select(.projectName == "raya")] | length == 0' "$PROJECTS" >/dev/null
if launchctl print "gui/$(id -u)/$RAYA_LABEL" >"$EVIDENCE/raya-launchd.before" 2>&1; then
  echo "Raya Lead already loaded" >&2
  false
fi
[ -z "$(git -C "$HOME/.flywheel/raya/memory" status --porcelain)" ]

brain_out="$(launchctl print "gui/$(id -u)/com.xrli.raya.brain")"
grep -qE '^[[:space:]]*state = running' <<<"$brain_out"
[ "$(grep -cE '^[[:space:]]*pid = [0-9]+' <<<"$brain_out")" -eq 1 ]
voice_out="$(launchctl print "gui/$(id -u)/com.xrli.raya.voice")"
grep -qE '^[[:space:]]*state = not running' <<<"$voice_out"
[ ! -e "$HOME/.flywheel/raya/data/metrics/run/voice.pid" ]
```

存量两位 Codex Lead 必须仍在线、心跳推进、运行时 home 字节不变。

```bash
MUFASA_HB="$HOME/.flywheel/state/codex-lead/mufasa-lead/brain/heartbeat.json"
INFRA_HB="$HOME/.flywheel/state/codex-lead/codex-infra-bot-lead/brain/heartbeat.json"
m1="$(jq -er '.updatedAt' "$MUFASA_HB")"; i1="$(jq -er '.updatedAt' "$INFRA_HB")"
jq -e '.state == "online"' "$MUFASA_HB" >/dev/null
jq -e '.state == "online"' "$INFRA_HB" >/dev/null
sleep 10
m2="$(jq -er '.updatedAt' "$MUFASA_HB")"; i2="$(jq -er '.updatedAt' "$INFRA_HB")"
[ "$m1" != "$m2" ] || { echo "Mufasa heartbeat did not advance" >&2; false; }
[ "$i1" != "$i2" ] || { echo "InfraBot heartbeat did not advance" >&2; false; }

mufasa_out="$(launchctl print "gui/$(id -u)/com.flywheel.lead.growth-mufasa-lead")"
infra_out="$(launchctl print "gui/$(id -u)/com.flywheel.lead.flywheel-codex-infra-bot-lead")"
mufasa_pid="$(awk '/^[[:space:]]*pid = [0-9]+[[:space:]]*$/ {print $3}' <<<"$mufasa_out")"
infra_pid="$(awk '/^[[:space:]]*pid = [0-9]+[[:space:]]*$/ {print $3}' <<<"$infra_out")"
case "$mufasa_pid:$infra_pid" in *[!0-9:]*|:|*:|0:*|*:0) echo "invalid existing Lead pid" >&2; false ;; esac
LC_ALL=C ps eww -p "$mufasa_pid" -o command= | tr ' ' '\n' | grep -Fxq "CODEX_HOME=$HOME/.codex-mufasa"
LC_ALL=C ps eww -p "$infra_pid" -o command= | tr ' ' '\n' | grep -Fxq "CODEX_HOME=$HOME/.codex-infra-bot"
```

assignments 物料必须与窗口当刻回执一致，仅多一条 `raya/raya=recipient`；managed registry 键集也必须闭合。

```bash
jq -S '.assignments | sort_by(.projectName,.leadId)' "$RECEIPT" >"$EVIDENCE/assignments.live.json"
jq -S '.assignments | map(select(.projectName != "raya" or .leadId != "raya")) | sort_by(.projectName,.leadId)' \
  "$MATERIALS/assignments.json" >"$EVIDENCE/assignments.material-existing.json"
cmp "$EVIDENCE/assignments.live.json" "$EVIDENCE/assignments.material-existing.json"
jq -S '.projectAggregators | sort_by(.projectName,.leadId)' "$RECEIPT" >"$EVIDENCE/aggregators.live.json"
jq -S '.projectAggregators | sort_by(.projectName,.leadId)' "$MATERIALS/assignments.json" >"$EVIDENCE/aggregators.material.json"
cmp "$EVIDENCE/aggregators.live.json" "$EVIDENCE/aggregators.material.json"

jq -r '.[] | .projectName as $p | (.leads // [])[] | select(.botTokenEnv != null) | "\($p)/\(.agentId)"' "$PROJECTS" \
  | { cat; printf '%s\n' 'raya/raya'; } | LC_ALL=C sort -u >"$EVIDENCE/managed-keys.live-plus-raya"
jq -r '.assignments[] | "\(.projectName)/\(.leadId)"' "$MATERIALS/assignments.json" \
  | LC_ALL=C sort -u >"$EVIDENCE/managed-keys.material"
cmp "$EVIDENCE/managed-keys.live-plus-raya" "$EVIDENCE/managed-keys.material"
```

### 4.0.4 备份、T0 产品身份与重启物

```bash
for source in "$PROJECTS" "$RECEIPT" "$RAYA_ENV" "$RAYA_SHARED_CONFIG"; do
  [ -f "$source" ] || { echo "backup source is not a regular file: $source" >&2; false; }
  [ -r "$source" ] || { echo "backup source is not readable: $source" >&2; false; }
  [ ! -L "$source" ] || { echo "backup source must not be a symlink: $source" >&2; false; }
  cp -p "$source" "$EVIDENCE/$(basename "$source").before"
done
[ "$(stat -f %Lp "$RAYA_ENV")" = 600 ]

for plist in "$PRODUCT_BRAIN_PLIST" "$PRODUCT_VOICE_PLIST"; do
  [ -f "$plist" ] || { echo "product plist is not a regular file: $plist" >&2; false; }
  [ -r "$plist" ] || { echo "product plist is not readable: $plist" >&2; false; }
  [ ! -L "$plist" ] || { echo "product plist must not be a symlink: $plist" >&2; false; }
  plutil -lint "$plist"
  node_path="$(plutil -extract ProgramArguments.0 raw "$plist")"
  entry_path="$(plutil -extract ProgramArguments.1 raw "$plist")"
  [ -x "$node_path" ] || { echo "product node is not executable: $node_path" >&2; false; }
  [ -r "$entry_path" ] || { echo "product entry is not readable: $entry_path" >&2; false; }
done

brain_out="$(launchctl print "gui/$(id -u)/com.xrli.raya.brain")"
old_pid="$(awk '/^[[:space:]]*pid = [0-9]+[[:space:]]*$/ {print $3}' <<<"$brain_out")"
[ "$(grep -cE '^[[:space:]]*pid = [0-9]+' <<<"$brain_out")" -eq 1 ]
old_lstart="$(LC_ALL=C ps -p "$old_pid" -o lstart= | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
[ -n "$old_lstart" ]
cp -p "$PRODUCT_BRAIN_PLIST" "$EVIDENCE/com.xrli.raya.brain.plist.before"
brain_plist_sha="$(shasum -a 256 "$PRODUCT_BRAIN_PLIST" | awk '{print $1}')"
brain_plist_mode="$(stat -f %Lp "$PRODUCT_BRAIN_PLIST")"
jq -cn --argjson pid "$old_pid" --arg lstart "$old_lstart" \
  --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg sha "$brain_plist_sha" --arg mode "$brain_plist_mode" \
  '{pid:$pid,lstart:$lstart,at:$at,brainPlistSha256:$sha,brainPlistMode:$mode}' \
  >"$EVIDENCE/product-brain.T0.json"
chmod 600 "$EVIDENCE/product-brain.T0.json"

for source in "$PROJECTS" "$RECEIPT" "$RAYA_ENV" "$RAYA_SHARED_CONFIG" "$PRODUCT_BRAIN_PLIST"; do
  printf '%s %s %s\n' "$(shasum -a 256 "$source" | awk '{print $1}')" "$(stat -f %Lp "$source")" "$source"
done >"$EVIDENCE/pre-window-sha-mode.txt"
```

## 4.1 ① 注册：持锁、原子、通用 registrar

本节使用 `register-codex-lead.py`；§4.3 的校验入口是 `edit-raya-env.py --verify`。

```bash
bash "$FLYWHEEL_REPO/scripts/flywheel-config-lock.sh" "$PROJECTS.cfglock" 5 \
  python3 "$MATERIALS/register-codex-lead.py" "$PROJECTS" "$MATERIALS/projects.raya-row.json"
cp -p "$PROJECTS" "$EVIDENCE/projects.after-register.json"
node "$FLYWHEEL_REPO/packages/flywheel-comm/dist/index.js" lead-identity resolve \
  --projects-file "$PROJECTS" --project raya --lead raya --format json \
  | tee "$EVIDENCE/raya-identity.json"
jq -e '
  .role == "cos" and .botUserId == "1542068543645024257" and
  .model == "gpt-5.6-sol" and .effort == "xhigh" and
  .modelContextWindow == 1000000 and .summaryRole == "recipient" and
  .hasSummaryDuty == false and
  (.summaryGranularity == "per-lead" or .summaryGranularity == "per-project")
' "$EVIDENCE/raya-identity.json" >/dev/null
```

失败执行 §4.11 R1 — registry + receipt。

## 4.2 ⑤ 同事务刷新 summary registry 回执

不得在 §4.1 与本节之间跨班车边界。

```bash
bash "$FLYWHEEL_REPO/scripts/migrate-summary-registry.sh" "$PROJECTS" \
  "$MATERIALS/assignments.json" "$RECEIPT" \
  "$(shasum -a 256 "$PROJECTS" | awk '{print $1}')"
cmp "$PROJECTS" "$EVIDENCE/projects.after-register.json"
(
  cd "$FLYWHEEL_REPO"
  TMPDIR=/tmp pnpm exec tsx packages/flywheel-comm/src/bin/summary-registry.ts verify-activation \
    --projects-file "$PROJECTS" --receipt-file "$RECEIPT"
) | tee "$EVIDENCE/summary-registry.verify.json"
jq -e '.ok == true and .granularity == "per-lead"' "$EVIDENCE/summary-registry.verify.json" >/dev/null
```

失败执行 §4.11 R1 — registry + receipt。

## 4.3 ② 工作区与 raya.env：唯一产品窗口步骤

再次证明产品 T0 未换代、brain plist 未漂移，再停、搬、改、preflight、起。语音在会话中时绝不执行。

```bash
old_pid="$(jq -er '.pid' "$EVIDENCE/product-brain.T0.json")"
old_lstart="$(jq -er '.lstart' "$EVIDENCE/product-brain.T0.json")"
brain_out="$(launchctl print "gui/$(id -u)/com.xrli.raya.brain")"
grep -qE '^[[:space:]]*state = running' <<<"$brain_out"
[ "$(grep -cE '^[[:space:]]*pid = [0-9]+' <<<"$brain_out")" -eq 1 ]
[ "$(awk '/^[[:space:]]*pid = [0-9]+[[:space:]]*$/ {print $3}' <<<"$brain_out")" = "$old_pid" ]
[ "$(LC_ALL=C ps -p "$old_pid" -o lstart= | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')" = "$old_lstart" ]
[ "$(shasum -a 256 "$PRODUCT_BRAIN_PLIST" | awk '{print $1}')" = "$(jq -er '.brainPlistSha256' "$EVIDENCE/product-brain.T0.json")" ]
[ "$(stat -f %Lp "$PRODUCT_BRAIN_PLIST")" = "$(jq -er '.brainPlistMode' "$EVIDENCE/product-brain.T0.json")" ]
voice_out="$(launchctl print "gui/$(id -u)/com.xrli.raya.voice")"
grep -qE '^[[:space:]]*state = not running' <<<"$voice_out"
[ ! -e "$HOME/.flywheel/raya/data/metrics/run/voice.pid" ]

launchctl bootout "gui/$(id -u)/com.xrli.raya.brain"
for _ in $(seq 1 30); do kill -0 "$old_pid" 2>/dev/null || break; sleep 1; done
! kill -0 "$old_pid" 2>/dev/null
! launchctl print "gui/$(id -u)/com.xrli.raya.brain" >/dev/null 2>&1

set +e
lsof_out="$(/usr/sbin/lsof +D "$HOME/.flywheel/raya/memory" 2>"$EVIDENCE/lsof.stderr")"
lsof_rc=$?
set -e
printf '%s\n' "$lsof_out" >"$EVIDENCE/lsof.stdout"
printf 'rc=%s\n' "$lsof_rc" >"$EVIDENCE/lsof.rc"
[ "$lsof_rc" -eq 1 ] || { echo "lsof returned unexpected rc: $lsof_rc" >&2; false; }
[ -z "$lsof_out" ] || { echo "Raya memory still has open files" >&2; false; }
[ ! -s "$EVIDENCE/lsof.stderr" ] || { echo "lsof inspection emitted stderr" >&2; false; }

install -d -m 700 "$HOME/Dev/raya-lead-workspace" "$HOME/Dev/raya-lead-workspace/state"
[ ! -e "$HOME/Dev/raya-lead-workspace/memory" ] || { echo "memory destination already exists" >&2; false; }
[ ! -L "$HOME/Dev/raya-lead-workspace/memory" ] || { echo "memory destination is a symlink" >&2; false; }
mv "$HOME/.flywheel/raya/memory" "$HOME/Dev/raya-lead-workspace/memory"
[ -r "$HOME/Dev/raya-lead-workspace/memory/MEMORY.md" ]
[ ! -e "$HOME/.flywheel/raya/memory" ]

python3 "$MATERIALS/edit-raya-env.py" "$RAYA_ENV" \
  'RAYA_MEMORY_FILE=/Users/xiaorongli/Dev/raya-lead-workspace/memory/MEMORY.md' \
  'RAYA_WORKSPACE_ROOTS_JSON=["/Users/xiaorongli/.flywheel/raya/code","/Users/xiaorongli/Dev/raya-lead-workspace/memory"]'
python3 "$MATERIALS/edit-raya-env.py" --verify "$EVIDENCE/raya.env.before" "$RAYA_ENV"
diff "$EVIDENCE/raya.env.before" "$RAYA_ENV" >"$EVIDENCE/raya.env.diff" || true

brain_node="$(plutil -extract ProgramArguments.0 raw "$PRODUCT_BRAIN_PLIST")"
brain_entry="$(plutil -extract ProgramArguments.1 raw "$PRODUCT_BRAIN_PLIST")"
voice_node="$(plutil -extract ProgramArguments.0 raw "$PRODUCT_VOICE_PLIST")"
voice_entry="$(plutil -extract ProgramArguments.1 raw "$PRODUCT_VOICE_PLIST")"
env -i HOME="$HOME" PATH=/usr/bin:/bin:/usr/sbin:/sbin \
  RAYA_ENV_FILE=/Users/xiaorongli/.flywheel/raya/raya.env "$brain_node" "$brain_entry" preflight
env -i HOME="$HOME" PATH=/usr/bin:/bin:/usr/sbin:/sbin \
  RAYA_ENV_FILE=/Users/xiaorongli/.flywheel/raya/raya.env "$voice_node" "$voice_entry" preflight

launchctl bootstrap "gui/$(id -u)" "$PRODUCT_BRAIN_PLIST"
for _ in $(seq 1 30); do
  brain_out="$(launchctl print "gui/$(id -u)/com.xrli.raya.brain" 2>/dev/null || true)"
  grep -qE '^[[:space:]]*state = running' <<<"$brain_out" && break
  sleep 1
done
grep -qE '^[[:space:]]*state = running' <<<"$brain_out"
[ "$(grep -cE '^[[:space:]]*pid = [0-9]+' <<<"$brain_out")" -eq 1 ]
new_pid="$(awk '/^[[:space:]]*pid = [0-9]+[[:space:]]*$/ {print $3}' <<<"$brain_out")"
[ "$new_pid" != "$old_pid" ]
sleep 5
BLOG="$HOME/.flywheel/raya/data/logs/brain.stderr.log"
[ -f "$BLOG" ] || { echo "brain stderr log is not a regular file" >&2; false; }
[ -r "$BLOG" ] || { echo "brain stderr log is not readable" >&2; false; }
[ ! -L "$BLOG" ] || { echo "brain stderr log must not be a symlink" >&2; false; }
tail -n 20 "$BLOG" >"$EVIDENCE/brain.stderr.post-restart.log"
[ "$(grep -vF 'RAYA_MEETING_SHARED_CHANNEL_ID is not configured' "$EVIDENCE/brain.stderr.post-restart.log" \
  | grep -ciE 'error|invalid|missing|ENOENT' || true)" -eq 0 ]
```

失败执行 §4.11 R2 — product workspace + env，然后 R1。

## 4.4 只读 activation preflight 与有效 home

```bash
RAYA_SUMMARY_FIXTURE_PR="$RAYA_SUMMARY_FIXTURE_PR" \
RAYA_LEAD_WORKSPACE=/Users/xiaorongli/Dev/raya-lead-workspace \
  bash "$FLYWHEEL_REPO/packages/teamlead/scripts/raya-activation-preflight.sh" \
  | tee "$EVIDENCE/raya-activation-preflight.log"
tail -n 1 "$EVIDENCE/raya-activation-preflight.log" \
  | grep -Fxq '[raya-activation-preflight] PASS: summary latch, canonical identity, workspace, and TUI launcher'

bash -c 'set -a; source "$HOME/.flywheel/.env"; set +a; FLYWHEEL_LEAD_DRY_RUN=1 \
  FLYWHEEL_TEAMLEAD_ROOT="$HOME/Dev/flywheel/packages/teamlead" \
  RAYA_LEAD_WORKSPACE=/Users/xiaorongli/Dev/raya-lead-workspace \
  bash "$HOME/Dev/flywheel/packages/teamlead/scripts/run-codex-lead-raya-tui-fullaccess.sh"' \
  >"$EVIDENCE/launcher-dryrun.txt"
home_line="$(grep -F 'CODEX_HOME    : ' "$EVIDENCE/launcher-dryrun.txt")"
[ "$(grep -c '' <<<"$home_line")" -eq 1 ]
[ "${home_line#CODEX_HOME    : }" = '/Users/xiaorongli/.codex-raya (isolated per-Lead — not the host ~/.codex)' ]
bin_line="$(grep -F 'codex bin     : ' "$EVIDENCE/launcher-dryrun.txt")"
[ "${bin_line#codex bin     : }" = '/Users/xiaorongli/.codex-raya/packages/standalone/current/codex' ]
grep -qF 'spawn cmd     : CODEX_HOME=/Users/xiaorongli/.codex-raya /Users/xiaorongli/.codex-raya/packages/standalone/current/codex app-server' \
  "$EVIDENCE/launcher-dryrun.txt"
[ "$(grep -cE '^(CODEX_HOME|FLYWHEEL_CODEX_BIN)=' "$HOME/.flywheel/.env" || true)" -eq 0 ]
[ -z "$(launchctl getenv CODEX_HOME)" ]
[ -z "$(launchctl getenv FLYWHEEL_CODEX_BIN)" ]
```

失败执行 §4.11 R2 — product workspace + env，然后 R1；不得改 preflight 绕过。

## 4.5 converge 与唯一 manifest

converge 必须从已部署的主 checkout 运行。`PIPESTATUS` 必须整数组一次捕获；即使 materializer 失败，
也必须先写 after 快照供 R3 回滚。

```bash
bash "$FLYWHEEL_REPO/scripts/converge-flywheel-bin.sh" | tee "$EVIDENCE/converge.log"
cmp "$FLYWHEEL_REPO/scripts/flywheel-codex-lead-wrapper-raya-tui-fullaccess.sh" \
  "$HOME/.flywheel/bin/flywheel-codex-lead-wrapper-raya-tui-fullaccess.sh"
cmp "$FLYWHEEL_REPO/scripts/resident-codex-lead-recover.sh" \
  "$HOME/.flywheel/bin/resident-codex-lead-recover.sh"
[ "$(stat -f %Lp "$HOME/.flywheel/bin/flywheel-codex-lead-wrapper-raya-tui-fullaccess.sh")" = 555 ]
grep -Fq 'derive_codex_lead_home' "$HOME/.flywheel/bin/resident-codex-lead-recover.sh"
cmp "$FLYWHEEL_REPO/scripts/lib/lead-address.sh" "$HOME/.flywheel/bin/lib/lead-address.sh"
grep -Fq 'derive_codex_lead_home' "$HOME/.flywheel/bin/lib/lead-address.sh"

[ ! -e "$HOME/.flywheel/manifests/raya-raya.json" ]
jq -r '.[] | .projectName as $p | .leads[] | "\($p)-\(.agentId)"' "$PROJECTS" \
  | grep -vx 'raya-raya' | while read -r key; do
      [ -f "$HOME/.flywheel/manifests/$key.json" ] || { echo "missing manifest: $key" >&2; false; }
    done
ls "$HOME"/.flywheel/manifests/*.json | sort >"$EVIDENCE/manifests.before"

set +e
bash "$FLYWHEEL_REPO/scripts/materialize-lead-manifests.sh" | tee "$EVIDENCE/materialize.log"
pipe_rc=("${PIPESTATUS[@]}")
set -e
[ "${#pipe_rc[@]}" -eq 2 ]
mat_rc="${pipe_rc[0]}"; tee_rc="${pipe_rc[1]}"
ls "$HOME"/.flywheel/manifests/*.json | sort >"$EVIDENCE/manifests.after"
printf 'materialize_rc=%s tee_rc=%s\n' "$mat_rc" "$tee_rc" >"$EVIDENCE/materialize.rc"
[ "$mat_rc" -eq 0 ] || { echo "manifest materializer failed: rc=$mat_rc" >&2; false; }
[ "$tee_rc" -eq 0 ] || { echo "manifest evidence tee failed: rc=$tee_rc" >&2; false; }
[ "$(grep -c '^materialize: wrote ' "$EVIDENCE/materialize.log")" -eq 1 ]
grep -qF "materialize: wrote $HOME/.flywheel/manifests/raya-raya.json" "$EVIDENCE/materialize.log"
[ "$(comm -13 "$EVIDENCE/manifests.before" "$EVIDENCE/manifests.after")" = "$HOME/.flywheel/manifests/raya-raya.json" ]
jq -e --arg home "$HOME" '
  .projectName == "raya" and .leadId == "raya" and
  .projectDir == ($home + "/Dev/raya-lead-workspace") and .workspace == .projectDir and
  .projectsFile == ($home + "/.flywheel/projects.json") and
  .leadBackend.backendId == "codex-app-server"
' "$HOME/.flywheel/manifests/raya-raya.json" >/dev/null
```

converge 若发 `bin_integrity_drift`，记录其 Discord 链接；若未发，保存 adoption marker 内容。它不是失败条件。
本节任一硬谓词失败执行 §4.11 R3 — manifest，然后 R2、R1。

## 4.6 plist 正名与首次出生

```bash
[ ! -e "$RAYA_PLIST" ] || { echo "Raya plist destination already exists" >&2; false; }
[ ! -L "$RAYA_PLIST" ] || { echo "Raya plist destination is a symlink" >&2; false; }
[ ! -e "$HOME/Library/LaunchAgents/com.flywheel.lead.raya-raya.tui.plist" ]
cp "$FLYWHEEL_REPO/packages/teamlead/scripts/templates/com.flywheel.lead.raya-raya.tui.plist" "$RAYA_PLIST"
[ ! -e "$HOME/Library/LaunchAgents/com.flywheel.lead.raya-raya.tui.plist" ]
plutil -lint "$RAYA_PLIST"
LOG="$HOME/.flywheel/logs/lead-raya-raya.log"
[ ! -e "$LOG" ] || { echo "Raya log destination already exists" >&2; false; }
[ ! -L "$LOG" ] || { echo "Raya log destination is a symlink" >&2; false; }
launchctl bootstrap "gui/$(id -u)" "$RAYA_PLIST"
for _ in $(seq 1 60); do
  raya_out="$(launchctl print "gui/$(id -u)/$RAYA_LABEL" 2>/dev/null || true)"
  if grep -qE '^[[:space:]]*state = running' <<<"$raya_out" \
    && [ -f "$LOG" ] && grep -qF 'tui-window: real TUI up (raya-raya' "$LOG"; then break; fi
  sleep 2
done
grep -qE '^[[:space:]]*state = running' <<<"$raya_out"
[ "$(grep -cE '^[[:space:]]*pid = [0-9]+' <<<"$raya_out")" -eq 1 ]
grep -qF 'WINDOWED FULL-ACCESS' "$LOG"
grep -qF 'tui-window: real TUI up (raya-raya' "$LOG"
! grep -Fq 'guard DISABLED' "$LOG"
! grep -Fq 'standalone codex install missing' "$LOG"
! grep -Fq 'auth.json missing' "$LOG"
[ -f "$HOME/.codex-raya/config.toml" ]
grep -Fq '[mcp_servers.lead_actions]' "$HOME/.codex-raya/config.toml"
cp -p "$LOG" "$EVIDENCE/lead-raya-raya.first-start.log"
```

失败立刻执行 §4.11 R4 — carrier birth，然后 R3、R2、R1。不得让 KeepAlive 30 秒循环刷告警。

## 4.7 “活了”：pid、pane、heartbeat、exact probe、消息

本节的只读恢复探针接口是 `resident-codex-lead-recover.sh --project raya --lead raya --probe`。

```bash
tmux -L default capture-pane -p -t flywheel:raya-raya >"$EVIDENCE/raya-pane.txt"
grep -Fq 'codex' "$EVIDENCE/raya-pane.txt"
HB="$HOME/.flywheel/state/codex-lead/raya/brain/heartbeat.json"
LIFECYCLE="$HOME/.flywheel/state/codex-lead/raya/brain/lifecycle.jsonl"
cp -p "$HB" "$EVIDENCE/heartbeat.h1.json"
sleep 10
cp -p "$HB" "$EVIDENCE/heartbeat.h2.json"
jq -e '.state == "online" and .lastGatewayPollStatus == "ok"' "$EVIDENCE/heartbeat.h1.json" >/dev/null
jq -e '.state == "online" and .lastGatewayPollStatus == "ok"' "$EVIDENCE/heartbeat.h2.json" >/dev/null
[ "$(jq -er '.updatedAt' "$EVIDENCE/heartbeat.h1.json")" != "$(jq -er '.updatedAt' "$EVIDENCE/heartbeat.h2.json")" ]
tail -n 20 "$LIFECYCLE" >"$EVIDENCE/lifecycle.first-start.jsonl"
grep -Fq 'online' "$EVIDENCE/lifecycle.first-start.jsonl"
grep -Fq 'gateway_poll_attempt' "$EVIDENCE/lifecycle.first-start.jsonl"
grep -Fq 'gateway_poll_ok' "$EVIDENCE/lifecycle.first-start.jsonl"

bash "$FLYWHEEL_REPO/scripts/resident-codex-lead-recover.sh" --project raya --lead raya --probe \
  | tee "$EVIDENCE/probe.json"
raya_pid="$(awk '/^[[:space:]]*pid = [0-9]+[[:space:]]*$/ {print $3}' <<<"$raya_out")"
jq -e --argjson pid "$raya_pid" '
  .state == "exact" and .pid == $pid and
  .label == "com.flywheel.lead.raya-raya" and
  .wrapper == "flywheel-codex-lead-wrapper-raya-tui-fullaccess.sh" and
  .codexHome == "/Users/xiaorongli/.codex-raya"
' "$EVIDENCE/probe.json" >/dev/null
[ "$(shasum -a 256 "$RAYA_SHARED_CONFIG" | awk '{print $1}')" = \
  "$(shasum -a 256 "$EVIDENCE/config.toml.before" | awk '{print $1}')" ]

cmux --json list-workspaces >"$EVIDENCE/cmux-workspaces.json"
[ "$(grep -cF 'cmux-raya-raya' "$EVIDENCE/cmux-workspaces.json" || true)" -eq 1 ]
```

Founder 在 #raya 发一句，Raya 回一句后，操作者填入两条真实 URL 并执行：

```bash
export FOUNDER_RAYA_MESSAGE_URL="REPLACE_WITH_DISCORD_MESSAGE_URL"
export RAYA_REPLY_URL="REPLACE_WITH_DISCORD_MESSAGE_URL"
case "$FOUNDER_RAYA_MESSAGE_URL:$RAYA_REPLY_URL" in \
  https://discord.com/channels/*:https://discord.com/channels/*) : ;; \
  *) echo "founder message and Raya reply URLs are required" >&2; false ;; \
esac
printf '%s\n%s\n' "$FOUNDER_RAYA_MESSAGE_URL" "$RAYA_REPLY_URL" >"$EVIDENCE/raya-message-roundtrip.urls"
```

失败执行 §4.11 R4 — carrier birth，然后 R3、R2、R1。

## 4.8 退应急面，不碰产品 job

所有独立谓词都必须在 `mv` 前通过。

```bash
[ -z "$(pgrep -f '[b]in-raya-watch.sh' || true)" ]
[ "$(tmux -L default list-windows -a -F '#S:#W' | grep -ci 'raya' || true)" -eq 1 ]
[ "$(tmux -L default list-windows -a -F '#S:#W' | grep -cx 'flywheel:raya-raya' || true)" -eq 1 ]
[ -f "$HOME/.flywheel/raya/bin-raya-watch.sh" ]
[ ! -L "$HOME/.flywheel/raya/bin-raya-watch.sh" ]
[ ! -e "$HOME/.flywheel/raya/retired-2259/bin-raya-watch.sh" ]
[ ! -L "$HOME/.flywheel/raya/retired-2259/bin-raya-watch.sh" ]
install -d -m 700 "$HOME/.flywheel/raya/retired-2259"
mv "$HOME/.flywheel/raya/bin-raya-watch.sh" "$HOME/.flywheel/raya/retired-2259/bin-raya-watch.sh"
[ ! -e "$HOME/.flywheel/raya/bin-raya-watch.sh" ]
[ -f "$HOME/.flywheel/raya/retired-2259/bin-raya-watch.sh" ]

product_out="$(launchctl print "gui/$(id -u)/com.xrli.raya.brain")"
grep -qE '^[[:space:]]*state = running' <<<"$product_out"
[ "$(grep -cE '^[[:space:]]*pid = [0-9]+' <<<"$product_out")" -eq 1 ]
```

mv 后验证失败只执行 §4.11 R5 — emergency watcher；新 Lead 仍满足 §4.7 时不级联拆除。

## 4.9 关出生窗口

```bash
cat "$HOME/.flywheel/deployed-sha" >"$EVIDENCE/deployed-sha.txt"
shasum -a 256 "$PROJECTS" "$RECEIPT" "$RAYA_ENV" "$RAYA_SHARED_CONFIG" >"$EVIDENCE/post-window-sha256.txt"
launchctl print "gui/$(id -u)/$RAYA_LABEL" >"$EVIDENCE/raya-launchd.after"
launchctl print "gui/$(id -u)/com.xrli.raya.brain" >"$EVIDENCE/product-brain.after"
git -C "$HOME/Dev/raya-lead-workspace/memory" status --porcelain >"$EVIDENCE/memory-git-status.txt"
[ ! -s "$EVIDENCE/memory-git-status.txt" ]
```

在 FLY-2259 thread 报：出生完成；patrol 要等班车 N+1 重启 Bridge 后覆盖，或等待 founder 单次
`request-restart.sh` 票。此时不自行重启 Bridge、不自行进入 §4.10。

## 4.10 班车 N+1 后：真机自愈、pane 重建、语音对照

先证 Bridge `/health` 正常，并证 patrol 已观察本代。再做一次有界 SIGSTOP；12 分钟没有完整收敛就安全
SIGCONT，记录失败，绝不把 founder 面的 Lead 留在 STOPPED。

```bash
set -euo pipefail
curl -fsS http://127.0.0.1:9876/health >"$EVIDENCE/bridge-health.before-drill.json"
jq -e '.status == "ok" or .ok == true' "$EVIDENCE/bridge-health.before-drill.json" >/dev/null

probe="$(bash "$FLYWHEEL_REPO/scripts/resident-codex-lead-recover.sh" --project raya --lead raya --probe)"
T0_pid="$(jq -er '.pid' <<<"$probe")"
T0_lstart="$(jq -er '.lstart' <<<"$probe")"
HB="$HOME/.flywheel/state/codex-lead/raya/brain/heartbeat.json"
OBSERVED="$HOME/.flywheel/state/codex-lead/raya/brain/patrol-observed-generation.json"
RECOVERIES="$HOME/.flywheel/state/codex-lead/raya/brain/recovery-receipts.jsonl"
T0_gen="$(jq -er '.generationId' "$HB")"
T0_car="$(jq -er '.carrierInstanceId' "$HB")"
jq -e --argjson pid "$T0_pid" '.processPid == $pid and .state == "online"' "$HB" >/dev/null
jq -e --argjson pid "$T0_pid" --arg ls "$T0_lstart" --arg g "$T0_gen" --arg c "$T0_car" '
  .pid == $pid and .lstart == $ls and .generationId == $g and .carrierInstanceId == $c
' "$OBSERVED" >/dev/null
rc_lines0="$(if [ -f "$RECOVERIES" ]; then wc -l <"$RECOVERIES"; else echo 0; fi)"
T0_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
deadline=$(( $(date +%s) + 720 ))
printf '%s\n' "$probe" >"$EVIDENCE/recovery-drill.T0-probe.json"
cp -p "$HB" "$EVIDENCE/recovery-drill.T0-heartbeat.json"

kill -STOP "$T0_pid"
converged=0
while [ "$(date +%s)" -lt "$deadline" ]; do
  sleep 30
  new_probe="$(bash "$FLYWHEEL_REPO/scripts/resident-codex-lead-recover.sh" --project raya --lead raya --probe 2>/dev/null || true)"
  [ -n "$new_probe" ] || continue
  new_pid="$(jq -er '.pid' <<<"$new_probe" 2>/dev/null || true)"
  new_lstart="$(jq -er '.lstart' <<<"$new_probe" 2>/dev/null || true)"
  if [ -n "$new_pid" ] && { [ "$new_pid" != "$T0_pid" ] || [ "$new_lstart" != "$T0_lstart" ]; } \
    && jq -e --argjson pid "$new_pid" --arg gen "$T0_gen" --arg car "$T0_car" '
      .processPid == $pid and .state == "online" and
      .generationId != $gen and .carrierInstanceId != $car
    ' "$HB" >/dev/null 2>&1 \
    && [ -f "$RECOVERIES" ] \
    && tail -n "+$((rc_lines0 + 1))" "$RECOVERIES" | jq -s -e \
      --argjson pid "$T0_pid" --arg ls "$T0_lstart" --arg at "$T0_at" '
        any(.[]; .phase == "pre_mutation" and .old.pid == $pid and .old.lstart == $ls and .at >= $at)
      ' >/dev/null; then
    printf '%s\n' "$new_probe" >"$EVIDENCE/recovery-drill.new-probe.json"
    converged=1
    break
  fi
done

if [ "$converged" -ne 1 ]; then
  live_out="$(launchctl print "gui/$(id -u)/$RAYA_LABEL")"
  live_pid="$(awk '/^[[:space:]]*pid = [0-9]+[[:space:]]*$/ {print $3}' <<<"$live_out")"
  live_lstart="$(LC_ALL=C ps -p "$live_pid" -o lstart= | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  [ "$live_pid" = "$T0_pid" ] || { echo "unexpected Raya pid after failed recovery drill" >&2; false; }
  [ "$live_lstart" = "$T0_lstart" ] || { echo "unexpected Raya process identity after failed recovery drill" >&2; false; }
  kill -CONT "$T0_pid"
  before_resume="$(jq -er '.updatedAt' "$HB")"; sleep 10; after_resume="$(jq -er '.updatedAt' "$HB")"
  [ "$before_resume" != "$after_resume" ]
  echo "recovery drill did not converge before deadline" >&2
  false
fi

tail -n "+$((rc_lines0 + 1))" "$RECOVERIES" >"$EVIDENCE/recovery-drill.new-receipts.jsonl"
! grep -Fq 'com.xrli.raya.brain' "$EVIDENCE/recovery-drill.new-receipts.jsonl"
cp -p "$HB" "$EVIDENCE/recovery-drill.new-heartbeat.json"
```

从 #flywheel-alerts 取得时间戳不早于 `T0_at` 的真实 `codex_lead_residency_stalled` 消息 URL，并执行：

```bash
export STALL_ALERT_URL="REPLACE_WITH_DISCORD_ALERT_URL"
case "$STALL_ALERT_URL" in https://discord.com/channels/*) : ;; *) echo "real stall alert URL is required" >&2; false ;; esac
printf '%s\n' "$STALL_ALERT_URL" >"$EVIDENCE/recovery-drill.alert.url"
```

pane 丢失只验证 runtime 20 秒内重建；不拆 tmux server 去故意逼投递失败。

```bash
LOG="$HOME/.flywheel/logs/lead-raya-raya.log"
log_lines0="$(wc -l <"$LOG")"
tmux kill-window -t '=flywheel:=raya-raya'
for _ in $(seq 1 20); do
  tmux -L default has-session -t flywheel 2>/dev/null \
    && tmux -L default list-windows -t flywheel -F '#W' | grep -Fxq 'raya-raya' && break
  sleep 1
done
[ "$(tmux -L default list-windows -t flywheel -F '#W' | grep -cx 'raya-raya' || true)" -eq 1 ]
tail -n "+$((log_lines0 + 1))" "$LOG" >"$EVIDENCE/pane-rebuild.log"
grep -Fq 'tui-window: real TUI up (raya-raya' "$EVIDENCE/pane-rebuild.log"
! grep -Fq 'guard DISABLED' "$EVIDENCE/pane-rebuild.log"
```

共享 voice home 配置必须与 4.0 备份逐字一致。Founder 完成一次 `/voice` 开关后填真实请求/完成 URL。

```bash
cmp "$EVIDENCE/config.toml.before" "$RAYA_SHARED_CONFIG"
export VOICE_REQUEST_URL="REPLACE_WITH_DISCORD_MESSAGE_URL"
export VOICE_RESULT_URL="REPLACE_WITH_DISCORD_MESSAGE_URL"
case "$VOICE_REQUEST_URL:$VOICE_RESULT_URL" in \
  https://discord.com/channels/*:https://discord.com/channels/*) : ;; \
  *) echo "voice control evidence URLs are required" >&2; false ;; \
esac
printf '%s\n%s\n' "$VOICE_REQUEST_URL" "$VOICE_RESULT_URL" >"$EVIDENCE/voice-control.urls"
```

将本目录所有证据整理到 `activation-evidence.md`，另开 docs-only PR。明确记录：

- `tui_window_lost` 对 Raya 已 armed（allowlist + 首启无 DISABLED + 关窗重建）；生产未故意触发投递失败；
- pane allowlist 仍未名册化，未来 Lead 不自动获得；
- state-bin helper 缺 `lead-restart-lifecycle.sh` 是 FLY-2216 既有边界，运行权威为仓库 helper；
- InfraBot 纳入的 founder 原话链接为 research.md §0 的两条直接引用；
- `raya-lead` 是当前不存在的占位 Linear label，日后若创建会开始匹配；
- `com.xrli.raya.brain` 保留且 running，应急观察面已退，不存在两个文本脑。

## 4.11 逆序回滚层级

每层都在新 `/bin/bash` 中先重跑 §4.0.1，但把 `EVIDENCE` 指回本次证据目录。动作只在对象存在或漂移时做。

### R1 — registry + receipt

```bash
set -euo pipefail
if jq -e '[.[] | select(.projectName == "raya")] | length == 1' "$PROJECTS" >/dev/null; then
  bash "$FLYWHEEL_REPO/scripts/flywheel-config-lock.sh" "$PROJECTS.cfglock" 5 \
    cp -p "$EVIDENCE/projects.json.before" "$PROJECTS"
fi
if [ "$(shasum -a 256 "$RECEIPT" | awk '{print $1}')" != \
  "$(shasum -a 256 "$EVIDENCE/migration-receipt.json.before" | awk '{print $1}')" ]; then
  cp -p "$EVIDENCE/migration-receipt.json.before" "$RECEIPT"
fi
cmp "$EVIDENCE/projects.json.before" "$PROJECTS"
cmp "$EVIDENCE/migration-receipt.json.before" "$RECEIPT"
jq -e '[.[] | select(.projectName == "raya")] | length == 0' "$PROJECTS" >/dev/null
(
  cd "$FLYWHEEL_REPO"
  TMPDIR=/tmp pnpm exec tsx packages/flywheel-comm/src/bin/summary-registry.ts verify-activation \
    --projects-file "$PROJECTS" --receipt-file "$RECEIPT"
) | jq -e '.ok == true' >/dev/null
```

### R2 — product workspace + env

```bash
set -euo pipefail
old_pid="$(jq -er '.pid' "$EVIDENCE/product-brain.T0.json")"
if launchctl print "gui/$(id -u)/com.xrli.raya.brain" >/dev/null 2>&1; then
  launchctl bootout "gui/$(id -u)/com.xrli.raya.brain"
fi
if [ "$(shasum -a 256 "$RAYA_ENV" | awk '{print $1}')" != \
  "$(shasum -a 256 "$EVIDENCE/raya.env.before" | awk '{print $1}')" ]; then
  cp -p "$EVIDENCE/raya.env.before" "$RAYA_ENV"
fi
[ "$(stat -f %Lp "$RAYA_ENV")" = 600 ]
if [ -d "$HOME/Dev/raya-lead-workspace/memory" ] && [ ! -e "$HOME/.flywheel/raya/memory" ]; then
  mv "$HOME/Dev/raya-lead-workspace/memory" "$HOME/.flywheel/raya/memory"
fi
[ ! -e "$HOME/Dev/raya-lead-workspace/memory" ] || { echo "memory rollback left destination residue" >&2; false; }
[ ! -L "$HOME/Dev/raya-lead-workspace/memory" ] || { echo "memory rollback left a destination symlink" >&2; false; }
[ -r "$HOME/.flywheel/raya/memory/MEMORY.md" ]
[ -z "$(git -C "$HOME/.flywheel/raya/memory" status --porcelain)" ]

expected_plist_sha="$(jq -er '.brainPlistSha256' "$EVIDENCE/product-brain.T0.json")"
expected_plist_mode="$(jq -er '.brainPlistMode' "$EVIDENCE/product-brain.T0.json")"
current_plist_sha="$(if [ -f "$PRODUCT_BRAIN_PLIST" ]; then shasum -a 256 "$PRODUCT_BRAIN_PLIST" | awk '{print $1}'; fi)"
current_plist_mode="$(if [ -f "$PRODUCT_BRAIN_PLIST" ]; then stat -f %Lp "$PRODUCT_BRAIN_PLIST"; fi)"
if [ "$current_plist_sha" != "$expected_plist_sha" ] || [ "$current_plist_mode" != "$expected_plist_mode" ]; then
  cp -p "$EVIDENCE/com.xrli.raya.brain.plist.before" "$PRODUCT_BRAIN_PLIST"
fi
[ "$(shasum -a 256 "$PRODUCT_BRAIN_PLIST" | awk '{print $1}')" = "$expected_plist_sha" ]
[ "$(stat -f %Lp "$PRODUCT_BRAIN_PLIST")" = "$expected_plist_mode" ]

launchctl bootstrap "gui/$(id -u)" "$PRODUCT_BRAIN_PLIST"
for _ in $(seq 1 30); do
  brain_out="$(launchctl print "gui/$(id -u)/com.xrli.raya.brain" 2>/dev/null || true)"
  grep -qE '^[[:space:]]*state = running' <<<"$brain_out" && break
  sleep 1
done
grep -qE '^[[:space:]]*state = running' <<<"$brain_out"
[ "$(grep -cE '^[[:space:]]*pid = [0-9]+' <<<"$brain_out")" -eq 1 ]
[ "$(awk '/^[[:space:]]*pid = [0-9]+[[:space:]]*$/ {print $3}' <<<"$brain_out")" != "$old_pid" ]
cmp "$EVIDENCE/raya.env.before" "$RAYA_ENV"
```

R2 验证后继续 R1。

### R3 — manifest

```bash
set -euo pipefail
attempt_dir="$WINDOW_ROOT/attempt-R3-$(date +%s)"
[ ! -e "$attempt_dir" ]
install -d -m 700 "$attempt_dir"
after_file="$EVIDENCE/manifests.after"
if [ ! -f "$after_file" ]; then
  after_file="$attempt_dir/manifests.after.recovered"
  ls "$HOME"/.flywheel/manifests/*.json | sort >"$after_file"
fi
comm -13 "$EVIDENCE/manifests.before" "$after_file" >"$attempt_dir/new-manifests.txt"
while IFS= read -r added; do
  [ -n "$added" ] || continue
  case "$added" in "$HOME/.flywheel/manifests/"*.json) : ;; *) echo "unsafe manifest path: $added" >&2; false ;; esac
  [ -f "$added" ] || { echo "new manifest is not a regular file: $added" >&2; false; }
  [ ! -L "$added" ] || { echo "new manifest must not be a symlink: $added" >&2; false; }
  mv "$added" "$attempt_dir/"
done <"$attempt_dir/new-manifests.txt"
ls "$HOME"/.flywheel/manifests/*.json | sort >"$attempt_dir/manifests.current"
cmp "$EVIDENCE/manifests.before" "$attempt_dir/manifests.current"
```

R3 验证后继续 R2、R1。

### R4 — carrier birth

```bash
set -euo pipefail
attempt_dir="$WINDOW_ROOT/attempt-R4-$(date +%s)"
[ ! -e "$attempt_dir" ]
install -d -m 700 "$attempt_dir"
if launchctl print "gui/$(id -u)/$RAYA_LABEL" >/dev/null 2>&1; then
  launchctl bootout "gui/$(id -u)/$RAYA_LABEL"
fi
for _ in $(seq 1 30); do
  launchctl print "gui/$(id -u)/$RAYA_LABEL" >/dev/null 2>&1 || break
  sleep 1
done
! launchctl print "gui/$(id -u)/$RAYA_LABEL" >/dev/null 2>&1
if [ -f "$RAYA_PLIST" ] && [ ! -L "$RAYA_PLIST" ]; then mv "$RAYA_PLIST" "$attempt_dir/"; fi
if [ -d "$HOME/.flywheel/state/codex-lead/raya" ] && [ ! -L "$HOME/.flywheel/state/codex-lead/raya" ]; then
  mv "$HOME/.flywheel/state/codex-lead/raya" "$attempt_dir/state-codex-lead-raya"
fi
if [ -f "$HOME/.flywheel/logs/lead-raya-raya.log" ] && [ ! -L "$HOME/.flywheel/logs/lead-raya-raya.log" ]; then
  mv "$HOME/.flywheel/logs/lead-raya-raya.log" "$attempt_dir/"
fi
if tmux -L default list-windows -a -F '#S:#W' 2>/dev/null | grep -Fxq 'flywheel:raya-raya'; then
  tmux -L default kill-window -t '=flywheel:=raya-raya'
fi
[ ! -e "$RAYA_PLIST" ]
[ ! -e "$HOME/Library/LaunchAgents/com.flywheel.lead.raya-raya.tui.plist" ]
[ ! -e "$HOME/.flywheel/logs/lead-raya-raya.log" ]
! tmux -L default list-windows -a -F '#S:#W' 2>/dev/null | grep -Fxq 'flywheel:raya-raya'
```

R4 验证后继续 R3、R2、R1。

### R5 — emergency watcher

R5 不自动级联。只有 §4.7 的新 Lead 活体判据也失效时，才再执行 R4。

```bash
set -euo pipefail
retired="$HOME/.flywheel/raya/retired-2259/bin-raya-watch.sh"
active="$HOME/.flywheel/raya/bin-raya-watch.sh"
if [ -f "$retired" ] && [ ! -L "$retired" ] && [ ! -e "$active" ]; then
  mv "$retired" "$active"
fi
[ -f "$active" ] || { echo "restored watcher is not a regular file" >&2; false; }
[ ! -L "$active" ] || { echo "restored watcher must not be a symlink" >&2; false; }
bash "$FLYWHEEL_REPO/scripts/resident-codex-lead-recover.sh" --project raya --lead raya --probe \
  | jq -e '.state == "exact" and .label == "com.flywheel.lead.raya-raya"' >/dev/null
```

`$HOME/.codex-raya` 是 founder 登录成果，任何回滚层都保留；需要 logout 时只能由 founder 自己执行。
