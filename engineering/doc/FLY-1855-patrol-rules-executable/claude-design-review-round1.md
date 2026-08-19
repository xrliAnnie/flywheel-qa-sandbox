# Design Review — FLY-1855 plan.md (Round 1, Claude stopgap for Codex)

Date: 2026-08-18
Author: Claude independent reviewer (Codex quota-blocked; formal Codex review pending)
Status: CHANGES REQUESTED

## Summary

计划的问题定位准确、四个缺陷(①抽象名词不可执行 / ②范围冲突 / ③无产出物 / ④无 UNAVAILABLE 出口)逐条有对应修法,总体架构(规矩重写 + 只读快照脚本 + 报告合同 + Linear 出口 + tick 模板 v2)是对的,且诚实边界(§9)与已否决方案(§10)写得扎实。我对照代码逐条核了计划的事实声称,**绝大多数属实**(详见 What's Good)。

但有 1 个 HIGH:步 3 的跨库联查按计划原文(和 §2 已"生产验证"的样例 SQL)**没有 project 过滤**,teamlead.db 是全局库而 comm.db 是每项目库——我在生产库上实测,当前 `workflow_run_node(state='running')` 有 124 行属 `flywheel`、1 行属 `tidal-echo`;任何非-flywheel 项目的 Lead 跑这条查询都会得到 100+ 条「running node 无 TURN 行」的假 FINDING-CANDIDATE。FLY-193/218/220 的教训就是:系统性假阳性会让 Lead 学会忽略 finding,机制随之死亡。另有 5 个 MEDIUM(守卫测试既有锚点冲突、CI 接线缺失、installer 接线不明、transient sqlite 错误会铸垃圾 Linear issue、tick↔report 锚定依赖一个渲染层从不显示的 seq)与若干 LOW。全部可在不改架构的前提下修复。

## What's Good (Keep)

以下事实声称我逐条对照代码/生产库验证过,**全部属实**,后续实现可以直接依赖:

- `formatPatrolTick` 在 `packages/teamlead/src/bridge/hook-payload.ts:250`,doc comment 明标 "Founder-fixed body";现行两句模板与计划 §5 引文逐字一致;`PATROL_DIRECTIVE_WORDS = /check|verify|suggest|inspect|建议|怀疑|该查/iu`(:231)只作用于 roster token 的 canonicalizer,但 `patrol-tick-render.test.ts` 对整个 body 做 deny-list 阴性断言 + byte-exact 期望 + Mailbox/CommDB parity(`renderEnvelope === formatPatrolTick`)。全仓只有 hook-payload.ts 与该测试两个文件内嵌模板字符串——"改动落点一处字符串 + 两个测试"的声称成立。
- 表与列全部核实:`workflow_run`(有 `issue_id`、`project_name`)、`workflow_run_node`(run_id/node_id/attempt/state/execution_id)、`dead_letter_alerts`(有 `project_name` + `created_at`,24h 窗可行)在 `packages/teamlead/src/StateStore.ts`;`three_stage_turn`(issue_id/holder_exec_id/phase/epoch)、`turn_wait_ledger.no_turn_streak`、`turn_wake_outbox.state ∈ pending/sent/acked/cancelled` 在 `packages/flywheel-comm/src/db.ts`;`mailbox`(state QUEUED/LEASED/ACKED/DEAD、`claim_expires_at`)经 `MAILBOX_SCHEMA` 装进**同一个** comm.db(db.ts:282)。teamlead.db 实测 69 张 `workflow_*` 表——"40+、执行者不可能猜对"的论断成立。
- `sqlite3 "file:...?mode=ro"` 对两个 live WAL 库实测可读(本次 review 即用此方式取证);`mode=ro`(而非 `immutable=1`)是正确选择。
- roster-empty 零 tick 门(`patrol-tick.ts:208-211`)与非 spawning 门(`canSpawnRunners !== false`,:167)如计划所述;`patrolTickOffsetMs` 相位错开存在。
- `lead-rules-bundle.sh` :365 确在 dept case 无条件 emit `runner-patrol-rules.md`(backend-independent,mailbox + commdb 两路),cos/companion 不装——"所有 non-cos dept Lead" 声称成立。
- Discord plugin cache `~/.claude/plugins/cache/flywheel-plugins/discord/0.0.4/server.ts` 确有 `fetch_messages`(:1144)与 `download_attachment`。
- `~/.flywheel/bin` symlink 先例成立:`scripts/flywheel-cmux-install.sh:41` 的 `ln -sf`、`converge-flywheel-bin.sh` 的健康收敛、`check-global-path-hygiene.sh` 对 bin 下任意 symlink 的 broken/temp-worktree 扫描。
- 设计判断的大方向对:SQL 收口进 CI 测真库的脚本(治 .md 腐烂)、报告落盘不刷 Discord(治噪音)、UNAVAILABLE 进工程队列(治静默蒸发)、Bridge 不做六步自动判读(避开 watchdog 误报风暴前科)都与仓库既有纪律一致。
- §9/§10/§12 的诚实度高:零 tick 门的残余盲区、报告可造假、多 Lead 重复发现,都没藏。

## Issues & Recommendations

1. **[HIGH] 步 3 跨库联查缺 project 过滤 → 多项目机器上结构性假 FINDING-CANDIDATE。**
   teamlead.db 是全局库,comm.db 按 `--project <name>` 只挑一个项目。计划 §2 的样例查询与 §4 步 3 的描述都没有 `r.project_name = :project` 过滤。生产实测(2026-08-18):`workflow_run_node(state='running') JOIN workflow_run GROUP BY project_name` = `flywheel|124, tidal-echo|1`。tidal-echo 的 Lead 按计划跑快照,会得到 124 条「running node 无 TURN 行」假候选——每个 tick 都如此。FLY-193/218/220 已经证明:每轮固定出现的假阳性会让读者把整类 finding 学成噪音,这正是本单要救的机制的死法。
   **修**:三类步 3 candidate 的账本 join 一律限定 `r.project_name = <project>`;「检测=整机」只落在真正全局的信源上(步 1 tmux 全窗、`dead_letter_alerts` 天然带 project_name 可全量列出但按项目分组标注)。CI 契约必须加**双项目 fixture 阳性对照**:另一项目的 running node 不得在本项目快照里出现为 candidate(单项目 fixture 抓不住这个 bug)。

2. **[MEDIUM] §0 重写会打红 FLY-1687 时代的既有守卫锚点,计划只说「扩展」不认账「改动」。**
   `fly369-patrol-rule.test.ts` 现断言 patrol 文件包含 `"TURN belt"`、`/纯闹钟/`、`"独立信源"`、`"gh pr view"` 等(FLY-1687 plan :135 明确交付了这些锚点,且写着「既有锚点不动」)。§8 草案里 `TURN belt` 被落地成具体表名(这正是缺陷①的修法)、`纯闹钟`/`独立信源` 出现在被重写的 §0 preamble 中而草案未保留。TDD 步 1 说「现文件即 RED」指的是新锚点,但重写同时会把**既有 GREEN 锚点打红**——这不是机械扩展,是对上一单守卫合同的有意修订。
   **修**:计划里逐条列出哪些 FLY-1687 锚点被有意替换及理由(如 `"TURN belt"` → 具体表名锚点;`纯闹钟`/`待核声明`/`不采信 Bridge 单方转述` 这三个 founder 不变量措辞必须原样保留在重写后的 §0 里),避免实现者当成普通测试更新顺手删掉不变量。

3. **[MEDIUM] 新 shell suite 的 CI 接线缺失:literal enumeration + dist 构建依赖。**
   `ci-shell-suite-enumeration.test.sh`(FLY-1764)强制每个 `scripts/__tests__/*.test.sh` 要么进 ci.yml 的字面枚举、要么进 manual-only inventory——FLY-1773 刚为同类遗漏返工过一轮。且该测试用「真代码建库」(StateStore dist + flywheel-comm dist),CI 的 Script Tests shard 必须先有这两个包的 build 产物。计划 §11 两处都没提。
   **修**:计划 §11 显式加:(a) ci.yml 枚举登记;(b) 确认/安排该 CI job 的 dist 前置(或 suite 内自建 `pnpm --filter` 构建并计入时长预算——注意 FLY-1861 的 Script Test shard 15→20min ceiling 历史)。顺带:命名按目录惯例应为 `lead-patrol-snapshot.test.sh`(目录里无 `test-*` 前缀惯例;`test-deploy-*.test.sh` 是"测 test-deploy.sh"的特例)。

4. **[MEDIUM] installer/部署接线不明:谁创建 `~/.flywheel/bin/flywheel-patrol-snapshot`?**
   `converge-flywheel-bin.sh` 明文「Absent links are not installed here (sync-bin / installers own creation)」且只收敛固定名单(:306);cmux 先例的创建者是 `flywheel-cmux-install.sh` 的 `ln -sf`。计划 §9 只说「merge + 生产 git pull + installer symlink」,没有指名创建机制,也没说是否进 converge 名单(不进则链断了没人修,只有 hygiene scan 的 broken/temp-worktree 检查兜底)。另有 FLY-1482 的教训:symlink 目标必须解析回主仓 source tree,worktree/QA slot 起的 Lead 不能把链指进 worktree(converge 有 trusted-root 硬门,新脚本的创建路径也要同款守卫)。
   **修**:计划写死:创建者是哪个脚本(建议挂进现有 install/converge 流程之一)、是否加入 converge 固定名单、temp/worktree root 拒绝创建。

5. **[MEDIUM] transient sqlite 错误(SQLITE_BUSY)会被当成 UNAVAILABLE 并铸 Linear issue——给工程队列制造垃圾单。**
   live WAL 库在 writer checkpoint 瞬间可能返回 `database is locked`;`sqlite3` CLI 默认 `busy_timeout=0`。按 §4「任一步收集失败 → UNAVAILABLE」+ §7「首次出现即建单」,一次自愈的瞬时锁就会生成 `[patrol-unavailable] step 3: database is locked`——这与本仓告警噪音纪律(FLY-1612/1687)相悖,且会稀释 UNAVAILABLE 出口的信号价值(出口的本意是抓「规矩解析不动/对象不存在」这类结构性缺陷)。
   **修**:脚本内 `sqlite3 -cmd ".timeout 3000"` + 一次有界重试;§7 的建单策略区分结构性原因(表不存在、命令不存在、无法解析步骤)与瞬时原因(locked/busy/gh 网络错)——瞬时原因只记报告不建单(或连续 ≥2 个 tick 同因才建单)。CI 加一个「瞬时错误不建单路径」的断言点(可用退出语义/输出标记区分)。

6. **[MEDIUM] tick↔report 1:1 锚定依赖一个当前渲染层从不显示的 event seq。**
   §6 报告文件名用 `tick<seq>`,「seq = tick 事件在 mailbox 批次头/正文里可见的 event seq」。实际:patrol body 由 `formatPatrolTick` 渲染,**不含 seq**(不像 `formatStuckEscalation` 有 `[Event #seq]`),parity 测试钉死 `renderEnvelope === formatPatrolTick`;mailbox 批次头是 `[mailbox-batch <batch_id> | N messages | ...]`,带的是 batch_id 不是该事件 seq。多数报告将落成 `tickunknown`,§6 承诺的 follow-up rider(机器核「每条已结算 tick 有对应报告」)将无 join 键,只能靠时间窗模糊配。
   **修**:二选一并写进计划:(a) 把「正文带 `[tick #<seq>]`」并入 §5 同一次 founder 呈报(seq 是事实标识不是指令,与零预判不冲突,但它改的是 founder-fixed 正文,必须一起过);(b) 明降 rider 承诺为时间窗配对,§6 删掉「批次头/正文里可见」的错误前提。

7. **[LOW] 「gh 固定两条 REST 调用」事实错误:`gh pr list` 走 GraphQL(`gh run list` 才是 REST)。**
   配额影响可忽略(60min 节拍 × Lead 数),FLY-1624 的预算是 Bridge 进程内机制、不受 Lead 侧调用影响——结论不变,但陈述要改对;或者顺 FLY-1624 Fix D 的方向直接用 `gh api repos/{owner}/{repo}/pulls`(REST)。计划以「已在生产验证」自居,事实句必须经得起核。

8. **[LOW] Codex full-access dept Lead(dormant 能力)写不了 `~/.flywheel/patrol-reports/`。**
   FLY-350 full-access 的 writableRoot=projectRoot,projectRoot 之外的写会被沙箱拒。当前生产没有会收 tick 的 Codex dept Lead(Mufasa 是 companion、不装本规矩),不阻塞;但规矩是全 dept Lead 共用的,§9 应记一句边界:Codex dept Lead 启用时报告目录需要纳入其 writable 面(或按 backend 落到 projectRoot 内),否则产出物合同对它结构性不可满足。

9. **[LOW] §12 fallback 措辞自相矛盾。**
   「未认可则模板不动……tick 句子保留『不是巡检边界』措辞豁免」——v1 模板里**没有**「不是巡检边界」这句(那是 v2 新增)。fallback 到底是纯 v1 不动、缺陷②全靠规矩侧单边压制,还是仍想微调第二句?写清楚,别让实现者猜。

10. **[LOW] 步 5 Discord 半步残留抽象性:「抽查 1–2 个活跃 issue thread」——哪 1–2 个?**
    缺陷①的标准是「每步落到唯一精确命令」;`fetch_messages` 需要具体 channel/thread id。建议规矩原文落成可判定的选择规则(如:你名下 roster 各 issue 的 `[FLY-XX]` thread 里取最近活跃的 1–2 个),否则这半步会重演「0% 被执行」。

11. **[LOW] 两库时间戳格式混用,脚本契约应点名。**
    mailbox/`dead_letter_alerts` 的时间列是 TEXT(ISO/`datetime('now')`),`three_stage_turn.granted_at`/`turn_wake_outbox.created_at` 是 INTEGER epoch。时间窗过滤写错单位不会报错、只会静默全过/全滤——正是「没看到坏消息≠好消息」类缺陷。CI fixture 的窗口阳性对照必须两种格式各覆盖一例(计划 §4 已要求阈值进测试,把格式覆盖也写进去)。

## Design-decision judgments

**(a) 检测=整机 / 处置=名下 的范围拆分,保留 roster-empty 零 tick 门 — AGREE(带条件)。**
这是对缺陷②最小且与 FLY-1687 founder 裁定兼容的修法:不动 Bridge 侧的门,只在规矩侧把「名册≠边界」写成合同。零 tick 门的残余盲区(全机/全项目零 runner 时无人看外部真相)§9 已诚实点名并指出既有兜底(runner-ship probe)。条件:「整机」不能字面化成跨项目账本 join(Issue #1)——检测整机指 tmux 窗口与真正全局的账(dead_letter_alerts),账本交叉核对必须按项目配对,否则拆分本身会制造它要防的那类漏报的反面(假阳性淹没)。

**(b) SQL 真相只住在 CI 测真库的脚本里,.md 每步一条命令 — AGREE。**
「.md 与脚本双写 SQL 必漂移、schema 改名后 .md 静默腐烂」的论证成立,且"真代码建库"让漂移在 CI 变 RED 而非生产变哑——这与本仓 flag-drift/residue-guard 的既有纪律同构。脚本缺失/坏掉时按 fail-visible 退化成 UNAVAILABLE,恰好走缺陷④的出口,自洽。8+ 条多行 SQL 让 Lead 逐条复制的替代方案确实更差。不算 over-engineering:脚本是只读、无状态、无 timer,复杂度花在了唯一正确的地方(把抽象名词钉到表名)。

**(c) 报告产出物 = 每 tick 本地 markdown,Discord 只在 FINDING/UNAVAILABLE — AGREE。**
60min × N Lead 的 all-healthy 上报必然刷屏,违反 FLY-1612/1687 噪音纪律;落盘让「做 2 步 vs 做 6 步」第一次在文件系统上可区分,这就是缺陷③要的最小可取证性。审计强度的确有限(Lead 自证、无机器核),但计划把机器核 rider 明示为 follow-up 而非假装已覆盖——过程分量与风险匹配。注意 Issue #6:锚定键要先修好,否则 rider 到时候接不上。

**(d) UNAVAILABLE 出口 = 首现建 `[patrol-unavailable]` Linear issue + 搜重去重 — AGREE(带条件)。**
「口头上报会再次静默蒸发」的否决理由成立,结构化落点(team FLY + label 自动进 Tadashi 队列)是对的。条件:必须先落 Issue #5 的瞬时/结构性分流,否则第一周就会被 `database is locked` 类垃圾单毒化,工程队列对该前缀脱敏,出口失效。标题前缀搜重 + 多 Lead 相位错开的竞态残余(偶发重复单)可接受,§9 已认。

**(e) tick 模板 v2(加范围合同句 + 规矩指针,保零预判不变量与 deny-list)— AGREE(对流程),细节两处要改。**
缺陷②的根在 tick 措辞本身,只在规矩侧压制而不动误导源头是半修;v2 草案不触 deny-list 词表(实核:7 个指令词均不出现),「范围声明 + 文件指针」与「预判/逐 runner 指令」的区分站得住,且计划走 founder design HTML 呈报 + 未批准则回退的流程正确——这是 founder-fixed 资产的唯一合规改法。两处要改:①若采纳 Issue #6(a),seq 显示应并入**同一次**呈报,别让 founder-fixed 正文半年内被请求改两次;②修 §12 的 fallback 矛盾措辞(Issue #9)。

## Verdict

**CHANGES REQUESTED。**架构与四缺陷映射全部成立,事实基础经逐条核验大体扎实,但 Issue #1(跨项目假阳性,生产数据实证)会在多项目机器上第一天就开始毒化 finding 信道,必须修;#2–#6 是会让实现或后续 rider 返工的真实缺口。全部修法都不动计划骨架,预期 Round 2 可过。
