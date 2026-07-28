# FLY-1507 QA 报告 — restart 换管家不换真身

Issue: FLY-1507
日期: 2026-07-27
被测: PR #714 / branch `flywheel-FLY-1507` @ `c65d158b`
QA exec: abafbd11-1127-4216-bf89-02d491a4545e
判定: **FAIL**（1 个确定性缺陷，5/5 复现；恰好命中本单要修的那条路径）

> 证据与复现脚本按 Lead 的零提交纪律留在 `~/.flywheel/qa-artifacts/FLY-1507/`，不进 git。

---

## 1. 结论速览

| 项 | 结果 |
|---|---|
| 现有单测（2 套 shell suite，104 断言） | ✅ 全绿 |
| bash 3.2 语法（5 个改动脚本） | ✅ 全过 |
| CI（PR #714 全部 check） | ✅ 全绿 |
| 生产载体真实形态适配（17 个 Lead plist 跑真 validator） | ✅ 15 PASS / 2 已知边界 |
| fleet 候选清点（真 manifests + 真 plist + 真进程表） | ✅ 与实机一致 |
| 真机 E2E：健康 Lead 重启（假阴性检验） | ✅ 通过，日志带真身证据 |
| 真机 E2E：**孤儿 Lead 重启**（本单核心场景） | ❌ **失败：换身成功却被判 failed** |

**一句话**：换身逻辑本身是对的——孤儿真被杀了、新本体真出生了、model 真变对了；
但**清场返回码把「目标正常死亡」误判成「传感器故障」**，于是重启对这台 Lead 报 FAILED。
方向是**假阴性**（不是假阳性），但计划 §0 的不变量 I1 写的是「假阴性零容忍」。

---

## 2. 🔴 缺陷 D1：目标正常死亡被判为传感器故障 → 清场误报 unsafe

**严重度**：高（阻塞 ship）
**复现率**：**5/5 确定性**，非偶发竞态
**触发条件**：清场阶段真的需要终结一个活着的本体时 —— 即**存量 9 个 4.8 冻结孤儿的每一台**

### 代码路径

`scripts/lib/lead-body-sweep.sh:53-62`

```
_lead_body_tuple_state() {
  lead_body_process_alive "$pid" || return 1                       # kill -0
  actual_start="$(lead_body_process_start_identity "$pid")" || return 2
  [ -n "$actual_start" ] || return 2                               # ← 命中这里
  ...
```

进程从「活」到「被回收」中间存在一个**真实可观测的中间态**：
`kill -0` 仍成功（进程条目还在／僵尸未被 tmux 回收），但 `ps -p <pid> -o lstart=` 已经读不到。
代码把这个状态归成 **rc=2 = 传感器故障**，而它其实是「目标死了」= rc=1。

往上传播：
`_lead_body_any_full_alive`（:426）`saw_sensor_error=1` → 返回 2
→ `_lead_body_wait_stage`（:439）立即 `return 2`
→ `lead_body_terminate`（:529）`rc=2`
→ `restart_lead`（:1116）`sweep_rc=1` → `ERROR: body sweep is incomplete/unsafe` → **return 1**

注意 `lead_body_process_start_identity` 是 `ps | sed` 管道，返回的是 **sed** 的退出码（恒 0），
所以 `|| return 2` 那一支永远不触发，真正触发的是紧随其后的空值判定。

### 实测证据（真 launchd + 真 tmux + 真进程，5 轮全中）

传感器逐拍轨迹（`probe-sensor-race.sh`，覆写库自带的 test seam 记录每次观测）：

```
alive(92688)=yes  lstart='Mon Jul 27 20:49:34 2026'  state=Ss+   ← 活着
alive(92688)=yes  lstart=''                          state=      ← 中间态：这一拍被判 rc=2
alive(92688)=no                                                  ← 已回收
```

分步跑 `lead_body_terminate` 的每个子步骤（`probe-terminate-rc.sh`）：

```
collect rc=0   快照 complete，恰 1 行：28202  full  window  @1  %1   ← 快照完全正常
send_interrupts rc=0
wait(C-c)       rc=2      ← 唯一的 2
signal TERM     rc=0
wait(TERM)      rc=0
signal KILL     rc=0
wait(KILL)      rc=0
any_full_alive  rc=1      ← 没有幸存者
has_live_detect 0         ← 没有 detect 行
cleanup_windows rc=0      ← 窗口清干净
cleanup_archive rc=0
orphan alive now: no      ← 孤儿确实死了
panes now: scratch        ← 窗口确实没了
```

