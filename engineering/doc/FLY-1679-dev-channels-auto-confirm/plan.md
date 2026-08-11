# FLY-1679 wrapper-v2 缺 dev-channels 自动确认 — 实施计划

Issue: FLY-1679 (https://linear.app/geoforge3d/issue/FLY-1679/wrapper-v2-缺-dev-channels-自动确认-lead-冷启动卡确认框直到人工按键该-lead-discord-下线)
日期: 2026-08-10
基于: research.md

---

## 0. 一句话

给 FLY-1663 的 launchd-native body 补上 dev-channels 自动确认：**新增一个 v2 专用 poller**，在 v2 分支里 `_launch_claude` **之前**起、之后（以及 `cleanup()` 里）收。识别用被测那一版 Claude 源码里逐字取到的三段框内文本的**合取**；动作**只发 `1`，永不发 `Enter`**。v1 路径逐字不动（digest 哨兵钉住），不加任何 flag。

---

## 1. 对「只搬不发明」的两处明示偏离（Codex design review R1 抓出，均有源码取证）

原计划是逐字照搬 FLY-109 的 `send-keys 1; sleep 0.3; send-keys Enter` 与三段 OR 正则。审计被测版本 Claude Code 源码后，这两点都必须改，否则**违反 founder 的验收 #3（其它对话框不被误按）**。

### 偏离 A：不再发 `Enter`

源码取证（`~/Dev/claude-code`，即本机在跑的那一版）：

- `src/components/DevChannelsDialog.tsx:82` 用的是 `<Select options={…} onChange={…} />`，**没有**传 `disableSelection` / `hideIndexes`。
- `src/components/CustomSelect/select.tsx:220` → `disableSelection = false`；`:302` → `t12 = disableSelection || (hideIndexes ? "numeric" : false)` = `false`。
- `src/components/CustomSelect/use-select-input.ts:255-280`：`disableSelection !== 'numeric'` 且输入是数字 ⇒ `state.onChange?.(selectedOption.value); return`。

⇒ **按 `1` 当场就选中 accept，不需要 `Enter`。**（本机 `~/Dev/claude-code` 即生产在跑的那一版；判据取自被测那一版，不是记忆里的旧版。）

而 `src/interactiveHelpers.tsx:291-295`：dev-channels 框被接受后，若 `claudeInChrome && !hasCompletedClaudeInChromeOnboarding`，**紧接着**会渲染 `ClaudeInChromeOnboarding` 另一个框。所以 v1 那个 0.3 秒后无条件补的 `Enter` 会落到**下一个框**上，等于替 founder 按掉一个她没看过的对话框 —— 这正是验收 #3 禁止的行为。

**改为只发 `1`。** 副作用因此被夹死为「至多一个 `1` 字符，永不附带提交动作」。

诚实界定这个界限的适用范围（Codex R2 #3）：
- 误判发生在 **REPL 已经起来**时 ⇒ 输入框里多一个未提交的 `1`，可见、无害。
- 误判发生在**另一个也接受数字键的对话框**正聚焦、同时屏幕上还残留三段标记文本时 ⇒ 这个 `1` 仍可能选中那个框的第 1 项。三段合取让这个组合极难成立，但机制本身**不能**排除它。所以本计划不宣称「绝对不会误按任何东西」，只宣称「绝不会额外发提交键，且识别面收窄到三段同屏」。
- 这不构成加 bottom-region 识别器的理由（见 §7）。

> 为什么不采纳 Codex 建议的「重新截屏、框还在才发 Enter」：在「框根本没出现、匹配到的是历史对话文本」这一支里，重截屏时那段文本**仍然在**，条件式 Enter 照样会把 `1` 提交出去。只发 `1` 是唯一能同时挡住两支的做法。
>
> 代价（明示）：若将来某版 Claude 改成必须按 Enter，本 poller 按完 `1` 框还在 ⇒ Lead 仍会卡。对策不是补 Enter，而是**留一条可 grep 的失败信号** `DEV_CHANNELS_CONFIRM_UNVERIFIED`：把今天「静默卡死」变成「有账可查」。真发生了走 follow-up 单改，不加 flag（founder 裁定）。

### 偏离 B：识别改成三段**合取**，且全部逐字取自源码

`Loading development channels` 与 `I am using this for local development` 单独任一都会被**历史对话文本**命中 —— 本单 issue 正文自己就同时含这两句。而框会被跳过是一条**真实可达**分支：`interactiveHelpers.tsx:265` `if (!isChannelsEnabled() || !getClaudeAIOAuthTokens()?.accessToken)` 命中时**不弹框**，poller 就会在恢复出来的历史对话上空转 90 秒。

改为要求同时出现三段（各自都是独立的 Ink 文本节点，在 pane 宽 220 下各占一行、不会折行）：

| 记号 | 匹配串 | 源码出处 |
|------|--------|----------|
| A | `WARNING: Loading development channels` | `DevChannelsDialog.tsx:90` Dialog `title`（逐字全串） |
| B | `I am using this for local development` | `DevChannelsDialog.tsx:70` 选项 1 的 `label`（逐字全串） |
| C | `Please use --channels to run a list of approved channels.` | `DevChannelsDialog.tsx:43` 独立 `<Text>`（逐字全串，含句末句号） |

三段都是**固定串匹配**（`grep -F`），A/B 是节点的完整文本，C 连句末句号一起带上，所以三段都是源码逐字串而不是截断片段。

识别面**只缩不扩**：真框三段必然同屏；随手引用 issue 的对话文本几乎不可能三段齐全（C 不在 issue 正文里）。

> pane 几何是确定的：`flywheel-lead-wrapper-v2.sh:224` 固定 `new-session … -x 220 -y 50`，三段最长 57 字符，`Pane.tsx` 无宽度上限，不折行。

---

## 2. 改动清单（4 个文件）

| 文件 | 改动 | 性质 |
|------|------|------|
| `packages/teamlead/scripts/claude-lead.sh` | ① 新增 `_dev_channels_dialog_present()`；② 新增 `_poll_dev_channels_dialog_v2()`；③ v2 分支里起/收；④ `cleanup()` 的 v2 分支里**先**收 poller 再终止子进程 | 生产代码 |
| `scripts/__tests__/fly1679-dev-channels-v2.test.sh` | 新增：桩层分支 + 寻址 + 接线 + v1 digest 哨兵 + 真 tmux E2E | 测试（新文件） |
| `.github/workflows/ci.yml` | 把新套件登记进既有 FLY-1663 script-tests 组 | CI |
| `scripts/test-deploy.sh` | 一行日志文案订正（`relies on expect-dev-channels.exp` → 指向启动链内 poller） | QA 可读性 |

**不改**：`_poll_dev_channels_dialog`（v1）及其调用点、`expect-dev-channels.exp`、`test-deploy.sh` 的 `confirm_dev_channels_prompt()` 逻辑、`flywheel-lead-wrapper-v2.sh`、`lead-body.sh`。

---

## 3. 生产代码改动（逐字）

### 3.1 识别谓词（插在 `_poll_dev_channels_dialog` 之后）

```bash
# FLY-1679: the dev-channels dialog's own text, taken verbatim from the Claude
# source under test (DevChannelsDialog.tsx: Dialog title, option-1 label, and
# the standalone approved-channels line). All three must be on screen at once:
# any single fragment also appears in ordinary conversation about this flag,
# and interactiveHelpers.tsx can legitimately skip the dialog (channels gated
# off / no OAuth token), which would leave the poller scanning a restored
# transcript. Here-strings, not pipes: `set -o pipefail` is active and a
# short-circuiting `grep -q` can SIGPIPE its producer.
_dev_channels_dialog_present() {
  local text="$1"
  grep -qF 'WARNING: Loading development channels' <<<"$text" || return 1
  grep -qF 'I am using this for local development' <<<"$text" || return 1
  grep -qF 'Please use --channels to run a list of approved channels.' <<<"$text" || return 1
  return 0
}
```

### 3.2 v2 poller

```bash
# FLY-1679: launchd-native (v2) carrier port of the FLY-109 auto-confirm.
# The v1 supervisor polls the shared session's Lead window; a v2 body has no
# such window — it IS the private server's pane and Claude is its direct child.
# Without this port every cold start parks on the dev-channels dialog until a
# human presses a key, while launchd still reports the job as running.
# Args: $1 = timeout_sec. Runs as a background job of the body shell.
_poll_dev_channels_dialog_v2() {
  local timeout_sec="${1:-90}"
  local elapsed=0 socket pane pane_text send_rc verify capture_rc

  # Address the private server explicitly. FLYWHEEL_TMUX_SOCKET_OVERRIDE is a
  # shared-topology (v1) concept and must never retarget these keystrokes.
  if [ -z "${TMUX:-}" ]; then
    _log_startup "dialog-poller-v2: no tmux identity — auto-confirm skipped"
    return 0
  fi
  socket="${TMUX%%,*}"
  # %0 is guaranteed by the carrier: wrapper-v2 creates `-s main -n main` and
  # the generated tmux.conf's pane-exited hook keys on `#{hook_pane} = %0`.
  pane="${TMUX_PANE:-%0}"

  _log_startup "dialog-poller-v2: start pane=${pane} timeout=${timeout_sec}s"

  while [ "$elapsed" -lt "$timeout_sec" ]; do
    if ! command tmux -S "$socket" display-message -p -t "$pane" '#{pane_id}' >/dev/null 2>&1; then
      _log_startup "dialog-poller-v2: pane gone, exiting"
      return 0
    fi

    # A transient capture failure is not evidence of anything. Treat it as
    # "nothing matched this tick"; the pane probe at the top of the next
    # iteration remains the only authority on pane death.
    capture_rc=0
    pane_text="$(command tmux -S "$socket" capture-pane -t "$pane" -p 2>/dev/null)" || capture_rc=$?
    [ "$capture_rc" -eq 0 ] || pane_text=""

    if _dev_channels_dialog_present "$pane_text"; then
      _log_startup "dialog-poller-v2: matched dev-channels dialog, sending '1'"
      # '1' alone accepts: the dialog's Select has numeric selection enabled,
      # so the keypress fires onChange immediately. No Enter is ever sent —
      # an unconditional Enter would land on whatever dialog renders next
      # (interactiveHelpers.tsx can show Chrome onboarding right after).
      send_rc=0
      command tmux -S "$socket" send-keys -t "$pane" "1" 2>/dev/null || send_rc=$?
      if [ "$send_rc" -ne 0 ]; then
        _log_startup "dialog-poller-v2: DEV_CHANNELS_SEND_FAILED rc=${send_rc}"
        return 0
      fi

      # Confirmation is only claimed on evidence: a SUCCESSFUL capture that no
      # longer shows the dialog. A failed capture is transport loss, not proof
      # the dialog closed — swallowing it here would let an offline Lead be
      # logged as `confirmed=1` and poison the production acceptance evidence.
      verify=0
      while [ "$verify" -lt 10 ]; do
        sleep 0.3
        capture_rc=0
        pane_text="$(command tmux -S "$socket" capture-pane -t "$pane" -p 2>/dev/null)" || capture_rc=$?
        if [ "$capture_rc" -ne 0 ]; then
          _log_startup "dialog-poller-v2: DEV_CHANNELS_VERIFY_FAILED rc=${capture_rc} (no confirmation evidence)"
          return 0
        fi
        if ! _dev_channels_dialog_present "$pane_text"; then
          _log_startup "dialog-poller-v2: confirmed=1"
          return 0
        fi
        verify=$((verify + 1))
      done
      _log_startup "dialog-poller-v2: DEV_CHANNELS_CONFIRM_UNVERIFIED (sent '1', dialog still present)"
      return 0
    fi

    sleep 1
    elapsed=$((elapsed + 1))
  done

  _log_startup "dialog-poller-v2: DEV_CHANNELS_DIALOG_NOT_SEEN after ${timeout_sec}s"
  return 0
}
```

要点复核：
- `command tmux` + 显式 `-S "$socket"` ⇒ 绕开 `FLYWHEEL_TMUX_SOCKET_OVERRIDE`。
- 发键前每轮重探 pane 存活。
- 全部输出走 `_log_startup`（写文件），零 stdout ⇒ 不污染共用 tty 的 Ink 渲染。
- 任何分支都 `return 0`：poller 永远不能让 body 失败。
- 只有「发键成功 **且** 一次**成功的**截屏显示框已消失」才打 `confirmed=1`。发键失败 → `DEV_CHANNELS_SEND_FAILED`；截屏失败 → `DEV_CHANNELS_VERIFY_FAILED`；框没消失 → `DEV_CHANNELS_CONFIRM_UNVERIFIED`。三者都**不**写 `confirmed=1`。

### 3.3 v2 分支接线

```bash
  CLAUDE_EXIT=1
  _v2_started_at="$(date +%s)"
  _v2_launch_rc=0
  # FLY-1679: the v2 _launch_claude blocks in `wait`, so the auto-confirm
  # poller must already be running when the child renders the dialog.
  _V2_DIALOG_POLLER_PID=""
  if [ "$INBOX_MCP_ENABLED" = "true" ]; then
    _poll_dev_channels_dialog_v2 "$FLYWHEEL_DIALOG_TIMEOUT_SEC" &
    _V2_DIALOG_POLLER_PID=$!
  fi
  _launch_claude "${_v2_launch_args[@]}" || _v2_launch_rc=$?
  _v2_reap_dialog_poller
  if [ "$_v2_launch_rc" -ne 0 ]; then
    CLAUDE_EXIT="$_v2_launch_rc"
  fi
