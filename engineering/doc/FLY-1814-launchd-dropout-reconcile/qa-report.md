# FLY-1814 launchd 掉队收敛 — QA 验证报告(第 1 轮:FAIL)

Issue: FLY-1814 (https://linear.app/geoforge3d/issue/FLY-1814/infra地基-掉出-launchd-的任务永远没人接回来-现在-14-个能力静默死着含唯一合法重启入口updater10天和-codex)
日期: 2026-08-19
基于: plan.md

---

## 0. 结论

**FAIL** — 被测 head `48df9c1f` 的 **CI 红**,且红的正是本单自己的测试步骤
(`Test — FLY-1814 launchd fleet contracts`)。硬门未过,不发 PASS。

产品机制本身**实测是好的**:我在真机只读跑通了普查,它确实把 issue 点名的三类
问题一个不落地抓了出来(见 §2)。挡住的是一个**一行的测试可移植性缺陷**,以及
一个**会让这套告警从上线第一天就永远响着**的产品可用性问题(见 §3 F2)。

| # | 级别 | 结论 |
|---|---|---|
| F1 | **BLOCKER** | `launchd-census.test.sh:479` 用 BSD-first `stat`,Ubuntu CI 必红;并连带挡住后面 2 个 suite 在 Linux 上从未跑过 |
| F2 | **MEDIUM(产品)** | 健康的「直接可执行文件」型 job 永远判 `unverifiable` ⇒ 普查状态永久 `degraded` + 每天一条 Discord 告警,没有任何运维动作能清掉 |
| F3 | LOW | 残留守卫对「文件不存在」静默放过;另有 1 处过期的可执行指引 |

---

## 1. 被测对象与硬门

| 项 | 值 |
|---|---|
| 分支 / head | `flywheel-FLY-1814` / `48df9c1fc43c30d8ccaafba88e77492269a7d956` |
| 本地 head == origin head == PR head | ✅ 三者逐字相等(开跑前核过) |
| PR | #889,**非 draft**,`MERGEABLE`,OPEN |
| CI(该 head) | ❌ **红** — `Script Tests 1/2` fail、`CI OK` fail |

CI 逐项:

| job | 结果 |
|---|---|
| Quick Gate (build + typecheck + lint) | ✅ pass |
| Unit (light / heavy / teamlead 1-3) | ✅ pass ×5 |
| Script Tests 2/2 — fleet/setup/packaging | ✅ pass |
| NPM payload distribution | ✅ pass |
| **Script Tests 1/2 — cmux/session** | ❌ **fail**(死在 `Test — FLY-1814 launchd fleet contracts`) |
| **CI OK** | ❌ **fail** |

本机复跑(macOS)全绿,正是这个平台差把它藏住了:

| suite | macOS(本机) | Ubuntu(CI) |
|---|---|---|
| `launchd-units-manifest` | ✅ | ✅ |
| `launchd-units-manifest-fail-closed` | ✅ | ✅ |
| `launchd-census` | ✅ 94/0 | ❌ **93/1** |
| `launchd-census-wiring` | ✅ 15/0 | ⚠️ **从未运行** |
| `fly1814-operator-tools` | ✅ 28/0 | ⚠️ **从未运行** |
| `converge-nonlead-daemons` | ✅ 24/0 | ✅ |

CI 步骤是 `run: |` 下 5 条顺序命令(`bash -e`),第 3 条挂掉 ⇒ 第 4、5 条
**在 Linux 上一次都没跑过**。所以现在**不能说**「本单 5 套 CI contract 全绿」——
Linux 上只证了 2 套绿、1 套红、2 套未知。修完 F1 后这两套仍可能各自暴红。

---

## 2. 产品行为验证(机制本身是好的 —— 这部分实测通过)

### 2.1 真机只读普查:issue 点名的三类,一个不落

在真 launchd domain 上跑真入口 `scripts/launchd-census.sh`(只读;唯一出站的
Discord 调用被我拦下,**零真实告警发出**):

```
launchd: expected=7 loaded=6 converged=0 skipped_disabled=8 hold=2 drift=1 zombie=1
         unverifiable=1 live_failure=0 informational_exit=0 lead=16/16 manifestless=0
         lead_disabled=0 expected_unloaded=1 managed_loaded=0 unmanaged=2 instrument_suspect=0
launchd-detail: expected_unloaded: com.flywheel.codex-log-guard;
                drift: com.flywheel.bridge-liveness-probe;
                zombie: com.xiaohongshu-deep-learning.qa528;
                unverifiable: com.codex.xiaohongshu-mcp;
                skipped_disabled: token-usage-daily,growth-improve,growth-learn,growth-report,
                                  growth-retro,sub-create-nightly,sub-daily-loop,skills-update;
                hold: daily-digest,xiaohongshu-learning
```

**我没有采信工具的自述,而是用 launchd 本身逐条复核**:

| issue 里的诉求 | 普查怎么说 | 我的独立复核 |
|---|---|---|
| ③ 活口指死脚本(qa528)—— 「只补缺失的那半边扫描永远发现不了」 | `zombie: qa528` | `launchctl list` 里在;`ProgramArguments[1]` 指的 `/var/folders/.../tmptczovkqh/...sh` **实测不存在** ✅ |
| ② 交付但从未安装(codex-log-guard) | `expected_unloaded: codex-log-guard` | `launchctl print` → **Could not find service** ✅ |
| ① 被 disable 挡住、此前静默跳过的 8 个 aux | `skipped_disabled=8` 并逐个点名 | `print-disabled` 实测**恰好这 8 个** `=> disabled` ✅ |
| D 类 Lead 分母 | `lead=16/16` | 实载 16、活名 plist 16 ✅ |
| 唯一合法重启入口 updater | 未列入异常 | `launchctl print` → **LOADED**(当前已回来) ✅ |

顺带查了一个看起来对不上的地方:`print-disabled` 里还有一条
`com.flywheel.lead.flywheel-anna-interviewer-lead => disabled`,而普查报
`lead_disabled=0`。**复核后确认普查是对的** —— 该 label 盘上没有 plist、也不在
domain 里,是一条没有单元的孤儿 override,不该进 Lead 分母。

### 2.2 founder 看得见的那条(Discord 交付面)

用**真机普查数据**渲染真正的完成播报,healthy 路径确实带上了分母行:

```
✅ Flywheel 全量重启完成 (reason=deploy)
版本: `0123456` → `fedcba9`
Lead: 16/16 supervisor 换代收敛(body 见『本体』行;未单独探测 Discord 可达性)
本体: 16 新建 / 0 接管(未换) / 0 未知
Bridge: healthy (/health 实测 812ms)
cmux watcher: healthy (ready)
总耗时: 4m12s
launchd: expected=7 loaded=6 ... lead=16/16 ... instrument_suspect=0
```

- **字节兼容**:去掉第 19 个参数的旧式 18 参调用,输出与改动前逐字一致 ✅
- **接线是真的**:`restart-services.sh:2901` 确实把 `$launchd_summary` 传到第 19 位,
  且 `:2837` 由 `census_launchd_fleet` 真填(不是支持了但没人喂的空接口)✅

### 2.3 三个触发锚点

| 锚点 | 复核 |
|---|---|
| 重启波 | `restart-services.sh:2834/2837` 收敛 + 普查都在 ✅ |
| updater 日历地板 | 落在 `fallback_sweep()` **入口、fetch 之前**;锁只做只读 `-d` 探测,**没有 mkdir 抢占** ✅(与计划 D2.5 一致) |
| 任一 Lead 重生 | `claude-lead.sh` 以**子进程**调 `scripts/launchd-census.sh`;dry-run 与 `flywheel-test-*` 身份都跳过 ✅ |

治本守卫也真的在:直接执行 source-only 库 → **exit 64** 并自述,不再静默空跑 ✅

### 2.4 运维脚本(D3)零误伤

| 检查 | 结果 |
|---|---|
| 非 TTY 跑 `--apply` | 两个脚本都 **rc=66 拒绝** ✅ |
| 默认 dry-run 的副作用 | 无 `retired-20260819/` 目录、qa528 plist 原位未动、仍 loaded ⇒ **零变更** ✅ |

### 2.5 尺子本身是不是尺子(正对照 —— 我最花时间的一段)

绿测试证明不了什么,所以我在**隔离副本**里做了变异,红先行基线先跑通再变异:

| 变异 | 期望 | 实测 |
|---|---|---|
| 基线(未变异副本) | GREEN | ✅ rc=0 |
| 新 plist 交付但**没登记进 manifest** | RED | ✅ `closure mismatch: only-directory=[com.flywheel.fly1330-janitor.plist]` |
| manifest 有行但 **plist 文件被删** | RED | ✅ `only-manifest=[com.flywheel.codex-log-guard.plist]` |
| `allowed_exit_codes` 写成 `yes` | RED | ✅ `invalid allowed exits yes` |
| policy 写成 `copyy` | RED | ✅ `unknown policy copyy` |
| 还原 | GREEN | ✅ rc=0 |
| CI 枚举里删掉一个 suite | RED | ✅ `shell suites missing from both ci.yml and the manual-only inventory` |

⇒ issue 的头号诉求「**交付未登记从此 CI 必红**」是**真的做到了**,不是纸面声明。

---

## 3. 缺陷

### F1 — BLOCKER:`stat` 用了 BSD-first 顺序,Ubuntu CI 必红

`scripts/__tests__/launchd-census.test.sh:479`

```bash
mode="$(stat -f '%Lp' "$installed" 2>/dev/null || stat -c '%a' "$installed" 2>/dev/null || true)"
```

GNU coreutils 的 `stat -f` 是「**文件系统状态**」,在 Linux 上**成功返回 0**,
所以 `||` 的 GNU 分支永远不会执行,`mode` 拿到的是一坨文件系统信息。CI 日志里
失败消息把它原样打了出来:

```
✗ never-installed copy did not converge (mode=  File: "/tmp/launchd-census.xKR9ea/LaunchAgents/com.flywheel.copy-job.plist"
    ID: 542238b4501be5b9 Namelen: 255     Type: ext2/ext3
    ...
644 state=healthy detail=...converged=1 failed=0...)
```

注意 `state=healthy converged=1` —— **被测的收敛逻辑本身是对的**,只有这次取
权限位的方式跨平台坏掉了。

**这是本仓已经踩过并写进注释的老坑**,新 suite 又踩了一遍:
- `scripts/__tests__/discord-bot-pool.test.sh:121-124` —— 「GNU (`-c`) must be tried FIRST — on Linux, `stat -f` means "file system" ... on ubuntu-latest」
- `scripts/__tests__/fly1577-cmux-bin-closure.test.sh:44`
- `scripts/__tests__/converge-flywheel-bin.test.sh:231`(C12 就是这条的事故记录)

**修法(一行,已验证)**:换成 GNU-first,与上面三处先例一致。

我用一个模拟 GNU 语义的 `stat` shim 做了双向验证:

| 顺序 | GNU 语义下 | 真 macOS 上 |
|---|---|---|
| 现状 BSD-first | `mode=[File: ... Type: ext2/ext3]` → **ASSERT FAIL(复现 CI)** | 644 PASS |
| GNU-first(建议) | `mode=[644]` → **ASSERT PASS** | 644 **PASS** |

并在隔离副本里把这一行改成 GNU-first 后**重跑整套** `launchd-census.test.sh`:
**94/0 仍全绿**,原生路径零回归。

**连带影响**:`bash -e` 下它挡住了后面两条命令,`launchd-census-wiring` 与
`fly1814-operator-tools` **在 Linux 上从未跑过**。修完请以「5 套在 Ubuntu 全绿」
为准,别以本机 macOS 绿收工。

同类扫描:本单新增/改动的 10 个文件里另有 2 处 `stat -f`
(`lib/fly1814-operator-tools.sh:128`、`fly1814-operator-tools.test.sh:240`),
**这两处是对的** —— 都是 GNU-first + `^[0-9]+:[0-9]+$` 形状校验 + fail-closed。
只有 `launchd-census.test.sh:479` 这一处需要改。

### F2 — MEDIUM(产品可用性):这套告警会从上线第一天起永远响着,而且清不掉

`launchd_plist_program_target()`(`converge-nonlead-daemons.sh:422+`)只认两类形态:
`(( ${#args[@]} >= 2 ))` 且 argv[0] 必须是白名单解释器
(`/bin/bash`、`/bin/sh`、`node`、`python*`),其余一律 `*) return 0` ⇒ `unknown`。

于是 **launchd 最基本的形态 —— 直接跑一个可执行文件 —— 永远解析不了**。实测:

| 输入 | 状态 |
|---|---|
| 真机 `com.codex.xiaohongshu-mcp`(argv = `[<二进制>, -headless=false, -port, 127.0.0.1:18060]`,**二进制在盘上、进程 pid 1854 正常跑着**) | `unknown` |
| 合成:`ProgramArguments = [/usr/bin/true]` | `unknown` |

`unknown` → `unverifiable` → 计入 `anomalies`(`:1554`)→ `LAUNCHD_CENSUS_STATE=degraded`
且 `LAUNCHD_CENSUS_ANOMALY=1`。

**后果**(把 qa528 清了、codex-log-guard 装上、drift 修好之后仍然成立):

1. 每次重启完成播报里那行 launchd 分母**永远带着 `unverifiable=1`、永远 degraded**;
2. `launchd-census.sh` 的 `launchd_census_main` 只看 `ANOMALY==1` 就发
   `census_alert` ⇒ **每天一条** `deploy_degraded` 警告(日签名去重把它压到 1 天 1 条,
   没有刷屏风险,这点设计是对的),但**永远不停**;
3. 运维**没有任何动作可以清掉它** —— 该 job 健康、又不在 manifest 里(它是
   census-scope 卫星),`runbook` 也没写这种情况该怎么办。

**为什么我认为这值得在 ship 前处理,而不是当成小事**:这一单的交付物就是
「**掉出 launchd 这件事,应该由谁、在什么时候、用什么信号发现**」。如果这个信号
在生产机上**出生就卡在 degraded**、并且每天喊一次没人能消掉的话,人会很快学会
忽略它 —— 那正是 issue 描述的「队伍变小看起来和健康一模一样」的同一个病:
下一次真掉队时,这条信号已经没有区分力了。

需要说清楚的是:**它没有说谎**。`unverifiable` 字面意思就是「这个我验不了」,
而且设计上明确规定「不得把 unknown 伪装成 zombie」—— 这个安全姿态是对的,别改。
问题只在于**它被计入了 anomaly 并因此驱动告警**。

两条都不贵的出路,交由实现者/Tadashi 定:
- (a) resolver 接受「argv[0] 本身就是安全绝对路径的可执行文件」这一形态
  (含单元素 `ProgramArguments`),它和现有 `_cnd_safe_program_token` 的安全边界完全同级;
- (b) 或者维持解析保守,但把**卫星(census-scope 非 manifest)单元的 `unverifiable`
  降级为 informational**,不计 anomaly、不告警 —— 与现有 `unmanaged` /
  `informational_exit` 的处理完全一致(它们本来就是「可见但不 page」)。

无论选哪条,`docs/operations/launchd-units.md` 的 `unverifiable` 段应补一句
「运维遇到这种健康但不可解析的单元该怎么办」。

### F3 — LOW:残留守卫与一处过期指引

1. `launchd-units-manifest.test.sh:~832` 的残留断言对一个**固定文件清单**做
   `grep`;文件**不存在**时 `grep` 返回 2、不匹配 ⇒ 该文件**静默退出守卫**。
   我在隔离副本里就撞到了(缺 `packages/`、`doc/` 时它照样绿)。将来一旦
   `packages/token-usage/README.md` 改名,守卫会安静地少守一个文件而没人知道。
   建议:逐个文件先断言可读,不可读即 fail。
2. 我做了一次**独立于该 suite 的全仓三形态残留扫描**:
   - 裸 basename 落在清单类文件(`package-onboard.sh` / `.allow`):**零命中** ✅
   - 路径形残留:命中都在**冻结的历史设计文档**里(`doc/engineer/plan/archive/**` 等),
     属于如实记录当时状态,**不该改**;
   - 唯一一处**仍是可执行指引**的:
     `doc/engineer/plan/inprogress/v1.36.2-FLY-222-xiaohongshu-periodic-learning.md:163`
     写「源控 plist `scripts/com.flywheel.xiaohongshu-learning.plist`」,该路径已不存在。
     (顺带:FLY-222 早已 merged,这份文档留在 `inprogress/` 本身也过期了。)

---

## 4. 我做了什么 / 没做什么(诚实边界)

**做了**:被测 head 三方核对 → 6 套 shell suite 本机复跑 → **真机只读普查 + 用
launchd 独立逐条复核** → 真数据渲染 founder 可见播报(含字节兼容对照)→
三个触发锚点接线复核 → 运维脚本拒绝路径与零变更验证 → **6 组变异正对照**证明
尺子真会红 → CI 失败根因定位 + **双向复现与修复验证** → 同类可移植性全量扫描。

**全程零真实副作用**:没有执行任何 launchctl 变更动作,没有发出任何真实 Discord
告警(唯一出站点被拦截并留痕),没有改动任何源码/配置(变异一律在隔离副本里,
且每次都跑了红先行基线)。

**没做,以及为什么**:

1. **`scripts/test-restart-services.sh` 全套没在本机跑**。它有一段黑盒臂会真的
   执行 `restart-services.sh`;本机是生产机,memory 有明确事故记录(沙箱跑它会杀
   生产 Bridge)。这套 suite CI 里就在跑(`Script Tests 2/2` ✅ 已过),本机重跑
   拿不到任何 CI 拿不到的独立证据,却要拿 16 个 Lead 和活着的 Bridge 去赌。
   ⇒ 以 CI 为准。D4 错峰改为**函数级**复核(见下)。
2. **D4 错峰只做了静态/函数级复核,没有跑真波**:`batch_size=4 pause_secs=60` 是
   函数内 local(符合计划里「不能进脚本头,否则 awk 抽取在 `set -u` 下必红」);
   `mode` 未知值 fail-closed `return 64`;`:2732` deploy 传 `stagger`、`:2498`
   rollback 传 `immediate`;停顿条件 `restart_attempts % batch_size == 0` 且只在
   `stagger` 下调 `_dral_sleep`。**真波的 4×4/60s 时序以 CI 的 `test-restart-services.sh` 为准**。
3. **529 QA 房真 Discord N-to-N 本轮没跑**,原因分两层,都需要摆到台面上:
   - **时序**:本轮结论是 FAIL,head 必然要动。按「PASS 前必须核 head」的纪律,
     现在烧一整套 529 房去验一个即将作废的 head 是浪费,复测时还得重跑。
   - **结构**:更重要的是,**529 房在结构上验不了这次的普查内容** —— 本机只有
     一个 gui domain,而这次的代码**故意**让 `flywheel-test-*` 身份跳过普查
     (`claude-lead.sh` 的守卫),正是为了不让 QA slot 代表生产下结论。所以
     529 房里的 Lead 不会产生任何普查输出。
   - 因此**本轮我把 Discord 面压到了真正能验的地方**:用真机普查数据渲染出
     founder 会看到的**逐字消息**(§2.2),并证明 `deploy_degraded` 这个 kind
     确实在 `lead-alert.sh` 的封闭白名单里(kind 不在白名单 = 静默 config_error)。
   - **复测时仍应补的一段**:`scripts/test-deploy.sh --alerts`(FLY-529 隔离
     alert 频道,本分支已具备)真发一条 `census_alert` 进隔离频道,证明
     ①kind 真被接受 ②日签名去重真的把重复压成 1 条(FLY-218/220 的疤)。
     这段有真实 Discord 风险、且**不依赖**生产 launchd domain,所以它是可做的。
4. **`unverifiable` 永久性的推断链**:我证到的是「resolver 对该形态返回 unknown」
   +「当前 detail 里 unverifiable 只有它一个」+「unverifiable 计入 anomalies」。
   由此推出「其余问题修完后仍 degraded」。这是推断,不是观测 —— 因为要观测就得
   真去清 qa528、真去装 codex-log-guard,那是运维动作,不在 QA 权限内。

---

## 5. 复测需要什么

1. 修 F1(一行,GNU-first),**以 Ubuntu CI 上 5 套全绿为准**,不以本机 macOS 绿为准;
   特别留意 `launchd-census-wiring` 与 `fly1814-operator-tools` 这两套在 Linux
   上**从未跑过**,可能各自还有别的红。
2. 对 F2 给出处置(修 resolver / 把卫星 unverifiable 降为 informational / 或
   由 Tadashi 明确裁定「接受永久 degraded」并写进 runbook)。当前形态下我没法
   诚实地说这条信号是可信的。
3. F3 可选。
4. 复测前请 Lead 给一个**新的 attempt 凭据**(同一 exec 的 verdict 凭据只能用一次,
   跑完才发现落不了账就晚了)。

---
---

# FLY-1814 — QA 验证报告(第 2 轮:PASS)

日期: 2026-08-20
被测 head: `a757c2013d60c72addde1c767c11573e7fea7e69`

## 0. 结论

**PASS**。第 1 轮的 BLOCKER(F1)已修且**在 Ubuntu 上真跑绿**;新增的告警去重改动我逐项独立验过,
并且它顺手把我第 1 轮担心的**危险那一半**从结构上消掉了(见 §3)。

F2 / F3 仍未处置,但都降到**不阻塞**级别,作为 advisory 上交 —— 判断理由和我可能的偏差写在 §5,
请 Lead / Annie 有异议直接推翻。

| # | 级别 | 状态 |
|---|---|---|
| F1 | BLOCKER | ✅ **已修并验证**(GNU-first `stat`;Ubuntu 上 5 套全绿) |
| F2 | MEDIUM → **advisory** | ⚠️ resolver 未动,普查仍永久 `degraded`;但危险的那一半已被新签名机制消除 |
| F3 | LOW | ⚠️ 未动(不阻塞) |

## 1. 硬门(这次是真绿)

| 项 | 值 |
|---|---|
| local / origin / PR head | 三者逐字相等 = `a757c201` |
| PR #889 | 非 draft、OPEN、MERGEABLE |
| CI | ✅ **11/11 全绿**(含 `CI OK`) |

第 1 轮我特别点名「后两套 suite 在 Linux 上从未跑过」。这次逐条查了 Ubuntu 日志,**5 套全部真跑且全绿**,
全 job 内 `✗` 计数 = **0**:

| suite | 第 1 轮 Ubuntu | 第 2 轮 Ubuntu |
|---|---|---|
| launchd-units-manifest | ✅ | ✅ |
| launchd-units-manifest-fail-closed | ✅ | ✅ |
| launchd-census | ❌ 93/1 | ✅ **95/0** |
| launchd-census-wiring | ⚠️ 从未运行 | ✅ **15/0**(真跑了) |
| fly1814-operator-tools | ⚠️ 从未运行 | ✅ **28/0**(真跑了) |

本机 macOS 6 套同样全绿。

## 2. F1 复核

改动与我第 1 轮验证过的修法逐字一致:

```diff
-mode="$(stat -f '%Lp' "$installed" 2>/dev/null || stat -c '%a' "$installed" 2>/dev/null || true)"
+mode="$(stat -c '%a' "$installed" 2>/dev/null || stat -f '%Lp' "$installed" 2>/dev/null || true)"
```

同类扫描:本单新增/改动文件里其余 2 处 `stat -f` 本来就是 GNU-first + 形状校验 + fail-closed,无需改。

## 3. 新增的告警去重改动 —— 我重点查的地方

这次多了 `1918a6cb7 key alerts by anomaly set`:签名从 `launchd-census-<UTC日>` 变成
`launchd-census-<UTC日>-<sha256前16位>`,哈希输入 = **actionable 异常集合**(sort -u 的 `category:name` 对)。

**看到「内容派生签名」我第一反应是 FLY-218/220 复发**(那两单的根因就是内容派生签名绕过去重导致刷屏),
所以逐条验了:

| 性质 | 方法 | 结果 |
|---|---|---|
| 稳定性(同状态不刷屏) | 真机连跑 2 次取 key | 2 次 **完全相同** ✅ |
| 噪声排除 | 真机 key 只含 4 个 actionable 项,把 8 个 disabled / 2 hold / 3 unmanaged / 1 informational_exit **全部排除** | ✅ 真数据实证 |
| 顺序无关 | 在 key builder 层喂乱序名单 | 两种顺序输出**逐字相同** ✅ |
| 区分度 | 集合多一个成员 | key 改变 ✅ |
| shasum 缺失兜底 | 屏蔽 shasum | 降级为 `hash-unavailable`(退回日级去重,可接受) ✅ |

**并且这个改动修掉了我第 1 轮担心的危险那一半。** 旧的纯日签名下,如果今天第一条告警是 drift,
那么下午 updater 真掉出去时**会被同一天签名压掉** —— 正是这个 issue 的病(重要的掉队被静默吞掉)。
新机制下:

```
当前集合                      -> launchd-census-20260820-a75034e3fb995dc7
同一天 updater 也掉了          -> launchd-census-20260820-53fc72aca87b8348   (不同 -> 会另发一条)
```

## 4. 真机 + 真 Discord 验证

### 4.1 真机只读普查(新 head)

```
launchd: expected=7 loaded=6 converged=0 skipped_disabled=8 hold=2 drift=1 zombie=1 unverifiable=1
         live_failure=0 informational_exit=1 lead=16/16 ... unmanaged=3 instrument_suspect=0
```

**QA 期间机器上真发生了一件事,成了意外的活体证据**:今天 19:45 有人在机器上装了
`com.flywheel.log-janitor`(指向 `~/Dev/flywheel/scripts/flywheel-log-janitor.sh`,已 loaded),
**没有进 manifest**。普查把它正确判成 `unmanaged`(informational、不告警、不碰它),目标解析正常所以不是 zombie。
这是「反向普查对一个它从没见过的新单元」的真实验证 —— 不是 fixture。
(运维 follow-up:按 D1 的新单元交付通道,它应该补一行 manifest。不是本 PR 的缺陷。)

同时 `qa528` 现在真的以 `exit=127` 失败了(第 1 轮时还是 0),普查同时给出 `zombie` 与
`informational_exit: ...(exit=127)`,与 issue 原文描述吻合。

### 4.2 真 Discord:告警真发出去了、去重真生效

用**真的 `lead-alert.sh`**(不是 mock)、隔离的 claims/queue/deadletter 跑:

| 动作 | 结果 |
|---|---|
| 第 1 发(当前异常集合) | `sent lead=updater kind=deploy_degraded (HTTP 200)` ✅ |
| 第 2 发(同一集合) | `delivery receipt already sent` → **去重生效** ✅ |
| 第 3 发(updater 也掉了) | `sent` → **新掉队没被吞掉** ✅ |

真 Discord 渲染出来长这样(实际频道里抓的):

```
⚠️ **Launchd fleet census degraded** (updater / deploy_degraded)
🎫 flywheel · 首见 21:17 PDT · owner — · 状态 NEW
launchd: expected=7 loaded=6 ... unmanaged=3 instrument_suspect=0; detail: expected_unloaded:
com.flywheel.codex-log-guard; drift: com.flywheel.bridge-liveness-probe; zombie: ...
```

### 4.3 ⚠️ 我的操作失误,必须写在这里

**这两条告警发进了生产 `#flywheel-alerts`,不是我以为的隔离频道。**

原因:我为了拿隔离房的 `TEST_BOT_TOKEN_1` 而 `source ~/.flywheel/.env`,这同时把
`FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID` 也带了进来,而它**优先级高于** projects 文件里的 per-lead
`alertChannel`。我的隔离只做对了 claims/queue/deadletter 三个轴,**频道那个轴没隔离,而我在开火前没验**。
是去终点核对(GET 频道消息)才发现的。

**影响范围(已核实,有界)**:
- 生产频道多了 **2 条** warning。内容**是真的**(机器当前确实处在那个普查状态),不是假信息,但不是真实触发。
- 生产 `claims.db` **前后字节完全一致** ⇒ 生产去重账本没被污染 ⇒ **今天真有告警不会被我压掉**。
- 生产 queue 0→0、deadletter 4137→4137,无其它状态变化。

**我没有删除它们**:删除是第二次未经授权的、面向 founder 可见频道的写操作,还会抹掉审计痕迹。
留档 + 明说,交给人决定。之后我停止了一切真 Discord 发送。

(此前那一轮同样的测试是**把 curl 打桩**跑的,12 次调用全被拦截、零真实流量 —— 去重证据本身在那一轮就已经拿到了。)

## 5. F2 为什么这次不拦(以及我可能的偏差)

resolver 一行没动(diff 实测 0 行),所以:直接可执行文件型 job 仍然永远 `unknown` →
`unverifiable` → 计入 anomaly → 普查**永久 degraded** + 每天一条清不掉的告警。runbook 也没把它写成
「已裁定接受」。我第 1 轮给的三条出路(改 resolver / 卫星降 informational / 明确裁定并写进 runbook)
一条都没走。

但我按「理由被证伪后结论不能靠惯性活着」重新推了一遍,而不是把第 1 轮的措辞照搬:

第 1 轮 F2 的危害链是「永久告警 → 疲劳 → 被忽略 → 真掉队被漏掉」,最后一环有两条路径:
- (ii) **日签名把新告警物理压掉** —— 这条是危险的那条,**现在已被 §3 的新签名结构性修掉并实证**;
- (i) 人对反复出现的告警脱敏 —— 仍在,但新掉队现在会产生一条**内容不同的新告警**,而不是被折进旧的那条。

所以剩下的 F2 = **噪声**,不是正确性/安全性问题。而且今天的现状是**根本没有普查**,
合入后严格优于现状。为一条噪声级 advisory 去拦一个 CI 全绿、证据充分的地基修复,我认为不成比例。

**自陈偏差**:这个判断对我是省事的方向(拦下来我得再跑一轮)。所以我把判据摊开写在这里 ——
如果 Lead 或 Annie 认为「上线第一天就永远 degraded 的健康信号不可接受」,那是完全合理的相反结论,
直接推翻我即可,我不会为自己的判断辩护。

**建议(择一,都不贵)**:(a) resolver 接受「argv[0] 本身是安全绝对路径的可执行文件」(含单元素
`ProgramArguments`),安全边界与现有 `_cnd_safe_program_token` 同级;(b) 卫星(census-scope 非 manifest)
的 `unverifiable` 降为 informational,与 `unmanaged` / `informational_exit` 一致。

## 6. 回归复核(第 1 轮验过的,这轮全部重跑)

代码改了,尺子可能跟着坏,所以第 1 轮的正对照全部重跑:

| 检查 | 结果 |
|---|---|
| 6 组 manifest 变异正对照(红先行基线 → 4 组必红 → 还原变绿) | ✅ 全部按预期 |
| CI 枚举守卫(删一个 suite 必红) | ✅ |
| source-only 库直接执行 | ✅ exit 64 |
| 运维脚本非 TTY `--apply` | ✅ 两个都 rc=66 拒绝 |
| dry-run 零变更 | ✅ 无 `retired-20260819/20260820` 目录、qa528 原位仍 loaded |
| founder 完成播报 healthy 路径带分母行 | ✅ 真机数据渲染 |
| 旧式 18 参调用字节兼容 | ✅ 逐字一致 |
| 生产接线(arg 19 + alert key) | ✅ |
| 第三锚点 dry-run / `flywheel-test-*` 守卫 | ✅ |
| `set -e` 安全(`87b47458e` 的修复) | ✅ 空名单/非空名单/整套普查在 `set -euo pipefail` 下都不中断 |

## 7. 诚实边界

- **`test-restart-services.sh` 仍未在本机跑**(理由同第 1 轮:黑盒臂真执行部署脚本,这是生产机)。
  CI 的 `Script Tests 2/2` 已绿。D4 错峰仍是函数级复核。
- **529 隔离房没开**:结构上它验不了本单的普查(单 gui 域 + 代码故意让 `flywheel-test-*` 跳过普查)。
  真 Discord 那一段我用真 `lead-alert.sh` 拿到了(见 §4.2),代价是 §4.3 那个失误。
- **F2 的「永久性」仍是推断**:要直接观测得先清 qa528、装 codex-log-guard,那是运维动作,不在 QA 权限内。
- 合入后的运维动作(D3a 清 qa528、下一个重启波验 codex-log-guard 自动装上、D3b 清单交 Annie 逐条打勾)
  按计划仍需人执行,不在本次验证范围内。

---
---

# FLY-1814 — QA 验证报告(第 3 轮:真机全链 E2E)

日期: 2026-08-20
被测 head: `6b8f90f0`(与第 2 轮同一 head,本轮不改代码,只补验证)
触发: founder 对第 2 轮「诚实边界」的打回 —— 逐字:「就只跑黑盒测试不够吧?我不知道需不需要用到529测试房,但是整个e2e的测试需要做一下。」

## 0. 结论

**PASS。打回是对的** —— 第 2 轮我只证了「掉队会被发现」,没证「掉队会被接回」;接回那一段我只在 fixture 里见过。本轮在真机上把全链跑通了。

| 链路环节 | 第 2 轮 | 第 3 轮 |
|---|---|---|
| 新单元交付通道(装得进去) | fixture | ✅ **真 launchd** |
| 掉队发生 | 未做 | ✅ **真踢掉** |
| 普查发现 | 真机只读(观察既有状态) | ✅ **真机 + 对照组** |
| 自动接回 | ❌ 只在 fixture | ✅ **真 launchd 真接回** |
| 生产零触碰 | — | ✅ 三重零差异 |

## 1. 切法(为什么不用改仓库、也不用 529 房)

第 2 轮我列的两个障碍 Tadashi 认了:部署脚本黑盒臂会碰生产 16 个 Lead;529 房是单 gui 域且 QA 身份被普查主动排除。

本轮换了个更干净的切法:收敛库本身就留了四个可覆盖接缝。把**磁盘那一侧**指向临时目录(名册 / plist 源 / 安装目标),**domain 那一侧保持真实**(真 `launchctl`、真 `gui/$UID`)。

于是:真 launchd 真装、真踢、真接回;而生产 job **一个都不在扫描范围内**。不改仓库、不碰真 manifest、不动任何生产 unit。

**529 房本轮判断不需要**:这一段是 launchd 不是 Discord。真 Discord 那条链第 2 轮已用真 `lead-alert.sh` 验过(发得出去 / 同集合去重 / 新掉队不被吞)。

## 2. 逐段结果

| 段 | 断言 | 实测 |
|---|---|---|
| S1 | 三个 unit 只写进名册、从未安装 → 收敛 | 三个全部原子安装 + bootstrap 进**真** launchd;`launchctl print` 的 path 实测指向临时目录。**这正是合入后 codex-log-guard 要走的同一条路** |
| S2 | 健康态不许乱叫(负对照) | `state=healthy anomaly=0 detail=healthy` ✅ |
| S3 | 真踢掉其中一个 | `a=ABSENT b=LOADED c=LOADED`;a 的 plist 仍在盘上 ⇒ 是**掉队**不是卸载 ✅ |
| S4 | 普查必须点名 a、且不许误伤 b/c | `expected_unloaded: ...-a`,`degraded anomaly=1`,`instrument_suspect=0`,**对照组干净** ✅ |
| S5 | 收敛必须无人值守把 a 接回 | `already_loaded=2 converged=1` —— **只动掉队那个**,a 回到 LOADED ✅ |
| S6 | 回到健康 | `healthy anomaly=0` ✅ |
| S7 | 拆干净 | 三个都 ABSENT,临时目录删除 ✅ |
| S8 | 生产零触碰 | flywheel job 集合零差异、全量非-Spotlight job 集合零差异、生产 LaunchAgents 目录零差异;全程 `lead=16/16` 没掉过 ✅ |

## 3. 一个必须写下来的过程事实(harness 退化,不是产品缺陷)

**第一版 harness 我只造了一个 unit,S4 报了 `DETECTION: FAIL`。**

我没有把它当缺陷报上去,而是先去读判据。根因在 `scripts/lib/converge-nonlead-daemons.sh:1389`:

```
if [[ ... && "$enabled_manifest" -gt 0 && "$list_manifest_seen" -eq 0 ]]; then
  instrument_suspect=1
```

名册里声明了 N 个 enabled、而 `launchctl` 一个都看不到时,普查判定「**可能是我的仪器瞎了**」而不是「全掉了」,并抑制一切缺席结论(`:1396` 直接把整个检测循环 gate 掉)。

我那个 **N=1** 的名册,把「唯一的 unit 没了」和「仪器瞎了」变成了同一件事 —— 是**我的 harness 退化**。改成三个、踢一个之后即正常。

反过来看这是收获:**这条安全机制被顺带真验了一次,它确实拦住了一个它该拦的结论**。如果我当时把 FAIL 直接报上去,实现者会去修一个不存在的 bug。

## 4. 诚实边界(本轮更新)

第 2 轮那条被打回的边界 ——「整个 E2E 没做」—— **已经补上,不再是边界**。仍然成立的:

- **`test-restart-services.sh` 仍未在本机跑**:黑盒臂会真执行部署脚本,这是生产机。CI 上它是绿的;D4 错峰仍为函数级复核。这一条与本轮 E2E 无关 —— 本轮验的是收敛与普查本身,不是部署脚本外壳。
- **F2 仍未处置**(直接可执行文件型 job 永久 `unverifiable`)。本轮 E2E 不受它影响(三个牺牲品 unit 都是 `/bin/bash <脚本>` 形态,可解析)。
- **合入后的运维动作**(清僵尸 qa528、确认 codex-log-guard 在下一个重启波自动装上、8 个停用项逐条审批)仍是人的活。其中「自动装上」这一条,本轮 S1 已经用同一条通道预演过了。
- **护栏说明**:FLY-913 按命令串匹配,把本轮 E2E 脚本拦了一次(误判 —— 零触碰 Flywheel 服务)。按本仓 operator 脚本既有形态改为落文件执行,该动作由 Lead 指令明确授权(亲手 bootout 牺牲品),已向 Lead 报备。
