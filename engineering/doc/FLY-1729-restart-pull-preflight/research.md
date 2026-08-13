# FLY-1729 重启脚本 pull-latest-main 前置步 — 调研

Issue: FLY-1729 (https://linear.app/geoforge3d/issue/FLY-1729/chore部署链-重启脚本缺先-pull-latest-main前置步-每次重启都在旧码上起舰8-12-实撞两卡差点没上线)
日期: 2026-08-12
基于: exploration.md

代码审计事实清单(全部实读于本分支 HEAD,行号以当前 `scripts/restart-services.sh` 2238 行版本为准)。

## 1. restart-services.sh 现有结构(与本单相关的骨架)

```
:19    set -euo pipefail
:38    FLYWHEEL_DIR="${HOME}/Dev/flywheel"          # 硬编码,非 env 可覆盖(host-path-allowlist.test.sh 断言)
:44-59 source libs: lead-restart-lifecycle / restart-notify / restart-cmux-watcher /
       deploy-build-identity / mailbox-queue-deploy-barrier / supervisor / tmux-server-rescue
:138   source ~/.flywheel/.env (set -a)
:396   notify_routine()                              # Discord 播报(infra bot token)
:426   restart_on_exit()                             # FLY-1603 终局 finalizer:只在
       RESTART_NOTICE_STARTED=true && RESTART_TERMINAL_REPORTED!=true 时补「异常终止」告警
:471   check_discord_plugin_fork()                   # live contract 校验 + pointer 更新;
       live_contract != discord@flywheel-plugins/v1 → 拒绝波次 return 2
:557   check_project_lead_changes()                  # 项目仓 .lead/ 检测;:604 有 fetch,
       但对象是 GeoForge3D 等项目仓,dry-run 跳过 fetch(:603)
:811-844 参数解析: --force / --wait-idle / --dry-run / --reason
:846   validate_restart_contract
:850-859 self-detach: 非 FOREGROUND 且非 dry-run → nohup "$0" 重启自身后 exit 0
:876-943 acquire_lock: mkdir restart.lock.d(与 flywheel-fleet.sh 共享互斥);
       随后设 EXIT/INT/TERM trap;scheduler-repair mutation lock 排水
:946-956 per-run sidecar 临时文件分配
:963-977 plugin-restart-pending marker + check_discord_plugin_fork(fork_rc==2 → exit 1)
:983   check_project_lead_changes
:989   DEPLOYED_SHA=$(cat ~/.flywheel/deployed-sha)
:990   CURRENT_HEAD=$(git -C "$FLYWHEEL_DIR" rev-parse HEAD)     # ← 全脚本唯一的「部署目标」来源,零 fetch/pull
:992-995 DEPLOYED_SHA==CURRENT_HEAD → SKIP_BUILD=true
:1057  CHANGED=$(git diff --name-only DEPLOYED_SHA CURRENT_HEAD) → classify_changes
:1079-1085 dbi_skip_build_allowed(build 身份闸):artifact sha 不匹配 intended head → 强制 rebuild
:1091-1096 DRY_RUN → 打印计划(build/skip、Changes since)后 exit 0
:1773  build_project(): pnpm install --frozen-lockfile(需要时)+ pnpm build,失败 return 1
:1800  rollback_and_restart(): 脏 checkout 拒绝回滚(:1815);git reset --hard 只在回滚用
:1881  deploy_and_verify(): notify_routine 开始播报(RESTART_NOTICE_STARTED=true)→ stop/build/start/健康验收
:2104-2106 成功后 record_deployed_range + deployed-sha 推进
```

**结论 1**:整条主链没有任何针对 `FLYWHEEL_DIR` 的 fetch/pull;`:604` 的 fetch 是项目仓(`.lead/`
检测),与 Flywheel 主 checkout 无关。issue 描述与代码逐行吻合。

**结论 2**:`restart_on_exit` 只在「开始播报已发出但没有终局报告」时补告警(`:437`)。preflight
插入点在 `deploy_and_verify` 之前,`RESTART_NOTICE_STARTED` 恒为 false → preflight 自己发的
告警不会被 finalizer 二次告警;同时也意味着 preflight 失败**必须自己发告警**,finalizer 不兜底。

## 2. update-flywheel.sh(updater)——既有的唯一 pull 路径

`default_deploy()`(:91-109),顺序即纪律:

```bash
:93  dirty check(status --porcelain 非空 → return 3 deterministic)
:96  git fetch origin main --quiet        (失败 → return 2 transient)
:99  discord_pointer_cutover_required     (成立 → return 3,拒绝 pull——注意是拒绝 PULL 本身)
:103 git pull origin main --ff-only --quiet(失败 → return 2 transient)
:106 FLYWHEEL_RESTART_FOREGROUND=1 restart-services.sh --reason updater
```

`discord_pointer_cutover_required()`(:72-84):`git show origin/main:packages/teamlead/scripts/claude-lead.sh`
含 `--dangerously-load-development-channels "plugin:discord@flywheel-plugins"` 且
`check-discord-plugin.sh --print-contract != discord@flywheel-plugins/v1` → 需要 cutover,拒 pull。
**闸在 pull 之前**的原因:Lead spawn 热读 checkout 的 claude-lead.sh,pull 而不 cutover 会让
活 Bridge 的后续 spawn 立刻用上新 pointer 而 live checker 还是 legacy → 现场破。

分类语义:rc=2 transient(重试)/ rc=3 deterministic(退避,阈值后 block + severe alert)。
`fallback_sweep()`(:212)每日 00:00/12:00 也 fetch+对比,漂移则走同一 `default_deploy`。

**结论 3**:pull 的完整纪律(dirty 前置、cutover 闸前置、ff-only、transient/deterministic 分级)
在 updater 里已成型;FLY-1729 = 把同一纪律带进 restart-services.sh 的直调路径,而非发明新规则。

**结论 4**(已知边界,非本单修):updater 的 pull 在 restart 锁**之外**(它只持 ssq 单例锁)。
理论上 updater pull 可与一个在飞直调重启的 build 竞争。本单把 restart-services 侧的 pull 放进
restart 锁内,不触碰 updater 侧;该既有窗口原样保留,单列观察。

## 3. 调用方盘点(谁会跑 restart-services.sh)

| 调用方 | pull? | 说明 |
|--------|-------|------|
| `update-flywheel.sh` default_deploy(launchd updater;self-ship marker + 日历 sweep + FLY-1671 request-restart.sh 入队) | ✅ 调用前已 pull | preflight 将成为幂等复核(fetch+ff-merge 皆 no-op) |
| **直接调用** `bash scripts/restart-services.sh`(Lead 手动统一重启 / 操作员;`flywheel-daemon.sh:1117` 拒绝直接重启时官方指路的入口;`provision-fleet-host.sh` darwin bring-up 委托) | ❌ **零 pull** | **8-12 事故路径,本单主治对象** |
| `flywheel-fleet.sh` | n/a | 只共享 restart.lock.d 互斥,不调本脚本 |

`self-ship-restart.sh` 不 inline 调 restart-services——它入队 marker 交给 updater(FLY-270),归第一行。

## 4. detach / 锁 / 脚本自替换 的机制事实

- self-detach(:850):parent `nohup "$0" …` 后 exit 0。child 以 detach 时刻的脚本文件启动。
- `acquire_lock`(:876):`mkdir restart.lock.d`;默认 wait=0(争用 = 成功 no-op exit 0);
  >2h stale 破锁;拿到锁后才设 EXIT trap(锁清理在 `restart_on_exit:452`)。
- **脚本在跑时被 pull 替换是否安全**:git 更新工作树文件 = unlink + 新建(新 inode);运行中
  bash 持旧 `restart-services.sh` 的 fd,不会把该文件本身读成半旧半新。但本轮已 source 的 lib
  仍是旧函数,merge 后才 spawn 的子脚本会读新文件,所以准确边界是**混合代运行**而非纯粹
  「整轮滞后一代」。本单不加自重启机制;涉及 restart machinery 协同改动时,不得假定拉取它的
  当轮已全量使用新版控制逻辑。
- `exec "$0"` 重执行不可行的机制依据:bash 的 `exec` 不触发 EXIT trap → `rmdir "$LOCK_DIR"`
  (:452)不执行 → 新进程 `acquire_lock` 撞到自己遗留的新鲜锁(age≪2h)→ 按争用语义 exit 0,
  重启静默不发生,锁悬挂到 2h stale-break。

## 5. 告警与播报设施(preflight 直接可用)

- `alert_severe` / `alert_warning`(restart-notify.sh;经 lead-alert.sh,claims.db 按 signature 去重)。
- `notify_routine`(:396):founder 可见 Notification 频道;当前首条播报在 `deploy_and_verify`
  开头(「🔄 开始全量重启 … old → new」),preflight 在其之前,失败不产生「开始了没结果」的悬案。
- `fire_meta_alert`:Discord 独立的桌面/文件 trace,best-effort。

## 6. 测试基建(实现节点的落点)

- 既有 harness 家族:`scripts/__tests__/restart-*.test.sh`(self-detach / notify / storm-gate /
  stabilization / admission-pause / deployed-range / discord-plugin …),CI 由
  `scripts/test-restart-services.sh` 聚合(ci-structure.test.sh:355 断言接线)。
- **既定 seam 模式**(restart-self-detach.test.sh 实例):`sed -n '/^func()/,/^}/p'` 从脚本抽函数
  进临时 harness + stub `log`/alert + env 注入(如 `FLYWHEEL_DIR="$FLYWHEEL_FAKE"`,
  restart-services-notify.test.sh:81)。`FLYWHEEL_DIR` 在脚本内是硬编码,harness 抽取后以自定义
  前奏覆盖——新 preflight 必须写成**自包含单函数**(依赖全部经全局变量/可 stub 函数)才能沿用该模式。
- git 场景 hermetic 化:mktemp 下建「假 origin」bare repo + clone,fetch/merge 全程离线可测
  (fetch 失败用不存在的 origin URL 制造);无需网络、无需 stub git。
- `update-flywheel.sh` 侧已有 `update-flywheel-queue.test.sh`(sourced 模式,
  `UPDATE_FLYWHEEL_SOURCED=1` + `SELF_SHIP_DEPLOY_CMD` 注入)——共享 lib 搬迁后此套件是回归哨兵。

## 7. classify_changes 对新文件的既有覆盖

`scripts/lib/*` → `_restart_bridge=true`(:1029):新共享 lib 落在 `scripts/lib/` 下,未来对它的
改动自动被 diff 分类判为需要 Bridge 重启,无需登记。

## 8. 风险清单(带出到 plan)

1. **混合代运行**(直调路径:已加载函数为旧版、merge 后 spawn 的子脚本为新版)——接受 +
   文档化;updater 路径先 pull 后启动 restart-services,无此边界。
2. **cutover 闸缺位会破热 spawn**——preflight 内置同款闸(共享 lib 原样搬,拒 inline 复制防漂移)。
3. **preflight 失败的可见性**——detach 后 stdout 进 detach log,必须靠 alert_severe/warning 出圈;
   finalizer 不兜底(结论 2)。
4. **dry-run 诚实性**——不 fetch 就显示不出真目标 sha;fetch 只动 remote-tracking ref,
   working tree 零 mutation,采纳(先例:plugin checker dry-run 做远端 lookup)。
5. **`set -euo pipefail` 下的 git 调用**——所有 git 步骤须显式 `|| { …; exit 1; }` 承接,
   禁止裸调依赖 -e 隐式退出(那会绕过告警)。
6. **updater 二次 fetch 成本**——updater 路径 pull 后数秒内 preflight 再 fetch 一次,窗口内若
   origin/main 又进新 commit,部署目标会比 marker 目标更超前;`ssq_is_satisfied` 按
   deployed-sha 包含 target 判定(祖先语义),更超前仍满足,无害。保持统一行为,不为 updater 加
   特例(零新机制)。
