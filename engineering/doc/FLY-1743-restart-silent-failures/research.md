# FLY-1743 重启部署两处静默失效 — 调研

Issue: FLY-1743 (https://linear.app/geoforge3d/issue/FLY-1743/bughigh-重启部署路径两处静默失效中途-abort-留源码前进产物未动无检测无告警1729-引入回滚-git-status-fail)
日期: 2026-08-13
基于: exploration.md

行号基于本分支 HEAD(含 FLY-1729 merge `9ccf92ab`)的 `scripts/restart-services.sh`。每条都是本次逐行读码取证,不是转述。

## 1. 缺陷 ① 的机制事实

### 1.1 EXIT trap 是唯一全覆盖收口

- trap 在 `acquire_lock()` 内安装(L1257-1259):`trap 'restart_on_exit "$?"' EXIT` + INT(→exit 130)/TERM(→exit 143)。**只有拿到锁的 deploy body 有 trap**;自分离父进程在 L1176-1186 `exit 0`,那之前没有 trap ⇒ 父进程退出不会误触任何新检查。
- `restart_on_exit()`(L433-469):`trap - EXIT; set +e`(⇒ 在里面加检查不会因 `set -e` 自杀);最后 `exit "$original_rc"`。**改写 original_rc 即可改最终退出码**——这是「保证非零退出」的落点。
- 现有 trap 告警 `restart-aborted-unexpectedly` 有双前置:`RESTART_NOTICE_STARTED == true && RESTART_TERMINAL_REPORTED != true`。`RESTART_NOTICE_STARTED` 在 `deploy_and_verify` 第一行(L2317)才置 true ⇒ **preflight 之后、deploy_and_verify 之前的三个顶层 `exit 1`(L1293 registry / L1301 default-lead / L1322 fork rc=2)在 trap 里零告警**。新的不变量检查必须**不依赖**这两个 flag。

### 1.2 HEAD 突变点与账本推进点

- HEAD 唯一突变点:`preflight_pull_latest_main()` 内 L757 `merge --ff-only`(成功后 L768 验 `post_head == target_sha`)。dry-run 在 L753-756 提前 return,永不 merge。
- 账本推进点:`deploy_and_verify` Step 5(L2545-2549):`record_deployed_range` + `echo "$CURRENT_HEAD" > "$DEPLOYED_SHA_FILE"`。位于 Bridge health/DBI/voice-bridge/Lead wave/1573 就绪闸**全部之后** ⇒ 残留窗口内的中止点 10+ 个(exploration §2.1 已枚举)。
- `DEPLOYED_SHA_FILE = ~/.flywheel/deployed-sha`(L39);`CURRENT_HEAD` 在 L1338 读一次并缓存 ⇒ **exit 检查必须 fresh-read 两端**(rollback 成功会把 HEAD 弄回去;deployed-sha 可能刚被推进)——验证在终点取证,不能用运行早期的缓存变量。

### 1.3 已存在的告警语义(新告警要对齐的合同)

- `alert_severe()`(L374-387):走 `scripts/lead-alert.sh`,`--kind deploy_failed --severity severe`,signature = `<slug>-YYYYmmddHHMM`(分钟粒度去重),设置了 `FLYWHEEL_FOUNDER_USER_ID` 时 @-mention founder,**结尾 `|| true` = best-effort** ⇒ 告警可能发不出去,所以「非零退出码」是不可省的第二根支柱,不是锦上添花。
- 一次失败会出「步骤告警 + 状态告警」两条。**这是设计而非缺陷**:步骤告警答「哪里断的」,状态告警答「现在留下了什么」。issue 逐字要求后者独立存在(「它告警的是那一步失败,不是『现在源码与产物不一致』这个事实」)。

### 1.4 arming 两点的必要性论证(各自覆盖对方漏掉的路径)

| arming 点 | 覆盖 | 若缺失 |
| --- | --- | --- |
| (a) L757 `merge --ff-only` **执行之前**(behind 分支内、非 dry-run) | merge 本身及其后一切:post-merge 校验失败(L768/L779/L787),以及 **merge 返回边界上到达的 INT/TERM**(Codex R1 #2:Bash 在前台命令返回后、下一条赋值前处理 pending trap——若 arm 放在 merge 之后,TERM 恰在该边界到达时 HEAD 已动而 armed 仍 false,trap 静默;Codex 用同形片段复现 rc=143 + armed=false) | 带着新残留的 signal 退出静默 |
| (b) L1284 调用点成功返回后(顶层,`DRY_RUN != true` 守卫) | already-at 修复跑:上次 abort 留残留,这次 preflight 没 merge(HEAD 已在 target)但接手了收敛义务;之后再失败必须响 | 「第二次失败」永远静默,残留无限期存活 |

arm-before-merge 无误报:merge 失败且 HEAD 未动时,正常跑 HEAD==deployed ⇒ 终态比较天然静音;修复跑 HEAD≠deployed ⇒ 响,而残留确实还在——正确信号。dry-run 两点都不 arm(dry-run 在 behind 分支前 return、(b) 有守卫)。

### 1.4b trap 内的传码通道(Codex R1 #1 BLOCKER 事实)

生产 `log()`(L160-165)**写 stdout** ⇒ 检查 helper 里既调 `log` 又想经 stdout `echo 1` 回传升级码的设计不成立:`$(...)` 捕获会把日志混进退出码(`exit "ERROR…\n1"` → `numeric argument required` → rc=2,且日志被吞)。正确通道 = **函数返回码**:helper 一致时 return 0,违约时告警后 return 1;trap 内(已 `set +e`)`if ! verify…; then (( original_rc == 0 )) && original_rc=1; fi`。

### 1.5 告警措辞的可证伪边界

残留窗口内有两类真实状态:(i) merge 后 build 前中止 ⇒ 跑的还是旧码;(ii) 新 Bridge 已 start、账本推进前中止(voice-bridge/就绪闸失败)⇒ 跑的已是新码、账本落后。exit 检查**只能证明「两个 SHA 不相等」**,不能证明哪一侧是活的 ⇒ 告警文案必须只断言可证的事实(「源码 HEAD=X 与 deployed-sha=Y 不一致,部署未收敛,需要 deliberate 重跑或回滚」),不得写「正在跑旧码」。(记忆规则:拿标签冒充事实/话对但没交代边界。)

### 1.6 deployed-sha 为空(first run)

L2210-2217:first run 失败已有专门 severe(`deploy-failed-no-rollback`)。exit 检查对「armed + deployed-sha 文件缺失/空」同样报不一致(文案适配「deployed-sha 缺失」),不特判静音——空账本 + 已 arm 的事务未收敛,同样是要人知道的状态。

## 2. 缺陷 ② 的机制事实

### 2.1 fail-open 链条

L2219 `if [[ -n "$(git ... status --porcelain --untracked-files=no)" ]]`:
- `$(...)` 内命令失败 ⇒ stdout 为空 ⇒ `-n ""` 假 ⇒ 不进 dirty 分支——**status fail-open 对所有调用路径成立**(失败的 substitution 位于 `if [[ ]]` 判定内,`set -e` 不管辖);
- ⇒ L2228 `git reset --hard` 对未知状态的工作区执行。
- 调用上下文事实(Codex R1 #4 更正,原稿断言过宽):三个调用点里只有 voice-bridge 路径(L2306 `if !`)处于条件上下文、函数体内 errexit 被抑制——**该路径上裸 `reset --hard` 失败会静默继续跑 pnpm rebuild + 重启并可能报「已回滚」**;build(L2359)与 health(L2425)是裸调用且 `deploy_and_verify` 在顶层也是裸调用,errexit 活跃,`reset` 失败会经 `set -e` 中止(响亮度取决于 trap 既有告警)。reset rc 显式 guard 的价值:堵死 voice 条件路径的静默继续,并给所有路径一致的专门告警。

### 2.2 同文件已验证的正确 pattern(L779-786,FLY-1729 自己写的)

```bash
status_rc=0
status_output="$(GIT_OPTIONAL_LOCKS=0 git -C "$FLYWHEEL_DIR" status --porcelain --untracked-files=no 2>/dev/null)" || status_rc=$?
if (( status_rc != 0 )); then …拒绝 + alert_severe + return 1…
if [[ -n "$status_output" ]]; then …dirty 分支…
```

镜像它即可。`GIT_OPTIONAL_LOCKS=0` 有额外意义:status 默认会拿乐观锁刷新 index,与并发 git 操作撞 `index.lock` 时非零——旧代码这种瞬时非零恰好走 fail-open「继续 reset」,新硬闸若不带此参数会把这类瞬时故障升级成拒绝回滚;带上则 status 不写 index,消掉这一类误拒。

### 2.3 `reset --hard` 自身 rc(相邻同病,一并修)

L2228 裸调用。失败(对象损坏、磁盘满、权限)后:**voice-style 条件调用下**(errexit 被抑制)函数继续「best-effort rebuild + restart + 报 update-rolled-back」——对未知工作区宣称回滚成功;build/health 裸调用下由 errexit 中止(无专门告警)。修:`if ! git reset --hard …` ⇒ severe `rollback-reset-failed` + `RESTART_TERMINAL_REPORTED=true` + return 1——堵死 voice 路径的静默继续,并给所有路径一致的专门告警。属于缺陷 ② 的判据范围,3 行改动,不扩 scope。(Codex R2 LOW-1 已折入,与 §2.1 口径一致)

### 2.4 与缺陷 ① 的组合行为(设计后的闭环)

回滚被新闸拒绝(unreadable / dirty / reset-failed)⇒ return 1 ⇒ deploy 失败退出 ⇒ **armed 的 exit 检查同时发现 HEAD ≠ deployed** ⇒ 状态告警补位。② 防止把状态弄得更坏,① 保证没修完必有人知道。回滚成功 ⇒ `reset --hard` 把 HEAD 弄回 `DEPLOYED_SHA` ⇒ exit 检查两端相等 ⇒ 静音——**回滚成功天然满足不变量,不需要豁免逻辑**。

## 3. 测试基建事实(RED→GREEN 的落点)

- `scripts/__tests__/restart-pull-preflight.test.sh`(FLY-1729,25 case)已确立本文件函数级测试的全部约定:**`sed -n '/^func()/,/^}/p'` 抽函数** → source 进沙箱 shell + stub(`alert_severe`/`alert_warning` 写 `SEVERE_FILE`/`WARNING_FILE`、`log` 写 `LOG_FILE`)→ 沙箱 git(bare origin + seed + checkout)→ 断言捕获文件与 rc。新测试直接复用该 harness 形状。
- 缺陷 ② 可注入点:PATH shim git wrapper(仅 `status` 子命令返回非零/仅 `reset` 返回非零,其余透传真 git)——suite 内已有 PATH-shim 先例;断言「shim 从未收到 `reset`」证明破坏性操作未执行(修前 RED:shim 记录到 `reset --hard` 被调用,**先证现行 fail-open 行为真实存在**)。
- 缺陷 ① 集成级注入点(整脚本沙箱跑):在 `check_discord_plugin_fork` 处制造 rc=2(checker 缺失即触发,L806-815)是 merge 后最早、最便宜的确定性 abort;post-merge-dirty 用 origin 侧 commit + checkout 本地改 tracked 文件在 merge 后被 hook 弄脏较绕,改用**函数级**:抽 `restart_on_exit` + 新 helper,直接摆两个 SHA 的沙箱状态断言告警与 rc。
- 🔴 沙箱红线(记忆,2026-08-12 两次真实事故):整脚本沙箱跑 `restart-services.sh` **必须 `export BRIDGE_URL=http://127.0.0.1:<空闲端口>`**——假 HOME/假 FLYWHEEL_DIR 拦不住 `stop_bridge` 按端口杀生产 Bridge。函数级测试不触 `stop_bridge`,天然安全;任何整脚本 case 必须带这条。
- 既有 finalizer harness `scripts/test-restart-services.sh` 用 sed **只抽取 `restart_on_exit()`**——新增外部 helper 后该 harness 不会自动加载它(Codex R1 #5)⇒ harness 的抽取范围必须随改动扩到 helper,并在既有 finalizer case 里显式置 armed 默认值,否则测试「全绿」但根本没跑新检查。
- 回归底座与 baseline 诚实化(Codex R1 #5 实测):`restart-pull-preflight` 本机 25/25;`scripts/test-restart-services.sh` 本机 124 passed / 8 failed(共 132,受限 host 环境项)——**不得沿用旧口径「131/131」宣称回归门已绿**;实现前先记录可复现 baseline/环境例外,或以 exact CI 为权威。CI 接线明确落 `.github/workflows/ci.yml`,并把新测试命令加入 `ci-structure.test.sh` 的 exactly-once sentinel。

## 4. 复用与不新增

- 不新建告警通道/机制:复用 `alert_severe()`(§1.3)。新 signature slug 四个:`restart-source-deployed-mismatch`(中性命名——`HEAD != deployed-sha` 只能证明「不一致」,证不了方向,Codex R1 #3)、`restart-deploy-consistency-unverifiable`、`rollback-blocked-state-unreadable`、`rollback-reset-failed`(均走既有 lead-alert.sh 合同)。
- 不新增 env/flag/配置(FLY-1466「不加新 flag」铁律):arming 是脚本内部状态变量,不对外。
- 不新增周期任务/timer:检查只发生在本就存在的 EXIT trap 里。
