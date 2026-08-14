# FLY-1743 重启部署两处静默失效 — 实施计划

Issue: FLY-1743 (https://linear.app/geoforge3d/issue/FLY-1743/bughigh-重启部署路径两处静默失效中途-abort-留源码前进产物未动无检测无告警1729-引入回滚-git-status-fail)
日期: 2026-08-13
基于: research.md

## 0. 保质期分辨(第一屏)

- **会作废**:本计划所有行号(基于 `9ccf92ab` 后的本分支 HEAD,`scripts/restart-services.sh` 2681 行)。实现前若 main 又动过此文件,以锚文本(函数名/告警 slug/代码片段)重定位,不以行号。
- **不会作废**:两条不变量本身——(①)armed 部署事务退出时 `HEAD == deployed-sha` 否则 severe+非零;(②)回滚在工作区状态不可读或 `reset --hard` 失败时拒绝继续。以及测试对这两条的行为断言。

## 1. 范围

只改 1 个生产文件 + 新增/扩展 shell 测试:

| 文件 | 改动 |
| --- | --- |
| `scripts/restart-services.sh` | 缺陷 ① 三小块(全局变量 + 两个 arming 位点 + trap 内检查函数);缺陷 ② 两小块(status rc 硬闸 + reset rc 硬闸) |
| `scripts/__tests__/restart-deploy-consistency.test.sh`(新) | 缺陷 ① 函数级 + 缺陷 ② 函数级,RED→GREEN |
| `scripts/test-restart-services.sh`(既有 finalizer harness) | sed 抽取范围扩到新 helper(否则 harness 不加载它,新检查在测试里根本不跑——Codex R1 #5);既有 finalizer case 显式置 armed 默认值 false |
| CI 接线 | 新 test 文件挂进 `.github/workflows/ci.yml`,命令加入 `ci-structure.test.sh` 的 exactly-once sentinel |

**不改**:preflight 响亮拒绝路径、`restart_on_exit` 既有告警逻辑、per-project SHA 台账、任何 env/flag(FLY-1466 铁律:零新 flag)、任何 TypeScript。

## 2. 缺陷 ② 实现(先做——独立、小、存量债)

### 2.1 status rc 硬闸(`rollback_and_restart()`,L2216-2226 一带)

现:

```bash
if [[ -n "$(git -C "$FLYWHEEL_DIR" status --porcelain --untracked-files=no)" ]]; then
```

改为(镜像同文件 L779-786 preflight 的既有 pattern,含 `GIT_OPTIONAL_LOCKS=0`;research §2.2 论证):

```bash
local rb_status_output="" rb_status_rc=0
rb_status_output="$(GIT_OPTIONAL_LOCKS=0 git -C "$FLYWHEEL_DIR" status --porcelain --untracked-files=no 2>/dev/null)" || rb_status_rc=$?
if (( rb_status_rc != 0 )); then
    log "ERROR: cannot read working-tree state (git status rc=${rb_status_rc}); refusing reset --hard"
    alert_severe "rollback-blocked-state-unreadable" "Flywheel rollback blocked" \
        "Flywheel rollback 被阻止: 无法读取工作区状态 (git status 失败, rc=${rb_status_rc})。状态未知时绝不执行 reset --hard。需要手动介入。"
    RESTART_TERMINAL_REPORTED=true
    return 1
fi
if [[ -n "$rb_status_output" ]]; then
    …(既有 dirty 分支原样保留:log + alert_severe rollback-blocked-dirty + return 1)…
fi
```

### 2.2 reset rc 硬闸(L2228)

```bash
if ! git -C "$FLYWHEEL_DIR" reset --hard "$rollback_sha"; then
    log "ERROR: git reset --hard ${rollback_sha:0:7} failed during rollback; working tree state unknown, stopping"
    alert_severe "rollback-reset-failed" "Flywheel rollback failed" \
        "Flywheel rollback 执行 reset --hard 到 \`${rollback_sha:0:7}\` 失败,工作区状态未知。已停止(不重建、不重启旧版本)。需要手动介入。"
    RESTART_TERMINAL_REPORTED=true
    return 1
fi
```

语义变化(诚实声明,按 Codex R1 #4 更正后的事实):
- **status fail-open 对全部三个调用路径成立**(失败 substitution 在 `if [[ ]]` 判定内,`set -e` 不管辖)——新 rc 硬闸对所有路径都是行为修复。
- **reset 裸调用的旧行为分路径**:voice-bridge 调用点(`if ! rollback_and_restart`)函数体 errexit 被抑制,reset 失败会**静默继续** pnpm rebuild + 重启并可能报「已回滚」——这是 reset guard 要堵的静默路径;build/health 两处是裸调用(errexit 活跃),reset 失败经 `set -e` 中止——guard 在这两处的价值是给出专门告警而非改变生死。
- 旧行为里被瞬时 `index.lock` 撞非零的场景,`GIT_OPTIONAL_LOCKS=0` 可避免 status 的可选 index refresh/锁竞争(不消除所有 index.lock 失败);剩余真失败本来就不该继续。

## 3. 缺陷 ① 实现

### 3.1 全局变量(Configuration 区,L23 一带)

```bash
DEPLOY_CONSISTENCY_ARMED=false
```

### 3.2 arming 位点 (a):**merge 执行之前** arm(`preflight_pull_latest_main` 内,behind 分支、dry-run return 之后、L757 `merge --ff-only` 之前)

```bash
DEPLOY_CONSISTENCY_ARMED=true
```

为什么在 merge **前**(Codex R1 #2 HIGH):Bash 在前台命令返回后、下一条语句前处理 pending trap;arm 放 merge 后,则 TERM/INT 恰在 merge 返回边界到达时 HEAD 已动而 armed 仍 false ⇒ trap 静默(Codex 以同形片段复现 rc=143 + armed=false)。arm-before-merge 无误报:merge 失败且 HEAD 未动时,正常跑 HEAD==deployed 终态天然静音;修复跑 HEAD≠deployed 会响——残留确实还在,是正确信号。(dry-run 在 behind 分支前已 return,到不了这里。)

### 3.3 arming 位点 (b):preflight 成功返回后(顶层 L1284 一带)

```bash
preflight_pull_latest_main || exit 1
if [[ "$DRY_RUN" != "true" ]]; then
    DEPLOY_CONSISTENCY_ARMED=true
fi
```

### 3.4 exit 检查函数(新,放 `restart_on_exit` 定义之前)

```bash
# FLY-1743: terminal deploy-consistency invariant. Once this run owns the
# deploy transaction (armed before the ff-merge / after preflight success),
# every exit must end with source HEAD == deployed-sha — otherwise a
# mid-flight abort has left source and the deployed ledger inconsistent and
# someone must hear about it. The criterion is the RESULT STATE, deliberately
# not "which step failed" (step alerts already exist and rot as steps evolve).
# Both sides are re-read here: a successful rollback moves HEAD back; a
# successful deploy advances the file.
# Return: 0 = invariant holds (or not armed / dry-run); 1 = violation alerted.
verify_deploy_consistency_on_exit() {
    [[ "$DEPLOY_CONSISTENCY_ARMED" == "true" ]] || return 0
    [[ "$DRY_RUN" == "true" ]] && return 0
    local final_head="" head_rc=0 final_deployed="" deployed_rc=0 deployed_display=""
    final_head="$(git -C "$FLYWHEEL_DIR" rev-parse --verify HEAD 2>/dev/null)" || head_rc=$?
    if (( head_rc != 0 )) || [[ -z "$final_head" ]]; then
        log "ERROR: deploy consistency check could not read source HEAD at exit (rc=${head_rc})" >&2
        alert_severe "restart-deploy-consistency-unverifiable" \
            "Flywheel deploy end-state unverifiable" \
            "重启结束时无法读取 ${FLYWHEEL_DIR} 的 HEAD (git rev-parse rc=${head_rc}),无法证明源码与 deployed-sha 账本一致。请人工核对后 deliberate 重跑。"
        return 1
    fi
    if [[ -f "$DEPLOYED_SHA_FILE" ]]; then
        final_deployed="$(cat "$DEPLOYED_SHA_FILE" 2>/dev/null)" || deployed_rc=$?
        if (( deployed_rc != 0 )); then
            log "ERROR: deploy consistency check could not read ${DEPLOYED_SHA_FILE} (rc=${deployed_rc})" >&2
            alert_severe "restart-deploy-consistency-unverifiable" \
                "Flywheel deploy end-state unverifiable" \
                "重启结束时 deployed-sha 账本存在但读取失败 (rc=${deployed_rc}),无法证明源码与已部署产物一致。源码 HEAD=\`${final_head:0:7}\`。请人工核对后 deliberate 重跑。"
            return 1
        fi
    fi
    if [[ "$final_head" == "$final_deployed" && -n "$final_deployed" ]]; then
        return 0
    fi
    deployed_display="${final_deployed:-missing}"
    [[ "$deployed_display" == "missing" ]] || deployed_display="${deployed_display:0:7}"
    log "ERROR: deploy did not converge — source HEAD ${final_head:0:7} vs deployed-sha ${deployed_display}" >&2
    alert_severe "restart-source-deployed-mismatch" \
        "Flywheel source and deployed ledger differ" \
        "重启退出时源码 HEAD=\`${final_head:0:7}\` 与 deployed-sha=\`${deployed_display}\` 不一致——部署事务未收敛。系统可能仍在运行,但下一次构建/部署决策会基于不一致状态。请 deliberate 重跑 restart 完成部署,或按 runbook 回滚;不要手工 reset。退出码已置非零。"
    return 1
}
```

要点(Codex R1 #1 BLOCKER + #3 采纳):
- **传码走函数返回码,不走 stdout**——生产 `log()` 写 stdout,`$(...)` 捕获会把日志混进退出码(`exit "ERROR…\n1"` → numeric argument required → rc=2 且日志被吞)。helper 内部 log 一律 `>&2` 双保险。
- **告警中性命名** `restart-source-deployed-mismatch`:`HEAD != deployed-sha` 只证明「不一致」,证不了方向(reset 部分失败/并发 writer 可留下 behind/diverged);标题与正文只陈述两端值。
- **读取失败与真缺失分流**:`rev-parse`/`cat` 的 rc 显式保存;已存在账本读取失败 → unverifiable;文件真不存在/为空 → mismatch,`deployed_display` 单独变量渲染 `missing`(空串截断渲染成空 code span 的坑已消)。

### 3.5 接入 `restart_on_exit`(L433 函数内,既有告警块之后、锁清理之前;trap 已 `set +e`)

```bash
if ! verify_deploy_consistency_on_exit; then
    if [[ "$original_rc" == "0" ]]; then
        original_rc=1
    fi
fi
```

不变量告警**不受** `RESTART_NOTICE_STARTED` / `RESTART_TERMINAL_REPORTED` 约束(research §1.1:三个顶层 exit 1 连既有 trap 告警都不触发,这正是最静默层);INT/TERM 同样检查(操作员取消留下的残留同样是残留)。`original_rc != 0` 时不改码只告警——非零已在,teeth 只补 rc==0 的漏洞面。

## 4. 测试(TDD:先 RED 证明现行为,后 GREEN)

新文件 `scripts/__tests__/restart-deploy-consistency.test.sh`,复用 `restart-pull-preflight.test.sh` 的既有约定(sed 抽函数 + stub alert 写捕获文件 + 沙箱 git;research §3)。

### 4.1 缺陷 ② case(抽 `rollback_and_restart`,stub `alert_severe`/`log`/`stop_bridge` 等;PATH shim git:仅拦目标子命令,其余 exec 真 git,并把收到的 argv 记账)

| # | 场景 | RED(修前必须先证) | GREEN(修后) |
| --- | --- | --- | --- |
| T1 | shim 令 `git status` rc=1 | shim 账本里出现 `reset --hard`(证实 fail-open 真实存在) | 账本无 `reset`;`rollback-blocked-state-unreadable` 进 SEVERE_FILE;rc=1 |
| T2 | shim 令 `git reset` rc=1,**以 voice-style 条件上下文调用**(复刻 errexit 被抑制的生产语义——Codex R1 #4:只有该路径旧行为会静默继续;fixture 调用语义必须与所覆盖的生产调用点一致)。rc 捕获用 `rb_rc=0; rollback_and_restart … \|\| rb_rc=$?`(Codex R2 LOW-2:`if !` 进 then 后 `$?` 已被反转为 0,不能在那里读原始 rc) | 函数继续走到 pnpm(stub 记账) | 停在 reset;`rollback-reset-failed`;pnpm stub 未被调用;rb_rc 精确 == 1 |
| T3 | 回归:干净工作区 + reset 成功 | — | reset 恰执行一次;无新增告警 |
| T4 | 回归:真 dirty(写 tracked 文件) | — | 既有 `rollback-blocked-dirty` 行为逐字不变;不出 unreadable 告警 |

### 4.2 缺陷 ① case(抽 `verify_deploy_consistency_on_exit` + `restart_on_exit` 同 harness 加载,沙箱摆状态)

| # | 场景 | 断言 |
| --- | --- | --- |
| T5 | armed + HEAD≠deployed + original_rc=1 | `restart-source-deployed-mismatch` 进 SEVERE_FILE;exit 码**精确保持 1**(不被改写) |
| T6 | armed + HEAD≠deployed + original_rc=0 | 告警 + exit 码**精确 == 1**(teeth);且无 `numeric argument required` 诊断(Codex R1 #1 的回归锚) |
| T7 | armed + HEAD==deployed | 零新增告警(成功路径回归) |
| T8 | 未 arm + HEAD≠deployed | 零新增告警(pre-arming 退出/父进程噪声面回归) |
| T9 | armed + DRY_RUN=true | 零新增告警 |
| T10 | armed + deployed-sha 文件不存在/为空 | mismatch 告警,正文渲染字面 `missing`(display 变量,不是空 code span)+ exit 非零 |
| T11 | armed + HEAD 不可读(FLYWHEEL_DIR 指向非 repo) | `restart-deploy-consistency-unverifiable` + 非零 |
| T11b | armed + deployed-sha **文件存在但读取失败**(权限 000) | `restart-deploy-consistency-unverifiable`(读失败≠缺失,不折叠进 mismatch)+ 非零 |
| T12 | arming 位点合同:抽 `preflight_pull_latest_main` 源文本断言 behind 分支 merge **之前**含 arm 语句;抽顶层调用点断言 (b) 存在且带 DRY_RUN 守卫 | 防将来重构拆掉 arming(近似检查弱于行为,故同时保留 T13/T14) |
| T13 | 集成级(整脚本沙箱,唯一一个):merge 成功后在 fork 检查处 rc=2 中止(checker 缺失即触发) | 告警捕获文件出现 `restart-source-deployed-mismatch`;脚本 exit 非零。**hermetic 边界全写死**:fake `HOME` + fake `FLYWHEEL_DIR`(本地 repo/remote)+ 私有 TMP/lock/alert 捕获文件 + 受控 source-lib stub + `FLYWHEEL_RESTART_FOREGROUND=1` + `export BRIDGE_URL=http://127.0.0.1:<空闲端口>`(🔴 记忆红线:沙箱跑 restart-services 曾两次杀生产 Bridge),并**断言零 pnpm/launchctl/service mutation**(记账 stub 全空)——防止意外越过预期 abort seam |
| T14 | 确定性 signal case(Codex R1 #2 的回归锚):git shim 完成真实 merge 后向父 Bash 发 TERM 再返回 | consistency severe 被捕获;exit 码保持 143 |

对应 issue 验收:验收 1 ⇔ T5/T6/T13/T14;验收 2 ⇔ T1/T2;验收 3 ⇔ T3/T4/T7/T8/T9 + 既有 `restart-pull-preflight` + finalizer harness 保持既录 baseline。

### 4.3 门(实现节点必跑)+ baseline 诚实化

- `pnpm lint`(全仓)→ `pnpm -r build` → 新 test 文件 + `restart-pull-preflight.test.sh` + `scripts/test-restart-services.sh`(抽取范围已扩)→ `pnpm test:packages:run` 以 CI 为准(host 全量 vitest 不当验收门——记忆:会压死生产 Bridge;本单零 TS 改动)。
- **baseline 实录(2026-08-13 本机,Codex R1 #5 实测)**:`restart-pull-preflight` 25/25;`scripts/test-restart-services.sh` **124 passed / 8 failed(132 total,受限 host 环境项)**——旧口径「131/131」已漂移,不得沿用。实现节点开工先复跑记录 before-baseline,验收比对 delta(改动不得新增失败);全绿判定以 exact-head CI 为权威。
- CI 接线:新测试命令加入 `.github/workflows/ci.yml` 对应 shell job + `ci-structure.test.sh` exactly-once sentinel。

## 5. 风险与既知取舍

1. **双告警噪声**(步骤 + 状态各一条):接受,两者答不同问题(research §1.3);不做跨条去重——去重逻辑本身就是新的静默面。
2. **post-start_bridge 段误读**:新 Bridge 已跑新码、账本未推进时中止,状态告警可能被读成「跑旧码」——文案已限定为「两 SHA 不一致/账本未收敛」,不断言哪侧存活(research §1.5)。
3. **回滚新硬闸拒绝了旧行为侥幸放过的瞬时失败**:`GIT_OPTIONAL_LOCKS=0` 避免 status 的可选 index refresh/锁竞争(非消除所有 index.lock 失败);剩余为真失败,拒绝是目的不是回归。
4. **告警通道 best-effort**(`|| true`):非零退出码为第二支柱;两者独立成立。
5. 行号漂移:见 §0,以锚文本重定位。

## 6. 交付与 ship

- 分支 `flywheel-FLY-1743` → PR base `main`;docs(本文件夹)随同一 PR。
- 本单**不阻塞** FLY-1729 已合并交付;风险窗口是下一次真部署(自动部署链当前未加载,已定「配好 TEAMLEAD_INGEST_TOKEN 之前不做任何部署/重启」)。merge 后生效 = 下一次 restart 自然使用新脚本字节(🔴 记忆:自部署跑的是旧脚本字节——本改动无一次性迁移,无此坑)。
- 真机验收(ship 后自然观察项,不阻塞 merge):下一次真部署若一切成功,应零新增告警;「下次重启必做清单」(总计划 V6.7.20)两条盯点由本单机制替代人工。
