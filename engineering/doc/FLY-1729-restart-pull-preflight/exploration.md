# FLY-1729 重启脚本 pull-latest-main 前置步 — 探索

Issue: FLY-1729 (https://linear.app/geoforge3d/issue/FLY-1729/chore部署链-重启脚本缺先-pull-latest-main前置步-每次重启都在旧码上起舰8-12-实撞两卡差点没上线)
日期: 2026-08-12
基于: 无

## 1. 问题

`scripts/restart-services.sh` 是全舰重启 + 部署脚本,但它**从不拉取远端代码**:`:990` 直接
`CURRENT_HEAD=$(git -C "$FLYWHEEL_DIR" rev-parse HEAD)`,部署的永远是本地 checkout 当前所在的
commit。当生产 checkout 落后 `origin/main` 时,重启 = 在旧码上起舰。

**8-12 实撞**:全舰重启前 dry-run 露馅,生产 checkout 落后 main 6 个 commit——若直接重启,E1.5
两卡(#807/#814)根本不会上线,会在旧码 `4b47fe3` 上起舰。Lead 手动 `git pull + build` 补救。

**Founder 直令**(2026-08-12 10:12 PT):在重启脚本里加「一开始先 pull latest main」这一步。
红线:零新机制、零新 flag,就是把 Lead 手动干的三步(pull → build → restart)机械化进脚本。

## 2. 现状事实(审计,详见 research.md)

- **updater 路径已有完整 pull 链**:`update-flywheel.sh` 的 `default_deploy()`(:91-109)=
  dirty check → `fetch origin main` → `discord_pointer_cutover_required` 闸(FLY-1676)→
  `pull --ff-only` → 调 `restart-services.sh`。所以经 launchd updater 走的部署没有这个坑。
- **直调路径零 pull**:Lead / 操作员直接跑 `bash scripts/restart-services.sh`(这是
  `flywheel-daemon.sh` 拒绝直接重启时指路的官方入口,也是历次「统一重启」的实际用法)时,
  没有任何 fetch/pull。8-12 撞的就是这条路径。
- 脚本 `:604` 有 fetch,但那是**项目仓**(GeoForge3D 等)的 `.lead/` 变更检测,不是 Flywheel
  主 checkout 自身。
- 脚本自带 detach(`:850`,parent 起 nohup 子进程后退出)、全局互斥锁 `restart.lock.d`
  (`:943`,与 `flywheel-fleet.sh` 共享)、dry-run 早退(`:1095`)。

## 3. 关键设计问题与定案

### Q1: pull 放在哪一段?(parent 预 detach / child 锁后 / 只留在 updater)

| 选项 | 结论 |
|------|------|
| A. parent(detach 前)pull | **拒**。pull 发生在 restart 锁之外:并发的在飞重启正在 build 时,parent pull 替换源码 → build 读到混合源 = 真实产物腐坏风险;两个并发直调还会撞 git index.lock 产生假 fail-loud |
| B. **child(锁后)pull** | **采纳**。在 `acquire_lock` 之后、Discord plugin fork 检测(`:963`)之前插入 preflight:pull 被 restart 锁串行化,与 fleet.sh 的互斥也天然继承;fork 检测 / deployed-sha 对比 / diff 分类全部读到 pull 后的新状态 |
| C. 只修 updater 文档,要求人走 updater | **拒**。founder 明确要求改重启脚本本身;直调是官方入口,不能靠纪律 |

**代价(诚实边界)**:child 是 detach 时刻的旧脚本字节在跑——pull 把 `restart-services.sh`
文件本身换掉后,运行中的 bash 继续读旧 inode(git 更新文件 = unlink+create 新 inode,旧 fd 安全),
即**直调路径的重启逻辑本身滞后一代**(用旧版重启逻辑部署新码;下一次重启自愈)。updater 路径
无此滞后(pull 在调用前)。曾考虑 pull 后 `exec "$0"` 重执行新脚本消除滞后:**拒**——`exec` 不触发
EXIT trap,restart 锁目录不清理,新进程 acquire_lock 撞自己的锁 → 自锁死等 2h stale-break,
是真实新机制 + 真实死锁风险,违背红线。

### Q2: 三类失败各怎么处理?

全部 **fail-loud 停止重启,零 mutation**,与 issue 口径逐字一致;分级沿用 updater 的
transient/deterministic 语义:

| 失败 | 处理 | 告警 |
|------|------|------|
| checkout 脏(status --porcelain 非空) | 拒绝重启,exit 1 | `alert_severe`(deterministic,需人清理;与 rollback `:1815` 同款规则) |
| 不在 main 分支 / detached HEAD | 拒绝重启,exit 1 | `alert_severe`(未知操作员状态,绝不代为决定;`merge --ff-only origin/main` 在错误分支上会把别人的分支指针快进,必须先挡) |
| `fetch origin main` 失败 | 拒绝重启,exit 1 | `alert_warning`(transient 措辞:网络恢复后重跑即可) |
| `merge --ff-only` 失败(分叉/未跟踪文件冲突) | 拒绝重启,exit 1 | `alert_severe`(需人裁决;**绝不 reset --hard**——会吞未知本地状态) |

为什么 fetch 失败也要停:重启在本系统里是**部署事件**(deployed-sha 推进 + founder 播报),
远端状态未知时继续 = 静默部署可能过期的代码,正是本次事故类。崩溃恢复不依赖本脚本
(Bridge 由 launchd KeepAlive 自动重拉),部署工具对未知远端 fail-closed 是对的。
必须 alert 的原因:直调路径 detach 后操作员只看到「detached (PID, log)」,preflight 失败若只写
detach log = 静默死,是最坏结局。

### Q3: FLY-1676 型 cutover 闸要不要进 preflight?

**要**。updater 在 pull **之前**跑 `discord_pointer_cutover_required`(origin/main 的
claude-lead.sh 已选 `discord@flywheel-plugins` 而 live checker 还是 legacy → 拒绝 pull),
原因:Lead spawn 热读 checkout 里的 claude-lead.sh,pull 了不 cutover 会让活 Bridge 后续
spawn 直接坏。restart-services 现有的 `check_discord_plugin_fork`(`:971`)只在 pull **之后**
校验 live contract——先 pull 后拒绝波次,checkout 已被推进,同样留下热 spawn 破窗。
pull 这一步必须继承 pull 路径既有的前置闸纪律:preflight 在 fetch 与 merge 之间跑同一个检查。
实现上把该函数从 `update-flywheel.sh` 搬进共享 lib(两处 source),拒绝 inline 复制(会漂移);
design review r5 又加了一层:搬迁时返回值**三态化**(0=required/1=not-required/2=git 读失败),
修掉原实现把 `git show` 失败 fail-open 成「无需 cutover」的既有缺陷,updater 调用点可观察语义
不变(细节见 plan §1/§2)。当前生产已完成 cutover,该闸常态不触发,纯保序。

### Q4: dry-run 语义?

dry-run 是**预告真跑**的报告,必须诚实:

- **fetch 真跑**(只动 remote-tracking ref,零工作树 mutation;先例:`check_discord_plugin_fork`
  dry-run 也做 bounded remote SHA lookup)。不 fetch 则显示的「目标 sha」可能是过期 ref = 说谎,
  8-12 那种「从没 fetch 过」的场景会直接显示错误目标。
- 打印:当前 HEAD、**目标 sha(origin/main)**、落后 N commits、脏/分支/ff 可行性判定。
- **不 merge**(工作树零 mutation)。
- 后续 dry-run 展示(`DRY RUN: Changes since …`)以 origin/main 作为有效 CURRENT_HEAD 计算,
  让打印的计划反映真跑会部署什么(display-only,dry-run 在 `:1095` 退出,无任何落盘)。
- 真跑会拒绝的状态(脏/分叉/…)→ 打印 `PREFLIGHT WOULD FAIL: <原因>` 并 exit 1;
  dry-run 是交互前台,**不发 Discord 告警**(操作员看得见 stdout,发告警是刷屏)。

### Q5: 「sha 变了 → build」要新逻辑吗?

**不要,零新机制成立**。pull 放在 `:989` 之前后,现有机器已覆盖:`DEPLOYED_SHA` vs 新
`CURRENT_HEAD` 对比 + diff 分类(`classify_changes`)+ `dbi_skip_build_allowed`(build 身份闸,
artifact sha ≠ intended head 时强制重建)天然得出「拉到新码就 build,build 失败 fail-loud
(既有 rollback 路径)」。issue 修法第 3 步就是现有机器,不加一行新决策代码。

## 4. 定案汇总(一句话)

在 `acquire_lock` 之后插入一个 `preflight_pull_latest_main()`:on-main → clean → fetch →
cutover 闸 → `merge --ff-only origin/main`,任一步失败 = 告警 + exit 1 零 mutation;dry-run
同检查但只报告不 merge;下游 build/重启机器一行不改。零新 flag、零新周期任务、零新状态文件。
