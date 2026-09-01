# FLY-1955 Codex Lead 81 秒崩溃循环 — 调研

Issue: FLY-1955 (https://linear.app/geoforge3d/issue/FLY-1955/infra活跃-两个-codex-lead-持续崩溃循环-235-小时精确每-81-秒已跨越两次全舰重启未自愈-remote-control)
日期: 2026-08-21(第一轮);2026-08-31(第二轮,见 §R2)
基于: exploration.md(含 §R2)

> 追加式文档:§1-§8 为第一轮(zombie,已随 PR #915 交付);§R2 起为第二轮。

## 1. 决定性实验:四格复现(2026-08-21 14:08-14:12 PDT 实测)

实验当时隔离了 `CODEX_HOME`(`~/.f1955exp`,已清理)+ symlink 引用生产 0.149.0 release binary。standalone 布局是 `remote-control` 的硬前置(缺了直接报 "managed standalone Codex install not found")。**实施期追溯发现「零改生产」判断不成立**:`CODEX_HOME` 隔离了 daemon 状态,却没有隔离 updater 继承的 `HOME/.local/bin`;隐藏的全局轴副作用见 §8。四格实验对 daemon/pid/socket 的结论不受影响。

| # | pid 文件状态 | `codex remote-control start --json` 行为 | 结果 |
|---|---|---|---|
| E1 | 无 pid 文件(干净 home) | spawn daemon(PPID=1)+ 写 pid 文件 + **创建 socket** | ✅ 健康(仅报 pairing 层 "connection is errored",无 auth 属预期) |
| E2 | pid 指向**彻底消失**的进程(已被 reap) | 判死 → **正常 spawn 新 daemon**,pid 文件更新、socket 创建 | ✅ 自愈 |
| E3 | pid 指向**zombie**(人造:fork 即死子进程,父不 wait;pid 文件 processStartTime 写 zombie 真实 lstart) | **不 spawn**(pid 文件不更新)→ 直连 socket → **ENOENT** | ❌ 输出与生产**逐字节同款**:`Error: app server did not become ready on …app-server-control.sock / Caused by: 0: failed to connect… 1: No such file or directory (os error 2)` |
| E4 | (生产 8-21 现场)pid=30942/23609,双双 zombie | 同 E3,800+ 轮 | ❌ 即本次事故 |

**E3 = 生产死锁的最小复现配方**(QA 可直接复用做 RED→GREEN)。

辅助证据:
- `kill -0 30942` / `kill -0 23609` 均 SUCCESS ⇒ zombie 可被发信号,基于 signal-0 的存活判定必然误判;
- zombie 的 `ps lstart` 与 pid 文件 `processStartTime` **逐字匹配**("Thu Aug 20 14:15:00 2026")⇒ 基于「pid + 启动时间」的防 pid 复用校验也拦不住 zombie;
- 生产 pid 文件 mtime 冻结在 Aug 20 14:15、`app-server.stderr.log` 0 字节 ⇒ 800+ 轮里 start **从未走到 spawn**,与 E3 行为一致。

## 2. `remote-control` 语义实测(0.149.0)

| 命令 | 实测行为 |
|---|---|
| `remote-control start --json` | 读 `app-server-daemon/app-server.pid` → 存活判定(pid + processStartTime,zombie 误判为活)→ 活:只连 socket,不 spawn;死:spawn daemon(daemonize 到 PPID=1)+ 附带拉起 `app-server daemon pid-update-loop` 常驻 updater |
| `remote-control stop --json` | `"backend":"pid"` 按 pid 文件停 daemon;**不停 pid-update-loop**(实验:daemon 死后 updater 仍在);对 zombie 无效果且不清 pid 文件(生产 mtime 冻结佐证) |
| `pid-update-loop`(updater) | PPID=1 长命进程;负责 standalone 自动升级(8-20 13:45 下载 0.149.0、14:14 切 current;8-21 13:35 又重写过 current);**升级换代时自己 spawn 新 daemon(child),child 死后不 `wait()`** → zombie 挂在它名下永不消失 |

生产 zombie 的 PPID 正是各自 home 的 updater(30942←4269、23609←69840)⇒ 14:14-14:15 的 daemon 换代由 updater 的升级重启路径执行,不是 `remote-control start` 执行(后者 spawn 的 daemon PPID=1,死后被 init 自动 reap,不会成 zombie —— E2 已证该路径可自愈)。

**⇒ 完整因果链:updater 自动升级 0.149.0 → updater 换代 spawn 的新 daemon 启动即死(一次性诱因,见 §5)→ 死子挂在不 reap 的 updater 名下成永久 zombie → `remote-control start` 的存活判定被 zombie 骗过 → 永不 spawn → 每轮 ENOENT → Lead fatal → launchd 重拉 → 81s 循环;全舰重启不管 PPID=1 的 updater → zombie 跨重启存活 → 不自愈。**

81 秒分解:进程跑 ~51s(其中 start 等 socket 就绪超时占大头)+ launchd `ThrottleInterval=30` 取整(实测重启间隔 14:02:17→14:03:38 = 81s;Aunt Cass 早前从日志独立测得同值)。

## 3. 改动落点与部署链路

```
launchd plist (KeepAlive=true, ThrottleInterval=30)
  → ~/.flywheel/bin/flywheel-codex-lead-wrapper-{codex-infra-bot,mufasa-tui-fullaccess}.sh
    → 主仓 packages/teamlead/dist/.../codex-lead-tui-runtime.js
      → execFileP("/bin/bash", [<主仓>/packages/teamlead/scripts/codex-lead-tui-home.sh, "ensure-daemon"])   ← runtime.ts:944
```

- `codex-lead-tui-home.sh` 由 runtime 按模块相对路径**现读**(`codex-lead-tui-runtime.ts:879-886`)⇒ 修复落在这一个 shell 文件。按 FLY-1959,merge 不部署也不重启;后续 updater 班车部署生产 checkout 后,仍在循环的 Lead 才会在下一轮吃到新脚本。已有健康 updater 还需一次受控换代,才能继承 §8 的安全 installer 目标。
- 注意:`ensure-daemon` 也被 dry-run 路径跳过(runtime.ts:852),改动不影响 dry-run 无副作用性。

## 4. 修复选项对比

### 4.1 死锁自愈(主修复)

| 选项 | 内容 | 评估 |
|---|---|---|
| **A. wrapper 侧证据驱动回收(选定)** | `ensure_daemon` 在 start 失败后:读 pid 文件 → 若该 pid 处于 **Z 态**(唯一能解释「判活但 socket 缺失」的形态)→ 按 pid+lstart+argv 身份栅栏定位其父 updater → 杀 updater → zombie 被 init reap → 重试 start 一次;证据不齐 → 不杀,fail-loud 保持现状循环 | 改动单文件、单函数;E2 证明 pid 彻底死后 start 必然自愈;对**未来任何 daemon 死因**都有效;对齐 FLY-1634/1659「bounded hard-clear、sensor 不确定即 hold」哲学 |
| B. 等 codex 上游修存活判定 | 报 bug:zombie 应判死 | 应报(顺手),但不可等——生产每 81s 在烧;且上游修了与 A 幂等不冲突 |
| C. 全舰重启清单收编 updater | restart-services 加「杀各 home 的 pid-update-loop」 | 治标:重启才清,循环期间不自愈;且全舰重启是重武器,为两个 Lead 的私有进程加全舰步骤越权(scope)。弃 |
| D. 常驻巡逻检测 zombie | 新 poller 扫 codex home | 违背 FLY-1570「拆追人型 watchdog」方向;A 已把检测挂在天然重试点(每轮 ensure-daemon),零新 timer。弃 |

### 4.2 杀 updater 的安全性论证(A 的关键子问题)

- updater 死后谁补?**`remote-control start` spawn daemon 时会重新拉起 pid-update-loop**(E1/E2 实验后 updater 均在)⇒ 杀它不是永久去功能,是让它换代重生;
- 身份栅栏(FLY-1759/1482 教训,`pgrep -f` 禁裸用):候选必须同时满足 ①pid 文件里 daemon pid 的 **PPID 指向它**(zombie 的父从 `ps -o ppid=` 读)②argv 精确匹配 `<该 home>/packages/standalone/…/codex app-server daemon pid-update-loop`(锚定本 home 绝对路径,绝不误杀别的 home / 别的 codex 进程)③读到的 pid 在 kill 前用 `ps -o lstart=,command=` 复核未被复用;
- 空窗影响:updater 只管自动升级,杀→重生的空窗里没有升级发生,零业务影响。

### 4.3 止血(不等代码的 operator runbook)

对两个 home 各执行:`kill <updater-pid>`(4269 / 69840,kill 前按 §4.2 栅栏复核)→ zombie 被 init reap → pid 文件变 E2 形态 → 下一轮 KeepAlive(≤81s 后)Lead 自愈。预计每个 Lead <3 分钟恢复。验收采样窗必须 >81s(Aunt Cass 的 45s 采样教训)。

### 4.4 FLY-513 放大器收尾

最新状态:Tadashi 8-21 15:22 再次把 `~/.local/bin/codex` 恢复到 `~/.local/opt/codex-stable/codex`;14:02 的同款换轴此前被实验 updater 踩回,见 §8。收尾分三层:
1. **切断自动翻写源头**:`remote-control start` 显式传 Codex installer 的原生 `CODEX_INSTALL_DIR="$HOME_DIR/.local/bin"`;updater 继承后只更新本 Lead 的可见命令,不再写真实 `~/.local/bin`。部署时让所有旧 updater 受控换代一次,使存量进程也继承该值;
2. **布局固化**:单文件拷贝 → FLY-513 警告文案的正路 `~/.local/share/flywheel-codex/<ver>/bin/codex` 版本化布局(该处已有 0.142.0 先例 + `.global-codex.symlink.bak`),一步迁移 + 保留 codex-stable 一个观察期;
3. **防再踩守卫**:`ensure-home` 的 FLY-513 检查从 warn-only 升级为 warn + `lead-alert.sh` 告警(kind 固定,claims.db 天级去重)。不让告警承担正确性:正确性来自第 1 项的写目标隔离。

### 4.5 崩溃循环静默烧的告警缺口

事故静默烧 23.5h,靠 Aunt Cass 人工观察发现("不在任何自动报告里")。最小补法:`ensure_daemon` 在**回收路径被触发**时(= 检出 zombie 死锁的那一刻)经 `lead-alert.sh` 发一条 kind=`codex_daemon_zombie_recovered`(或回收失败时 `codex_daemon_zombie_stuck`),天级去重。不做通用 crash-loop 检测(那是 FLY-1687 巡检/launchd 层的事,scope 之外)。

## 5. Open questions(如实边界)

| # | 问题 | 状态 | 对设计的影响 |
|---|---|---|---|
| Q1 | 14:14-14:15 换代 daemon 为何启动即死(zombie 的一次性诱因) | **未定**。无 stderr、macOS 统一日志已滚过、无 crash report。嫌疑=换代竞态(新 daemon 抢 startup lock 失败静默退出) | **无**:修复针对持续性死锁机制,对任意死因有效。修复部署后若再发,回收路径会当轮自愈并留告警痕迹,可继续取证 |
| Q2 | standalone updater 能否禁用/钉版本(0.149 无预告升级是事故源头) | **未找到旋钮**:`app-server daemon --help` 无 update 开关,binary strings 探针无命中,上游文档未查证 | 设计不依赖:A 使 updater 引发的死锁一轮内自愈(伤害 23.5h → <3min)。「评估禁升级/钉版本」列 follow-up |
| Q3 | FLY-1892(双向断路)与本单同根? | 存疑:其入站断自 8-13 起,早于本循环一周 | 按 Lead 指令:修复部署后跑双向通路验证,通则并单、不通则回报 FLY-1892 独立继续 |

## 6. 现场动作与边界

- 全局 codex 换轴是临时止血而非永久完成:14:02 首次换轴只跨过 3 个 81 秒周期;15:22 在污染复现后由 Tadashi 再次恢复。永久性依赖 §4.4/§8 的 updater 写目标隔离 + 中立版本化布局。
- 「symlink 每 81 秒被翻写」已被 Aunt Cass 勘误为**偶发**(updater flip 时)——守卫设计按低频建模,不做高频监测。

## 7. 实施期 live recheck(2026-08-21 15:20 PDT)

实施节点从两份 append-only `/tmp/flywheel-lead-*.log` 的最新尾部复核到:

- 两个 Lead 仍按 81 秒节奏失败,最新启动分别为 infra `15:20:34`、mufasa `15:20:23`,错误仍是同一 control socket ENOENT;
- infra `15:19:13` / `15:20:34` 的 `ensure-home` 又打印 FLY-513 warning,实时 realpath 已回到 `~/.codex-infra-bot/packages/standalone/releases/0.149.0-.../bin/codex`。

因此 14:02 的中立换轴只证明「连续三个循环未被踩回」,**没有跨过下一次偶发 updater flip**;§4.4 的固化、写目标隔离与真实告警仍是本单必要交付。implement 节点本身只做只读复核并报告 Lead,没有修改生产 symlink、发信号或重启服务。

## 8. 实验污染全局轴的追溯与修正(2026-08-21 15:22 PDT)

Tadashi 报告全局 link 一度解析到设计会话 scratchpad 的 `codex-home-exp/.../current/bin/codex`。逐条回放设计会话 transcript 后,因果链已闭合:

1. 14:08:31 的首次实验只设置 `CODEX_HOME=<scratchpad>/codex-home-exp`,随后执行真实 0.149.0 `remote-control start`;该命令创建了常驻 `pid-update-loop`。会话后来清掉了 `~/.f1955exp` 的 updater,**没有清掉这棵 scratchpad 的 updater**;
2. [Codex 0.149.0 官方 `update_loop.rs`](https://github.com/openai/codex/blob/rust-v0.149.0/codex-rs/app-server-daemon/src/update_loop.rs) 明确:updater 先等 5 分钟,之后每 60 分钟下载 installer,以继承当前环境的 `/bin/sh -s` 执行;
3. 当日 installer 的默认值为 `BIN_DIR=${CODEX_INSTALL_DIR:-$HOME/.local/bin}`。实验仅改 `CODEX_HOME`,没有改 `HOME` 或 `CODEX_INSTALL_DIR`,所以 updater 周期性把真实全局 link 重写到实验 home 的 managed `current/bin/codex`;
4. 因而这不是手写 `ln ~/.local/bin/codex`、也不是外部神秘劫持;它是本次设计实验启动 updater 后未隔离 installer 目标、又遗漏清理 updater 造成的间接生产副作用。

修正合同:

- 生产 wrapper 的每一次 `remote-control start` 都传 `CODEX_INSTALL_DIR="$HOME_DIR/.local/bin"`;不改变 daemon 的真实 `HOME`,只使用 installer 已有原生开关隔离可见命令写目标;
- 所有真实 Codex 实验同时隔离 `HOME`、`CODEX_HOME`、`CODEX_INSTALL_DIR` 与 `PATH`,并在退出前按 pid 文件身份栅栏清掉 daemon **和 updater**;不得仅靠 scratchpad 路径声称隔离;
- harness 使用 fake `HOME` + fake standalone,并在前后断言 fake global symlink 未变;不再让实验碰真实全局轴。

---

## R2. 第二轮调研(2026-08-31,基于 exploration.md §R2)

### R2.1 现行代码合同(现读,worktree 与生产 checkout 同源)

- `ensure_daemon`(`codex-lead-tui-home.sh:713-778`):start 成功 → `daemon OK` return;失败 → `reap_zombie_daemon_if_proven` 四态分派。**告警只挂在 `reaped`(recovered/stuck)与 `action_stuck` 分支**;`race_self_healed` 重试失败与 `not_proven` 两条 die 路径零告警——auth-dead 每轮走的正是 `race_self_healed` 重试失败(新 spawn 的 daemon 已建出 socket,P2 判「他愈」)。
- 告警 seam 已泛化:`emit_lead_alert kind severity signature title body`(:148-166),经 `FLYWHEEL_LEAD_ALERT_SH`(harness)或 repo-root 派生的 `scripts/lead-alert.sh`;`FLYWHEEL_LEAD_ID`/`FLYWHEEL_PROJECT_NAME` 缺失时 skip+log。**通路已实证可达**:8-31 03:16:22 一条 kind=crash_loop 实发 HTTP 200(整个 4.7 天日志里仅此一条,即偶发走到 reaped 路径的那一轮)。
- 故障注入 seams 已存在:`fly1955_ps`/`fly1955_kill`/`fly1955_sleep`(:134-136)。
- `scripts/lead-alert.sh` kind allowlist 含 **`login_expired`**(且不在 INFORMATIONAL_KINDS ⇒ 渲染完整 unified ticket header,正常分级投递);severity 合法值 info|warning|severe。
- runtime 侧:`DaemonConnectionSupervisor.start()` 启动时恰调一次 `ensureDaemon()`,失败 → main fatal → exit 1 → launchd(KeepAlive=true, ThrottleInterval=30)重拉 ⇒ **脚本内的有界 hold 可直接节流整个循环,无需动 TS**。

### R2.2 auth-dead 判据实测

| 证据面 | 实测 | 作为判据的资格 |
|---|---|---|
| `remote-control start` exit code | 1(runtime execFileP `code: 1`) | 必要非充分(任何失败都退 1) |
| start stderr | `Remote control is enabled on <host> but the connection is errored.` ×2 | **有歧义**:第一轮 E1(干净无 auth home)也见过同文案;网络断时同样可能出现 ⇒ 不能单独定罪 |
| daemon stderr(`$HOME_DIR/app-server-daemon/app-server.stderr.log`) | 每轮 daemon spawn **重建**(两次现读内容均为当轮时间戳起头);持续输出 `refresh_token_invalidated` / `token_revoked` / `Your access token could not be refreshed because your refresh token was revoked` | **判别性证据**:codex_login::auth::manager 的 401 吊销签名只在凭据死亡时出现 |
| `codex login status` rc | 未采用 | memory 在案:该命令 rc 会因 config 载入期冲突假报非 0(companion false-unauth 先例);且每轮多 spawn 一个 codex 进程 |

**⇒ 分类合同(两证并举,evidence-driven,对齐第一轮 P1-P6 哲学)**:
1. `remote-control start` 非零退出;
2. daemon stderr log 存在、**mtime ≥ 本轮 start 调用时刻 - 1s**(防拿 zombie 事故那种 0 字节/陈旧日志定罪——第一轮现场该文件冻结 0 字节,此条会拒绝分类,正确回落 zombie 机制);
3. tail 内容命中吊销签名集(fixed-string grep,不用 ERE):`refresh_token_invalidated`、`refresh_token_reused`、`token_revoked`、`token_expired`、`Your access token could not be refreshed`。
三条全满足 → `auth_dead`;任一不满足 → 走既有路径,行为零变化。

签名集来源:前四个是 Codex CLI/后端的机读 error code(本次现场 + `/codex-relogin` skill 的既有触发词);第五个是 auth manager 的稳定人读文案。均为 0.151.0 现场逐字采集。

### R2.3 修复选项对比

#### R2.3.1 分类后的处置(parking)

| 选项 | 内容 | 评估 |
|---|---|---|
| **A. 脚本内有界 hold 后 die(选定)** | 分类 `auth_dead` → 发 login_expired 告警 → `fly1955_sleep $HOLD`(默认 900s,`FLYWHEEL_CODEX_AUTH_DEAD_HOLD_SECONDS` 可覆写)→ die(带分类文案)。循环从 ~37s/轮 → ~15.5min/轮(降 ~25×);token 修好后**下一轮自动满血恢复**,零人工 kickstart 依赖(要快可 `launchctl kickstart -k`) | 单文件单函数;不动 launchd/TS;KeepAlive 语义原样;SIGTERM 杀得掉 sleep(launchd stop 不受阻)。缺点:恢复延迟上界 = HOLD,人工修 auth 本就是分钟级动作,可接受 |
| B. runtime 驻留 parked-loop,周期 recheck | exit code/marker 跨层合同 + TS 状态机 + TUI 呈现 | 体验更好但引入新跨层合同与新状态;违背「enforce simplicity」;收益(恢复延迟 0 vs ≤15min)不值复杂度 |
| C. `launchctl unload` 自停 | 循环归零 | ❌ 自身不可自愈(修好 auth 也不回来);服务自改生命周期越权(memory 红线:未经许可不 shutdown);弃 |

#### R2.3.2 静默烧缺口的修法

| 选项 | 内容 | 评估 |
|---|---|---|
| 按失败类别逐条补告警 | 给 race_self_healed 重试失败、not_proven 各补一条 | ❌ 第一轮就是按类别挂告警,auth-dead 整层从缝隙漏过 4.7 天 ⇒ 该方法论已被证伪:未来任何新失败类别默认继续漏 |
| **通用连败计数 + 天级去重(选定)** | `ensure_daemon` 每次 die 前:计数文件(`$HOME_DIR/.flywheel-ensure-daemon-failcount`)+1;**达到 3 次连败**时发 kind=crash_loop severity=severe signature=`fly1955-ensure-daemon-failing\|YYYYMMDD`(天级去重,body 带当轮 die 文案与连败数);任一成功路径删计数文件 | fail-open 安全网:**任何**(含未来未知)失败类别连败 ≈2-4 分钟内必有当日告警;单次瞬态 blip(下一轮自愈)不响;claims.db 天级去重兜底噪音上界 1 条/天/Lead |

阈值=3 论证:1 次瞬态(如 boot 竞态)自愈常见,不该响;3 连败在 37s 节奏下 ≈2min、81s 节奏下 ≈4min,发现延迟从 4.7 天压到分钟级。计数文件放 Lead home 根(不放 `app-server-daemon/`——那是 codex 管理的目录,不塞外来文件)。

zombie 专用告警(recovered/stuck)原样保留——它们带证据链上下文,与通用安全网互补;auth_dead 轮同时会推进连败计数,一个 auth-dead 停机日最多 login_expired + crash_loop 两条,可接受且互为佐证。

#### R2.3.3 分类点位置

选**首次 start 失败后、zombie 机制之前**:探针零成本(读一个本地文件),且 auth-dead 时跳过无意义的 reap/重试(重试必然再败,还多杀一次 daemon)。不在重试失败点重复分类——若首败非 auth(如真 zombie),reap 后重试再败于 auth 的组合形态罕见,下一轮 37s 后就会在首败点被正确分类,无需多一个分支。

### R2.4 FLY-513 残留复核(证伪「隔离失效」)

| 证据 | 值 | 结论 |
|---|---|---|
| 全局 `~/.local/bin/codex` | → mufasa home standalone current,**mtime 8-21 23:43:27** | 翻写发生在 PR #915(8-21 22:33 merge)与部署生效之间的窗口,是旧 updater 最后一次作案 |
| 两个 home 的 `.local/bin/` | 8-22 00:08/00:09 创建,8-31 15:26/15:49 仍在被 updater 刷新 | **`CODEX_INSTALL_DIR` 隔离生效**:updater 换代后 9 天只写 home-scoped 轴 |
| 两个 updater 进程 env(`ps eww`) | 均带 `CODEX_INSTALL_DIR=<home>/.local/bin` + `CODEX_HOME=<home>` | 同上 |
| 中立布局 `~/.local/share/flywheel-codex/` | 仅 0.142.0 残留 | 第一轮 plan **阶段 3(operator 收口)从未执行** |
| 阶段 3 前置条件(现读) | 全局链 realpath = mufasa home 完整 release 树(`releases/0.151.0-*/bin/codex`) | **为真** ⇒ `fly-513-repoint-global-codex.sh` 可直接走 |

⇒ 第二轮**无需新代码**处理 FLY-513;交付物 = runbook 里把阶段 3 排进执行并留验收证据(>65min 跨 updater 周期观察窗,沿用第一轮判据)。

### R2.5 部署链路(沿用第一轮 §3,自动送达)

`codex-lead-tui-home.sh` 由 runtime 每轮**现读**生产 checkout ⇒ merge 后 updater 班车部署到生产 checkout 的下一个 37s 循环,infra-bot 自动吃到新脚本:分类命中 → 发一条 login_expired → 进入 15min 节奏 parking。**修复部署本身不依赖任何人碰这个 Lead。**账号重登录(独立 operator 动作)完成后的下一轮自动满血恢复。

### R2.6 Open questions

| # | 问题 | 状态 | 对设计的影响 |
|---|---|---|---|
| Q-R1 | refresh token 为何被吊销(8-23~8-26 窗口内 OpenAI 侧动作/别处登录挤掉/舰队事件) | 本机不可考(无归档日志;Linear MCP 本会话 401 连不上,无法翻 issue 评论) | 无:分类+parking 对任意吊销原因有效,且为未来所有 Lead 的同类死亡建立自愈告警路径 |
| Q-R2 | infra-bot 账号救回 vs 退役 | **已非阻塞上报 Lead**(question id e95aa0d3),等待裁决 | 只影响 runbook 主线(重登录 vs 长期 parked);代码设计两者兼容——退役情形下 parked Lead 每 15.5min 一轮、每天 2 条去重告警,直到正式下架(下架属 Lead 生命周期管理,超出本单) |
| Q-R3 | FLY-1892 双向断路与本单同根? | 账号死亡窗口(8-23起)仍晚于其入站断(8-13) ⇒ 同根性仍存疑 | 沿用第一轮 G5:账号救回后跑双向验证,通则并单、不通则回报 |
