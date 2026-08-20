# FLY-1814 plan.md — Claude Stopgap Design Review (Round 2)

Date: 2026-08-18
Author: Claude (independent stopgap reviewer; formal Codex xhigh review pending quota reset)
Status: CHANGES REQUESTED (narrow — 2 blockers + 3 small; Round-1 的 18 条全部关闭,无需再审)

## Summary

**Round-1 的 18 条逐条核过,全部真折入,没有一条是「声称折入但文字没动」。** 抽查的几条改写质量高于最低要求:#4 不只是换了个数据源,而是明确写了「不数 manifest 文件」+ 点名 `lead_restart_collect_candidates` 的文件行号 + 把 `manifestless` 单列进摘要行;#13 把 `census_alert` 的 severity/identity/签名/不 @founder/stderr/明细只进 body 六项逐条写死,还显式写了「**不得复用** `severe_alert`」并说明原因;#3 的迁移清单把我给的每个站点都落进去了,还主动加了「初稿列的 `flywheel-daemon.sh` 引用不存在,已删」的更正痕迹。§2.5 用一整节承认「三重兜底」是错的、§6 用一段写明残余 SPOF 的**确切世界**(updater 掉出 + 所有 Lead 稳定存活 + 无人手跑波 ⇒ 发现延迟到下次 Lead 重生、修复仍需人),这是我在 Round 1 要的两条里更难写的那条。

我另外做了一次**独立事实核验**(不是复读折入声明),结果:

- D1 新增的 copy 预检(`ProgramArguments` 路径存在)在本机对 **7/7** 个相关单元全部 EXISTS —— 含验收关键的 `scripts/codex-log-guard.sh`(8232 bytes, 可执行)。**scope-② 的验收在新预检下确实可达**,不是自己把自己挡住了。
- `converge_flywheel_bin` 的挂点形态(`claude-lead.sh:1314-1367`)确认存在,D2.6 抄的先例是真的。

但这次重写**引入了 3 个新问题**,其中 2 个是实现期一定会撞的硬阻塞:`census_alert` 按现在的写法**发不出去**(N1),第三锚点按现在的写法**会静默空跑并报成功**(N2)——后者恰好是本计划存在的理由那种形状。第三个(N3)会打断一条现有的 founder 可见消息。

三条都很便宜。折完这 5 条我不需要再开一轮。

## What's Good (Keep)

1. **折入是逐条带证据的,不是刷一层措辞。** 每条改动都在原文里留了 `[评审 #N]` 锚点,反向可查;`§7 A1/A2` 用删除线保留了历史裁定;`§2.3` 的 FLY-1330 从「走同通道」改写成「本仓当前零 footprint……不进本单验收」,并把 scope-② 的验收面收窄到 codex-log-guard —— 这是把一个没核过的继承说法降级成事实,而不是删掉了事。

2. **Annie 裁定被如实改写了设计,不是被贴在旁边。** §2.2 引了原话(「要救 不过不急 而且可能需要分别审批还需不需要 要怎么救」),D3 据此**拆成 D3a/D3b 两半**、把批量救回换成打勾制、并把「不急」翻译成明确的排期含义(清单在机制半落地后出,不挡主线)。选项集与答案一起记了,符合 `feedback_option_set_bounds_what_she_can_say`。

3. **残余 SPOF 段落写的是「哪个世界会失效」而不是「有一定风险」。** §6 第一条把失效条件写成三个可判定的合取项,并给出发现延迟的确切上界和「修复仍需人」的诚实结论 —— 可证伪,能被下一个人拿去检验。

4. **诚实边界扩到了自己不喜欢的地方。** D4 主动记了「批间 sleep 在 command substitution 子 shell、父进程 TERM trap 已重置 ⇒ 波中被 TERM 的窗口扩大 ~3 分钟」并写明「可接受,不另设防」;D1 承认「只挪位置不改内容」不成立并改成「注释同步单独 commit」。两处都是把 Round-1 的批评原样留在文档里,没有洗白。

