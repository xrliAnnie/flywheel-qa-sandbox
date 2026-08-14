# FLY-1766 QA·PR #838 — 第二轮:8.1 真机层验证报告

Issue: FLY-1766 (https://linear.app/geoforge3d/issue/FLY-1766)
日期: 2026-08-14
基于: qa-report.md(第一轮:静态/隔离层)+ Tadashi 分层合同指令 `c78b2e98`

---

## 0. 本轮范围与结论

Tadashi 采用实现方 PR #838 §8 的分层合同,把我的范围定为 **8.1「合入前可跑」全部**;
**8.2 不做**(部署后半张,由部署后清单承接),**8.3 明确不验**(逐事件 provenance)。

**结论:8.1 的 11 项里 9 项 PASS,2 项(额度/登录扫描「真发」、fleet 传感器「真发」)
卡在 529 房今天的能力边界上 —— 那个房**结构上就投递不了任何告警**,如实见 §5,建议并入 8.2 收。**

| 8.1 条目 | 结果 | 一句话证据 |
|---|---|---|
| `BridgeEventLoopGuard` 沙箱 SIGKILL | ✅ **PASS** | 真进程 **rc=137/SIGKILL** + 取证行;健康对照存活;kill-switch 对照「楔死也不杀」 |
| HeartbeatService 全家 GREEN + 真机 reap | ✅ **PASS** | 12 文件 **244/244**;真 Bridge 上 crash/orphan reaper 真跑(W-1 span 实测落点) |
| 5 rider 真跑 + 逐段隔离 + 重叠防护 | ✅ **PASS** | 真 GatePoller 驱动真 pass:顺序 5/5、**逐段 5 次注入全隔离**、12 tick 不重入;去掉 try/catch → 8 测变红 |
| **late-arm 锚点真机验证** | ✅ **PASS(带真实前基线)** | 同款故障注入:**修前首轮推迟 600.0 秒**(整一个 cadence),**修后 ~15 秒** |
| fleet 传感器搬家后真发 | ⚠️ **接线真机确认;真发被房间结构挡住** | boot 日志逐字 `FLY-1082 fleet sensors wired (… on lead-reconcile tick …)`;但 529 房**没有 alert channel**,任何告警都落不了地(§5) |
| 额度/登录扫描新宿主真发 | ⚠️ **新宿主真跑已验;真 pane 已注入,告警未观测到** | 真 Bridge 上 `runner-quota-scan pass fired` 每 60s(实测 10 连拍);**login-expired 文本已落在真 Runner pane 上**,但 3.5 分钟内无告警,两个候选原因未分离(§5) |
| unreachable-runner 正面注入 | ✅ **PASS** | 真类正面注入 → `founder_reply_unreachable_runner`;episode 闩、重检新 eventId、关闭开关静音四态 |
| w1/w2/w3 fresh + **w1 假-fresh 负测** + probe 双 schema | ✅ **PASS** | 真 Bridge 上 w1 `not_started → fresh`(boot+300s 实测);挂死 owner 永不 fresh(4 负测,突变 3 红) |
| patrol-tick 照常 | ✅ **PASS** | `gate-poller-reconcile-patrol` 套件绿;patrol rider 未被本单触碰 |
| **探针假 page 回归** | ✅ **PASS(最重的雷)** | 真 v2 Bridge:**新探针 ok/0 page,旧探针 degraded/1 page**;同 Bridge 渲染成 v1:两代都 0 page |
| 529 真机 E2E(真 Bridge + 真 Lead + 真 Runner) | ✅ **PASS** | 真 Bridge(head 逐字)+ 真 Lead + **真 Runner 真起**(exec `f846257a…`,真 tmux pane 在跑 Claude)+ **真 Discord thread 真建**(`threadId=1537872970146521098`,隔离频道,生产零污染) |

另外补齐了第一轮欠的两项本地门:**`pnpm -r build` exit 0(22 workspace)**、
**`pnpm lint` exit 0(2426 文件 / 0 error / 7 warning)**,在冻结 head 的隔离 worktree 里跑的。

---

## 1. 环境(真机层)

| 项 | 值 |
|---|---|
| 被测 head | `a30e4c70f330843f71e55913881dd6a96060702e` |
| 529 房 | slot 3,port **19873**,**从被测 worktree 调 `test-deploy.sh`**(遵 `reference_529_bridge_runs_script_repo_not_from_branch`) |
| **一句话验收** | slot Bridge `/health` → `buildSha=a30e4c70f…`,且 boot 日志逐字 `[bridge-boot] running HEAD=a30e4c70f…` |
| `/health` 形态 | 顶层键 **`liveness`**、`schema_version: 2`、components 只剩 **w1/w2/w3**(`w4_lead_blocked` 已随驱动者消失) |
| 两个已知坑 | ① 本 pane 有半套 ambient `FLYWHEEL_ROUNDTABLE_*` → 全程 `env -u` 摘掉;② `TMPDIR` 89 字符 → 全程 `TMPDIR=/tmp/`(sun_path 104) |
| 生产 | 只读;全程未碰生产 Bridge / 未跑 `restart-services.sh` |

---

## 2. A1 — `BridgeEventLoopGuard` 沙箱 SIGKILL(三态对照)

真进程实测(生产类、`testMode:false`、真 worker_threads + 真 SharedArrayBuffer):

```
stall       | rc=137 signal=KILL | stdout=READY enabled=true WEDGING
            | guardlog={"event":"bridge_event_loop_stall","stall_age_ms":2185,"threshold_ms":2000,
                         "at":"2026-08-14T16:13:19.604Z","pid":6994,...}
healthy     | rc=0   signal=-    | stdout=READY enabled=true SURVIVED      | guardlog=(空)
killswitch  | rc=0   signal=-    | stdout=READY enabled=false WEDGING ESCAPED | guardlog=(空)
```

- **stall**:主循环被同步自旋楔死(复刻 2026-06-17 sql.js/WASM 那次)→ **进程被 SIGKILL**,
  即 launchd KeepAlive 可以重启的崩溃。改名没有把行为改死。
- **healthy**:真 CPU 工作但不阻塞循环 → 存活、零告警行(不误杀)。
- **killswitch**(`FLYWHEEL_BRIDGE_LOOP_GUARD=0`)→ `enabled=false`,**同样楔死却活了下来**。
  这一格才是关键:它证明上面那个 SIGKILL 是**这个 guard 干的**,不是巧合。
- 跨进程契约 JSON key `bridge_event_loop_stall` **逐字保留**。

真 Bridge boot 日志同样逐字确认接线:
`[Bridge] EventLoopGuard started (worker-thread heartbeat; SIGKILL self on a confirmed main-loop stall → KeepAlive restart)`。

---

## 3. A4 — late-arm 锚点真机验证(本轮最硬的一条)

### 3.1 第一次对照失败了,我没拿它当结论

先按「修后 vs 去掉 readiness 探针」各起一次真 Bridge:**两边都在 ~13-14 秒内跑了首轮**。
也就是说 **在这台机的启动速度下竞态根本不显形** —— 那次「修后 14 秒」什么都证明不了。
(`start()` 在 plugin.ts:8026,holder 在 9539/9693,中间 49 个 await;但这台机上这段跑完不到 3 秒 = 不到一个 tick。)

### 3.2 加故障注入让竞态显形,再做 A/B

在 holder 赋值**之前**注入 `await setTimeout(15000)`(纯延迟,不改任何判定逻辑),两边**同一份注入**:

| 形态(同款 15s 注入) | 首轮 lead-reconcile | 相对 GatePoller 起点 |
|---|---|---|
| **修前**(无 readiness 探针) | `16:46:32.974Z` | **+600.0 秒 = 整一个 cadence** |
| **修后**(PR head) | `16:48:56.836Z` | **≈15 秒 = holder 装配后的第一个 tick** |

修前那一轮的完整实测序列(每 60s 一条 quota,10 连拍之后 lead-reconcile 才第一次出现):

```
16:36:32 runner-quota-scan   ← quota rider N=20(≈60s)照常
16:37:32 … 16:45:32 runner-quota-scan ×9
16:46:32.974 lead-reconcile  ← 首轮,恰好一个 200×3s=600s cadence 之后
16:46:32.976 runner-quota-scan
```

这正是 Codex R1 MEDIUM-1 描述的缺陷:**未装配的首 tick 不是空跑,而是烧掉锚点**,
把「启动即跑一轮对账」推迟整整一个 cadence。修后消失。

> 观测手段声明:为了让 pass 可见,我在 `runLeadReconcilePass` / quota pass 入口各加了**一行
> `console.log`**(纯观测,不改控制流,diff 已逐行核对为 log-only),两轮用**同一个** shim;
> 15 秒延迟是**故障注入**,不是被测行为。测完全部还原,`git status` tracked diff 为空,
> 重建后 dist 里 `qa1766` 命中数 = 0。

---

## 4. B — 探针假 page 回归(真 Bridge,不是手写 fixture)

真 slot Bridge(`buildSha=a30e4c70f…`)发的是 `liveness` + v2。把它的 `/health` 原样喂两代探针,
连打 6 个 tick 越过 page 阈值,**两组旋钮各跑一遍**(生产默认 grace 5min / degraded 3;以及激进的 1min/3):

```
w1=not_started(boot grace 内)      w1=fresh(稳态)
  AFTER  live v2   : ok      0 page      AFTER  live v2   : ok      0 page
  BEFORE live v2   : degraded 1 page     BEFORE live v2   : degraded 1 page
        ↳ 🚨 Bridge 可达,但 watchdog manifest 缺失或不完整 …
  AFTER  derived v1: ok      0 page      AFTER  derived v1: ok      0 page
  BEFORE derived v1: ok      0 page      BEFORE derived v1: ok      0 page
```

- **修后探针对真 v2 Bridge 零 degraded、零 page** —— 合同要求的那条,成立。
- **修前探针对同一台真 Bridge 每轮 page** —— 事故不是纸面推演,是真会响。
- 同一台 Bridge 渲染成 legacy v1 形状,两代都 0 page —— rollout 窗口**两个方向**都安全。
- 另外:今天的**生产** Bridge(`f3a27971e`)仍发 `watchdogs`(v1),新探针只读实跑 = `ok`/0 page,
  所以部署前那一侧也不会回归。

### 4.1 我自己踩的两个仪器坑(写下来,因为不查就会报错结论)

1. **第一版 A/B 让两代探针共用同一个 state 文件** → BEFORE 在第二次跑时把 stalled 计数累加过阈值、
   多发了一条 W-2 page,看起来像「两代行为不同」。其实两边默认阈值都是 2,**是我的 harness 污染**。
2. **第一版把 grace 设成 1 分钟**,而 W-1 的真实 cadence 是 `TEAMLEAD_STUCK_INTERVAL` 默认 **5 分钟** ——
   grace 短于 cadence 会把「boot 后还没跑完第一轮」判成 degraded。这是我的旋钮设错,不是产品缺陷;
   换成生产默认后 AFTER 立刻 `ok`。

---

## 5. 529 真机 E2E 做到了哪一步,以及卡在哪(如实,不含糊)

### 5.1 做到了的(item C)

真 Bridge(`buildSha=a30e4c70f…`,boot 日志逐字 `[bridge-boot] running HEAD=a30e4c70f…`)
→ 真 Lead(`flywheel-test-3`,launchd v2 载体,lease 真活)
→ **真 Runner 真起**:`POST /api/runs/start` → `{"success":true,"executionId":"f846257a-c429-4591-8911-0c817dbd315e"}`,
  slot StateStore 里 `f846257a… | FLY-1766 | running | test-slot-3`,
  真 tmux 窗口 `runner-test-slot-3:1`(名字 `FLY-1766-runner-claude-Fable-…`)里跑着真 Claude
→ **真 Discord 腿**:`[ChatThreadCreator] create thread channel=1493080995862413439` →
  `[DirectEventSink] ensureChatThread: created=true threadId=1537872970146521098`
  —— 隔离测试频道,**生产频道零污染**。

一个前置坑值得记下来:slot 3 的 lead 默认 `match.labels = ["*"]`,而 `classifyIssue()` 做的是
**字面集合求交,`"*"` 不是通配符** —— 所以默认房**任何真 issue 都起不了 Runner**
(`DEPT_SCOPE_REJECT / issue_no_department_label`,传 `leadId` 也绕不过,FLY-127 明文)。
正解是 `test-deploy.sh --lead-label <该 issue 真有的 label>`(我用 `--lead-label Flywheel`)。
另:`TEST_REPLY_BY_ISSUE=1` 会给 Bridge 装 `TEAMLEAD_API_TOKEN`,而 `inject-linear-issue.sh`
**不发 Authorization 头** → 必然 401;要么不开该开关,要么用 `TEST_API_TOKEN=` 钉死 token 后自己 POST。

### 5.2 卡住的:告警腿在默认 529 房**结构上就落不了地**

login-expired 文本**已经真的落在真 Runner 的 pane 上**(证据留档
`evidence/slot3-runner-pane-login-expired.txt`:`❯ API Error 401: Your session has expired. Please run /login to sign in again.`),
但 3.5 分钟内 **没有观测到 `runner_login_expired`**。查下来有两个候选原因,我**没有**把它们分离开:

1. **房间根本发不出告警(已证实的结构性原因)**:slot lead 配置里
   `alertChannel / generalChannel / alertFallbackToCore` **三个全空**,Bridge 在 boot 时就打了
   > `[Bridge] ALERT-UNREACHABLE lead="flywheel-test-3" project="test-slot-3": no alertChannel and no alertFallbackToCore+generalChannel — alerts cannot resolve a channel`

   也就是说 **任何** 告警(`runner_login_expired`、fleet 传感器、其它)在这个房里都**解析不到频道**。
   这不是本 PR 的问题,是 529 房今天的能力边界 —— 而补上这块能力的
   **FLY-529「alerts 镜像」本身还是 ⏳ Pending ship**(见 CLAUDE.md 里程碑表)。
2. **1h/session claim 可能已被消耗**:扫描是每 session 每小时一次,session 在 `10:18:22` 转
   `running`,我在 `10:22` 才注入 —— 中间有过 quota tick,若那一轮 capture 成功,claim 就被吃掉,
   下一次要等一小时。

**结论口径**:我**不**报「额度/登录扫描真发 PASS」,也**不**报「它坏了」——
证据只支持「注入到位、未观测到告警、且这个房本来就投递不了告警」。

### 5.3 要把这条真正收掉,需要什么

- 给 529 房配一个隔离 alert channel(= FLY-529 alerts 镜像那条能力),或临时给 slot lead 写
  `alertChannel`;并且
- 在 session 转 `running` 后的**第一个 quota tick 之前**完成 pane 注入(或重启 slot Bridge 清掉
  内存里的 `lastScannedAt` claim)。

我的建议:**并入 8.2 部署后清单**一起收(生产有真 alert channel,那里天然能观测),
而不是为它继续加房。fleet 传感器「真发」同理。

### 5.4 已经拿到的、但不等价的替代证据

- 新宿主**真跑**:真 Bridge 上 `runner-quota-scan pass fired` **每 60 秒一条、连续 10 条**(A4 那轮带 shim 的实测);
- 扫描逻辑本身:真 `makeRunnerQuotaScanPass` + login-expired pane 的隔离验证 **5/5**
  (含 1h/session claim 门、非 running 过滤、capture 失败**不**吃掉 claim、单个 scan 失败不中断扫描);
- fleet sensors 接线:boot 日志逐字确认挂在 lead-reconcile tick 上,且 A4 已证明这个 tick 宿主
  在 boot 后 ~15 秒就真的跑起来了。

我不把「接线正确 + 宿主真跑」写成「传感器真发过」—— 那是两件事。

---

## 6. 其它真机观察

1. **结构性部署证明(8.2 的形状,但我在 8.1 顺手取到了)**:被 slot Bridge 真正加载的
   `packages/teamlead/dist` 里,`LeadWatchdog` / `RunnerIdleWatchdog` / `applyStallWatchdog`
   **零命中**;7 个被删模块的 `.js` **全部不存在**;6 个改名幸存者 `.js` **全部存在**。
2. **W-1 真驱动落点实测**:slot Bridge boot `16:19:14.392Z` → w1 在 `16:24:19.578Z` `started`、
   `16:24:19.581Z` `completed`、翻 `fresh` —— 恰好一个 `TEAMLEAD_STUCK_INTERVAL`(300s)之后。
   新驱动(HeartbeatService `reconcileMonitorLoss → reapOrphans` span)在真机上确实在驱动它。
3. **环境项(非本 PR)**:第一次 `test-teardown.sh 3` 因为等不到 cmux mutator lease(owner
   `mode=watch pid=94092`)**超时 60s 放弃、零动作**;重跑即成功。属 FLY-1482 那一族的既有现象,
   记录备查。

---

## 7. 本轮所有实测数字

| 门 | 结果 |
|---|---|
| `pnpm -r build`(22 workspace,冻结 head 隔离 worktree) | ✅ exit 0 |
| `pnpm lint`(同上) | ✅ exit 0 — 2426 文件,**0 error / 7 warning** |
| HeartbeatService 家族 + fleet-sensors + exit-marker + patrol + liveness-manifest | ✅ 12 文件 **244/244** |
| 我的四套独立 harness(rider 重放 / rider 契约 / 保留项契约 / 额度扫描新宿主) | ✅ 4 文件 **25/25** |
| loop-guard 真进程三态 | ✅ 3/3(KILL / 存活 / kill-switch 存活) |
| 探针真 Bridge 假-page 回归 | ✅ 4 组场景 × 2 代探针 = 8 次,全部符合预期 |
| 本轮突变检验 | ✅ 逐段 try/catch 去掉 → 8 测红;tracker generation 守卫去掉 → 3 测红;全部还原 |

第一轮(PR #840)的数字仍然有效:残留守卫 7/7 + 5 突变、探针套件 30/30、
`fly1674-residue` 53/53、`check-flag-truth` 2/2、改动测试文件 14 文件 122/122、CI 9/9 @ 精确 head。

---

## 8. 纪律

- **零 commit 到 `flywheel-FLY-1560`**;复核 head 仍是 `a30e4c70f`,共享 worktree tracked diff 为空。
- 全部真机操作在**独立 detached worktree**(scratchpad)+ **529 slot 3** 里做;
  观测 shim / 故障注入**全部还原并重建**,冻结 worktree tracked diff 为空、dist 零残留。
- 生产 Bridge 只读探测,跑前跑后 `buildSha` 同为 `f3a27971e`;未跑 `restart-services.sh`。
- 第一轮的 4 条 advisory(F1 Lead 巡检规则说已死事件还活着 / F2 两个 infra-bot identity 仍点名
  LeadWatchdog / F3 探针套件最强断言静默跳过且不在 CI / F4 注释腐化)**本轮未变**,仍建议修。
