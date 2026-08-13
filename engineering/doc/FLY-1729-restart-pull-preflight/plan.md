# FLY-1729 重启脚本 pull-latest-main 前置步 — 实施计划

Issue: FLY-1729 (https://linear.app/geoforge3d/issue/FLY-1729/chore部署链-重启脚本缺先-pull-latest-main前置步-每次重启都在旧码上起舰8-12-实撞两卡差点没上线)
日期: 2026-08-12
基于: research.md
修订: r6(吸收 Codex design review R1 全 5 项 + R2 全 3 项 + R3 全 2 项 + R4 全 4 项 + R5 全 2 项)

## 0. 一句话

在 `restart-services.sh` 的 restart 锁内、一切检测与部署决策之前,插入一个自包含的
`preflight_pull_latest_main()`:on-main → clean → 有界、显式更新 remote-tracking ref 的
`fetch origin +refs/heads/main:refs/remotes/origin/main` → **不可变 target sha
+ 四态拓扑判定** → FLY-1676 cutover 闸 → `merge --ff-only <target-sha>` → 合并后核验;任一步失败
= 告警 + exit 1 零服务 mutation;dry-run 跑同一套判定、只报告不 merge;下游 build/重启机器一行
不改。零新 flag、零新状态文件、零新周期任务。

## 1. 变更清单(5 处)

| 文件 | 变更 |
|------|------|
| `scripts/lib/discord-pointer-guard.sh` | **新增**(搬迁 + 最小三态化——r5#1):`discord_pointer_cutover_required()` 从 `update-flywheel.sh:72-84` 搬入;增加可选 commit-ish 参数(默认 `origin/main`),preflight 传捕获的 target sha;**返回值三态化**:0=cutover required、1=not required、2=target launcher 读取失败(原实现 `git show … \|\| return 1` 把 git 读失败混同「无需 cutover」= fail-open)。updater 调用点 `if discord_pointer_cutover_required` 原样不动——rc=2 对 if 仍为 false,可观察语义逐字不变 |
| `scripts/update-flywheel.sh` | 删本地函数定义,source 共享 lib;`default_deploy` 调用点与语义逐字不变 |
| `scripts/restart-services.sh` | source 共享 lib;新增 `preflight_pull_latest_main()`;`bounded-run.sh` 以**可执行文件**方式调用(它声明 "Executable, not sourced",无 `bounded_run()` 函数——r2#1 勘误;沿用 `lead_restart_gate_exec` 同款模式);在 sidecar 分配(:956)之后、`PLUGIN_RESTART_PENDING` 检测(:963)之前调用;dry-run 分支内以 `PREFLIGHT_TARGET_SHA` 作为展示用 CURRENT_HEAD |
| `scripts/test-restart-services.sh` | **既有顶层 fixture 改造**(必须,否则全部既有顶层用例被 preflight 打断):fixture checkout 收敛为 clean tracked main + 本地 bare origin(`origin/main` 可解析);注入式辅助脚本移出 checkout 或形成受控 commit;新增顶层 preflight 用例(§5B) |
| `.github/workflows/ci.yml` + `scripts/__tests__/ci-structure.test.sh` | 新测试文件 `scripts/__tests__/restart-pull-preflight.test.sh` 以**具名 workflow 命令**接入 CI(shell suite 是显式枚举清单,`test-restart-services.sh` 是独立 suite 而非聚合器——r1 勘误);ci-structure 断言恰一次接线 |

## 2. `preflight_pull_latest_main()` 规格(r2 重写)

自包含单函数(依赖经全局变量 + 可 stub 函数:`FLYWHEEL_DIR` / `DRY_RUN` / `log` /
`alert_severe` / `alert_warning` / `discord_pointer_cutover_required`;bounded runner 经**可注入
的可执行文件路径**,harness 注入 fake executable,不 stub 不存在的函数——r2#1),满足既有
sed 抽取 harness 模式。**每一个 git 调用(含只读的 status / rev-parse / rev-list / merge-base)
显式承接失败**:`set -euo pipefail` 下裸调会在 `RESTART_NOTICE_STARTED=false` 阶段静默退出,
finalizer 不兜底(research 结论 2)——读态失败统一走 typed 告警
`restart-preflight-git-state-unreadable`(severe)后 exit 1。

**dry-run 告警旁路是全分支契约(r3#2)**:下述每一个失败分支(含 bounded-run-missing 与
git-state-unreadable)一律 real = typed alert + exit 1,dry-run = stdout
`PREFLIGHT WOULD FAIL: <原因>` + exit 1 且**零告警调用**——dry-run 绝不触发 founder-facing
deploy alert,伪码中不再逐分支重复。

**git rc 三态语义(r2#2)**:布尔型 git 查询的 rc 必须三态承接,禁止两态 if——
`symbolic-ref --short -q HEAD`:0=读到分支、1=detached(正常 false → 归 not-on-main)、
其它=git-state-unreadable;`merge-base --is-ancestor`:0=true、1=false、其它(如坏 commit
的 128)=git-state-unreadable,绝不落进 diverged/not-on-main 签名。

**status 读取统一加 `GIT_OPTIONAL_LOCKS=0`(r5#2;QA R1 修订)**:普通 `git status` 会刷新并持久化 index
stat cache(实测:tracked 文件仅 touch,porcelain 为空,`.git/index` SHA 仍变)——与 dry-run
「无 index mutation」契约冲突。preflight 内三处 `status` 一律
`GIT_OPTIONAL_LOCKS=0 git -C "$FLYWHEEL_DIR" status --porcelain --untracked-files=no`:
dirty 门只拒绝 tracked/index 变化,并在 stdout + 告警正文列前 10 条路径;无关 untracked
文件原字节保留,其与来袭 commit 的真路径冲突交给后续 `merge --ff-only` fail-loud 拒绝,
不 reset/stash/覆盖。

```
preflight_pull_latest_main():
  # ① 分支形态:必须在 main(rc 三态:0=读到分支;1=detached → 归 not-on-main;
  #    其它 → git-state-unreadable —— r4#4 与三态契约对齐)
  branch=$(git symbolic-ref --short -q HEAD)
  branch != "main":
    real:    alert_severe "restart-preflight-not-on-main"(含实际分支/detached + 修复指引) → exit 1
    dry-run: "PREFLIGHT WOULD FAIL: checkout not on main (<actual>)" → exit 1
    # 理由:在别的分支上 ff-merge 会把那个分支的指针快进——绝不代操作员处置未知状态

  # ② tracked 工作区干净(第一次;untracked 不误拒,真路径冲突由 merge --ff-only 拒绝)
  git status --porcelain --untracked-files=no # 命令失败 → git-state-unreadable(severe) → exit 1
  输出非空:
    real: stdout + alert_severe "restart-preflight-dirty" 列前 10 条路径
          (明说不 reset --hard、需人清理) → exit 1
    dry-run: "PREFLIGHT WOULD FAIL: dirty checkout" + 前 10 行 → exit 1

  # ③ 有界 fetch(dry-run 也真跑——只动 remote-tracking ref,工作树零 mutation;
  #    不 fetch 则 dry-run 显示的目标 sha 可能是过期 ref = 说谎)
  bounded="${FLYWHEEL_RESTART_BOUNDED_RUN_BIN:-${FLYWHEEL_DIR}/scripts/lib/bounded-run.sh}"
    # bounded-run.sh 是可执行程序("Executable, not sourced"),按 lead_restart_gate_exec
    # 同款模式调用(r2#1);FLYWHEEL_RESTART_BOUNDED_RUN_BIN 为既有注入 seam,非新 flag
  [[ -x "$bounded" ]] 否则: alert_severe "restart-preflight-bounded-run-missing"
    # 工具缺失是 deterministic tooling failure,不伪装成 transient 网络告警 → exit 1
  GIT_TERMINAL_PROMPT=0 "$bounded" 120 git -C "$FLYWHEEL_DIR" fetch origin \
    +refs/heads/main:refs/remotes/origin/main --quiet
    # 显式 refspec 保证 origin/main 就是本次 fetch 的 main;不依赖 checkout 中可能缺失或
    # 被收窄的 remote.origin.fetch,避免 fetch 成功后仍把旧 remote-tracking ref 当最新目标
    # 无界 fetch 挂起会永久持有 restart.lock.d,2h stale-break 后与第二个重启并行(r1#5);
    # 120s 固定常量,零新 flag
    失败/超时: real: alert_warning "restart-preflight-fetch-failed"(transient:网络恢复后重跑;
              本次重启未执行) → exit 1
              dry-run: "PREFLIGHT WOULD FAIL: fetch failed" → exit 1

  # ④ fetch 后完整状态复核(**任何拓扑分派/early-return 之前**,real 与 dry-run 共用
  #    —— r2#3 + r3#1 + r4#1):最长 120s 的 fetch 窗口内操作员/其它进程可能写文件、也可能
  #    干净地切分支(porcelain 不报分支;不复核则 behind 态的 ff-merge 会把 topic 分支指针快进
  #    ——正是本 preflight 最初要禁止的「在错误分支上 merge」;restart 锁只串行化重启调用,
  #    不约束外部 git 操作)
  再跑 symbolic-ref 三态 → 必须仍为 main(否则 not-on-main / unreadable 失败分支)
  git status --porcelain --untracked-files=no 非空 → dirty 失败分支
    (real: stdout + alert_severe "restart-preflight-dirty" 均含前 10 条 tracked 路径;
    dry-run: WOULD FAIL "dirty checkout (appeared during fetch)")→ exit 1(不 merge)

  # ⑤ 捕获不可变 target + 四态拓扑判定(real 与 dry-run 共用同一路径 —— Codex r1#1)
  old_head=$(rev-parse HEAD); PREFLIGHT_TARGET_SHA=$(rev-parse origin/main)   # 40-char,此后只用它,不再用可移动 ref
  log "preflight: HEAD=${old_head:0:7} origin/main=${PREFLIGHT_TARGET_SHA:0:7} (behind N)"  # N=rev-list --count HEAD..target
  case 拓扑:                                    # 两次 merge-base --is-ancestor,读失败 → git-state-unreadable
    old_head == target                → accepted_state=already-at,继续 ⑥
                                        # 不早退:cutover 闸必须覆盖**所有**可部署 target——checkout
                                        # 被人工推进到需 cutover 的 target 时同样要给统一 verdict(r4#2)
    is-ancestor(old_head, target)     → accepted_state=behind,可 ff → 继续 ⑥
    is-ancestor(target, old_head)     → **本地领先**(local-only commits;此时 merge --ff-only 会
                                        返 0 且 HEAD 不动 = 部署不在 main 上的代码,r1#1 复现过)
                                        → real: alert_severe "restart-preflight-local-ahead" → exit 1
                                          dry-run: "PREFLIGHT WOULD FAIL: local-ahead" → exit 1
    两者皆非                          → 真分叉 → alert_severe "restart-preflight-diverged"(绝不
                                        reset --hard,需人裁决) / dry-run 同款 WOULD FAIL → exit 1

  # ⑥ FLY-1676 型 cutover 闸(merge 前,与 updater :99 同序同因:Lead spawn 热读 checkout 的
  #    claude-lead.sh,pull 而不 cutover = 现场破)。检查对象 = 捕获的 $PREFLIGHT_TARGET_SHA
  discord_pointer_cutover_required "$PREFLIGHT_TARGET_SHA";rc 三态承接(r5#1):
    rc=0(cutover required):
      real: alert_severe "restart-preflight-cutover-required"(指路 guarded FLY-1676 cutover) → exit 1
      dry-run: "PREFLIGHT WOULD FAIL: discord pointer cutover required" → exit 1
    rc=1(not required)→ 继续 ⑦
    rc=2(target launcher 读取失败)→ git-state-unreadable 失败分支(real severe /
      dry-run WOULD FAIL 零告警)——git 读失败绝不 fail-open 成「无需 cutover」

  # ⑦ 闸后分派(r4#2):already-at 在此收尾;behind 走 dry-run 报告/real 合并
  accepted_state == already-at → log "already at origin/main" → return 0(real 与 dry-run 同;后续零变化)
  dry-run: log "DRY RUN: would pull ${old_head:0:7} → ${PREFLIGHT_TARGET_SHA:0:7}" → return 0
  git merge --ff-only "$PREFLIGHT_TARGET_SHA" --quiet     # merge 的是 sha,不是可移动 ref
    失败(如未跟踪文件冲突):stdout + alert_severe "restart-preflight-nonff" 带 Git 诊断前 10 行
      (含冲突路径)→ exit 1
  # 合并后核验:HEAD 必须真到 target,且 tracked 工作区必须仍干净
  # (post-merge hook / 并发 tracked 写盘都会在此暴露;原有无关 untracked 可保留)
  rev-parse HEAD == PREFLIGHT_TARGET_SHA      否则 alert_severe "restart-preflight-postmerge-mismatch" → exit 1
  git status --porcelain --untracked-files=no 为空
                                               否则 alert_severe "restart-preflight-postmerge-dirty" → exit 1
  log "preflight: pulled ${old_head:0:7} → ${PREFLIGHT_TARGET_SHA:0:7}"
```

告警可见性契约:直调路径 detach 后 stdout 只进 detach log,preflight 失败**必须**经
alert_severe/warning 出圈;`restart_on_exit` finalizer 不兜底(只覆盖
`RESTART_NOTICE_STARTED=true` 之后的异常退出,preflight 恒在其之前)——preflight 的告警即终局
报告,不触发二次告警,也不产生「开始了没结果」悬案。dry-run 一律不发 Discord 告警(交互前台,
stdout 可见)。

## 3. 插入点与顺序论证

```
acquire_lock (:943)                     # pull 必须在 restart 锁内:串行化并发直调,
                                        # 且天然继承与 flywheel-fleet.sh 的互斥
sidecar mktemp (:946-956)
──► preflight_pull_latest_main()  ← 新   # 本单唯一插入点
PLUGIN_RESTART_PENDING (:963)           # 以下全部既有检测按「pull 后的新状态」工作:
check_discord_plugin_fork (:970)        #   fork 检测对比新 repo 状态(应然)
check_project_lead_changes (:983)
DEPLOYED_SHA / CURRENT_HEAD (:989-990)  #   CURRENT_HEAD 现在读到 target sha
diff 分类 + dbi_skip_build_allowed
DRY_RUN 汇报后 exit (:1091-1095)
deploy_and_verify (:1881)
```

- **不放 parent(detach 前)**:pull 在锁外——与在飞重启的 build 竞争 = 产物腐坏;并发直调撞
  git index.lock = 假 fail-loud。
- **不 `exec "$0"` 重执行**:bash `exec` 不触发 EXIT trap → 锁不清理 → 新进程撞自己的锁按争用
  语义 exit 0 = 重启静默消失。接受**一代滞后**(直调路径本次运行用 detach 时刻的旧重启逻辑部署
  新码;git 更新文件 = unlink+新 inode,运行中 bash 持旧 fd 安全)。准确说这是**混合代运行**:
  已 source 的函数保持旧版,merge 后 spawn 的子脚本读新版;下次重启全量自愈。updater 路径无此边界。
- **updater 路径幂等**:updater 已 pull → ⑤ 判 already-at、过 ⑥ cutover 闸后在 ⑦ 返回
  (r4#4 编号勘误),行为零变化;二次
  fetch 窗口内 origin/main 再进新 commit → 部署目标更超前,`ssq_is_satisfied` 祖先语义
  (self-ship-queue.sh:186)仍满足,无害。不加 updater 特例。

### 3a. build 失败契约(r2 新增,诚实化 —— Codex r1#3)

issue 字面第 3 步是「build 失败同样 fail-loud 不重启」。**既有下游机器的真实行为不是这样**,
本计划也**不改它**:`deploy_and_verify` 的顺序是 开始播报 → 暂停 admission → `stop_bridge` →
`build_project`;build 失败走 `rollback_and_restart`(:1800):reset --hard 回 DEPLOYED_SHA(会
退掉刚 pull 进来的 commits——自洽:checkout 回到与 deployed-sha 一致,下次重启重新 pull)→
重建旧版 → 重启旧版舰队 → `alert_warning "update-rolled-back"` / 失败升 severe。deployed-sha
不推进。与 preflight 的 tracked-clean 策略一致,rollback 的 reset 前置门也只拒绝 tracked/index
变化;无关 untracked 不会被 `reset --hard` 删除,也不能把已准入的恢复路径反向堵死。

**为什么不按字面改**:build 发生在 Bridge 已停之后,「不重启」的字面含义 = 让舰队保持死机;
既有 rollback 是恢复服务的安全机制(FLY-516 加固过,fail-closed 齐全)。把 build 挪到 stop 之前
才能实现字面语义,但那是对 deploy_and_verify 的真实重排——重开「build 期间活 Bridge spawn 读到
半成品 dist」的风险面,违背零新机制红线。**本单选择:保留既有 rollback 契约,满足 spirit
(响亮、deployed-sha 不推进、不在坏状态上完成部署),偏离字面「不重启」。** 该偏离作为关键
tradeoff 写进 founder design HTML 显式呈现,由 founder 在 review 时裁决;若 founder 要字面
语义,另立 issue 重排 build 顺序,不塞进本单。

另注(r1#3 附带):`dbi_skip_build_allowed` 在 built 模式下要求 artifact sha == 新 CURRENT_HEAD,
拉到新码后旧 artifact 必然不匹配 → 强制 rebuild;唯一 skip 的情形是该 head 的 artifact 已存在
(如上次失败部署已建成),那是合法跳过。source mode 需显式 env override,非默认路径,不展开。

## 4. dry-run 输出契约(验收:「dry-run 输出含目标 sha」)

- preflight 报告块必含:当前 HEAD sha、**origin/main 目标 sha**、落后 commit 数、
  `would pull X → Y` 或 `already at origin/main`。
- 之后(仅 dry-run 分支内)`CURRENT_HEAD="$PREFLIGHT_TARGET_SHA"`,使 `:1092-1094` 打印的
  build/skip 与 `Changes since` 反映真跑将部署的内容(display-only:dry-run 在 `:1095` exit 0)。
- dry-run 的 mutation 边界(r4#3 收窄):**无 HEAD/index/工作树/merge/service mutation**;
  fetch 的 Git metadata(remote-tracking ref、FETCH_HEAD)按设计更新,测试显式核对而非笼统
  断言「零落盘」。
- 真跑会拒绝的状态(脏/本地领先/真分叉/fetch 失败/cutover)→ `PREFLIGHT WOULD FAIL: <原因>`
  + exit 1。四态拓扑判定在 dry-run 与 real 共用同一路径,dry-run 的分叉/领先判定是真判定,
  不依赖 merge(r1#1 的 dry-run 缺口由此闭合)。已有 dry-run 消费方均为人眼/交互,无解析
  rc==0 的自动化(research §3)。

## 5. 测试计划(TDD,先红后绿)

### 5A. 函数级 hermetic suite — 新 `scripts/__tests__/restart-pull-preflight.test.sh`

mktemp 下建 bare「假 origin」+ clone 出假 FLYWHEEL_DIR,sed 抽 `preflight_pull_latest_main`
进 harness,stub `log/alert_severe/alert_warning/discord_pointer_cutover_required`;bounded
runner 经 `FLYWHEEL_RESTART_BOUNDED_RUN_BIN` 注入 **fake executable**(不 stub 函数——它不是
函数,r2#1),env 注入 `FLYWHEEL_DIR`。全程离线、不 stub git。

| # | 场景 | 断言 |
|---|------|------|
| 1 | 纯落后 N commits(real) | rc=0;HEAD == target;log 含 `pulled old → new` |
| 2 | 已在 origin/main | rc=0;HEAD 不变;零 merge 副作用(reflog 无新条目) |
| 3 | tracked 脏 checkout(real) | rc=1;stdout + alert_severe 均含路径;告警恰一次(dirty);HEAD/工作树未动 |
| 3b | 无关 untracked 文件 + 可安全 fast-forward | rc=0;HEAD == target;untracked 原字节保留;零告警(QA R1 F1) |
| 3c | untracked 路径与来袭 commit 真冲突 | `merge --ff-only` rc!=0;stdout + nonff 告警含冲突路径且告警恰一次;HEAD 与 untracked 原字节均不变(QA R1 B2) |
| 3d | checkout 缺省 fetch refspec 被移除 | 显式 fetch refspec 仍推进 `origin/main`;HEAD 最终等于远端 main,不把旧 remote-tracking ref 当最新目标 |
| 4a | **本地领先**(local-only commit,origin/main 是其祖先;real) | rc=1;alert_severe local-ahead;HEAD 不动;**无 merge 执行痕迹**(r1#1 关键新例) |
| 4b | **真分叉**(双方各有提交;real) | rc=1;alert_severe diverged;无 reset(local commit 仍在) |
| 5 | fetch 失败(origin URL 指向不存在路径) | rc=1;alert_warning(transient 措辞) |
| 5b | fetch 超时(fake bounded runner 返 124) | rc=1;alert_warning;锁清理由上层 trap 覆盖(顶层例见 5B) |
| 5c | bounded runner 缺失/不可执行 | rc=1;alert_severe bounded-run-missing(deterministic,**非** transient fetch 告警——r2#1) |
| 5d | **真 bounded-run.sh** × 挂起的 fake git(sleep 冒充) | 124 超时返回;**无残留子进程**(bounded runner 收尸回归) |
| 5e | fetch 窗口内变脏(fake bounded runner 成功返回前向 checkout 写文件;behind 态) | rc=1(第二次 clean 检查拦下);HEAD/reflog 未变;**无 merge**(r2#3) |
| 5f | fetch 窗口内变脏 × **already-at 态**(real + dry-run 各一例) | rc=1;零下游继续(already-at 早退不得绕过二次 clean 检查——r3#1) |
| 5g | fetch 窗口内**干净切分支**(fake bounded runner 成功返回前 checkout 切到同点/落后 topic 分支;behind + at-target 两态) | rc=1;typed not-on-main / dry-run WOULD FAIL;**无 merge,topic 分支指针未被推进**;零服务调用(r4#1) |
| 6 | 不在 main / detached HEAD | rc=1;alert_severe not-on-main;分支指针未动 |
| 7 | cutover 闸成立(stub 返回 0)× behind | rc=1;merge 未执行(HEAD 不变);闸收到的实参 == 捕获的 target sha |
| 7b | cutover 闸成立 × **already-at**(real + dry-run 各一例) | rc=1;already-at 不得绕过闸——checkout 已被人工推进到需 cutover 的 target 时同样给统一 verdict(r4#2) |
| 7c | **真 helper**(非 stub)三态回归:(i) 注入 `git show` fatal → helper 返 2 → preflight 走 git-state-unreadable,**不** fail-open 继续 merge;(ii) 让 `origin/main` 与传入 commit-ish 处于不同 selector 状态 → 判定跟随传入参数(证明 helper 内部真用了参数,未硬编码 `origin/main`)(r5#1) | rc/verdict 如左;stub-only 的 #7 抓不住 helper 内部实现错误 |
| 13 | dry-run × tracked 文件仅 mtime 变(内容不变) | porcelain 判 clean;**`.git/index` checksum 前后不变**(`GIT_OPTIONAL_LOCKS=0` 生效证明,r5#2) |
| 8a | dry-run × 纯落后 | rc=0;输出含目标 sha + `would pull`;**HEAD 不变**;fetch 已发生(remote-tracking ref 已更新) |
| 8b | dry-run × 本地领先 / 真分叉(各一例) | rc=1;`PREFLIGHT WOULD FAIL`;零告警调用(r1#1 的 dry-run 真判定证明) |
| 9 | dry-run × 脏 | rc=1;`PREFLIGHT WOULD FAIL`;零告警调用 |
| 10a | rev-parse 读态失败(PATH 注入) | rc=1;alert_severe git-state-unreadable(r1#2) |
| 10b | symbolic-ref fatal(rc>1,非 detached) | rc=1;git-state-unreadable,**不落 not-on-main 签名**(r2#2) |
| 10c | merge-base fatal(坏 commit,rc=128) | rc=1;git-state-unreadable,**不落 diverged 签名**(r2#2) |
| 11 | 合并后核验:post-merge hook 把工作区弄脏(fixture 装一个写文件的 post-merge hook) | rc=1;alert_severe postmerge-dirty(r1#2) |
| 12 | 告警配额反证(参数化矩阵:**real 覆盖全部失败分支;dry-run 覆盖全部 dry-run-reachable 失败分支**——nonff/postmerge-mismatch/postmerge-dirty 是 real-only,merge 在 dry-run 中不执行,无对应形态,r4#3) | 每个 real 失败分支恰一条 typed 告警;dry-run 分支零告警 + stdout 含准确 `PREFLIGHT WOULD FAIL` 原因 + **无 HEAD/index/工作树/merge/service mutation**(fetch metadata 变化为预期,显式核对) |

### 5B. 顶层 suite — `scripts/test-restart-services.sh` 改造 + 新用例(Codex r1#4)

函数级抽取证明不了「顶层真的在锁后、一切 mutation 前跑了 preflight」。既有顶层 fixture
(:1693-1744)是**脏 checkout 且无 origin remote**——preflight 落地后所有既有顶层用例会死在
dirty/fetch 阶段。因此:

1. **fixture 改造**:fixture checkout 收敛为 clean tracked main;配套建本地 bare origin 并设
   `origin/main`;注入式辅助脚本移出 checkout(或受控 commit 进 fixture 历史)。既有用例在改造
   后必须全绿(它们是「preflight 幂等短路(already at origin/main)不扰动既有行为」的回归证明)。
2. **新顶层用例**(真跑脚本顶层,FLYWHEEL_RESTART_FOREGROUND=1):
   - behind + 无关 untracked → 走到部署决策时 HEAD == origin/main,untracked 原字节保留;
   - tracked dirty(告警/stdout 均含路径) / local-ahead / diverged / fetch-fail → exit 1 + 恰一条 fake lead-alert 记录 +
     **零 mutation 证据**(stub 的 pnpm/launchctl/Lead-wave 调用计数全 0)+ 锁与 sidecar 已清理;
   - dry-run behind → stdout 含目标 sha,HEAD 不变,exit 0;
   - detach 路径一例:parent exit 0 后 detached child 的 preflight 失败在 fake alert sink 里
     可见(告警是 detach 后唯一出圈通道的直接证据)。
3. **rollback 一致性回归**:tracked dirt 继续阻止 `reset --hard`;仅无关 untracked 时允许恢复旧版,
   并保留 untracked 字节。

### 5C. 回归哨兵

- `update-flywheel-queue.test.sh` + `self-ship-queue.test.sh` 全绿(共享 lib 搬迁后 updater
  语义逐字不变;guard 增加可选参数后 updater 无参调用路径 byte-compat)。
- `restart-self-detach.test.sh` / `restart-services-notify.test.sh` 等既有 restart 家族全绿。
- `ci-structure.test.sh`:新增断言「restart-pull-preflight.test.sh 在 CI workflow 中恰一次
  具名接线」。

### 5D. 真机验收(implement 之后、独立 QA 节点;部署 founder-gated)

制造生产 checkout 落后 origin/main 的状态 → 跑重启 → 起舰后 Bridge build 身份 sha ==
origin/main HEAD(issue 验收 a);脏 checkout → 拒绝且信息指明原因(验收 b);dry-run 输出含
目标 sha(验收 c)。

## 6. 明确不做(诚实边界)

1. **不改 updater 的 pull 流程**(只做函数搬迁 + 可选参数,行为逐字保留);updater pull 在
   restart 锁外的既有窗口不在本单修(research 结论 4)。
2. **不消除直调路径的一代滞后**(exec 重执行 = 新机制 + 自锁死风险;下次重启自愈)。
3. **不加任何跳过开关**:无 `--no-pull`、无 env 旁路。离线时重启会被拒——部署工具对未知远端
   fail-closed 是意图行为;崩溃恢复由 launchd KeepAlive 负责,不依赖本脚本。fetch 上限用既有
   `bounded-run.sh` 固定常量,不引入可调 env。
4. **不 reset --hard、不 stash、不代清理**(preflight 内);既有 rollback 路径里的
   reset --hard 是既有机制,不动(§3a)。
5. **不重排 build/stop 顺序**:build 失败沿用既有 rollback 契约(§3a),偏离 issue 字面
   「不重启」,作为关键 tradeoff 交 founder 裁决;要字面语义另立 issue。
6. **不动项目仓逻辑**(`check_project_lead_changes` 的 fetch 语义原样)。

## 7. 验证门(implement 节点收尾)

`pnpm lint`(全仓)+ `pnpm -r build` + `pnpm test:packages:run` + 全部
`scripts/__tests__/restart-*.test.sh` + `scripts/test-restart-services.sh`(改造后全量)+ 新
suite;shellcheck 对改动文件零新告警。Codex code review(codex:rescue)循环至 APPROVED。