5. **fail-closed 的方向选对了。** #9a 的处理特别好:manifest 文件级缺失 ⇒ degraded 永不 healthy,**但 v1 的盘上收敛照跑**(「已被生产验证的那半不陪葬」)。这既没有把新盲区藏起来,也没有让新代码的失败拖垮已验证的旧行为。

6. **§5 的 gate 清单补了 `scripts/test-restart-services.sh` 并注明理由**(「它在 `scripts/` 根下,不在 `__tests__` glob 里」)—— 这类「为什么要单列」的一句话,是下一个人不再漏它的原因。

## Issues & Recommendations

### N1. [HIGH] `census_alert` 发不出去:`lead-alert.sh` 的 `--kind` 是封闭白名单,而 D2.5 没指定 kind;§6 又拿「新 kind 的注册成本」当理由推掉了另一个方案

**Issue.** D2.5 把 `census_alert()` 的六项写死了(warning / `--lead updater` / `launchd-census-YYYYMMDD` / 不 @founder / `1>&2 || true` / 明细只进 body),**唯独没写 `--kind`**。初稿里的 `launchd_census_degraded` 在重写中消失了。

而 `scripts/lead-alert.sh` 对 kind 是**封闭 case 白名单**:未命中即

```
log "ERROR: unknown --kind '$KIND'"; emit_result "config_error"; exit 1
```

全仓 grep:`launchd_census` **零命中**(代码/脚本/TS 全无)。新增一个 kind 的真实成本是**三面注册**:
- `scripts/lead-alert.sh` 的 case 列表;
- `packages/teamlead/src/LeadAlertNotifier.ts:70` 的 `ALERT_EVENT_TYPES`;
- `packages/teamlead/src/bridge/kind-contract.ts` 的 `KIND_CONTRACTS`(是 `Record<AlertEventType, …>`,**漏了是编译错**),且 `validateKindContracts()` 在 plugin 初始化、listen 之前跑并 **THROW** —— 契约违规时 **Bridge 拒绝启动**(kind-contract.ts:9-17,明确写着「deliberately no warn-and-continue and no kill-switch」)。

**Why it matters.** 两层:
1. **实现期硬阻塞**:不指定 kind ⇒ 实现者要么随便挑一个语义不符的、要么临时发明一个然后被 `exit 1` 挡住,而这个失败发生在**告警路径本身** —— census 判定 degraded 时那条告警静默 config_error(`1>&2 || true` 还会把它吞掉)。结果:census 跑了、发现了问题、**没有人被告知**。这与 §2.4 第三条诊断的病(「被关掉与在跑长得一样」)是同一个形状,只是搬到了告警层。
2. **内部不一致**:§6 推掉 Bridge FleetSensors 方案的理由**逐字**是「引入新 alert kind + kind-contract 注册,告警风暴是有疤的类……本单不折进去」。如果 D2.5/D2.6 自己也要付同一笔注册成本,那条推掉的理由就不成立了 —— 要么计划付了成本却没说,要么 §6 的取舍依据是错的。两者必须只留一个。

**Fix(推荐 A,零成本且语义正好)。**
- **A:复用 `deploy_degraded`。** 它在两面都已注册(`LeadAlertNotifier.ts:227`、`kind-contract.ts:192` = `{ owner: "claude", arc: "human_by_design" }`),而且 `lead-alert.sh` 里它的注释**逐字**写着它的用途:「FLY-1081: deploy_failed / deploy_degraded — restart-services.sh / **update-flywheel.sh** ⚠️ deploy notices (system identity --lead deploy / **`--lead updater`**; **shell-only kinds**, the Bridge never emits them)」。identity 约定、发起文件、shell-only 属性三项与 D2.5 完全吻合,注册成本为零,Bridge 启动零风险,且 §6 的取舍理由保持成立。
- **B:真加 `launchd_census` kind。** 那就在 D2.5 里写明三面注册清单 + `KIND_CONTRACTS` 条目的 owner/arc 取值 + 「Bridge 启动会因契约缺失而 THROW」这一风险,并**同步改写 §6 推掉 FleetSensors 的理由**(成本已付,不能再当理由用)。