**每一个语义子结论都是「干净成功」，唯独一个中间态观测把整体拖成 rc=2。**

批量复现：

```
round 1..5: terminate_rc=2, orphan_alive_after=no
terminate_rc==2 in 5 / 5 rounds
```

### 端到端后果（真 restart_lead，前后对照）

同一个孤儿夹具，分别跑 `main` 和本分支的**真** `restart_lead()`：

```
── AFTER (branch @ c65d158b) ──
  orphan BEFORE: pid=62732  model=claude-opus-4-8[1m]
  branch| ERROR: Lead drill-lead body sweep is incomplete/unsafe (collect=0 terminate=2)
  branch| WARNING: Lead drill-lead restart failed, but its launchd job was restored
  branch| RESTART_LEAD_RC=1                       ← 报失败
  orphan AFTER: alive=no                          ← 但孤儿真死了
  new body: pid=65945  model=claude-fable-5       ← 新本体真出生、model 真变对
```

即：**实际效果是对的，报告是错的。**

### 影响面

1. **claude-code Lead（8 台 4.8 冻结孤儿）**：模型会收敛（recovery bootstrap 兜住了），
   但每台都计 `failed` → `leads-partial-failed` 告警 + Lead restart status 长期 `degraded`。
   验收条款 2「restart 日志对每个 Lead 的成功与真身替换一致(无假阳性)」方向上没破，
   但计划 §0 的 **I1「假阴性零容忍」**被破。
2. **codex-app-server Lead（Mufasa）更严重**：`restart_lead` 在三个失败出口都硬传
   `sweep_safe=false`（`restart-services.sh:1101/1108/1120`），而
   `lead_restart_recovery_bootstrap_allowed`（`lead-restart-lifecycle.sh:303`）对 codex
   要求 `sweep_safe=true`。所以只要 codex Lead 走到「清场失败」这条路，
   就是 `alert_severe` + **不 bootstrap = Lead 离线等人工**。
   D1 让这条路在「本来完全成功」的情况下也会被走到。

### 为什么 104 个单测没抓到

`scripts/test-lead-body-sweep.sh:85-88` 的 stub 让 `alive` 和 `lstart` **原子翻转**：
pid 一进 `DEAD_PIDS`，`lead_body_process_alive` 立刻返回 1。
mock 里根本不存在 `alive=yes && lstart=''` 这个真实中间态，所以 stub 层永远绿。
（这正是「mock 测试需 real-tool 补位」那条老账。）

### 建议修法（供实现者参考，不代做）

在 `_lead_body_tuple_state` 里把「读不到 lstart」再做一次死活复核：
`ps` 读空时重新 `kill -0`，若已不存在则判 **rc=1（确定死亡）**而非 rc=2；
只有「进程确实还在、但 lstart 读取失败」才算真传感器故障。
修完请用 `probe-sensor-race.sh 10` 复验（应 0/10 命中 rc=2），
并给 stub 补一个「alive=yes + lstart 空」的中间态用例，避免回归。

---

## 3. 🟡 观察 O1：Mufasa（codex）当前没有可被验证器认到的窗口

QA 时点实测：`tmux list-panes -a` 全服务器**没有任何** `growth-mufasa-lead` 窗口，
也没有 `codex resume --remote unix://…` 形态的进程（她当前跑的是 `codex-lead-tui-runtime.js`）。

而 `lead_body_newborn_ok` 要求：`flywheel` session 内恰 1 个同名窗口 + 恰 1 个 live pane + argv 全证明。
若她被重启，这一步会失败 → 报 FAILED（bootstrap 已先执行，所以不至于离线，但仍是假阴性）。

**未下定论**：需要确认她的 TUI 窗口正常形态下是否会出现在 `flywheel` session。
若不会，验证器对 codex backend 就是结构性无法通过。建议 ship 前由实现者确认。

---

## 4. 🟡 观察 O2：Anna 让每次重启永久 `failed:1`

`flywheel-anna-interviewer-lead` 的 plist 已加载（`state = spawn scheduled`），
但既无 manifest、projects.json 里也没有条目 → 新清点判 `config-drift` → **计 failed**。
旧代码根本发现不了她（她没有 `claude-lead.sh` 进程），所以这是**新增**的常驻失败。

