# FLY-1602 重启换代孤儿/lease catch-22 — QA 验证报告

Issue: FLY-1602 (https://linear.app/geoforge3d/issue/FLY-1602/基建a-重启换代-lead-失败即孤儿-lease-catch-22-每次-restart-挂掉只能人工捞回)
日期: 2026-08-03
基于: plan.md

- attempt 1 head `1ce30644` → **FAIL**
- attempt 2 head `607c0a4f`(= origin/flywheel-FLY-1602 = PR #764,验证前后各核对一次)→ **仍 FAIL**

核心结论:**孤儿 body 依旧一次都没被收养过。** issue 的核心验收(换代失败后自愈、不需要人工捞回)两轮都未达成。

---

## 1. 验证台架(真机、生产零接触)

现有 4-slot QA Room 验不了这个改动:收养链第一道门是 V9「受管 launchd 属权」,而 QA slot 是无 plist 的裸进程,按 R4-3 一律不许 adopt。因此自建隔离台架:

| 组件 | 真实性 | 隔离手段 |
|---|---|---|
| launchd | 真 `gui/$UID` job | 独占 label `com.flywheel.lead.qa1602-probe-lead`,KeepAlive + RunAtLoad |
| supervisor | 真 `claude-lead.sh`(分支代码,经真 wrapper exec) | 独立 HOME → 独立 lease DB / pids / manifests / projects.json |
| body | 真进程、真 argv(含 `--session-id`)、真 tmux 窗口 | 编译的假 `claude`(保留 argv、阻塞),独立 tmux socket |
| lease | 真 sqlite,真 migration | lease DB 落在隔离 HOME |
| 告警 | 真 `lead-alert.sh` 调用 | queue/deadletter/claims 三处 env 隔离,出站不通 |

---

## 2. attempt 2(head `607c0a4f`)结果

### 已修复(逐条实测)

| 编号 | 状态 | 证据 |
|---|---|---|
| **F1** census 自 fork 误报 | **已修** | `lead_identity_process_table` 现在先吐 `#sensor <pid> <ppid>` 再 exec ps,census 沿祖先链只排除被证明的 ps 调用链。独立复现 3/3 从 CENSUS NON-EMPTY 翻成 **CENSUS EMPTY**;真机 HOLD 原因也从 `foreign_supervisor_present` 前进到了下一道门 |
| F1 **反向控制**(没被过度遮蔽) | **通过** | 种一个 ancestry 无关的真异己 supervisor → 仍被检出;自己 fork 的**同名子进程** → 仍被检出。双活保护 V1 完好 |
| **F6** npm payload closure | **已修** | 三个 lib 全进 `package-onboard.sh` + `package-onboard-files.allow`,`package-onboard-smoke` 新增断言覆盖后两个 source 点。CI 在 `607c0a4f` 上**全绿 9/9** |

### F7(新 BLOCKER)— tmux 在 launchd 极简环境下把 `-F` 的 tab 消毒成 `_`,收养证据闭集永远算不出来

**真机现象**:强制终止 supervisor 32632 → 孤儿 body 60426 存活 → 继任者起来 → **37 次 `adoption_evidence_not_closed`,约 20 分钟,跨两个继任 supervisor(78304、50531)**,lease 的 supervisor tuple 始终停在已死的 32632,收养一次都没发生;结束靠我手工卸载 job。

**根因(xtrace 在真 supervisor 里抓到,非推测):**

```
++[lead-body-sweep.sh:420] inventory='@0_zsh_%0_37738_0
@2_qa1602-probe-lead_%2_60426_0'          ← 分隔符是下划线,不是 tab
++[lead-body-sweep.sh:425] IFS='<TAB>'
++[lead-body-sweep.sh:427] '[' '' = qa1602-probe-lead ']'   ← window_name 空
++[lead-body-sweep.sh:462] '[' 0 -ne 1 ']'                  ← window_count=0
++[lead-body-sweep.sh:464] status=unsafe                    → rc 1 → not_closed
```

`lead_body_pane_inventory`(`scripts/lib/lead-body-sweep.sh:39-42`)拿 tab 当 `-F` 分隔符。传给 tmux 的参数确实是真 tab(已 od 逐字验证),但 **tmux 3.5a 在没有任何 locale 变量的环境里把输出中的 tab 消毒成 `_`** → `IFS=$'\t' read` 切不开 → 整行落进 `window_id` → 无行匹配窗口名 → `window_count=0` → `status=unsafe`。

**环境对照(逐项实测,基线 `env -i HOME=… PATH=…`):**

| 环境 | 分隔符 |
|---|---|
| launchd 极简环境(基线) | `_` **broken** |
| `+TERM` / `+SHELL` / `+USER` / `+LOGNAME` / `+TMPDIR` / `+SSH_AUTH_SOCK` | `_` 仍 broken |
| `+LC_ALL=C`(**仓库惯用写法**) | `_` **仍 broken** |
| `+LANG=en_US.UTF-8` | tab ✅ |
| `+LC_CTYPE=UTF-8` | tab ✅ |
| 改非空白分隔符(如 `\|`),无 locale | 正常 ✅ |

`LC_ALL=C` **治不了**,别照抄仓库里其它进程表函数的写法。

**为什么以前没暴露**:`lead_body_pane_inventory` 是既有函数(main 上就有),但 main 的 `claude-lead.sh` 从不调用它(grep = 0);它原来只服务 restart-services 的 sweep 路径,而那条路是从终端跑的、locale 齐全。FLY-1602 **第一次把它放进 launchd 起的 supervisor 里跑**,所以现在才炸。

**生产同样成立**:12 个生产 Lead plist **无一** 设置 `LANG`/`LC_ALL`/`LC_CTYPE`(逐个 grep,locale-keys 全 0);台架是同域(`gui/$UID`)、同 plist 形态的真 launchd job,端到端复现。(直接读活进程 env 这条路不可用 —— 本机 `ps -Eww` 连 HOME/PATH 都读不到,尺子本身是坏的,故不以此作证。)

**建议修法**:`-F` 换成非空白可打印分隔符(最稳,不依赖环境),或在 `_sweep_tmux` 里显式给一个 UTF-8 locale;**不要用 `LC_ALL=C`**。修完补一条**无 locale 环境**下的回归 —— 现有 harness 全从终端跑,这一类结构上看不见。

## 2b. 变异判据 — 收养单测断言是否真的在跑(Lead 指定的第②条)

在**独立副本**上跑(共享工作树全程未改)。每个变异都故意破坏收养逻辑,有判别力的断言必须变红。

| 变异 | 结果 | 判定 |
|---|---|---|
| M0 基线(未变异) | GREEN,30 pass / 0 fail | 基线成立 |
| **M1 `FLYWHEEL_COMM_CLI` 不设** | **RED,11 fail** | ✅ **评审官的疑虑排除** —— 收养断言确实在执行 |
| M2 去掉 sensor 链排除 | RED,2 fail | ✅ 自 fork 那一类有判别力 |
| M3 排除面放到最大(遮蔽真冲突) | RED,1 fail | ✅ 双活保护有判别力 |
| **M4 抑制 `#sensor` 标记(census 恒 rc 2)** | **GREEN,30 pass / 0 fail** | ❌ **零判别 —— 见 F8** |

### M1 细节:断言是真的在跑

`FLYWHEEL_COMM_CLI` 一去掉,11 条断言立刻变红,其中两条正是收养的:

```
[TEST] FAIL - orphan classification did not preserve its tuple evidence
[TEST] FAIL - idempotent adoption did not preserve its holder evidence
```

`lead_identity_prepare_lease` 开头那道 sentinel(`identity_cli_unavailable`,lib 第 44-47 行)确实会吞掉后面所有逻辑 —— 但它**fail-loud**,不是静默变绿。所以评审官担心的「断言可能没真正执行」在 CLI 存在时**不成立**;CI 绿 = CI 环境里该变量是有的。

附带一条工艺提醒(非缺陷):harness 自己从不设 `FLYWHEEL_COMM_CLI`(grep = 0),完全依赖环境里恰好有。方向是安全的(缺了就红),但这是个隐式环境依赖,建议 harness 自带一个 fixture CLI 路径,别靠运气。

### F8(NEW,MEDIUM)— census 永久 fail-closed 会带着绿灯上线

M4 把 `#sensor` 标记抑制掉后,真实的 census 变成:

```
mutated census rc=2 census=[]        ← 连真的异己 supervisor 702 都不报了
```

但整套测试**仍然全绿**,四条 census 断言一条不落地报 ok:

```
[TEST] ok - supervisor census excludes the complete nested sensor chain and unrelated Leads
[TEST] ok - supervisor census reports an exact foreign supervisor
[TEST] ok - supervisor census sensor failure is fail-closed
[TEST] ok - real nested census is fail-closed when the host process table is unavailable
```

两个原因叠在一起:

1. **前三条用 `FAKE_SUPERVISOR_TABLE` 桩掉了 `lead_identity_process_table`** —— 它们对这个函数本身的任何回归天然免疫,`#sensor` 标记坏没坏它们看不见。
2. **唯一走真进程表的那条(本轮新增的真嵌套子 shell 测试)把 rc 2 当成通过**:
   `if [ "$real_census_rc" -eq 2 ]; then ok "real nested census is fail-closed when the host process table is unavailable"`。

再叠上第一条断言只判 `[ -z "$census" ]`、**不判返回码** —— 「census 干净」和「census 已死」在断言层长得一模一样。

后果:任何让 sensor 标记不可解析的回归 → census 恒 rc 2 → 继任者恒 HOLD → **生产里就是 FLY-1602 本身**(永不收养),而测试套件一路绿灯放行。

公平地说,fail-closed 对**安全性**(双活)是对的方向,坏的是**活性**;而这单要治的恰恰就是活性,所以这个绿灯零判别值得堵。

**建议**:真拓扑那条把 rc 2 判为失败(或至少在标记可解析时必须判失败),并给前三条断言补上返回码断言;另外补一条**不桩** `lead_identity_process_table` 的用例。

### 顺带:F7 为什么单测层也接不住

`scripts/test-lead-body-sweep.sh` 把 `_sweep_tmux` 整个桩掉了(第 125 行),全程不碰真 tmux(`FLYWHEEL_TMUX_SOCKET_OVERRIDE` / `tmux new-session` 出现次数 = 0)。所以「tmux 在无 locale 环境下把 tab 消毒成下划线」这一类**在现有单测结构里不可见**,只能靠真机台架抓。这也解释了为什么 F7 能连过两轮 review 和全绿 CI。

---

## 3. attempt 1(head `1ce30644`)已修复项的原始记录

### F1(已在 attempt 2 修复)— census 把自己的子 shell 当异己 supervisor

`lead_identity_supervisor_census` 原先只排除 `$$`,却在命令替换里跑 `ps`;自己 fork 的子 shell argv 与父进程逐字相同、PID 不是 `$$`,被判成异己 supervisor。真机 16 次 `adoption_hold` / 7 分钟不自愈;独立复现 3/3(零其它 supervisor 时仍返回 2 个命中,PID 回查已消失)。

单测漏掉是因为 `test-lead-identity-preflight.sh:242` 用 `FAKE_SUPERVISOR_TABLE` 桩掉进程表。

### F6(已在 attempt 2 修复)— 三个新 lib 不在 npm onboard payload closure

`package-onboard-smoke` ④d 失败,`claude-lead.sh:234` 找不到 `lead-restart-lifecycle.sh`。注意归属:红的是 *Script Tests (shell suites)*,*NPM payload distribution* 那项当时是 pass。

---

## 4. 仍未修的其余问题

| 编号 | 级别 | 内容 |
|---|---|---|
| **F2** | MEDIUM | `claude-lead.sh:3393` 的 `${ENSURE_HOLD_EVIDENCE:-{\"reason\":…}}`,bash 参数展开在第一个未转义 `}` 处结束,尾巴两个 `}` 变字面量。本轮 37 条观测的 evidence 仍是 `{"reason":"adoption_evidence_not_closed"}}}`,`fromjson` 失败落进 `raw` |
| **F3** | MEDIUM | HOLD 原因只 POST 给 Bridge,supervisor 日志只有一行 `adoption_hold`。restart 波期间 Bridge 常常同时在重启,恰是最需要原因的时刻;本次两轮都是自建 sink 才拿到原因 |
| **F4** | MEDIUM | 生产 `~/.flywheel/lead-lease.db` 已被未合入的分支代码迁移(三新列 + `lease_supervisor_audit`),main 无此 DDL。无功能损伤(行全 NULL、旧 binary 不碰新列),但违反 plan 自己的 V8 隔离,且把 migration 提前落到 ship 窗口之外。另注:新 binary 开库即迁移,只读动词 `progress-snapshot` 也会写 schema |
| **F5** | ship note | legacy 行(supervisor 列 NULL)+ holder 活 → `denied_holder_alive`(实测 rc 3),V7 设计如此;要经过一次 holder 确死的正常 acquire 才升级成 version-valid(实测会写入 supervisor tuple)。生产 19 行 lease 全是 legacy 形态,所以「ship 完就不会再挂」不成立。现场佐证:生产 eng-lead 至今仍卡在这个态(`gen=53 holder=85132 supervisor=NULL`,无 supervisor 进程、无 pid 文件、launchd `runs=780` 空转) |

---

## 5. 通过的部分

| 项 | 结果 |
|---|---|
| CI(head `607c0a4f`) | **全绿 9/9**,含 Script Tests 与 NPM payload |
| `pnpm -r build` | 通过 |
| lease vitest | 27/27 |
| kind-contract + LeadWatchdog vitest | 101/101 |
| 8 个 shell harness(隔离 HOME) | 全部 exit 0,0 failed |
| `lead_body_adopted` 告警五面注册 | 齐全 |
| 真台架 acquire+bind | 正确写入 version-valid 行,PID 文件 / tmux 窗口 / body launch 均正常 |
| 生产零污染(两轮) | `lease-schema` / `state-lead-replacements` / `launchd-leads` 逐字相同;生产快照里 `qa1602|probe-lead` 出现 0 次;台架 label 已卸载;eng-lead 行前后一致 |

---

## 6. 诚实边界

- **未跑生产真机 restart-services**。它会重启 Bridge 和全部 Lead(含派我的 Tadashi),超出 QA 节点权限,且分支未合入、生产跑的仍是 main。issue 验收第 1 条需在 ship 窗口由部署方 + 独立 QA 复验。
- **「连续两次 restart 不产生孤儿」与「newborn 验证失败注入 → 自愈」两条仍未跑**。它们都排在收养可达之后;收养一次都跑不到时先跑这两条得不出有意义结论。
- **`lead_body_adopted` 的真 Discord 渲染 E2E 仍未跑**。该告警只在收养成功路径发出,当前不可达,无法经产品路径驱动出真消息。已静态核对五面注册 + 契约测试通过;修好后复测时补 529 隔离频道真机 alert E2E。**这是被 BLOCKER 挡住,不是跳过。**
- **QA 自身噪音**:attempt 1 台架起步阶段(隔离 alert env 之前)有 1 条 `tmux_rescue_hold` 发到了真 Discord 告警频道并被标成 `lead=flywheel-eng-lead`,原因是 `scripts/lib/flywheel-alert-lib.sh` 把 `--project flywheel --lead flywheel-eng-lead` 写死(既有代码,非本 PR)。之后全程无出站。
- **xtrace 仅加在台架自己的 wrapper 副本上**(QA 夹具),产品源码全程未改,验完已还原。

---

## 7. 复测入口(scratchpad,修好后可直接复跑)

```
rig-setup.sh              建隔离 HOME / manifest / projects.json / 假 claude
rig-install-launchd.sh    写 plist 并 bootstrap 进真 launchd(参数 = 要跑的 repo 根)
rig-lib.sh                rig_state / rig_kill(带隔离断言,拒绝对生产进程动手)
rig-reset.sh              清台架运行态         rig-teardown.sh  卸载 + 收尾
census-repro/run.sh       F1 自 fork 误报复现
census-repro/run-positive.sh  F1 反向控制(真异己 supervisor 不能被遮蔽)
rig-probe-evidence.sh     证据闭集探针(会话环境)
rig-probe-launchd-env.sh  证据闭集探针(plist 环境)
rig-probe-inventory.sh    pane inventory 原始字节
tmux-bisect.sh            F7 环境二分
tmux-fix-validation.sh    F7 候选修法验证(含 LC_ALL=C 无效的证据)
rig-trace-on.sh           台架 wrapper 副本的 xtrace 开关
hold-sink.py              替身 Bridge,捕获 adoption HOLD 的 evidence
legacy-row-check.sh / legacy-upgrade-check.sh   F5 两个复现
```

---

## 8. F5 追加实证 — 「重启后第一次孤儿能不能治」(Lead 指定,真机)

Lead 关心的是:三单齐了一起重启全舰队后,存量 Lead 会写出新 schema 行,那时的**第一次**孤儿能不能被治;如果重启也治不了,就是 ship blocker。拆成两半,在真台架上逐半验证。

**前半(不依赖 F7,现在就能答)—— 通过**

把台账行强制回到生产此刻的 legacy 形态(supervisor 三列 NULL、holder 已死),再走一次真 launchd 重启:

```
seeded legacy row : gen=1 holder=32124 sup=-      supgen=-       ← 生产当前形态
post-restart row  : gen=2 holder=62615 sup=44611  supgen=2       ← 已升级为 version-valid
```

**结论:部署升级路径本身不是 ship blocker。** 一次真重启就能把存量 legacy 行升级成 version-valid,后续孤儿因此**具备**被收养的资格。

**后半 —— 仍被 F7 挡住**

在这个刚升级的 version-valid 行上制造「重启之后的第一次孤儿」(强制 supervisor 下线,body 62615 存活):

```
09:47:19Z 强制 supervisor 44611 下线
t+20/40/60/80s  lease 始终 gen=2 holder=62615 sup=44611(已死)supgen=2
hold 观测:5 次 adoption_evidence_not_closed
```

分类已经越过 census 走到了 `holder_orphaned`(所以才会进收养分支),**卡点就是 F7 那一处,再无其它**。

**给 Lead 的净结论**:F5 不是独立的 ship blocker;「重启后第一次孤儿能被治」与 F7 是同一件事 —— F7 修好,这条链就通;F7 不修,重启也救不回来。下轮 F7 修完复测时,这条会作为收养成功的正向用例一并跑通。