无论选哪条,`census_alert()` 的规格里必须**显式出现 `--kind <值>`**,并在 D5.2 加一条断言:census_alert 的 kind 在 `lead-alert.sh` 白名单内(这条断言本身就是防止未来有人改 kind 后静默 config_error 的尺子)。

### N2. [HIGH] D2.6 第三锚点的调用形态未定,而最省事的那种写法会**静默空跑并报成功**

**Issue.** D2.6 只说「在 `claude-lead.sh` 的 Lead 启动路径挂只读 census……挂点形态抄 `converge-flywheel-bin.sh:13` 注释列的三挂点先例」。核了两侧:

- `converge-nonlead-daemons.sh` 第 3 行自述 **"Source-only."**,文件里**只有函数定义,没有 main**,而且**没有 auto-run guard**(对照 `self-ship-queue.sh` 末尾那种 `SELF_SHIP_QUEUE_SOURCED != 1 && BASH_SOURCE == $0 → exit 64` 的自我保护,这个文件没有)。⇒ `bash scripts/lib/converge-nonlead-daemons.sh` 会**定义完函数、什么都不做、exit 0**。
- `claude-lead.sh` 的既有先例是**子进程调用独立可执行脚本**:`converge_flywheel_bin()`(`:1314-1330`)做 `bash "${FLYWHEEL_ROOT}/scripts/converge-flywheel-bin.sh"`。而 `claude-lead.sh` **不 source 任何 `scripts/lib` 下的东西**(grep `source .*scripts/lib` 零命中)。

所以「抄先例」在字面上会得到 `bash .../lib/converge-nonlead-daemons.sh` —— **rc=0、无输出、无副作用**,而 `converge_flywheel_bin` 的既有形态在 rc=0 时打印的是 `"flywheel-bin convergence OK"`。第三锚点会在每次 Lead 启动打一条「OK」,而实际一次 census 都没跑。

**Why it matters.** 这是本计划立项要消灭的**那一种**故障:一个看起来健康、实际什么都没做、且没有任何东西会发现它没做的组件。更糟的是它是**唯一**在「updater 已死」世界里能出声的东西(§2.5 原话),它空跑 = 残余 SPOF 从「发现会延迟」退化成「永远发现不了」,而 §6 的诚实边界会因此变成一句不成立的承诺。而且这个错误**不会被任何现有测试抓到**(D5.2 的行为测试是 source 这个库直接调函数,根本不经过 D2.6 的调用形态)。

**Fix.**
1. **写死调用形态。** 建议新增一个薄可执行入口 `scripts/launchd-census.sh`(source 库 → 调 `census_launchd_fleet` → 只读输出 + 按需 `census_alert`),`claude-lead.sh` 按 `converge_flywheel_bin` 同款子进程调用它。这不是新 daemon / 新 timer / 新 flag,只是一个 entrypoint,符合铁律。
2. **给库补 auto-run guard**(顺手治本):`converge-nonlead-daemons.sh` 末尾加 `SELF_SHIP_QUEUE_SOURCED` 同款守卫 —— 被直接执行时 `exit 64` 并说明它是 source-only 库。这样「写错调用形态」从**静默成功**变成**响亮失败**,以后谁再挂点都不会踩。
3. **D5 加一条挂点断言**(不是行为断言):`claude-lead.sh` 里存在对该 entrypoint 的调用,且该 entrypoint 直接执行时**真的会跑 census**(阳性对照:喂一个 fixture 域,断言产生了非空 census 输出)。**只断言「调用点存在」是不够的** —— 空跑的调用点也存在。

### N3. [MEDIUM] 折入 #18 会打断既有的 5 字段 sidecar 契约,把完成消息里的 body 计数打成 `0/0/N`

**Issue.** D4 写「在既有 `LEAD_BODY_OBSERVATIONS_FILE` sidecar(`restart-services.sh:2254-2256`)里每 Lead **多记一个** verify 耗时」。实测该 sidecar 是**严格 5 字段 TAB 契约**,写读两侧硬绑:

