# Design Review — FLY-1855 plan.md (Round 2, Claude stopgap for Codex)

Date: 2026-08-18
Author: Claude independent reviewer (Codex quota-blocked; formal Codex review pending)
Status: APPROVED

## Summary

Round 1 的 11 条 finding(1 HIGH / 5 MEDIUM / 5 LOW)**全部被采纳并正确折入**计划(§4/§5/§6/§7/§8/§9/§11/§12),且新增 §13 设计评审记录。我从磁盘重读了更新后的 plan.md,并对 Round 2 新引入的事实声称做了**增量代码核验**(不信任 coordinator 转述),全部属实。无新 HIGH/MEDIUM;3 条非阻塞 LOW advisory 留给实现 PR。**APPROVED**。

## What's Good (Keep)

Round 1 全部 11 条的折入位置与质量逐条核对:

1. **HIGH-1(project 过滤)** → §4 新增独立 bullet(:77),写明全局库/每项目库的错配机理 + 生产实测数据(flywheel 124 / tidal-echo 1);§4 步 3(:78)join 明标「含 project_name 过滤」;「整机」维度显式收窄到 tmux 窗口清单 + `dead_letter_alerts`(:77/:79);CI 契约(:87)新增**双项目 fixture 阳性对照**并点名「单项目 fixture 抓不住 HIGH-1」。修法完整,连测试的反例覆盖都到位。✅
2. **MEDIUM-2(锚点清算)** → §11.1(:165)显式两列:保留的 founder 不变量锚(纯闹钟/独立信源/待核声明/不采信 Bridge 单方转述/Lead 不得自建 timer)与有意改写的锚(裸 `"TURN belt"`/`"engine node table"` 字面 → 名词=表名对照写法),并要求实现 PR 逐条列改动断言及理由;§8 步 3 标题(:135)已带对照写法「TURN belt = comm.db `three_stage_turn`;engine node table = teamlead.db `workflow_run_node`」——这同时是缺陷①「名词钉到表名」的最佳落法(名词不消失,而是就地绑定表名,FLY-1687 锚点语义得以延续)。✅
3. **MEDIUM-3(CI 接线)** → 改名 `lead-patrol-snapshot.test.sh`(:66/:87);ci.yml 字面枚举 + `ci-shell-suite-enumeration.test.sh`/FLY-1773 教训点名;dist 前置(teamlead + flywheel-comm)写进 CI 段(:87);§11.2 同步(:166)。✅
4. **MEDIUM-4(安装接线)** → §4 新增安装接线 bullet(:85):明确 converge 不创建缺失链接、创建位点候选(restart-services 安装步或独立 installer,实现时确认)、加进 converge 管理清单、FLY-1482 leaf-symlink→生产 source tree 守卫。✅(见 Advisory A2)
5. **MEDIUM-5(瞬态分类)** → §4(:82):`.timeout 3000` + 一次有界重试 + `UNAVAILABLE(transient:...)/(structural:...)` 两类;§7(:120):structural 首现建单、transient 连续 2 tick 才升格。与告警噪音纪律一致。✅(见 Advisory A1)
6. **MEDIUM-6(join key)** → §5 v2 首行 `[patrol_tick #<seq>]`(:102),与措辞修订并入**同一次** founder 认可(:107);否决 fallback = 时间窗匹配 + `tickNA`(:107/:113)。**增量核验**:(a) `StuckEscalationEnvelopeLike.seq: number` 确实在 `formatPatrolTick` 入参上——「零新数据」属实;(b) 我 grep 了全仓 `[patrol_tick` 的全部出现点:`patrol-tick.ts` ×5 与 `plugin.ts:8096` 全是**日志行前缀**,不是 body 解析器;`lead-inbox-runtime.test.ts:293/318` 是 stub renderer 的固定返回串,语义不受影响——**前缀改 `#<seq>` 不破坏任何既有消费者**。✅
7. **LOW-7(REST)** → §4 步 5(:80)与 §8 步 5(:137)均改 `gh api 'repos/{owner}/{repo}/pulls?...'` + `gh api '...actions/runs?...'`,并注明 `gh pr list` 走 GraphQL 故不用;§4(:83)「两条 REST 调用」的陈述现在内部一致(两条确都是 REST)。✅
8. **LOW-8(Codex 写路径)** → §9(:150)边界注记:full-access(`READ_DENY=0`)可写、write-capable(writableRoot=projectRoot)显式移出 v1、生产当前无此形态。与 FLY-350/FLY-245 的形态事实相符。✅
9. **LOW-9(fallback 措辞)** → §12(:176)改为「模板整句不动(v1 原文保留)」,矛盾消除。✅
10. **LOW-10(Discord 选取规则)** → §4(:80)/§8 步 5(:137):名册 identifier 对应 `[FLY-XX]` issue thread、最多 2 个、最近活动优先、名册空记 n/a——可判定。✅
11. **LOW-11(时间戳格式)** → §4 步 4(:79)逐表标注 + CI 双格式覆盖。**增量核验**:`turn_wake_outbox.created_at` 的写入值是 `input.createdAtMs`(db.ts:4969)——「INTEGER 毫秒」标注属实。✅