```

守卫 `INBOX_MCP_ENABLED = true` 与 v1（`:4525`）一致。**不带** v1 的 `[ -n "${LEAD_WINDOW_ID:-}" ]` —— 那正是 v2 永远为空的那一半缺口。

变量用 `_V2_DIALOG_POLLER_PID`（与 v1 的 `_DIALOG_POLLER_PID` 分开，v1 不受影响），脚本顶层赋值即全局，`cleanup()` 可见。

### 3.4 收割器 + `cleanup()` 信号路径

```bash
# FLY-1679: is this PID still a RUNNING async job of THIS shell?
#
# The poller self-terminates within FLYWHEEL_DIALOG_TIMEOUT_SEC (≤90s) while
# _launch_claude stays blocked for the entire Claude lifetime — hours or days.
# So at reap time the poller is almost always long gone and its PID number is
# free for reuse by an unrelated process. Signalling the stored number
# unconditionally would eventually TERM a stranger.
#
# `jobs -pr` with NO argument, matched line-exact, is the only form that works
# here. Measured on this host (GNU bash 3.2.57, macOS): `jobs -pr <pid>` fails
# with "no such job" for a live job AND a finished one (rc=1 both times), so a
# PID-argument guard would silently degrade into "never signal anything".
_v2_dialog_poller_is_running() {
  local pid="$1" running
  running="$(jobs -pr 2>/dev/null || true)"
  grep -qxF -- "$pid" <<<"$running"
}