- 写:`restart-services.sh:1117-1119` `printf '%s\t%s\t%s\t%s\t%s\n' key project lead carrier_pid carrier_start`;
- 读:`:1141` `while IFS=$'\t' read -r key project lead carrier_pid carrier_start`。

Bash 的 `read` 在变量数少于字段数时,**把剩余全部塞进最后一个变量**。加第 6 个字段 ⇒ `carrier_start` 变成 `"<start>\t<duration>"` ⇒ `:1145-1146` 的 `lbe_read_matching "$project" "$lead" "$carrier_pid" "$carrier_start"` 拿到污染值 ⇒ provenance 匹配全失败 ⇒ `:1150` 每行都记 `unknown` ⇒ `summarize_lead_body_observations` 返回 `0 0 N` ⇒ 完成消息(`rn_render_completion_message` 的 `body_new/body_adopted/body_unknown`)从此永远报「新建 0 / 接管 0 / 未知 N」。

这是 **FLY-1671 那条 founder 可见播报**的数据线,静默失真且方向恰好是「看起来全都不明」。另注 `:1112` 已经在拒绝含 TAB 的字段,说明这个契约的字段数是被当作不变量对待的。

**次要一点**:`record_successful_lead_body_observation` 只在 `restart_lead` **成功**分支被调(`:2253-2256` 是 `rc != 0` 的 else),所以失败/最慢的那些 Lead —— 恰恰是最想要耗时数据的那批 —— 一条都不会被记录。这会让 #18 想提供的「下次评价 4×4/60s 的数据」系统性偏乐观。

**Fix.** 二选一,写进 D4:
- **(a) 同 commit 改两侧**:写侧加第 6 字段、读侧 `read -r key project lead carrier_pid carrier_start verify_ms`,并在 `scripts/test-restart-services.sh` 加一条 5→6 字段的契约测试(**先红**:用旧读侧跑新写侧,证明 `unknown` 塌陷确实会发生,再修绿)。
- **(b) 不碰该文件**:耗时另写一个独立 sidecar / 独立行前缀,5 字段契约逐字不动。风险最低,推荐。

无论哪条,补一句:耗时只覆盖成功 Lead,分布行必须标注样本数与「失败 Lead 不在样本内」,否则下一个人会拿一个偏乐观的分布去调参数。

### N4. [MEDIUM] D2.6 没有把先例里的 dry-run/QA 跳过守卫一起抄过来

**Issue.** D2.6 说抄 `converge_flywheel_bin` 的挂点形态,但那个函数**第一件事**就是守卫:

```
claude-lead.sh:1315-1318
if [ "${FLYWHEEL_LEAD_DRY_RUN:-0}" = "1" ]; then
  log "DRY-RUN: skipping flywheel-bin convergence"; return
fi
```

D2.6 的描述里没有任何对应物。

**Why it matters.** 机器上只有一个 `gui/$(id -u)` 域。任何 dry-run / QA slot 的 Lead 启动都会拿**生产** launchd 域跑 census 并按其结论判断 —— 结论天然是关于生产的。告警是否外泄取决于该 slot 有没有设 FLY-1608/529 的 `FLYWHEEL_ALERT_QUEUE_DIR` 隔离,这不是本计划能保证的前提。「16 个 Lead 并发重生时也只是并发只读」这句只回答了负载问题,没回答**谁有资格代表生产下结论**。

**Fix.** D2.6 明写守卫:`FLYWHEEL_LEAD_DRY_RUN=1` 跳过;QA slot Lead(`flywheel-test-*` 身份)跳过。并在 D5.2 加一条断言:dry-run/test 身份下第三锚点零 census、零 alert。

### N5. [LOW] D1 迁移清单第 2 条自相矛盾

`scripts/package-onboard-files.allow:37-38` 那条写的是「(**改路径**;`:63` 已有 `scripts/launchd/*` 通配,旧行会变僵尸,**删**)」—— 同一括号里给了两个互斥动作。按 gate② 的实际语义(`po_gate` 只校验「树里每个文件命中某条 pattern」,不校验「每条 pattern 命中某个文件」),`:63` 的通配已经覆盖搬家后的文件,**正确动作是删**,改路径会留下一条与通配重复的冗余行。

