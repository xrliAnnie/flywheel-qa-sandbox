# FLY-1366 账号自愈探针失效 — 实施计划

Issue: FLY-1366 (https://linear.app/geoforge3d/issue/FLY-1366/bughigh-账号自愈切换失效panorama-探针-44-全失败usage-malformed3-freshness-stale-no)
日期: 2026-07-18
基于: research.md

## 0. 目标与非目标

**目标**:① usage 校验接受闲置账号的合法 API 形态(`resets_at: null`),让 0% 用量备胎能被选中(F1);② panorama 的 `freshness_stale` 携带真实拒绝原因(F2);③ `quota_no_target` 等 mention 类告警在 env 未配时 fallback @founder(F3);④ 部署到生产 daemon 并以真实 quota-100% 窗口实弹验收(gate 补充 B/C)。

**非目标**(brainstorm gate 已确认):切换决策逻辑(阈值/排序规则/degradedSwitch/确认流)、identity_conflict 自动收敛(FLY-865 域,本单以运维对齐处理)、refreshTokenInvalid 自动落库、新增告警 kind、personal 号复活(运维)。

## 1. 验收标准(三级,全过才关单)

| 级 | 标准 |
|---|---|
| L1 单测+类型 | 真抓 fixture(school/business 闲置形态,含 null 与全量杂字段)从红变绿;负向(resets_at 为数字/乱串)仍 malformed;闲置候选进 tier0 并完成切换的 pollOnce e2e;sevenD null 排最前;active-trigger null 守卫 e2e(见 C2);mention fallback 单测(见 C5)。**merge 前必须**:`pnpm --filter flywheel-teamlead typecheck` + 全仓 `pnpm -r typecheck` + `pnpm -r test` + `pnpm lint` 全绿(注意:teamlead tsconfig 排除 `**/*.test.ts`,测试内 null 行为靠运行时断言而非 tsc;pnpm -r 首败即 bail,teamlead 包必须单独确认真跑过) |
| L2 独立 QA | 实现者之外独立 session:① 复跑单测+typecheck;② 真机只读探针(同 exploration 方法)对照修后解析结果 = API 实测;③ 告警实发实收:**从已部署 main dist 的 `sendQuotaMonitorAlert`/daemon 路径**发一个 mention 策略 kind(unset quota mention env、保留 founder id),Discord 侧(fetch_messages)核实唯一 signature + @Annie 落到位——不许只用 shell 直发 lead-alert.sh 绕过本次修改的 TS fallback 层 |
| L3 实弹(能力级,gate 补充 C,证据分线) | 合入+部署后,**下一次真实触发窗口**:**F1 证据** = `quota_poll` **`outcome === "switched"` 精确判**(switch-executor.ts:339-344 无条件提交 generation+1,不存在需要兜底的「等价 outcome」)+ `account_switched` 告警实收 + **`postGeneration === preGeneration + 1` 且 `activeAccount === 切入号`** + 三方见证(marker/OAuth identity/store)收敛到新号 + **真 Keychain 见证**(`flywheel-claude-profile verify <新号> --source keychain` = match)+ **reviveEpoch 成功态**(见 §5);**F3 证据** = L2-③ 已过,若窗口内发生真 no_target 则告警必须 @Annie 实收(此为 F3 支线证据,**不能**替代 F1 证据关单)。runner 连续性**不作**验收判据:上游架构明确旧 Claude 进程不随 Keychain 切换自动迁移(FLY-1182 recovery-runbook:等 reset 或 close+redispatch),诚实判据 = 切换后**新 dispatch** 使用新号。panorama 读数一致性:实弹同窗保存一份只读探针对照证据(log 只记 name:status,不含数值);**实弹过了才关单**(已向 founder 承诺) |

## 2. 改动清单(TDD:每块先 RED 后 GREEN)

### C1 `quota-usage-api.ts` — 核心校验修复
- `QuotaWindow.resets_at: string | null`;`isQuotaWindow`:`utilization` 规则不变;`resets_at` 允许 `null`,为 string 时必须可 `Date.parse`,其余类型仍 malformed。
- `ok.fiveH/sevenD.resetsAt: string | null` 透传,不造伪值。
- 测试(quota-usage-api.test.ts):新增真抓 fixture(2026-07-18 school/business 完整 payload,含 limits/spend/null 杂字段;数字可保留,无任何 secret);RED 先行 = 旧校验下该 fixture 判 malformed 的阳性对照即当前红测本身。

### C2 `quota-monitor.ts` — 消费点 null-safe + freshness 带因
- `toObservation`(L180-185):类型跟随透传。
- `operativeResetAt`(L242-247):返回 `string | null`。
- **active-trigger null 守卫(唯一、前置)**:`resetAt` 有**两个**强转消费点——SwitchInput(L1679-1687)与切换成功后的 `reviveEpoch.expiresAt = Date.parse(resetAt as string)`(L1770-1776);且 L1537 得出 `scope` 后存在多条早退(cooldown L1565 / monitor-only L1573 / no_target L1651),守卫若放 L1679 会被绕过。改为:**在 `triggerScope` 返回非 null 后、任何决策早退与候选 I/O 之前**做一次守卫:`scope !== null && operativeResetAt(currentUsage.ok, scope) === null` → 结构化日志 `usage_reset_missing` + 复用**既有** kind `quota_monitor_down` 发告警 + `finish("error")`。**signature 必须独立命名空间**:既有 usage 失败路径同 kind 已占 `quota-monitor-down-${day(now)}`,而 lead-alert.sh 按 project|lead|kind|signature 去重(lead-alert.sh:348-364)——撞名会互相吞;用 `quota-usage-reset-missing-${activeName}-${scope}-${day(now)}`,守卫测试**断言这个精确 signature**。守卫之后用已收窄的非空局部变量替换**两处** `as string` 强转(消灭强转,让 tsc 接管)。
- 候选排序(L600):`sevenD.resetsAt === null ? Number.NEGATIVE_INFINITY : Date.parse(...)`(周窗未开=最早可用;同为 -Infinity 时仍按 config order 稳定裁决)。
- exhausted 判定(L589-598,纯 pct)不动。
- freshness 带因:`readCandidateCredential`(L291-312)把 `verdict.reason` 一并返回;`verifyAndRankCandidates` L526-537 组装 panorama status 为 `` `freshness_stale: ${reason}` ``(仿 `model_bench_malformed: ${reason}` 既有形态);`PanoramaStatus` union 增模板成员;`panoramaClass`(L413-420)对 `freshness_stale` 改前缀匹配 → `unverifiable`。日志 panorama 数组与 no_target 告警 body(panoramaBody)自动携带;degradedOrder 的 class 过滤自动兼容。
- 测试(quota-monitor.test.ts + helpers):**helpers 先修**——`usageResult` 等的 `??` 会把显式 null 偷换回默认值(quota-monitor-test-helpers.ts:6-9、quota-monitor.test.ts:35-38),改用 `value === undefined` 判默认,让 null 可显式传入;e2e:active 触发 + 唯一候选为闲置号(five_hour null)→ panorama=qualified、切换成功;sevenD null 排序;freshness stale 断言 panorama 串含 reason 子串;**守卫 e2e**:active-trigger + operative reset null → outcome=error + 结构化 `usage_reset_missing` + `quota_monitor_down` 告警 + **零 candidate/switch I/O + 无 reviveEpoch**。负向断言按突变纪律配阳性对照。

### C3 `quota-guard-cli.ts` — 文案与投影跟随
- `refusalMessage`(L450-462)只在任一窗口 pct≥100 时被调用,届时 reset=null 是合同异常而非「闲置」:文案用 `reset unavailable`,**维持 fail-closed 返回 32**;健康闲置号(pct 0 + null)根本不进此路径 → 补测:null 且未 exhausted 时 exit 0、投影不制造 exhaustion。L608-609 投影类型跟随。
- statusline cache 契约(修正 research 曾有的错误前提):切到闲置号后下一轮 cache **可能写入 null**;本机 statusline 消费端经 `jq ... // empty` 已验证 null-safe——把该消费契约记入风险表,并加 cache null round-trip 测试(写入含 null 的 raw → 读回不炸)。

### C4 `account-store.ts` — 观测投影类型
- `AccountQuotaObservation.fiveHResetAt/sevenDResetAt: string | null`;`validFutureReset` 入参 `string | null`(`Date.parse(value ?? "")` → NaN 走既有守卫);`applyObservation` 的 `parsedWeeklyReset` 同法。语义核对:闲置号 pct=0 永不触发 exhausted 落值;`quotaExhaustedUntil`/`weeklyResetAt` 落值路径行为不变;auth 字段/cooldown/last-observed-wins/generation CAS 全不动。测试补 null 投影案例(store round-trip)。

### C5 `quota-monitor-alert.ts` — mention fallback
- 选择逻辑**不是**裸 `A ?? B`(空串会压住 fallback,且 `alertArgs` 对 falsy 不发 mention):取 `FLYWHEEL_QUOTA_ALERT_MENTION_USER`、`FLYWHEEL_FOUNDER_USER_ID` 中**trim 后第一个非空**者(仅 policy.mention 时)。
- 单测落 `quota-monitor-alert.test.ts`(注入 execFile,**不是**只改 spawn lead-alert.sh 的 contract test——那层测不到 TS fallback):显式配置优先 / unset / 空串 / 纯空白 → fallback founder / `mention:false` 不带;before/after 清理两个 env。

### C6 收尾
- **merge 前**:`pnpm --filter flywheel-teamlead typecheck` + `pnpm -r typecheck` + 全仓测试 + lint;`packages/teamlead` 单包 vitest 显式跑一遍(防 -r bail 假绿);push 前全仓 lint(memory 纪律)。

## 3. Pre-QA 运维步骤(gate 补充 A —— runner 执行,可回滚,不留 founder)

生产 daemon 卡 `identity_conflict` 时 panorama 停转,不解除则 L3 实弹无从发生。`resolveMachineAccount`(machine-account.ts:81-130)要求**三方见证完全一致**:pool `.active` marker、OAuth identity(~/.claude.json email → 唯一 pool label)、store `activeAccount`;runtime 在 resolver 非 resolved 时直接返回、到不了 `syncActiveAccountInStore`(quota-monitor-runtime.ts:365-385)——**只改 .active 解不了 conflict**。Implement 阶段在部署前执行「采认 Keychain 现实」事务:
1. **锁外取证(仅作审计证据,绝不作补偿依据)**:记录 `.active` 原值、`~/.flywheel/claude-accounts.json` 原文(含 generation)、`~/.claude.json` display identity 的**规范字段快照**(email 原值 + 映射出的 pool label;为第 2-b 步字段等值比对准备,事发时为 personal1)、daemon log 最新 outcome,存入本 doc 文件夹 `ops-identity-realign.md`;
2. **全事务在同一 accounts lock 内**(锁外验证有 TOCTOU:`claude-profile use` 等合法 writer 拿同一把锁写 Keychain/.active/store——锁外快照与验证在竞争提交后全部作废,拿它补偿会把别人的新状态覆盖回旧世代)。`withAccountsLock` 进入后按序:
   a. **按 wrapper 三种结果显式分支**(accounts-lock.ts:139-158):`blocked` → 零采认 mutation 中止报 Lead;`reconciled`(journal `completed`,callback 不会运行,但 reconciler **已经**写过 .active/store/清 journal——这不是零 mutation)→ 记录该恢复性 mutation、**作废第 1 步快照**、放锁、从取证从头再来;仅 `ok` 进入采认 callback;
   b. **锁内重读** marker/store/display,与第 1 步快照做 **generation + 具名字段等值 CAS**(marker 字符串、store generation/activeAccount、display email——不是字节比对,display 只存了规范字段),**任何漂移 → 零 mutation 中止**(说明有并发 writer,现状需重新评估);
   c. 由锁内 display witness 得出候选 label,**锁内**跑只读 `flywheel-claude-profile verify <label> --source keychain`(真 token UUID/email 对照不可变 identity anchor,bin:1616-1650;display identity 只是展示元数据,resolver 不查 Keychain——machine-account.ts:81-132——没有这步会假 resolved),**verdict=match**(exit 0)才继续;mismatch(86)/untracked(87)/unavailable(88)→ 零 mutation 中止报 Lead;
   d. **锁内截取补偿 preimage**(此刻的 .active + store 原文——唯一可用于失败补偿的依据);
   e. 原子写 `.active` = label → `syncActiveAccountInStore(storePath, label)`(要求返回 `synced`/`noop` 且 generation 与返回值的对应关系精确符合预期;account-store.ts:499-519);
   f. **放锁前双验**:先 `readStoreStrict` **重读磁盘上的新 store**(resolveMachineAccount 只消费调用方传入的 store 对象、不自己重读——machine-account.ts:25-29,拿旧对象验证是自欺),以新鲜 store 对象跑 `resolveMachineAccount` = `resolved(label)` **且** 第二次 `verify <label> --source keychain` = match;任一不满足 → 按 d 的锁内 preimage 补偿回滚后放锁报错。
   全部 verify 输出记入 `ops-identity-realign.md` 并列入 L3 F1 证据。**不得**裸用既有 active-sync seam(不取锁且失败仍 exit 0);**严禁** `claude-profile use`(方向反了,会拿 pool 旧凭据覆盖 keychain,重演 2026-07-04 全员登出事故;verify 是只读的,不受此禁);
3. 验证:下一个 poll(≤10min)outcome 不再是 identity_conflict(恢复 quota 心跳行);
4. 回滚语义:补偿**仅**允许发生在第 2-f 终验成功之前、放锁之前。**终验通过的事务一旦提交放锁,无论 daemon 是否已观察到新 generation,一律不得恢复旧 marker/store**(generation 是单调 CAS token,「下游还没读到」不构成可以倒退的依据),只能 roll-forward 或升级报 Lead。

## 4. Ship / 部署步骤(gate 补充 B —— 防半部署)

**关键事实(launchctl print 实证)**:当前 loaded job 的 plist 把 wrapper(FLY-1182 副本)与 `FLYWHEEL_DIR` / `FLYWHEEL_QUOTA_MONITOR_BIN` / `FLYWHEEL_QUOTA_MONITOR_DIST` / `FLYWHEEL_CLAUDE_PROFILE_BIN` 四键**硬钉在 FLY-1182**(EnvironmentVariables;证据同 engineering/doc/FLY-1182-quota-switch-ignition/evidence/candidate-quota-monitor.plist:9-20);wrapper 又会在 source .env 后**恢复** launchd 预注入的 `FLYWHEEL_(QUOTA|CLAUDE)_*`(wrapper.sh:11-38);`kickstart` 只重启已加载 job、**不重载 plist**。所以「改 .env + kickstart」不会部署到 main。正确顺序:
1. PR merge 后:主仓 `/Users/xiaorongli/Dev/flywheel` `git checkout main && git pull`(绝不 push main),`pnpm install` 如 lockfile 变更,`pnpm --filter flywheel-teamlead build`;
2. 留证 + **构建可证等价的回滚 plist**:过滤后的 `launchctl print gui/$(id -u)/com.flywheel.quota-monitor`(只留 FLYWHEEL 路径键,token 类一律 redact)、磁盘 plist 副本、`.env` 相关键快照,存入本 doc 文件夹。**磁盘 plist ≠ loaded job**(本单 research 已实证:磁盘副本是主仓 wrapper 无钉死,loaded job 是 FLY-1182 wrapper + 四键钉死)——回滚候选必须从 **loaded job 权威**(launchctl print 证据)构建,**覆盖全部非 secret job-policy 键**:`Label`、ProgramArguments、四个 FLYWHEEL 路径键、`KeepAlive`、`ThrottleInterval`、`RunAtLoad`、两个 log 路径逐项等价(漏 ThrottleInterval/RunAtLoad 会改变拉起/重启行为,不算语义等价),`plutil -lint` 通过,归一化比对记录连同 lint 过的回滚工件在**进入 bootout 前**存档;若磁盘副本恰好逐项等价则记录该证明后可用,否则**重建 loaded preimage,不 bootstrap-ready 不许进入停服步骤**;
3. 更新 `~/.flywheel/.env` 三键(`FLYWHEEL_QUOTA_MONITOR_DIST`/`FLYWHEEL_QUOTA_MONITOR_BIN`/`FLYWHEEL_CLAUDE_PROFILE_BIN`)指主仓——plist 钉死解除后 .env 是唯一配置源;**只动这三键**;**FLYWHEEL_DIR 硬门**:新 plist 不再钉 FLYWHEEL_DIR,而 wrapper 允许 .env 里的旧值重定向工作根与默认 alert bin(wrapper.sh:5-38)——`.env` 中 FLYWHEEL_DIR **必须缺席或已指主仓**,若仍指 FLY-1182 → **停止部署**报 Lead 处置(共享键不擅改),否则会留下混合运行时;其它 FLY-1182 路径键同样列清单报 Lead;
4. **launchd 切换(不是 kickstart),顺序无歧义**:渲染主仓 plist 候选 → `plutil -lint`(**先 lint 后停服**,lint 失败零停机中止)→ bootout 旧 job → 等旧 PID 真正退出 → 安装 plist 到 `~/Library/LaunchAgents` → bootstrap → 健康检查。**只复现 `scripts/setup-quota-monitor.sh:287-346` 这段被 review 过的事务,不跑完整脚本**——脚本 enable 模式尾部(L348-355)会继续 `FLYWHEEL_QUOTA_DAEMON_CUTOVER=1` + Bridge 重启,不在本单授权范围。bootout/bootstrap 命令带 restart-guard bypass 前缀:`FLYWHEEL_RESTART_GUARD_BYPASS="FLY-1366 redeploy quota daemon onto main dist" ...`。确认新 plist 无 EnvironmentVariables 钉死、ProgramArguments 为主仓 wrapper;
5. 部署验证清单(全过才算部署完成):新 pid 存在;**禁止 `ps eww`**(会扩大 secret 暴露),用 `ps -ww -o command= -p <pid>` + 过滤后的 `launchctl print` 核 wrapper/bin/dist 路径 = 主仓(注意 bin 是相对自身定位 dist 的,不能只核 env 字符串);`~/.flywheel/quota-monitor.health.json` 出现新 PID/`processStartTime`/`completedAt`/`runtimeTreeSha256`/正常 outcome(quota-monitor-cli.ts:43-50,243-291);log 出现新 quota 心跳行;outcome 非 identity_conflict(§3 已对齐);
6. 回滚:**用第 2 步构建并证明等价于 loaded job 的回滚 plist + 三个 .env 键旧值 → 再次 bootout/bootstrap**(不是 kickstart;不是未经证明的磁盘副本),然后按第 5 步清单反向核验回到旧态——plist 和 .env 都要回,否则留下混合半态;
7. 部署后执行 L2-③ 告警实发实收验证。

## 5. 实弹验收执行(L3)

- 部署完成后由 Lead 保持 issue 开放,等下一次真实触发窗口(active 号爬到 trigger5hPct=90);
- 按 §1 L3 的**分线证据**判定(F1 = `outcome === "switched"` + account_switched 实收 + `postGeneration === preGeneration + 1` 且 `activeAccount === 切入号` + 三方见证收敛 + `flywheel-claude-profile verify <新号> --source keychain` verdict=match + **切换后新 dispatch 的 runner 实际用新号**;F3 = L2-③/真 no_target @Annie;两线不可互相替代);同窗保存只读探针对照证据;
- **reviveEpoch 成功态证据**(本单改动的第二个 reset 消费点,必须实弹检视其落库):切换成功后 state 中 `reviveEpoch.open=true`、`sourceAccount=<切出号>`、`generation` 等于新 store generation、`expiresAt` 为有限数且 = operative reset + 既有 grace;且 **`confirmation === null` / `confirmDueAt === null`**(account 级成功分支就是这么置的,quota-monitor.ts:1765-1777;延迟 confirmation 是 model-cap 路径产物,对本 F1 事件 **N/A**,不许把它当判据等)+ 无遗留 `pendingSwitchFailure`、无 blocked alert outbox;保存 account 级 revive-scan 证据(`reviveEpoch.panes` 尝试记录、如出现 `quota_revive_stuck` 一并存);五分类延迟 confirmation 记录仅当另发生 model-cap 切换时才要求(旧 runner 是否 recovered **不是**判据);
- **「新 dispatch 用新号」的进程绑定证据(实现前定义,不许用第二次全局 Keychain verify 充数)**:全局 marker/store/keychain 收敛证明不了**某个具体新 runner 进程**加载了哪份凭据。实现阶段定义非 secret 取证流程:新 dispatch 的 execution id → 绑定其 PID + 进程启动时间 → 该进程实际 OAuth identity 与预期 anchor 的脱敏比对(label/UUID-或-email digest;上游 runbook:recovery-runbook.md:156-157 已认可此证据源)。若审计后发现无受支持的进程级 seam,取 Lead 批准的人工替代流程,或经 Lead 同意移除该判据——**不得静默降级**;
- 实弹通过 → 关单;失败 → 按 log 复盘回到 implement。

## 6. 风险与回滚

| 风险 | 缓解 |
|---|---|
| null 语义波及未盘点到的消费点 | research §5 全量清单(含 reviveEpoch 第二消费点)+ **消灭两处 `as string` 强转** + C6 的 typecheck 把漏网点编译期暴露 |
| statusline cache 消费方吃到 null | 切到闲置号后 cache 确会写 null;本机 statusline 消费端 `jq // empty` 已验证 null-safe;C3 加 cache null round-trip 测试固化契约 |
| loaded job plist 钉死 env → 半部署 | §4 已改 bootout/bootstrap 流程 + 留证 + 双向核验清单;wrapper 自带 crash-streak fail-loud |
| bootout→bootstrap 窗口瞬断 | 秒级;10min 轮询节奏下无观测损失;注意 booted-out job **没有** KeepAlive 兜底(未加载即无策略),靠 §4 的 lint-先于-停服 + 失败即按回滚序恢复保证不悬空 |
| identity 事务提交后回滚造成 generation 倒退 | §3.4 明确禁止提交后覆盖旧 store,只 roll-forward 或升级 |
| 实弹窗口迟迟不来 | 不造假触发(改 trigger 阈值=动决策配置,越界);Lead 可与 Annie 商定压测窗口,设计上不依赖 |
| FLY-1182 worktree 与 main 漂移 | 部署后 daemon 唯一真源=main dist + main plist;worktree 保留仅作档案 |

## 7. Follow-ups(不进本单,交 Lead 建单)

1. degradedSwitch 兜底开关决策(FLY-1182 决策域);
2. freshness 连续拒绝 → 自动 refreshTokenInvalid + re-login 专项告警;
3. identity_conflict 手动切号后自动收敛(FLY-865 域);
4. personal 号复活运维(Annie 重登 + claude-profile save personal);
5. 切换后旧 runner 自动迁移新号(FLY-1182 runbook 域:现架构只能等 reset 或 close+redispatch)。