# FLY-1679: single reaping point, used by both the normal post-launch path and
# the signal path. Must run BEFORE the child is terminated so no keystroke can
# be delivered into a pane that is being torn down. Idempotent.
_v2_reap_dialog_poller() {
  local pid="${_V2_DIALOG_POLLER_PID:-}"
  [ -n "$pid" ] || return 0
  if _v2_dialog_poller_is_running "$pid"; then
    kill "$pid" 2>/dev/null || true
  fi
  # Consume the saved exit status either way; harmless if already reaped.
  wait "$pid" 2>/dev/null || true
  _V2_DIALOG_POLLER_PID=""
  return 0
}
```

`cleanup()` 的 v2 分支改成（**唯一**改动是最前面加一行 `_v2_reap_dialog_poller`）：

```bash
  if [ "${FLYWHEEL_LEAD_BODY_V2:-0}" = "1" ]; then
    _v2_reap_dialog_poller
    if [ -n "${CLAUDE_CHILD_PID:-}" ] && kill -0 "$CLAUDE_CHILD_PID" 2>/dev/null; then
      kill -TERM "$CLAUDE_CHILD_PID" 2>/dev/null || true
      wait "$CLAUDE_CHILD_PID" 2>/dev/null || true
    fi
    exit 143
  fi
```

定义位置：`_v2_reap_dialog_poller` 必须在 `cleanup()` 之前定义（`cleanup()` 在 `:3068`），且 `_V2_DIALOG_POLLER_PID` 需在脚本早期初始化为空，避免 `set -u` 下 `cleanup()` 先于 v2 分支执行时取不到值（已用 `${…:-}` 兜住，初始化只是显式化）。

---

## 4. 测试计划（TDD：先红后绿）

新文件 `scripts/__tests__/fly1679-dev-channels-v2.test.sh`，纯 bash，**macOS bash 3.2 实跑**（不只 `bash -n`）。

### 4.1 谓词层（直接 eval `_dev_channels_dialog_present`）

| # | 输入 | 断言 |
|---|------|------|
| P1 | 三段齐全的真框渲染 fixture | present |
| P2 | 只有 A | absent |
| P3 | 只有 B | absent |
| P4 | A+B（= 本 issue 正文的形态：标题 + 选项行，无 C） | **absent** ← 验收 #3 的核心反例 |
| P5 | 裸词组 `development channels` 出现在正常对话里 | absent |
| P6 | 另一个确认框（`Do you want to proceed?` / `1. Yes` / `2. No`） | absent |
| P7 | Chrome onboarding 框 | absent |

### 4.2 桩层（PATH shim 假 tmux）

`sed` 抽 `_poll_dev_channels_dialog_v2` + 谓词 → `eval` → PATH 前置假 `tmux` 记录每次调用与参数（不用 `TMUX_TMPDIR`，它不隔离）；`_log_startup` 打桩到临时文件。

| # | 场景 | 断言 |
|---|------|------|
| T1 | 首轮就是真框，`1` 之后框消失 | 恰好一次 `send-keys … 1`；**零** `send-keys … Enter`；日志末尾 `confirmed=1` |
| T2 | 真框，但 `1` 之后框一直在 | 恰好一次 `send-keys … 1`；零 Enter；日志 `DEV_CHANNELS_CONFIRM_UNVERIFIED` |
| T3 | `send-keys` 返非零 | 日志 `DEV_CHANNELS_SEND_FAILED`；**不**打 `confirmed=1` |
| T3b | 首轮截屏与 `send-keys` 都成功，但**之后每次**校验截屏都返非零 | 日志 `DEV_CHANNELS_VERIFY_FAILED`；**不**打 `confirmed=1` |
| T4 | 屏幕上是 A+B（无 C）的对话文本 | **零** `send-keys`；超时后 `DEV_CHANNELS_DIALOG_NOT_SEEN` |
| T5 | 屏幕上是别的确认框 | 零 `send-keys` |
| T6 | `display-message` 返非零（pane 没了） | 零 `send-keys`；日志 `pane gone, exiting` |
| T7 | `TMUX` 未设 | 零 tmux 调用；日志 `no tmux identity` |
| T8 | 寻址 | 每条 tmux 调用都带 `-S <$TMUX 推出的 socket>`；`-t` = `$TMUX_PANE`；未设时 `%0` |
| T9 | `FLYWHEEL_TMUX_SOCKET_OVERRIDE` 指向别处 | 仍只打私有 socket |
| T10 | poller 的 stdout | 为空（不污染 Ink TUI） |

### 4.3 接线层

| # | 断言 |
|---|------|
| W1 | v2 分支中 `_poll_dev_channels_dialog_v2` 的调用出现在 `_launch_claude "${_v2_launch_args[@]}"` **之前**，且其后有 `_v2_reap_dialog_poller` |
| W2 | `cleanup()` 的 v2 分支里 `_v2_reap_dialog_poller` 出现在 `kill -TERM "$CLAUDE_CHILD_PID"` **之前** |
| W3 | v2 起点**不**带 `LEAD_WINDOW_ID` 守卫（防止有人「照抄 v1」把缺口重新引入） |

W1/W2 是源码顺序断言，只能防「有人把顺序改回去」。收割行为本身另有以下行为级用例（bash 3.2 实跑）：

| # | 断言 |
|---|------|
| R1 | 给 `_v2_reap_dialog_poller` 一个**真的还在跑**的非匹配 poller 后台进程，在 `set -euo pipefail` 下调用：进程真的没了、`_V2_DIALOG_POLLER_PID` 被清空、**再调一次**无害（幂等、退码 0） |
| R1b | **主导情形**：poller 自己已经跑完（正常路径下它 ≤90s 退出，而 `_launch_claude` 会阻塞数小时）。断言它已不在 `jobs -pr` 里、reaper **不发任何信号**、`wait` 与清空照常、二次调用无害 |
| R1c | **PID 复用反例（必须能变红）**：不等真的 PID 回绕，直接构造那个状态 —— 用一层**会立刻退出的 helper 子 shell** 起一个长命进程（`( sleep 60 >/dev/null 2>&1 </dev/null & echo $! )`），于是它**活着但不是本测试 shell 的作业**；把**它本人的 PID** 写进 `_V2_DIALOG_POLLER_PID`。先断言它活着且不在 `jobs -pr` 里，调用 reaper 后断言它**仍然活着**、变量已清空。收尾显式终止它 |

| R2 | 用锚点从 `cleanup()` 抽出 v2 分支，在隔离子 shell 里把 `kill` / `wait` / `log` / `exit` 全部打桩成写调用日志，喂一个活 poller PID 与一个活子进程 PID：观察到的**实际调用顺序**是「先收 poller，后 TERM 子进程」，不是只看源码文本顺序 |

> R1c 的判别力已实测（bash 3.2）：带守卫的 reaper → 受害进程存活；**去掉守卫**的朴素实现 → 受害进程被杀。也就是说这条用例在实现回退时会真的变红，不是空过绿测。旧写法（另起一个 PID 不同的无关进程）是无效对照：朴素实现根本打不到它，怎么写都绿。

### 4.4 v1 字节兼容哨兵（digest 钉死）

| # | 断言 |
|---|------|
| B1 | `sed -n '/^_poll_dev_channels_dialog()/,/^}/p'` 的 SHA-256 == `3b1f6d3aa61bdcc8fd906ebcdb42ead415bed5718dfedfb5af350837af676d36` |
| B2 | `sed -n '/# FLY-109: Start background dev-channels dialog poller/,/^    _DIALOG_POLLER_PID=""$/p'`（16 行，含调用与回收）的 SHA-256 == `fb21c75019603f12af5d4131071645371c92f24783f0563501415c3cf4c195c3` |

两条都用**锚点抽取**而不是行号，插入新函数后仍稳定。

### 4.5 真 tmux E2E（Mock 的补位）

自建**独立**私有 tmux server（socket 在测试自己的 `mktemp -d` 里，路径 < 90 字节），pane 里跑一个假 claude。假 claude **直接读 `/dev/tty` 原始字节**（不是 canonical `read` —— canonical `read` 要等换行才返回，会把「必须发 Enter」这个错误语义编进测试）。

| # | 场景 | 断言 |
|---|------|------|
| E1 | 假 claude 打印真框三段文本，然后从 `/dev/tty` 读单字节 | 读到的第一个字节是 `1`；证明按键真进了 pane |
| E2 | 假 claude 打印真框 → 收到 `1` 后**立刻**换渲染成另一个不相干的框，并继续读字节 | 第二个字节**从未到达**（证明没有多余 Enter 打到下一个框）；poller 日志 `confirmed=1` |
| E3 | 假 claude 只打印一个非 dev-channels 的确认框 | 全程零字节到达；日志 `DEV_CHANNELS_DIALOG_NOT_SEEN` |
| E4 | 假 claude 打印真框；收到 `1` 后**整个测试 server 消失**（校验期截屏必失败） | 日志 `DEV_CHANNELS_VERIFY_FAILED`；**零** `confirmed=1` |

清理：`trap` 里对**测试自己的** socket 收尾（绝不碰 `~/.flywheel/sock/` 下任何生产 socket）。

### 4.6 CI 登记与全仓门

- `.github/workflows/ci.yml` 的 `Test — FLY-1663 launchd-native Lead lifecycle` 步骤追加一行 `bash scripts/__tests__/fly1679-dev-channels-v2.test.sh`，并把该步骤注释里的「四个迁移接缝」表述补上本单这一条。
- 本机（macOS，`/bin/bash` 3.2）实跑新套件全绿。
- 相关既有 shell 套件回归：`scripts/__tests__/supervisor-storm-regression.test.sh`、`packages/teamlead/scripts/__tests__/expect-script.test.sh`、`scripts/__tests__/fly1663-lead-v2-runtime.test.sh`。
- `pnpm lint`（全仓）、`pnpm -r build`（全仓）。

> 记忆纪律：全量 vitest 会压死生产 Bridge（load 曾顶到 88）。只跑上述定向 shell 套件 + lint/build；全仓 TS 结论以 CI 为准，不在生产宿主自证。

---

## 5. 验收与责任边界

| 验收项 | 由谁 | 怎么证 |
|--------|------|--------|
| #1 QA 槽冷启动零人工按键 | **独立 QA 节点** | `SKIP_DEV_CHANNELS_WORKAROUND=1 ./scripts/test-deploy.sh …`（关掉 QA 外部代偿）⇒ Lead 自动到 REPL + Discord 插件连上；`~/.flywheel/logs/lead-<slot>-startup.log` 出现 `dialog-poller-v2: confirmed=1` |
| #2 生产下一次 Lead 重启零卡框 | **ship 后自然观察** | 部署伴随重启后，各 Lead 的 startup log 出现 `dialog-poller-v2: confirmed=1`。before 基线 = research §1 那张「08-07 停笔」表 |
| #3 其它对话框不被误按 | 本节点 + 独立 QA | P4/P6/P7、T4/T5、E2/E3；QA 侧可在真槽里让 Chrome onboarding 框紧随其后，观察它**没有**被按掉 |

实现节点**不**自证 #1/#2：那是重启/部署效果，按既有纪律由独立 QA 与部署后观察把关。

`confirmed=1` 作为验收证据是**有条件**的：它只在「发键成功且框确实消失」时才写，所以它证明的是「确认真的生效了」，不是「我调用过 send-keys」。

---

## 6. 风险与对策

| 风险 | 评估 | 对策 |
|------|------|------|
| 只发 `1` 不够，将来某版要 Enter | 当前版本源码已证不需要（`select.tsx:302` + `use-select-input.ts:255-280`） | `DEV_CHANNELS_CONFIRM_UNVERIFIED` 可 grep；从「静默卡死」变「有账可查」；真发生走 follow-up |
| 三段合取漏匹配真框 | 三段都是独立文本节点，pane 固定 220 宽不折行 | P1 用真框 fixture；E1/E2 真 tmux 跑真框文本 |
| 误按其它框 | 只发 `1`；且 `1` 只在三段齐全时发 | P4/P6/P7、T4/T5、E2/E3 |
| 信号路径漏收 poller | `cleanup()` v2 分支 `exit 143` 会跳过正常回收 | `_v2_reap_dialog_poller` 放在 v2 cleanup 分支**最前**，先收 poller 再终止子进程；W2（源码序）+ R1/R2（行为序）双证 |
| 校验期 tmux 失联被当成「框已关」 | 命令替换里 `|| printf ''` 会把传输失败洗成空文本 → 误报 `confirmed=1` → 污染验收 #2 的证据 | 校验循环保留 `capture-pane` 退码，非零 ⇒ `DEV_CHANNELS_VERIFY_FAILED` 且不写 `confirmed=1`；T3b + E4 双证 |
| 只发 `1` 仍可能被别的数字键框吃掉 | 需要「另一个数字框聚焦 + 三段标记同屏残留」同时成立，极难 | 不额外加识别器；在 §1 明示这个残余边界，不做过强承诺 |
| 收割时 PID 已被别的进程复用 | 真实：poller ≤90s 自退，而 `_launch_claude` 阻塞数小时，正常路径下**绝大多数**收割发生在 poller 早已消失之后 | 发信号前用 `jobs -pr`（无参数、整行匹配）确认这个 PID 仍是本 shell 的运行中作业；不是就只 `wait` 不 `kill`。R1/R1b/R1c 三态覆盖。注：bash 3.2 实测 `jobs -pr <pid>` 对活/死作业一律报 "no such job"，不能用 |
| poller 污染 Ink TUI | 只写文件、不写 stdout | T10 断言 stdout 为空 |
| 后台作业干扰 `wait "$CLAUDE_CHILD_PID"` | `wait <pid>` 按 pid 等，不受影响 | E1/E2 覆盖「poller 与子进程并存」形态 |
| `set -o pipefail` + `grep -q` SIGPIPE 误判 | claude-lead.sh `:70` 确实开了 pipefail | 谓词用 here-string，不用管道 |
| poller 让 body 失败 | 所有分支 `return 0`；起停都 `|| true` | — |
| 新套件不进 CI | CI 显式枚举 shell 套件，不自动发现 | §4.6 登记 + W 层断言由 CI 实跑 |

---

## 7. 明确不做

- 不加任何 feature flag / env 开关（founder 裁定：统一修复，回滚=revert）。
- 不改 v1 `_poll_dev_channels_dialog` 与 v1 调用点（digest 哨兵 B1/B2 钉死）。
- 不删 `test-deploy.sh` 的外部代偿（幂等；保 QA 房稳定；`SKIP_DEV_CHANNELS_WORKAROUND=1` 才是验收杠杆）。
- 不清理 `expect-dev-channels.exp`（v2 没接，属另一单的死代码清理）。
- 不动 `flywheel-lead-wrapper-v2.sh` / `lead-body.sh`。
- 不做「bottom-region 锚定」之类的更复杂识别器。机制真正证明的边界是：**至多发出一个数字键 `1`，且永不附带任何提交键**（不是「绝不会误按任何东西」—— 残余边界见 §1）。在这个边界之上再加一层识别器是过度设计，FLY-193 的历史也说明第二套识别器会带来自己那一类事故。


---

## 8. 实施后记（与计划的差异，以实际落地为准）

PR: #801（`005d0c98` / `4a232918` / `f5de8986` / `aa2907ad`）。Codex design review 5 轮 APPROVED，code review 4 轮 APPROVED。

计划之外**新增**的东西，全部来自 code review 抓到的真缺陷：

| 新增 | 起因 |
|------|------|
| 9 个 v2 `_log_startup` 调用一律 `|| true` | **R1 HIGH**：poller 继承 `errexit`，日志写不进去（权限/`FLYWHEEL_EXPECT_LOG` 指错/磁盘满）会在第一条语句就杀掉后台作业 —— 早于第一次 pane 探测。Claude 照常启动并卡框，launchd 仍报健康。等于「可观测性故障静默关掉了修复本身」。设计阶段我以为 `:1261` 的 `mkdir -p` 兜住了，其实它只兜住「目录不存在」这一种 |
| 用例 T7b | 上一条的回归 |
| 用例 W1b（行为级） | **R1 MEDIUM**：W1 只比源码行号，删掉 `&` 或 `$!` 仍然绿，而那会让 body 同步空转满 timeout 再无保护地启动 Claude |
| 用例 E4、T8 收紧 | **R1 LOW**：计划里写了 E4 但没实现；T8 只证明「至少一条」调用用了 body pane |
| E 层三态判定 + H1/H2/H3 自检 | **R2/R3 MEDIUM**：我为「不许空过绿测」加的 SKIP 出口，自己就是空过绿测 —— 先是 tmux 起不来被当成「本机不支持 raw tty」（跳过、退 0），修完之后**任何** `stty` 失败仍然买得到一次跳过。两次都被 Codex 用 shim 复现 |

**沉淀下来的不变量**：跳过必须凭**肯定性证据**，绝不能凭「没成功」。child 三态分类（`ok` / `denied` / `error`），只有 stderr 真的写明能力被拒（`Operation not permitted` 等）才允许 `denied` 跳过；H1/H2/H3 双向覆盖，且断言**失败原因**而不只是退出码。

其余与计划一致。最终：套件 37/37（macOS bash 3.2 与 Linux CI 均**真跑** E 层，非跳过）；mutation battery 10 条全部能把对应用例打红；v1 两条 digest 哨兵仍然通过，launcher diff 纯增无删。


---

## 9. FLY-1672 design runner 取证的落地（Lead 转来的 4 条）

| # | 他们的结论 | 我这边的处置 |
|---|-----------|-------------|
| ① | v2 body 继承 `TMUX`/`TMUX_PANE`，裸 tmux 可驱动自己 pane | **一致**，与 research §3 独立得到同一结论；实现即按此寻址 |
| ② | belle 没卡框是因为 companion 不注册 inbox MCP，压根没这道框；移植时别给 companion/external 加 | **已按此办，且做成结构性保证**。源码核实：`claude-lead.sh:3355` companion/external 分支让 `INBOX_MCP_ENABLED` 保持 false ⇒ `:3548` 不加 flag ⇒ 无框。我的 poller 用**同一个** `INBOX_MCP_ENABLED` 闸，天然免除。新增用例 **W4** 断言「flag 的闸」与「poller 的闸」是同一个，防止日后有人把两者改岔 |
| ③ | 隔离私有 server 上 `'=session名'` 定位 capture-pane 会 can't find pane，要用 pane_id | **我用的就是 pane_id**（`$TMUX_PANE`），所以实现不受影响。但**这条我没能复现**：新增用例 **E6** 在同样形态的隔离 server（`new-session -d -s main -n main`）上实测，`%0` 与 `=main:main.%0` **两种都работ**。如实记录，不当作对方判断有误 —— 我们的探针可能有差异。附带含义：`test-deploy.sh` 的 QA 外部代偿（用 `=main:main.%0`）**不是**坏的，所以 research §6「QA 房一直在替生产打这一针」的说法成立 |
| ④ | ⚠️ 未验证：send-keys 能否到达 **bg-job 形态**的 claude；必须先让 v1 形状对照组变绿再下结论 | **已补上，这是他们指出的真缺口，我原来的 E2E 确实没覆盖**。E1–E4 的假 claude 是 pane 进程本身 = **v1 形状**，只能当对照组；生产 v2 是 `env -i … claude … &` + `wait`，claude 是 body shell 的**后台作业**共用 pane tty，后台读 tty 有吃 SIGTTIN 的风险，我原来的用例一条也排除不了。新增 **E5**：pane 里跑一个真的 body shell，把假 claude 以 `&` 起再 `wait`，断言 `1` 真的到达。**先 v1 对照组绿（E1/E2），再 v2 形状绿（E5）**，顺序照他们要求 |

套件因此从 37 → **40**。


---

## 10. 验收 1 真机跑（Tadashi 指派我自己跑）— 抓出一个只有真机会暴露的 bug

### 10.1 第一次跑：FAIL，而且是真 FAIL

QA 槽 2 冷启动，`SKIP_DEV_CHANNELS_WORKAROUND=1`（关掉 QA 房的外部代偿，只剩启动链自己）。结果：**Lead 卡在真确认框上，lease 拿不到**。pane 实录 t+144s 仍停在框上。

poller 日志只有一行 `start`，之后什么都没有 —— 没 matched、没 NOT_SEEN、没 pane gone。

对照组（把我的 launcher 改动 stash 掉、其余一模一样）：**同样失败**，且 poller 一行日志都没有。所以两件事同时成立 —— ① 我的接线确实生效了（v2 载体上头一次出现 `dialog-poller-v2` 日志，此前基线 0 条）；② 但 poller 干不完活。

### 10.2 根因：bg job 里的裸外部命令被 bash exec 掉

一连串对照实验（都在真 tmux 上）：

| 实验 | 结果 |
|------|------|
| 把**发布版函数**从外部对着真卡框 pane 跑 | matched → 发 `1` → `confirmed=1` → pane 进 REPL → **lease 出现**。函数本身完全正确 |
| 本地复刻真 body 形状（pane 里跑 body，body 后台起 poller + 后台起假 claude 再 wait） | **一比一复现**：`start` 之后即死 |
| 控制 (a)：`func &` 里的 EXIT trap 会不会触发 | **不会**（bash 3.2）。所以「trap 没打印」根本不能当证据 —— 我的探针在骗我 |
| 控制 (b)：pane shell 的 bg job 里调 tmux client（不带 claude） | **照死**。与 claude、与 raw mode 无关 |
| 矩阵：换写法 | 裸 `command tmux …` → **死**；`</dev/null` → 还是死；**放进 `$( )` → 活** |

结论：**poller 是 body shell 的后台作业，而 body shell 就是 pane 进程本身。在这个位置上，一条裸的外部命令会被 bash 的 subshell exec 优化直接顶替掉**——tmux client 占用了 poller 的进程，跑完退出，循环再也回不来。`capture-pane` 因为本来就写在 `$( )` 里，反而是安全的；偏偏第一个 pane 存活探测是裸调用，于是每次都死在第 0 轮。

v1 为什么没这个病：v1 的 supervisor **不是** pane 进程，claude 在另一个 tmux window 里，两者不在同一个进程/终端位置上。这是 v2 载体独有的形态差异 —— 也正是「只搬不发明」搬不过来的那一部分。

### 10.3 修复

poller 里 4 处 tmux 调用**全部**走命令替换（`$( )`），确保每次都 fork 子进程：pane 探测、两处 capture-pane（本来就是）、send-keys。

### 10.4 我的测试为什么没抓到（诚实记账）

E5 号称「真 v2 形状」，其实只覆盖了一半：它把**claude**放进后台，但 **poller 仍然跑在测试进程的前台**。真正致命的组合是「**poller 自己是 pane body 的后台作业**」，我一条用例都没覆盖。

补 **E7**：pane 里跑真 body 脚本 —— 后台起 poller、后台起假 claude、`wait` —— 断言框真的被按掉。已验证判别力：把修复回退成裸调用，E7 立刻变红，且红出来的形态与生产一模一样（`start` 之后无输出、零按键）。

### 10.5 验收 1 结果：PASS

`TMPDIR=/tmp/f9 SKIP_DEV_CHANNELS_WORKAROUND=1 scripts/test-deploy.sh 2` → **deploy rc=0**

```
01:36:18 dialog-poller-v2: start pane=%0 timeout=90s
01:36:21 dialog-poller-v2: matched dev-channels dialog, sending '1'
01:36:21 dialog-poller-v2: confirmed=1
18:36:26 Lead flywheel-test-2 ready (lease alive, PID 98251)
```

3 秒确认，零人工按键，pane 进 REPL（`❯` 提示符 + Channels 横幅列出 `plugin:discord@…, server:flywheel-inbox`），lease 拿到，Bridge 起来。

短 `TMPDIR` 说明：第一次全链跑 rc=1 是卡在 Lead **之后**的 Bridge 阶段，报 `EINVAL` on `…/browser-tmp/tsx-501/*.pipe` —— 本机已知的 Runner TMPDIR 过长撞 macOS unix socket 104 字节上限，与本单无关；换短 TMPDIR 复跑即 rc=0。

生产未受影响：Bridge `ok=true`、14 个 Lead socket 全在，槽位已 teardown 归还。


---

## 11. ship 前置补丁:闸从「代理」改成「事实」(Tadashi 转 FLY-1676 QA 审计)

### 11.1 缺陷成立(我独立读代码复核过)

| 事实 | 位置 |
|------|------|
| companion/external 明确把 `INBOX_MCP_ENABLED` 置 false | `claude-lead.sh:3368` + 紧随的分支 |
| v1 调用点注释写「Only poll when dev-channels flag is active」,条件却是 `INBOX_MCP_ENABLED` | `:4695-4696`(**main 上就已存在**,我只是忠实复制了它) |
| 全仓**只有一处**加这个 flag,且就以 `INBOX_MCP_ENABLED` 为闸 | `:3563-3564` |

所以今天两者恒等价 —— 这正是当初照抄看起来没问题的原因。但闸守的是**代理**,不是**事实**。FLY-1676 把 `plugin:discord@flywheel-plugins` 变成无条件加入的那一刻:companion Lead 拿到框、代理却读 false、没有 poller 去按、launchd 仍报健康 —— 与 FLY-1672 那次全舰下线**同一形状**。

### 11.2 修法:从 argv 派生,而不是再抄一遍条件

新增 `_dev_channels_flag_active()`:直接扫 `CLAUDE_ARGS` 里有没有 `--dangerously-load-development-channels`。**两个**调用点(v1/v2)都改用它。

这样做而不是新加一个并行布尔量,是因为**唯一真相就是我们真正传给 claude 的 argv**:今后任何一处贡献 development channel 的代码都自动获得 poller,没有第二个地方需要同步 —— 结构上消灭这类漂移,而不是加一个报警器。

### 11.3 v1 要不要一起改 —— 结论:改,而且这是**今天可证的 no-op**

- 缺陷在**闸的概念**上,v1/v2 一模一样。只修 v2 等于留一颗同样爆型的雷。
- 今天可证等价:全仓**只有一个** flag 生产者,且就以 `INBOX_MCP_ENABLED` 为闸(W6 用例把这个前提钉住)。所以 v1 换成 argv 派生,**行为逐位不变**。
- 两处共用同一个 helper,不存在"两个概念各自漂移"。

**哨兵处置**:B1(v1 **函数**摘要)**未动** —— 实测仍是 `3b1f6d3a…`,函数一个字节没改。B2(v1 调用点区块)因为条件那一行变了,按 Tadashi 允许的方式**重新钉**为 `5b73c510…`(21 行),并在测试里写明重钉理由。

### 11.4 新增用例

| # | 断言 |
|---|------|
| W4 | 两个调用点都读真 argv,v2 侧不得再出现 `INBOX_MCP_ENABLED` |
| W5 | helper 分类正确:无 flag→false;inbox 形态→true;**plugin-only(FLY-1676 形态)→true**;空 argv→true 不炸;`--dangerously-skip-permissions`→**false**(精确匹配非前缀,舰队真在传这个 flag);flag 只作为**参数值**出现→false |
| W6 | 今天仍是「单一生产者 + 仍以 INBOX_MCP 为闸」,即 v1 改动是 no-op 的前提。第二个生产者出现时这条会翻面并明说「代理已失效,argv 闸开始承重」 |
| E8 | **真 tmux**:`INBOX_MCP_ENABLED=false` + argv 里有 plugin-only development channel(companion/external 冷启动形态)⇒ poller 照常跑、零人工按键、**确认框确已从 pane 消失**之后才记 `confirmed=1` |

### 11.5 判别力(mutation,每条都真变红)

| mutation | 变红的用例 |
|---|---|
| v2 闸退回 `INBOX_MCP_ENABLED` 代理 | W4 |
| v1 闸退回代理 | W4 + B2 |
| helper 放宽成前缀匹配 | W5 |

> 第一轮 mutation 时 G3(前缀匹配)**没被抓到** —— 说明当时 W5 缺 `--dangerously-skip-permissions` 这个反例,已补。另:mutation 期间 H3 自检会连带变红,因为它递归跑整套,launcher 被改坏时子套件本就该失败;这是 mutation 的附带现象,不是缺陷,正常运行下 H3 绿。

套件 41 → **44**;lint rc=0、build rc=0;supervisor-storm 27/27、expect-script 14/14、fly1663-lead-v2-runtime 19/19、fly1663-foundation 19/19。
