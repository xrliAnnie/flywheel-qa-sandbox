# FLY-2264 arm64 tmux 切换 — 切换手册
Issue: FLY-2264 (https://linear.app/geoforge3d/issue/FLY-2264/cutovertmux-fly-2190-落地-载体换-arm64-原生-tmux-先改-host-tmux-selection-gate)
日期: 2026-09-02
基于: plan.md

## 0. 授权、范围与硬停止线

本文件只供 founder 明确批准的破坏性窗口使用。实现/PR 节点不得执行这里的 production mutation；
本 PR 本身不 link、不改 `~/.flywheel/.env`、不重启、不 merge、不 deploy。

founder 必须从普通 macOS Terminal.app 窗口执行本手册的全部命令；
不得从 cmux、Lead pane 或任何 tmux session 执行。开窗前先退出 founder 自己通过 `tmux new -s ...` 创建的会话，不得为了保住
operator shell 而给权威 census 制造临时 tmux 豁免。服务自身的旧 tmux 仍由 §4 权威枚举和关闭。

开窗必须同时满足：

1. founder 对**本次具体时段**给出明确批准，工单保存原话、时间与消息链接；2026-08-30 的“派给
   Tadashi 做”不是时机批准。
2. 有 ship 权限的工人在窗口内合入本 PR；合入后冻结其它 main merge。此 PR 不得随普通班车先部署。
3. 窗口避开 00:00/12:00 班车边界；合入到唯一重启票之间不得出现自动 updater 部署。
4. pause 后两次权威 quiescence 均为零；只看 `/api/runs/active == 0` 不足以证明无 runner，因为还要
   覆盖 dispatcher inflight、durable launch claim 与 admission crossing。
5. 所有操作者接受权威 union 中全部非豁免旧 tmux server、全部 Lead pane 与工人窗口会断。任何 receipt/lease/SHA/
   inventory/预算证据不完整，立即停窗。
6. 不直接执行 `restart-services.sh`，不手工 `kickstart -k` Bridge/Lead。link 后服务重生只允许一张
   `bash ~/Dev/flywheel/scripts/request-restart.sh` 票；不调用 `install-bridge-launchd.sh`。受审的 launchd
   例外只有三处：§1.1 pre-ship bootout updater、§5.5/§8.2 按 0600 recovery bootstrap 原 supervisor
   plist、§6 在唯一票前 bootstrap updater；任何一处都不 kickstart Bridge/Lead。

Lead ruling `33dc0da4-c6a3-4621-be79-37893a694059` 锁定顺序为“先停旧 server、link/pin/env，后发唯一
部署票”；ruling `16a390ab-59e9-4357-871b-1dc1fcbe792c` 锁定 lease 交接为“旧 Bridge NULL-owner pause
→ 新 restart 路径接管 → 0600 handoff → host transaction renew/resume”。不得现场改成其它 bootstrap。

## 1. 固定值、私有目录与受审窗口件

在宿主 operator shell 中设置非秘密值；token 只从现有受管环境取得，禁止回显：

```bash
export LIVE_REPO="$HOME/Dev/flywheel"
export WINDOW_DIR="$HOME/.flywheel/state/FLY-2264-window-FLY-2279"
export WINDOW_ARTIFACTS="$WINDOW_DIR/artifacts"
export CUTOVER_SHA='<本 PR 合入后的 40-hex merge commit>'
export NATIVE_TMUX='/opt/homebrew/Cellar/tmux/3.7c/bin/tmux'
export OLD_TMUX='/usr/local/Cellar/tmux/3.5a/bin/tmux'
export CUTOVER_RECEIPT="$HOME/.flywheel/state/host-terminal-cutover.json"
export PREP_RECEIPT="$WINDOW_DIR/preparation-receipt.json"
export LEASE_HANDOFF="$HOME/.flywheel/state/host-terminal-cutover.admission-lease-id"
export FLYWHEEL_HOST_CUTOVER_RECEIPT="$CUTOVER_RECEIPT"
export FLYWHEEL_BRIDGE_URL='http://127.0.0.1:9876'
umask 077
install -d -m 700 "$WINDOW_DIR"
```

`TEAMLEAD_API_TOKEN` 必须已存在。`CUTOVER_RECEIPT` 与 `LEASE_HANDOFF` 都是 capability；不得贴入工单、
聊天或日志摘要。
原 `$HOME/.flywheel/state/FLY-2264-window` 仅作为只读历史证据保留；本次 installer、receipt、worktree
和 verification artifact 一律写入带 `-FLY-2279` 后缀的新目录，禁止覆盖或清理旧窗口证据。

在 ship 前、live checkout 仍是旧代码时，保存旧工具并记录 hash：

```bash
install -m 700 "$LIVE_REPO/scripts/host-terminal-cutover.sh" \
  "$WINDOW_DIR/host-terminal-cutover.pre-ff.sh"
shasum -a 256 "$WINDOW_DIR/host-terminal-cutover.pre-ff.sh" \
  > "$WINDOW_DIR/host-terminal-cutover.pre-ff.sha256"
export OLD_TOOL="$WINDOW_DIR/host-terminal-cutover.pre-ff.sh"
```

### 1.1 ship 前 park updater

这一步必须在 ship 前、live checkout 仍是旧代码时完成，因此不能调用尚未部署的受审 helper。下面的
固定检查只接受唯一受支持的 urgent queue 不存在或为真实空目录，先证明 updater loaded+enabled，再 bootout，并在
60 秒内证明 exact label absent。任何 symlink、普通文件、非空 urgent queue、launchctl transport/parse 不确定
都立即停窗；不得先 ship 再补做 pre-unload。

```bash
bash -euo pipefail <<'BASH'
window_uid="$(id -u)"
die() { printf 'updater pre-unload: %s\n' "$*" >&2; exit 1; }
assert_empty_updater_queue() {
  local queue="$1" entry=""
  if [ ! -e "$queue" ] && [ ! -L "$queue" ]; then return 0; fi
  [ -d "$queue" ] && [ ! -L "$queue" ] || die "queue is not a real directory: $queue"
  entry="$(find "$queue" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" \
    || die "cannot inspect queue: $queue"
  [ -z "$entry" ] || die "queue is not empty: $queue"
}
assert_updater_queues_empty() {
  assert_empty_updater_queue "$HOME/.flywheel/self-ship-urgent.d"
}
updater_state() {
  local out="" rc=0
  out="$(launchctl print "gui/${window_uid}/com.flywheel.updater" 2>&1)" || rc=$?
  if [ "$rc" -eq 0 ]; then printf 'loaded\n'; return 0; fi
  case "$out" in
    *'Could not find service "com.flywheel.updater"'*|*'No such process: com.flywheel.updater'*)
      printf 'absent\n' ;;
    *) die "launchctl state is unknown (rc=$rc)" ;;
  esac
}
assert_updater_enabled() {
  local out="" lines=""
  out="$(launchctl print-disabled "gui/${window_uid}" 2>&1)" \
    || die "cannot determine updater enabled state"
  lines="$(printf '%s\n' "$out" | grep -F '"com.flywheel.updater"' || true)"
  [ "$(printf '%s\n' "$lines" | awk 'NF {n++} END {print n+0}')" -le 1 ] \
    || die "updater enabled state is ambiguous"
  case "$lines" in
    ''|*'=> false'*|*'=> enabled'*) ;;
    *'=> true'*|*'=> disabled'*) die "updater is disabled" ;;
    *) die "updater enabled state is unparseable" ;;
  esac
}
assert_updater_queues_empty
[ "$(updater_state)" = loaded ] || die "updater is not loaded before pre-unload"
assert_updater_enabled
launchctl bootout "gui/${window_uid}/com.flywheel.updater"
updater_deadline=$(( $(date +%s) + 60 ))
while [ "$(updater_state)" = loaded ]; do
  [ "$(date +%s)" -lt "$updater_deadline" ] || die "updater did not become absent within 60 seconds"
  sleep 1
done
[ "$(updater_state)" = absent ] || die "updater absence was not proven"
assert_updater_queues_empty
BASH
```

从这里到 §6 bootstrap 之前，updater 必须保持 absent，urgent queue 必须保持空；发现任何新 ticket 就停窗。

ship 后从 `CUTOVER_SHA` 建 detached 的受审源码 worktree，供新工具做 SHA/receipt/run-step；这不更新
live checkout，也不重启服务：

```bash
git -C "$LIVE_REPO" fetch --quiet origin main
if test ! -e "$WINDOW_DIR/source"; then
  git -C "$LIVE_REPO" worktree add --detach "$WINDOW_DIR/source" "$CUTOVER_SHA"
fi
test "$(git -C "$WINDOW_DIR/source" rev-parse HEAD)" = "$CUTOVER_SHA"
bash "$WINDOW_DIR/source/scripts/cutover/FLY-2264/install-window-artifacts.sh" "$WINDOW_ARTIFACTS"
test "$(stat -f %Lp "$WINDOW_ARTIFACTS")" = 700
test "$(stat -f %u "$WINDOW_ARTIFACTS")" = "$(id -u)"
(cd "$WINDOW_ARTIFACTS" && shasum -a 256 -c sha256-manifest.txt)
fresh_labels="$(mktemp "$WINDOW_DIR/supervisor-labels.XXXXXX")"
"$WINDOW_ARTIFACTS/generate-supervisor-labels.sh" "$HOME/Library/LaunchAgents" > "$fresh_labels"
cmp "$fresh_labels" "$WINDOW_ARTIFACTS/supervisor-labels.txt"
rm "$fresh_labels"
export NEW_TOOL="$WINDOW_DIR/source/scripts/host-terminal-cutover.sh"
```

installer 可安全重跑：它只重验 manifest 内受审字节，并原样保留权限正确、名称受限的
`supervisor-recovery.json`、`tmux-union.json` 与 `verification-artifacts/`；未知额外文件仍 fail closed。

## 2. Founder ship、freeze 与 main SHA 证明——此时不部署

1. founder 批准时机；ship 工人合入并把 merge commit 写入 `CUTOVER_SHA`。
2. 冻结其它 main merge，确认没有 updater 票、没有 runner、且不在班车边界。
3. 用 post-merge 受审工具 fresh-fetch 并逐字证明 main：

   ```bash
   "$NEW_TOOL" assert-main-sha --expected "$CUTOVER_SHA"
   ```

4. 检查 receipt 最后一个 `assert-main-sha` event 的
   `expected == observed == CUTOVER_SHA` 且 `passed == true`。**不要在这里发
   `request-restart.sh`。** 当前宿主仍选 Intel 3.5a；新 gate 若先部署，Bridge wrapper 会 fail
   closed，无法出生。

## 3. 旧 Bridge brake 与窗口准备

### 3.1 旧脚本创建耐久 NULL-owner pause

用保存的 pre-FF 工具调用旧 API：

```bash
"$OLD_TOOL" pause-admission --duration 3600 --minimum 1770 \
  --reason 'FLY-2264 arm64 tmux destructive window'
"$OLD_TOOL" inspect-admission
"$OLD_TOOL" quiescence
```

通过条件：旧 API 返回 active，receipt 为 `status=paused`，但没有 `pause.leaseId`；quiescence event
证明连续两次 total=0。这个 NULL-owner row 是预期 bootstrap 形态；此时不得用新工具调用
`pause-admission`，也不得无主 resume。
`--reason` 会被部署票逐字当作接管匹配键：≤200 字符、首尾无空白、无换行，建议只用 ASCII；
不满足时新脚本会在停止旧 Bridge 之前拒绝该票。

### 3.2 单独的 preparation receipt

新工具拒绝覆盖 active transaction receipt，因此准备动作使用同目录的独立 receipt：

```bash
FLYWHEEL_HOST_CUTOVER_RECEIPT="$PREP_RECEIPT" "$NEW_TOOL" preflight-receipt
FLYWHEEL_HOST_CUTOVER_RECEIPT="$PREP_RECEIPT" "$NEW_TOOL" build-closure
FLYWHEEL_HOST_CUTOVER_RECEIPT="$PREP_RECEIPT" "$NEW_TOOL" rehearse-rollback
bash "$WINDOW_DIR/source/scripts/check-global-path-hygiene.sh" \
  --source-tree "$WINDOW_DIR/source"
```

必须证明：

- 3.5a recovery binary 与 3.7c native binary 都存在；bottle/rollback closure 完整；
- rehearsal server 真实 start/attach/stop，PID/start tuple 消失；
- Darwin runtime PATH 中 `/opt/homebrew/bin` 精确 segment 位于 `/usr/local/bin` 前；
- `brew-upgrade=N/A`：3.7c 已安装，本窗口不升级 Intel Homebrew 或任何依赖。

## 4. 停 supervisor、权威 census、停止全部非豁免旧 server

本窗口的全部脚本必须由 §1 installer 从 exact `CUTOVER_SHA` 安装、通过 sha256 manifest 校验并放在
0700 `WINDOW_DIR`；不得现场改脚本。
`com.flywheel.updater` 应按 §1.1 保持 absent，supervisor manifest 不得包含它。受审脚本在 updater
loaded+enabled 或 absent 两种状态下都可继续，但只要 urgent queue 非空或状态不确定就失败。

### 4.1 bootout-supervisors

```bash
"$NEW_TOOL" verify-receipt --step bootout-supervisors
"$NEW_TOOL" run-step --name bootout-supervisors --timeout 120 -- \
  bash "$WINDOW_ARTIFACTS/bootout-supervisors.sh" "$WINDOW_ARTIFACTS/supervisor-labels.txt"
```

manifest 必须覆盖 Bridge、bridge-liveness-probe、cmux watcher 与全部 16 个 Lead label（共19项）；每个
loaded label bootout 后都要以 `launchctl print gui/$(id -u)/<label>` 证明 absent。
脚本先发完全部 19 个 `launchctl bootout`，再让所有尚未 absent 的 label 共用一个最多 90 秒的截止时间，
按轮次轮询直到全体收敛；120 秒的 run-step 预算覆盖整个脚本而不是逐 label 重新计时。任一 deadline、
parse/transport/absence 不确定均为失败。

### 4.2 authoritative-census

用新 preparation receipt 再跑同一 exact extractor，并把 preflight 与 post-bootout inventory 按
`PID + startIdentity` 取并集：

```bash
export AUTH_RECEIPT="$WINDOW_DIR/authoritative-receipt.json"
"$NEW_TOOL" verify-receipt --step authoritative-census
"$NEW_TOOL" run-step --name authoritative-census --timeout 60 -- \
  env FLYWHEEL_HOST_CUTOVER_RECEIPT="$AUTH_RECEIPT" "$NEW_TOOL" preflight-receipt
jq -s '[.[0].preflight.processInventory[], .[1].preflight.processInventory[]]
  | unique_by([.pid,.startIdentity])' \
  "$PREP_RECEIPT" "$AUTH_RECEIPT" > "$WINDOW_ARTIFACTS/tmux-union.json"
```

每个条目必须有 image、architecture、socket 与 supervisor disposition；未知/未归属 server 不能忽略。

### 4.3 stop-old-servers

```bash
"$NEW_TOOL" verify-receipt --step stop-old-servers
"$NEW_TOOL" run-step --name stop-old-servers --timeout 120 -- \
  bash "$WINDOW_ARTIFACTS/stop-old-tmux-servers.sh" \
    "$WINDOW_ARTIFACTS/tmux-union.json" "$OLD_TMUX"
```

操作脚本必须在每次 kill 前重证 PID/start tuple，只用版本匹配的绝对旧 client 对精确 socket
`kill-server`，之后重跑 census，证明旧 tuple 全消失且没有新 tmux server。禁止 `pkill tmux`，禁止只
清 default/atlas，禁止漏掉 QA/散装 socket。server 的唯一豁免是由 `launchctl print pid/<serverPID>`
正向证明 resource coalition 为 exact `com.xiaorongli.atlas-growth`；只把其 label/socket/image 写为
informational，不 bootout、不 kill、不碰其 plist。argv 含 `-D`/`-S`/`-L`/`new-session` 且不含
`attach-session` 的进程先按 server 形态处理；只有没有 filesystem socket、且 argv 含 `attach-session`
的 cmux client 才记为 `role=client,socket=n/a`，不进入 stop list，也不阻塞 server census；其它
socket-less/未知进程与 server 的 owner/socket 任一未知仍须变红。

## 5. phase-b-link、pin 与唯一 production env

link 由受审、hash 固定的 `phase-b-link.sh` 在 30 秒预算内完成。其合同必须逐字包含：

```bash
/opt/homebrew/bin/brew link tmux
/opt/homebrew/bin/brew pin tmux
test "$(python3 -c 'import os; print(os.path.realpath("/opt/homebrew/bin/tmux"))')" \
  = '/opt/homebrew/Cellar/tmux/3.7c/bin/tmux'
test "$(/opt/homebrew/bin/tmux -V)" = 'tmux 3.7c'
file -b /opt/homebrew/Cellar/tmux/3.7c/bin/tmux | grep -F arm64
/opt/homebrew/bin/brew list --pinned | grep -Fx tmux
```

执行：

```bash
"$NEW_TOOL" assert-main-sha --expected "$CUTOVER_SHA"
"$NEW_TOOL" verify-receipt --step phase-b-link
"$NEW_TOOL" run-step --name phase-b-link --timeout 30 -- \
  bash "$WINDOW_ARTIFACTS/phase-b-link.sh"
```

随后用受审 `flywheel-setup.sh` 的 symlink-refused、0600 atomic upsert helper 只写这一项，并只读回该
exact line，不打印其它 env 内容：

```bash
FLYWHEEL_SETUP_SOURCED=1 FLYWHEEL_SETUP_STATE_DIR="$HOME/.flywheel" \
  bash -c 'source "$1"; fs_env_upsert FLYWHEEL_CMUX_ATTACH_TMUX_BIN "$2"' _ \
  "$WINDOW_DIR/source/scripts/flywheel-setup.sh" "$NATIVE_TMUX"
grep -Fx 'FLYWHEEL_CMUX_ATTACH_TMUX_BIN=/opt/homebrew/Cellar/tmux/3.7c/bin/tmux' \
  "$HOME/.flywheel/.env"
```

**不要写** `FLYWHEEL_HOST_TMUX_EXPECTED_CANONICAL_PATH`；它仍是 hermetic test-only seam。也不设置
`FLYWHEEL_LEAD_V2_TMUX_BIN`，不新增第二个 carrier pin。

### 5.5 supervisor 正向恢复

发唯一 updater 票之前，用 bootout 前已完整写出的 0600 recovery 恢复原来 loaded 的 exact 19 项：

```bash
bash -euo pipefail <<'BASH'
window_uid="$(id -u)"
source "$WINDOW_ARTIFACTS/lib/launchd-window.sh"
fly2264_assert_updater_state_safe "$window_uid"
bash "$WINDOW_ARTIFACTS/restore-supervisors.sh" "$WINDOW_ARTIFACTS/supervisor-recovery.json"
while IFS= read -r label; do
  launchctl print "gui/$(id -u)/$label" >/dev/null
done < "$WINDOW_ARTIFACTS/supervisor-labels.txt"
fly2264_assert_updater_state_safe "$window_uid"
BASH
```

脚本固定按 Bridge → bridge-liveness-probe → cmux watcher → sorted 16 Leads bootstrap original plist，逐项
证明 loaded，并在恢复前后只断言 updater 状态安全（loaded 时须 enabled，absent 也安全）。这里故意不以
queue 非空阻断 emergency restore，也绝不读取或消费 queue ticket；parse/transport/bootstrap/post-print
任一不确定都在发票前失败。old code + native tmux 可能短暂进入 gate fail-closed 循环，这是预期过渡态；不得绕门。唯一
gate-mounted auxiliary `com.flywheel.quota-monitor` 可能在 monitor binary 启动前因旧 gate 拒绝而退出并产生
预期 alert；它不在19项 scope，也不能据此加第二张票。

link 与部署票之间若任何 KeepAlive 意外重拉 Lead，旧 gate 会拒绝；supervisor 已 bootout、admission
已 pause，因此这是预期 fail-closed，不得为“救窗”绕门。

## 6. 唯一 updater 票与 owner handoff

发票前再次证明 frozen main，然后重验 urgent queue 仍为空、updater 仍 absent，才 bootstrap exact updater
plist。bootstrap 后必须证明 updater loaded+enabled；这只是恢复已 park 的 updater，不是第二张部署票。

```bash
bash -euo pipefail <<'BASH'
"$NEW_TOOL" assert-main-sha --expected "$CUTOVER_SHA"
window_uid="$(id -u)"
source "$WINDOW_ARTIFACTS/lib/launchd-window.sh"
fly2264_assert_updater_queues_empty
test "$(fly2264_launchd_state com.flywheel.updater "$window_uid")" = absent
launchctl bootstrap "gui/${window_uid}" "$HOME/Library/LaunchAgents/com.flywheel.updater.plist"
test "$(fly2264_launchd_state com.flywheel.updater "$window_uid")" = loaded
fly2264_assert_updater_safe "$window_uid"
"$NEW_TOOL" verify-receipt --step services-bootstrap
"$NEW_TOOL" run-step --name services-bootstrap --timeout 30 -- \
  bash "$LIVE_REPO/scripts/request-restart.sh"
BASH
```

这是全窗唯一一张票。票据受理不等于部署结束；等待 updater 拉取/构建 `CUTOVER_SHA`、启动新 Bridge、
完成全部 Lead 波和终态播报。不得调用 `install-bridge-launchd.sh`，不得补发盲票。

新 `restart-services.sh` 的强制时序：

1. 发现 0600 legacy transaction receipt，记为待接管；phase-1 以 receipt 中的 exact pause reason
   同时作为 `reason` 与 `expectedLegacyReason` 向当前 Bridge 续 1800s 的 pause（旧 Bridge 会以同一
   reason 覆盖该行；lease-aware Bridge 精确匹配后直接分配 owner 并写 handoff）；只有连接被拒
   （旧 Bridge 已 bootout）才保持待接管状态继续，任何 HTTP 拒绝或结果不明的传输失败都在停止
   Bridge 之前拒绝该票。
2. 新 Bridge health 与 build identity 通过。
3. 在任何 Lead 波之前，以 receipt 中的 exact pause reason 为 expected identifier，原子接管 legacy
   NULL row；identifier 不匹配即 409，绝不接管外部 brake。常规部署另写 0600 run-local receipt
   （UTC、PID、唯一 pause identifier），只接管本 wave 自己创建的 NULL row。
4. 把 UUID 原子写入 `$LEASE_HANDOFF`，目录 0700、文件 0600；写不成即拒绝 Lead 波。
5. 接管 lease 在 Lead 波结束后也不由 restart resume。只有常规、无 legacy receipt 的 restart 自建
   lease 才按原合同自动 resume。

## 7. Host 接管 owner、验收与 resume

updater 已把 live checkout 部署到 `CUTOVER_SHA` 后，切回 live 新工具。handoff 必须是当前用户所有的
0600 regular file，内容只含一行 UUID：

```bash
export CUTOVER_TOOL="$LIVE_REPO/scripts/host-terminal-cutover.sh"
test "$(git -C "$LIVE_REPO" rev-parse HEAD)" = "$CUTOVER_SHA"
test "$(stat -f %Lp "$LEASE_HANDOFF")" = 600
"$CUTOVER_TOOL" pause-admission --duration 3600 --minimum 1770 \
  --reason 'FLY-2264 post-deploy owner renewal'
"$CUTOVER_TOOL" inspect-admission
"$CUTOVER_TOOL" quiescence
jq -e '.status == "paused"
  and (.pause.leaseId | type == "string" and length == 36)
  and .pause.reacquiredAfterLapse == false' \
  "$CUTOVER_RECEIPT" >/dev/null
```

新工具必须从 handoff 导入同一 id 后才发 renewal。handoff 缺失、symlink、mode/owner 错、内容非法或
与 receipt 不同都必须在 API mutation 前失败；不得无 id 重新申请或 resume。
`pause-admission` 若返回 `reacquiredAfterLapse:true`，会先把 breach 写入 receipt/event，再以 rc=3
结束；这证明窗口中 admission 曾重新开放，不能继续验收或把本次 cutover 记为成功。

### 7.1 自动验收

继续只在 §0 指定的普通 Terminal.app operator shell 中执行。verifier 与 stop 脚本的 tmux census 使用
ancestor-inclusive `pgrep -a -x tmux`；不要另开临时 tmux 来绕过 operator 断线，也不要添加 operator 豁免。

```bash
"$CUTOVER_TOOL" verify-receipt --step automated-verification
"$CUTOVER_TOOL" run-step --name automated-verification --timeout 120 -- \
  bash "$WINDOW_ARTIFACTS/verify-native-tmux-cutover.sh" "$CUTOVER_SHA"
```

受审 verification artifact 至少证明：

- updater 终态 `skipped/failed/total` 可读、`failed=0`，deployed SHA 与 Bridge
  `buildSha/artifactBuildSha` 均为 `CUTOVER_SHA`；
- gate 对完整 loaded Lead census 通过，输出 `census pass plists=... generic=... codex-*=...`；按
  carrier 类保存 receipt，不伪称有 16 份独立 Lead receipt；
- `/opt/homebrew/bin/tmux` realpath 为 exact 3.7c Cellar，`tmux -V` 为 `tmux 3.7c`，`file` 含 arm64，
  tmux 已 pinned；
- 所有活 tmux server image 都是 `$NATIVE_TMUX`；`ps`/exact extractor 没有
  `/usr/local/bin/tmux` 或 3.5a server；
- 16 个 Lead launchd PID/start identity 健康；每个 Lead shell 与代表性实际 child 的 macOS hex p_flag
  均未置 `P_TRANSLATED (0x00020000)`，过滤 AOT/Rosetta runtime/dylib 后唯一 main image 含 arm64 slice；
  另把固定 `/bin/bash -c '/usr/sbin/sysctl -n sysctl.proc_translated'` 的 `0` 只记为 host native control，
  不冒充任一 PID 的查询；
- cmux watcher 健康，全部 tab 自动 attach/sidebar 验证通过；所有 socket-owning server 不再 3.5a↔3.7c 混用，
  socket-less attach client 以 `role=client,socket=n/a` 留作 informational；
- 16 个 Lead 的 runtime PATH 由 live `ps eww` 证明 `/opt/homebrew/bin` 在 `/usr/local/bin` 前；Bridge 的 PATH 证据不是 runtime 环境读取，
  因 Node process-title 不暴露 env，改由 launchd plist 的 `ProgramArguments` 与其指向的受审 wrapper 源码 export 合同证明；
  `launchctl print` 不提供 default PATH 时 artifact 明记 `unavailable` 而不伪称 process env；另要求
  `bash scripts/check-global-path-hygiene.sh --source-tree "$LIVE_REPO"` 通过。

全部自动证据绿色后才释放自己的 owner：

```bash
"$CUTOVER_TOOL" inspect-admission
"$CUTOVER_TOOL" resume-admission
jq -e '.status == "resumed"
  and .resume.wasActive == true
  and .resume.leaseLapsed == false
  and .events[-1].kind == "resume"' \
  "$CUTOVER_RECEIPT" >/dev/null
test ! -e "$LEASE_HANDOFF"
```

founder 的 cmux 全 tab 视觉确认放在自动验收完成、resume 前后紧邻处，并把结果写入窗口证据。不要让
人工等待耗尽 lease；必要时先用同 owner renew。
`resume-admission` 若发现 `leaseLapsed:true`，同样先持久化 evidence 再以 rc=3 结束。任一 lapse 信号
都是 admission continuity breach：保全 receipt/handoff/updater 日志，停止宣告成功，并由 founder
决定向前重试还是另批 rollback；不得用随后一次成功 renew 掩盖断档。

## 8. 失败与 rollback

1. **bootout 前、link 前失败**：不做 carrier mutation；若旧 Bridge 仍健康且该 legacy receipt 明确
   属于本事务，可用保存的 pre-FF 工具恢复 admission。不得用新工具伪造 owner。
2. **bootout 后、link 前失败**：保持 merge freeze，执行
   `bash "$WINDOW_ARTIFACTS/restore-supervisors.sh" "$WINDOW_ARTIFACTS/supervisor-recovery.json"`，使用开窗前已
   rehearsal/hash 固定的 supervisor recovery artifact 恢复原 launchd tuple 与 3.5a server；不调用
   `install-bridge-launchd.sh`。权威 census 恢复后才处理 legacy pause。恢复到 recovery 记录的原状态后，
   同一受审 `bootout-supervisors.sh` 可原地重跑；它会先完整校验并原子刷新 recovery，不需手删窗口文件。
3. **link 后失败**：默认保持 native link、tmux pin 与 absolute cmux pin，保持 brake 并向前收敛；不要
   在新 gate 环境里先 unlink 回 Intel。
4. **takeover/handoff 失败**：restart 路径在 Lead 波前 fail closed，且永不 resume 已获得的 owner。
   立即保全 receipt、handoff 路径权限与 updater 日志；handoff 找不到时 host 工具也必须拒绝 mutation。
5. **确需恢复 3.5a**：另取 founder 明确 rollback 授权，先把接受 3.5a+x86_64 的代码通过 freeze +
   SHA proof + 唯一正门实际部署；只有旧 gate 已出生后，才可停 3.7c server、`brew unpin/unlink tmux`、
   移除 cmux pin并使用已演练 closure 恢复。不得用 test-only canonical env 绕门。

### 8.3 部署票在 Step 0 被拒后的恢复

日志出现 `rejected or its outcome is unknown` 只说明 restart 没有收到权威的成功租约回包；请求是否
送达、行是否已被改写、是否已经有 owner 都未知。操作者必须另行建立行的真实状态，再按下表恢复：

| 已建立的状态 | 恢复动作 |
|---|---|
| 0600 handoff 存在，当前是 lease-aware Bridge | 用新工具 `pause-admission` 导入。成功判据是退出码 0，且 0600 receipt 被改写为 owned 形态（`.pause.leaseId` 等于 handoff 内容）；stdout 刻意不暴露 owner capability，不要在 stdout 找 `leaseId`。退出码 3 表示工具已把 continuity breach 写入 receipt/event，先保全证据且不得宣告成功。成功后立即再发票，走 ordinary owned-receipt 路径。 |
| 0600 handoff 存在，当前是旧 Bridge | 旧 Bridge 不返回 `leaseId`，新工具无法导入。发一张过渡票：phase-1 对旧 Bridge 幂等续期；新 Bridge 出生后 takeover 对已有主的行返回 409，并按设计在 Lead 波前拒绝。随后按上一行导入 handoff，再发 owned-receipt 票完成 Lead 波。 |
| 没有可用 handoff（不存在或导入返回 409），当前是 lease-aware Bridge | 不做固定等待。取得 founder 授权后，以裸 curl 发一次**无限定** `pause`（body 只有 `durationSeconds` 与 `reason: R`，不带 `leaseId` / `expectedLegacyReason`）作原子探测兼获取。200 且返回 `admissionPause.leaseId` 表示行原本无主或 owner 已过期：把 id 写成目录 0700、文件 0600 的 handoff，再按第一行导入。409 表示仍有活跃 owner：用 `inspect-admission` 权威观测到 `active == false`，把 admission 重开记为 continuity breach，再重复获取。 |
| row reason 与 receipt 不匹配且无主，当前是旧 Bridge | 用保存的 pre-FF 旧工具对旧 Bridge 重跑 `pause-admission --reason <receipt 中同一 reason>`，覆盖回匹配键后再发票。 |

owned receipt 再发票前必须先用新工具成功续期一次（成功判据同表第一行），确保 lease 仍 active；否则
ordinary path 的过期行可能被无限定接管。代码回滚回旧 Bridge 后的过渡票预期会在 Lead 波前失败，不能
当作事故重试。这里不新增自动接管机制；所有无限定获取均需 founder 明确授权。

### 8.4 代码回滚回旧 Bridge 后的前向转换

若代码 rollback 重新拉起旧 Bridge，而数据库行仍带新 Bridge 铸出的 owner，按固定四步前向转换：

1. 保留 legacy receipt 与 0600 handoff，发一张过渡票，让旧 Bridge 以 receipt reason 幂等续期；
2. 新 Bridge 出生后，预期 takeover 因行已有 owner 而拒绝，并在任何 Lead 波前结束该票；
3. 用新工具从 handoff 导入 owner，并成功续期，得到 owned receipt；
4. 再发 owned-receipt 票，走 ordinary path 完成 Lead 波。

窗口策略可由 founder 预先选择 `FLYWHEEL_RESTART_DISABLE_CODE_ROLLBACK=1`，避免部署失败时自动把代码
rollback 到旧 Bridge；这是既有选项，本流程不改变其默认值。

## 9. 本单明确不做

- 不 upgrade/unlink/修改 Intel Homebrew 的其它包或依赖；
- 不把 `FLYWHEEL_HOST_TMUX_EXPECTED_CANONICAL_PATH` 放进 production `.env`；
- 不在普通班车或 runner 存活时开窗；
- 不把 `/api/runs/active == 0` 当完整 quiescence；
- 不 self-merge，不由实现/QA 节点 deploy，不跳过 founder 的本次时机原话记录。