另:§13 设计评审记录如实记录了 Codex 额度背景、Tadashi 裁定、Round 1 结论与折入位置——满足「评审结论写进 design 产物」要求,且没有把 Claude 交叉评审冒充成 Codex 评审。

## Issues & Recommendations

无阻塞项。3 条 LOW advisory,不要求改计划,随实现 PR 落即可:

1. **[LOW] transient 原因串要归一化成稳定 token,否则「连续 2 tick 复现」与 Linear 标题搜重会碎片化。**
   sqlite/gh 的原始错误文本是易变的(带路径、行号、时刻);step-0 自检靠比对上一份报告的 reason、§7 靠标题前缀搜重,两处都要求同因可判等。建议脚本把 transient 原因收敛为固定枚举(如 `transient: sqlite_busy` / `transient: gh_network`),原始文本放证据行不进状态行/标题。CI 的 transient 阳性对照顺手断言这一点。
2. **[LOW] 安装位点的「实现时确认」是有界推迟,但必须在同一个 PR 内落地。**
   §4 已列候选(restart-services 安装步 / 独立 installer)+ converge 清单 + FLY-1482 守卫;merge 时不接受「链接手工创建」的过渡态——创建位点、converge 名单项、worktree-root 拒绝三件事同 PR 交付(计划语义已含,此处点名为验收口径)。
3. **[LOW] §8 步 5 Discord 半步的「名册为空记 n/a」是不可达文本。**
   roster 为空的 Lead 零 tick(§2/§9 自己写明),不会有报告可写。无害,实现时可保留(防御性)或删句,不影响批准。

## Design-decision judgments

- **(a) 检测=整机 / 处置=名下 + 保留零 tick 门 — AGREE。** Round 1 的条件(「整机」不得字面化为跨项目账本 join)已通过 §4 project-filter bullet + 双项目 CI 对照结构性落实;残余盲区在 §9 诚实点名。
- **(b) SQL 真相只在 CI 测真库的脚本里 — AGREE。** Round 2 未变,Round 1 论证维持:防 .md 腐烂、fail-visible 退化路径自洽、非 over-engineering。
- **(c) 报告落盘 + Discord 只在 FINDING/UNAVAILABLE — AGREE。** join key(#<seq>)补上后,follow-up rider 的机器核查从「无键可 join」变为可实现,该决策的长期价值兑现路径闭合。
- **(d) UNAVAILABLE 出口 = structural 首现建单 / transient 二次升格 — AGREE。** Round 1 的条件(瞬态分流)已折入;配合 Advisory 1 的 reason 归一化,工程队列不被自愈抖动毒化。
- **(e) tick 模板 v2(范围句 + 指针 + `#<seq>`)同一次 founder 呈报 — AGREE。** 三处改动合并为一次 founder-fixed 资产变更请求,否决路径完整(v1 逐字保留 + 规矩侧单边压制 + 时间窗锚定);deny-list 与零预判不变量不触;我已验证前缀变更对全部既有消费者无破坏。

## Verdict

**APPROVED。**Round 1 的 11 条全部正确折入,增量事实核验(seq 在 envelope 上、`[patrol_tick` 无 body 解析消费者、turn_wake_outbox 毫秒单位、gh REST 端点、Discord MCP 五工具名)全部属实。剩余 3 条 LOW advisory 均为实现细节,不阻塞设计。注意:本批准是 Codex 额度受限下的 stopgap 交叉评审(§13 已如实记录);若后续补跑正式 Codex design review,以其增量发现为准。
