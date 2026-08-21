# FLY-1944 宿主终端链统一加固 — QA 验证报告

Issue: FLY-1944 (https://linear.app/geoforge3d/issue/FLY-1944/宿主终端链-tmux-统一升级-brew-护栏-cmux-守护看门狗并-19501951)
日期: 2026-08-21
基于: plan.md, PR #912, Tadashi 下发的 7 条 QA 判据

## 结论:FAIL

判据 ⑦(Tadashi 明确的硬 FAIL 项)已复现:founder 面向的「这个 runner 在哪个窗口」这条链
仍然会**自信地给出别人的窗口**,而且没有任何报错或告警。本单的立单目的正是「这条链不再骗人」,
所以按判据原文 —— 「复现即按缺陷 FAIL,不可当 follow-up 放行」。

另有 brew 护栏两处真实绕过(判据 ⑥)。其余判据的结论与诚实边界见下表。

| 判据 | 结论 | 依据 |
|---|---|---|
| ① 开窗失败两病根有重试+可见标记 | PASS(单测层) | 两病根均已分型为可重试并入梯子;117/117 |
| ② `--recover` 真机跑一次 | PASS(有边界) | 真进程 SIGSTOP → 7s 内被收掉;bootstrap 腿受限见 §2 |
| ③ 看门狗自愈 / 新窗口 ≤1min | PASS(有边界) | 真冻结进程被真判定为 stalled;端到端墙钟见 §3 |
| ④ runner 启动零可见浏览器 | **未测(本 PR 无实现)** | W5 不在本 PR 内,见 §4 |
| ⑤ 关工作区 60s 内 helper 退出 | **未测(本 PR 无实现)** | 同上 |
| ⑥ brew/全舰工具护栏 | **FAIL** | 两类绕过,见 §6 |
| ⑦ `:pending` 目标串到别的 execution | **FAIL(硬门)** | 见 §7 |

被测版本:分支 `flywheel-FLY-1944`。验证期间实现方持续在推,head 由 `1cc525aa4` →
`d60fb8fe1` → `91eb492e9`(这四个 commit 只动 CI wiring、一处测试 fixture 与文档)。
承载本报告全部缺陷的三个文件 —— `tmux-lookup.ts`、`issue-display-refresher.ts`、
`flywheel-restart-guard.py` —— 在 `1cc525aa4..91eb492e9` 之间**逐字未变**(git diff 为空),
所以结论对当前 head `91eb492e9` 成立。
本次 QA 未执行任何真实 Homebrew / tmux / cmux 变更,生产 watcher(pid 79610,8h03m)全程未被触碰。

---

## §7 判据⑦ — FAIL(硬门):停留在 `:pending` 或已失效的窗口目标会解析成同 issue 另一个 execution

### 根因(实测,不是推断)

`tmux display-message -p -t "<session>:<窗口部分>" '#{window_name}'` 在**窗口部分无法解析时不会报错**,
而是**静默回落到该 session 的当前窗口**。隔离 socket 实测:

```
active window: FLY-1940-implement-codex-G-session-ship-1941-1946

  runner-flywheel:pending                  -> FLY-1940-implement-codex-G-session-ship-1941-1946
  runner-flywheel:FLY-9999-gone-window     -> FLY-1940-implement-codex-G-session-ship-1941-1946
  runner-flywheel:@99999                   -> FLY-1940-implement-codex-G-session-ship-1941-1946
  runner-flywheel:FLY-1944-qa-node         -> FLY-1944-qa-node        (能解析的才是对的)
```

所以受影响的**不只是 `:pending`**,而是三类目标:`:pending`、失效的窗口名、**失效的 `@id`**。
本 PR 给 `probeTmuxWindowLiveness` / `isTmuxWindowAlive` / `sendKeysToWindow` / `killTmuxWindow`
都加了 `:pending` 短路,但**唯独 founder 面向的解析口 `resolveCmuxAttachTarget()` 没有**,
而且失效 `@id` 这一类根本不带 `:pending`,现有短路一条也挡不住。

### 后果链(实测)

`resolveCmuxAttachTarget("runner-flywheel:pending")` 拿到回落来的**别人的窗口名**之后:

1. 它把这个错的窗口名当成解析结果返回;
2. FLY-907 的防串线闸 `attachTargetMatchesIssue(issueIdentifier, windowName)` 收到的是一个
   **看起来完全合法、且同 issue 前缀**的窗口名 → **闸放行**(实测 `true`);
3. 于是 `ensureRunnerAttachPin` 把命令钉进该 execution 的 Discord thread。

两种形态都实测复现:

**形态 A(有 cmux linked session,完全静默 —— 最糟)**
```
resolved = {"kind":"cmux","session":"cmux-FLY-1944-design","windowName":"FLY-1944-design"}
crossWireGuard("FLY-1944","FLY-1944-design") = true
pinned command = env -u TMUX tmux attach -t '=cmux-FLY-1944-design'
```
QA execution 的 thread 里钉的是 **design execution 的 cmux tab**。命令干净、无报错、无告警,
founder 点进去就在别人的窗口里,而且没有任何东西告诉她走错了。

**形态 B(无 linked session)**
```
pinned command = env -u TMUX tmux attach -t '=runner-flywheel' \; select-window -t '=runner-flywheel:pending'
select-window 报错 "can't find window: pending" → 客户端停在 session 的当前窗口 = FLY-1944-exec-A
```

### 为什么防串线闸挡不住

`attachTargetMatchesIssue` 是按 **issue identifier 前缀**判定的。跨 issue 能挡住;
但**同一个 issue 的多个 execution 共用一个 tmux session**,前缀天然相同,闸必然放行。
而且它拿到的不是 `undefined` 而是一个真实存在的错窗口名,连「证据缺失」都看不出来。

### 这不是理论形态 —— 生产库里就是这个拓扑

生产 `~/.flywheel/comm/flywheel/comm.db`(只读查询)当前:

```
FLY-1944|3| 7416f51f=runner-flywheel:@371 | 63f3150d=runner-flywheel:@388 | 85c785f6=runner-flywheel:@496
FLY-1940|3| dfcb231a=runner-flywheel:@374 | 43ffd2ac=runner-flywheel:FLY-1940-implement-codex-G-session-ship-1941-1946 | bb51d512=runner-flywheel:@474
FLY-1925|2| b58b8dbc=runner-flywheel:FLY-1925-implement-codex-G-tick-patrol-tick-run-fo | 66f01364=runner-flywheel:@368
```

同一 issue 三个 execution、同一个 `runner-flywheel` session —— 正是复现所需的全部前提。
FLY-1940 / FLY-1925(Tadashi 点名的两例)那两行还带着**窗口名形态**的目标,
一旦那个窗口退休,它们就落进上面第二类。

### 边界(已排除的更坏情况)

破坏性操作**不共享**这个回落:隔离 socket 实测 `send-keys` 与 `kill-window` 对失效 `@id`
都明确报 `can't find window: @99999`,两个窗口都完好。所以影响面收敛在
**「显示 / attach 解析」这一路**,没有误杀别人窗口的风险。

### 复现脚本

`pending-attach.mts` / `pending-attach-cmux.mts`(隔离 socket `qa1944` / `qa1944b`,真 tmux,
直接 import 被测 TS 源码,不走 dist)。

---

## §6 判据⑥ — FAIL:brew 护栏两类真实绕过

判据本身(`brew install tmux` 在 runner 里被拦)是**过的**;下面两类不过。

### 6.1 wrapper 前缀绕过(`arch` 最要命)

P5 的 wrapper 剥离复用了 `_segment_command()`,而它只认 `{sudo, env, command, time}` 四个;
同一文件上方 150 行的 `_WRAPPERS` 集合(P3 用的)认的是 12 个。实测(runner 态):

| 命令 | 结果 |
|---|---|
| `brew install tmux` / `sudo …` / `env …` / `command …` / `time …` | deny ✅ |
| `arch -x86_64 /usr/local/bin/brew install tmux` | **allow** ❌ |
| `arch -arm64 brew upgrade tmux` | **allow** ❌ |
| `nohup` / `exec` / `nice -n 5` / `timeout 60` / `caffeinate` / `setsid` / `stdbuf -o0` + `brew install` | **allow** ❌ |

`arch -x86_64 …brew` 不是对抗性绕过,而是这台**双 Homebrew 机器上驱动 Intel 侧 brew 的标准写法** ——
也就是本单事故本身的那个场景。护栏对它完全无声(既不拦也不告警)。

### 6.2 `env -S` 带赋值时整段命令被丢掉

```
env -S "FOO=1 brew install tmux"   -> deny ✅
env -S brew install tmux           -> deny ✅
env -S FOO=1 brew install tmux     -> ALLOW ❌
```
`_wrapper_split_string_payload()` 把 `-S` 的下一个 token(`FOO=1`)当作整个 split-string payload
返回,`_brew_mutation_hit()` 递归扫完这个 payload 后 `continue`,**该 segment 剩下的
`brew install tmux` 再也没有被检查过**。实测 `env -S FOO=1 <cmd>` 在 macOS 上确实会执行 `<cmd>`,
所以这是一条真能落地的路径。PR body 写的是 "including wrapper and `env -S` forms",与实测不符。

现有测试只覆盖了带引号的 `env --split-string='brew install tmux'`,没有覆盖不带引号+赋值的形态,
也完全没有覆盖任何 wrapper 前缀 + brew 的组合。

### 6.3 无误拦(回归面干净)

`brew list` / `--prefix` / `info` / `--version` / `brew list | grep tmux` / `ls /opt/homebrew/bin` /
`echo brew install tmux` / `grep -r brew scripts/` / `pnpm install` 全部放行,没有过度拦截。
实现方自带的 204 条用例本地全绿。

### 6.4 顺带:P1–P4 部署护栏是活的(阳性对照)

我第一版 QA harness 里写了 launchd 的停/起子命令,被 FLY-913 护栏当场硬拦。
这是一次真实的阳性对照 —— 旧护栏没有被本 PR 改坏。(后续 harness 改成按参数个数分发的
假 launchctl,全程没有调用过真 launchctl。)

---

## §1 判据① — 开窗失败两病根

两个病根都已在 `codex-runner-tui-window.ts` 分型,且都是**可重试**类,会进梯子:

- `hold_lock_unavailable` → `retryable-hold`(:787)
- `stale_window_unproven` → `retryable-transient-ipc`(:807)

`tmux_absent` → `permanent` 立即终局;梯子外层 30min 绝对 deadline 可抢占在飞 attempt。
`test/codex-runner-tui-window.test.ts` + `test/CodexTmuxAdapter.test.ts` **117/117 本地通过**,
覆盖两病根的分型、退避序列、deadline 抢占、run-ended 取消仍发终局、三触发点去重。

**诚实边界**:plan §4.3 列的「真机并发双 codex runner 抢锁 → 双窗最终出现 + 账面核对」
这一项**没有跑**。理由:它需要在生产 infra 上真起两个 Codex runner;而 §7 已判 FAIL、
`resolveCmuxAttachTarget` 必然要改,这条 E2E 放到修好后的 head 上跑才有意义,现在跑要重跑一遍。
建议列为 rework 后的必跑项,别默认它已被覆盖。

---

## §2 判据② — `--recover` 真机运行(评审两轮点名缺 runtime 覆盖)

隔离 sandbox(独立 lock dir / plist / heartbeat)+ 真 bash + 真 `ps` + 真 SIGSTOP/TERM/KILL;
launchd CLI 用**按参数个数分发的假 binary** PATH-shim,生产 `com.flywheel.cmux-watcher` 全程未被触碰。

已证:
- 真被 SIGSTOP 冻住的 owner(`ps state=T`)在 **7s** 内被 tuple-bound TERM→KILL 收掉(`old_alive=0`),
  远在 60s 内部 deadline 之内;
- **expected-owner tuple 对不上时一个信号都不发**:换成错的 incarnation/nonce → 直接
  `unverifiable ... recovery signalled nothing`,旁观进程存活。防误杀是真的;
- 进程 census 是 fail-closed 的:owner PID 的 argv 形状不像 watcher 就拒绝动手
  (我第一版拿 `/bin/sleep` 冒充,被 `expected owner pid=… is absent from the verified watcher census` 挡回)。

**诚实边界(bootstrap 腿没走完)**:`_crw_watcher_pids` 是**全机范围**按 argv 形状的 census
(`pgrep -f 'flywheel-cmux-sync(\.sh)? +--watch'`)。我的 sandbox 里它看见了**生产那个 watcher**,
于是判定 `watcher survived shutdown verification pids=79610; bootstrap skipped`。
所以在有生产 watcher 活着的机器上,我无法把 bootstrap 那一腿跑完 —— 这是 harness 的边界,不是缺陷。

顺带这也暴露一个**值得知道的生产行为**(不算缺陷,但请知悉):只要机器上存在**第二个** `--watch`
进程(孤儿 watcher、QA 槽 watcher),`--recover` 会先把冻住的 owner 杀掉、然后拒绝 bootstrap,
且 job 已被 bootout 出 domain(KeepAlive 不会再拉起)—— 自愈退化成「杀完不救」。
好在这条路径**会告警**(rider 的 alert body 带 `recovery=failed: <detail>`,severity=severe),
所以是「降级为只告警」,不是静默。日常维护调用(`--once` / `--refresh` / `--qa-teardown`)
不在 pgrep 模式里,**不会**误触发 —— 这点我核过了。

---

## §3 判据③ — 看门狗自愈 / 新窗口镜像

### 已证(真进程 + 真文件系统)

自建 harness 直接 import 被测 TS 源码(`tsx`,绕开 dist 以免测到旧字节),
喂真 SIGSTOP 进程 + 真 owner/heartbeat 文件 + 真 `ps` sensor:

| 场景 | 结果 |
|---|---|
| 冻结 owner + 心跳过期 20min | `stalled`,alert=true,recover=true ✅ |
| 心跳新鲜 | `healthy`,不告警不 recover ✅ |
| 心跳新鲜 + 事件积压 20min | `event_backlog`,**告警但不重启健康 owner** ✅(与里程碑口径一致) |
| park marker 在场 | `parked`,**永不 recover** ✅ |
| owner 进程真的死了 | owner 不 valid,不做任何破坏性动作 ✅ |
| PID 复用(incarnation 对不上) | owner 被拒,不 recover ✅ |

告警 kind `cmux_watcher_stalled` 五处注册齐全并核过:`lead-alert.sh` allowlist(:190)、
`LeadAlertNotifier`(:336)、`infra-event-router`(:86)、`kind-contract`(:307)、`alert-kind-copy`(3 处)。
kind-contract / router / gate-poller / admission-barrier 四个套件本地 **54/54**;
watcher patrol 套件 **16/16**;`restart-cmux-watcher.test.sh` **18/18**;
`host-terminal-cutover.test.sh` **8/8**。

W2 的前置测试门我也独立重跑了一遍:`scripts/qa-tmux-3.7c-compat.sh` 以 exact
`/opt/homebrew/Cellar/tmux/3.7c/bin/tmux` 全绿、**zero skips** ——
cmux-sync **549/549**、cmux-hooks 通过、TmuxAdapter **147/147**、scaffold-race **1/1**。
这一项与实现方的自报一致(它报的是 548,现为 549)。

rider 在 plugin.ts 里是**默认接线、无 flag**,条件是存在 projectName 恰为 `flywheel` 的项目 —
生产 `projects.json` 里确实有(root `/Users/xiaorongli/Dev/flywheel`,leads[0]=`flywheel-cos-lead`),
所以合入后会真的跑起来。

### 诚实边界

1. **端到端「新 tmux 窗口 → cmux tab 出现」的墙钟没有实测**。≤3s 切片 + 事件唤醒的机制层
   有 6 条新用例覆盖,但真墙钟需要一个真 cmux,而 cmux 是单实例 GUI 生产进程,隔离环境起不了。
   founder 那条验收(「新窗口 1 分钟内出 tab」)只能放到 founder 批准的窗口里、和 tmux cutover 一起看。
2. **部署后有一段无覆盖窗口**:生产 watcher(pid 79610,05:44 起)当前**没有心跳文件**
   (跑的是 main 的字节)。合入 + `git pull` 之后 `flywheel-cmux-sync.sh` 的 mtime 变新 →
   owner 启动时间早于 rollout anchor → 落 `legacy_no_heartbeat` 分支 → **静默跳过**。
   这是设计意图(不对旧版误报),但意味着**直到 watcher 被重启之前,看门狗对它没有覆盖**。
   统一重启会带上它,只是别把「合入即生效」当成默认。

---

## §4/§5 判据④⑤ — 本 PR 无实现,未测

W5(playwright 按需 / 无头)**不在本 PR 的改动里**:`git diff main...HEAD --name-only`
没有任何 MCP / playwright / slim 相关文件,diff 里 29 处 `playwright` 全部落在设计 HTML 文档里。
所以④「runner 启动零可见浏览器」和⑤「关工作区 60s 内 helper 退出」在这个 head 上**没有东西可验**。
我不会把「没实现」记成 PASS。

顺手量了一下当前宿主实况(按 argv 精确匹配,不用命令行子串;判据来自 plan §5.2):

- `npm exec @playwright/mcp@latest` 活进程:**78 个**;
- `~/.claude/settings.json` 里 `FLYWHEEL_RUNNER_SLIM_MCP` **未设**,
  `playwright@claude-plugins-official` = **true**(全局开着)→ W5 的 cutover 显然还没做;
- 屏幕上有窗口的 Chrome 是 founder 自己那个(CoreGraphics on-screen window count = 5),
  在 W5 没落地之前没法把它和 runner 拉起的区分开。

78 个空挂 server 这个数字本身说明 W5 还值得单独排期(plan §5.3 记的是「存量 19 个」)。

---

## 建议的修复方向(供实现者参考,不替你定方案)

§7:`resolveCmuxAttachTarget()` 需要一个**能证伪的解析**,而不是信任 `display-message` 的回落。
可选的最小改法是先用 `=` 精确定位再取属性,或者直接对无法证明属于目标 execution 的解析结果
返回 unresolved(走已有的 `ensureRunnerAttachUnresolvedResult` 路径)。
另外 `attachTargetMatchesIssue` 目前用 issue 前缀,挡不住同 issue 多 execution ——
判据需要收紧到 execution 粒度,否则修了解析这一层,下次换个形态还会漏。

§6:让 P5 直接复用 `_WRAPPERS` 那个集合(而不是为「保守豁免」设计的 `_segment_command`),
并且 `env -S` 取完 payload 之后不能 `continue` 掉整个 segment 的剩余部分。
两处都建议补上对应用例:wrapper × brew 矩阵、`env -S <assign> brew <mutation>`。

## 证据清单

隔离 harness(scratchpad,未入库):
`real-frozen-watcher.mts` · `pending-attach.mts` · `pending-attach-cmux.mts` · `recover-real.sh`