这是计划 §2.3f 明写、Codex R5 批过的**有意行为**（「绝不静默」），
但运营后果要让 Annie 知道：ship 后每次统一重启都会是
`failed≥1 + skipped≥1` → 状态永远 `degraded` + `leads-partial-failed` 告警，
直到 Anna 的 plist 被移除/登记、codex-infra-bot 补上 manifest。
（`codex-infra-bot-lead` 走 `manifestless` → skipped，符合计划。）

---

## 5. ✅ 已验证正确的部分（不要在修 D1 时改坏）

**真机（真 launchd + 真 tmux + 真进程）**

- 健康 Lead 重启零回归：旧本体消失、新本体出生、成功日志带完整真身证据
  `Lead drill-lead restarted via launchd (supervisor 74831 born …, body PID 74919 born …, model claude-fable-5)`
- 换身实质有效：孤儿 `claude-opus-4-8[1m]` → 新本体 `claude-fable-5`（founder 最关心的一条）
- **前后对照**：同一夹具下 `main` 的 `restart_lead` 走 `kickstart -k`，
  本分支走 `bootout → 静默期 → 清场 → bootstrap`，且**再没有** `kickstart -k`
- 真 launchd 三态 probe：loaded 时拒绝判静默；bootout 后正面 unloaded + 旧 tuple 证死才放行；
  bootstrap 产出的确实是新 supervisor

**读-only 打真生产配置**

- 17 个生产 plist 逐个跑真 `lead_restart_validate_authority`：
  15 PASS（14 claude + Mufasa codex），2 FAIL 恰是计划 §6 已声明的 manifestless 边界
- 真 fleet 清点：15 restart / 1 manifestless / 1 config-drift / 5 QA skip，与实机逐条对得上
- 生产 plist 形态（argv0=/bin/bash、标准 wrapper 三参、两个定制 codex carrier 两参）
  与闭集矩阵完全吻合——preflight 不会误伤任何在产 Lead

**存量 bug 现场（before 基线，本次采集）**

8 台 4.8 冻结本体仍在跑：
`cos-lead(1745) ops-lead(62473) sub-lead(46844) joycon-lead(98252) product-lead(36568)
flywheel-cos-lead(60964) flywheel-product-lead(57594) tidal-echo-content-lead(15465)`
另 `reflection-lead(2622)` 停在 `sonnet`（7/22 出生）。

---

## 6. 复现材料

| 文件 | 用途 |
|---|---|
| `bodyswap-drill.sh` | 真机换身演练：真 launchd 抛弃型 label + 真 tmux + main/branch 真 `restart_lead` 前后对照 |
| `probe-terminate-rc.sh` | 把 `lead_body_terminate` 拆成子步骤逐个打 rc，定位到 `wait(C-c)` |
| `probe-sensor-race.sh [N]` | 覆写 test seam 记录 alive/lstart 逐拍观测，统计 rc=2 命中率 |
| `lib-level-e2e.sh` | 库级真 tmux/真进程场景（含跨项目撞名、多 pane 保护） |
| `drill-run.log` / `evidence-*.txt` | 演练输出与前后 ps 证据 |

**爆炸半径**：全部使用抛弃型 launchd label `com.flywheel.lead.fly1507qa-drill-lead`、
独立 tmux socket、独立假 HOME。未触碰任何生产 Lead / plist / 窗口 / 进程；
演练结束 label 已 bootout、进程已清理。

（说明：演练需要真 launchd，Tadashi 转达的 founder 指令第 ② 条明确授权
「搭一个假 Lead(临时 launchd label+假 claude 进程)做全链路演练」。
FLY-913 部署护栏拦的是手动重启**生产**服务，与本抛弃型 label 无关。）

**夹具口径说明**：演练里的「本体」是一个套着生产 argv（`claude --agent <lead> …
--append-system-prompt-file <bundle> --model <m>`）的 sleep 进程，不是真的 Claude ——
因为清场读的是身份契约（argv + pid/lstart + 窗口名），不是 Claude 本身的行为。
真实 Claude 对 C-c 的响应可能比 sleep 进程慢，但那只会让 D1 更容易命中（停留在中间态更久），
不会掩盖它。