**Fix.** 改成单一动作:「删除 `:37-38`(`:63` 的 `scripts/launchd/*` 已覆盖)」。

### N6. [LOW] 收敛现在每次 self-ship 部署会跑两遍 —— 良性,但值得记为已知而非留给下一个人发现

把收敛移到 `fallback_sweep()` 入口(折入 #6,方向正确)之后,一次 self-ship 部署的实际序列是:`process_due_markers` → `restart-services.sh`(**收敛第 1 次**,`:2716`)→ 回到 `update_main` 循环 → pending 归零 → `fallback_sweep` 入口(**收敛第 2 次**)。

收敛幂等、census 只读、`census_alert` 日签名去重会吸收掉重复告警,所以是良性的;`restart.lock.d` 只读探测在第 2 次时锁已释放,也不会被跳过。但**多跑一遍不是零成本**(每个 label 一次 `launchctl print`),而且「同一次部署里 census 摘要出现两次、数字可能不同」会让读日志的人困惑。

**Fix.** §6 加一行记为已知可接受行为(附一句为什么无害:幂等 + 日签名去重),或在 `fallback_sweep` 入口加一个「本进程本次已收敛过则跳过」的进程内标记(一个变量,不是新机制)。

## Verdict

**CHANGES REQUESTED(narrow)。**

**Round-1 的 18 条全部关闭,逐条核过是真折入,不需要再审。** 计划本身已经到了可实施的成色:分母落 repo、三锚点、fail-closed 语义、迁移清单、CI 闭环、诚实边界都写到了可执行精度,而且把几处对自己不利的事实(「三重兜底」是错的、「只挪位置不改内容」不成立、残余 SPOF 的确切世界)原样留在了文档里。

剩下 5 条全是**这次重写新引入**的,其中两条会在实施期确定撞上:

- **N1 [HIGH]** `census_alert` 没有 `--kind`,而 `lead-alert.sh` 是封闭白名单 + 三面注册(`kind-contract.ts` 缺条目会让 Bridge 拒绝启动);§6 又拿这笔成本当理由推掉了另一个方案 —— 推荐直接复用 `deploy_degraded`(已注册,且其注释逐字就是 `update-flywheel.sh` + `--lead updater` 这个场景),零成本且让 §6 的取舍继续成立;
- **N2 [HIGH]** 第三锚点的调用形态未定,而最像「抄先例」的那种写法(`bash .../lib/converge-nonlead-daemons.sh`)会 exit 0 空跑并被日志报成 OK —— 唯一能在「updater 已死」世界里出声的东西静默失效,且现有测试抓不到。需要写死 entrypoint + 给库补 auto-run guard + 加阳性对照断言;
- **N3 [MEDIUM]** 折入 #18 会把既有 5 字段 sidecar 契约撑破,导致 founder 可见的完成消息 body 计数塌成 `0/0/N`;
- **N4 [MEDIUM]** 第三锚点漏抄先例的 dry-run/QA 跳过守卫;
- **N5/N6 [LOW]** allow 文件动作自相矛盾;收敛每次部署跑两遍应记为已知。

这五条都是局部改写,不动设计骨架。**折完这 5 条我不需要再开一轮** —— 建议由实施者直接 fold,Round 3 只在 Codex 恢复后由正式评审接手。

边界声明:本轮同样是 Codex xhigh 不可用期间的替代审查,全部结论基于本节点(worktree `/Users/xiaorongli/Dev/flywheel-FLY-1814`,plan commit `ad2f1a7e8`)的静态代码阅读 —— 本轮实读并交叉验证了 `lead-alert.sh` 的 kind 白名单、`kind-contract.ts` 的启动期 THROW、`claude-lead.sh:1314-1367` 的挂点形态、`converge-nonlead-daemons.sh` 无 auto-run guard、sidecar 写读两侧字段数,以及 7 个候选单元的 `ProgramArguments` 路径存在性。未在生产主机上执行任何 launchctl 或部署动作;§0 保质期表的实测读数按 ground truth 采信,未重新验证。
