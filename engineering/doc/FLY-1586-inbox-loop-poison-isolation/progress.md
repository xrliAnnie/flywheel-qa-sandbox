# FLY-1586 进度游标

阶段: **implement — 已停 loop(预算耗尽,非完成)**(Lead 指令 22839940 覆盖了设计阶段:停写设计,开始写代码)
文档文件夹: engineering/doc/FLY-1586-inbox-loop-poison-isolation/
PR: https://github.com/xrliAnnie/flywheel/pull/744 (draft)

## 已完成
- [x] 抢救 FLY-1579 被搞浅的三份文档进 git,抬头改写为 FLY-1586 (5ce80680)
- [x] 确认 lane: adapter_type=claude-tmux → claude family → 本地 codex design
      review + design-review.json + await-codex-gate(**不走 request-review**)
- [x] scope 适配: D 移出本单(Lead e0cefb44 已确认,他来开 follow-up)、
      新增 F(存量冻结)、「A+B+C 不带 F」写进禁止组合 (f2f69d0d)
- [x] §1b 从「九条红线」补成实现级设计 + 纠正两处继承错误 (ab8fdb17)
- [x] Codex design review R1 闭合 (392a48c5)
- [x] Codex design review R2 闭合 (2e893570)
- [x] Codex design review R3 闭合 (a193c28f)

## 停在这里 — 等 Lead 决策
三轮 design review 全部 CHANGES REQUESTED,触发 codex-design-review 的
**三轮安全阀**(继续 / override / 重做,不许自动批准)。已非阻塞 ask Lead。
同时 Lead 有在先指令: 收工前先问他、不要自己 complete。

## 实现进度(Lead 指令 22839940 后)
- [x] **C 码点安全截断 — 完成**
      - helper `packages/flywheel-comm/src/text-truncate.ts` + 18 测 TDD (55599562)
      - flywheel-comm 侧接线: db.ts:4931 引爆点 + gate.ts 两处 (6abbccb3)
      - teamlead 侧接线: mailbox/commdb runtime + hook-payload 三处 (10e5797f)
      - 全仓 build 退出码 0 零 TS 错误;145 + 3 测绿
- [x] **A 统一规范化 — 三个写入口全部完成**
      - primitives `inbox-write-normalize.ts` + 17 测 TDD (b81cca45)
      - enqueue() (6fea9ab7) · tsc 修 + 更正假声明 (6e20216c)
      - enqueueHubRoot + reconcileEnqueueConsumed (92b4a8db)
      - **逐入口变异验证**: 各自退回原始值 → 恰好对应那条红、其余仍绿
      - build exit 0 / 零 TS 错误 / 157 测绿
      - **净化审计表完成** (§3.4): 新表 lead_inbox_sanitation_audit,
        与 INSERT 同事务(能独立丢失的审计不算证据);digest 用 UTF-16LE
        (UTF-8 会让毒值和修复值哈希相同);测试抓到 hub-root 层修复与记录漂移
- [x] **B 逐行隔离 — 端到端完成**
      - `legacy-row-errors.ts` + 12 测 TDD (40e19c78)
      - 只隔离故意铸出的类型(LegacyRowPoisonError / InboxWriteValidationError);
        SQLITE_* / I/O / owner fence / 未知 → 继续抛走 retry
      - 按【错误类型】判定,绝不按消息文本(有专门测试钉这条)
      - 错误消息不回显 payload(防 ship 指令随日志进告警)
      - onRowQuarantine 未接 → 继续抛,不静默跳过
      - **验收 #2 正对照集成测试完成** (c6b28486): 毒行留在 journal 里不删,
        证明 reconciler 照样跑完、毒行【后面】那行照样入列、第二次跑仍稳定
      - **端到端变异验证**: 把 A 的 expected 退回原值 → 集成测试报出
        "lead inbox id ... was reused with different content",
        与 61 小时停摆时 Bridge 日志【逐字相同】。
        不是「测试绿了」,是「把修复弄坏就能重现那次事故」
      - **durable quarantine marker 完成** (75e4f083): 新表
        legacy_cutover_quarantine(不复用退役的 dead_lettered_at);
        commit point 是 marker 不是 alert(否则告警通道故障会拖死全场);
        绝不写 delivered_at;listUndeliveredLeadEvents 跳过隔离中的行
        (没这条就每次重启重扫再抛 = 「重启试试」永远不管用的原因)
      - 生产侧 lead-inbox-runtime 接线 onRowQuarantine
      - 注: 本次事故其实【不走】隔离路径 —— seq 56649 的代理项在可修复的
        content 里,归 A 修复并正常投递。A+C 就能恢复本次停摆;
        B 是给下一类确定性坏行的韧性,不夸大它的作用
- [x] **F 存量冻结 — 完成**(Tadashi 裁定走第三条路: seq 水位线)
      - 一次性数据标记 consumed_at + disposition=frozen_fly1586,
        delivered_at 留 NULL(没投递就不许说投递了)
      - **零消费方耦合、零既有测试改动、不依赖时钟**
      - 白捡: countPending / stall 判定也只看 consumed_at ⇒ R3 HIGH-4
        (冻结积压打瞎 checker)自动消失
      - 实现前核实两个事实前提: founder_msg 不走 lead_events(直接进
        lead_inbox)⇒ 40 条危险行全在水位线下; 水位线后物化的是遥测,无害
      - **变异验证用 Tadashi 警告的 fail-OPEN 陷阱当变异体**: 把谓词改成
        msg_class=founder_msg → 5 测立刻红(含对照组)
      - 已知边界写进 plan §1b.16 交承接单

## 已知未做完(诚实标注,不当作完成)
- C 的全仓复扫做了,但**没有逐条分类**每个 slice 命中能否到达 lead_inbox。
  至少 complete.ts:370 的 (await response.text()).slice(0,1000) 值得单独看。
- 三轮 design review 的 question 3b2e3ea7 已作废(Lead 指令回答了它)。
- R3 HIGH-7: #10c 的真 SQL + install lifecycle baseline 表,属实施阶段。

## 旧待办(已被 Lead 指令覆盖)
- [~] R4+ 继续闭合 — Lead 指令 22839940 明确:停写设计,开始写代码
- [ ] R3 HIGH-7 未闭合项: #10c 的真 SQL + install lifecycle baseline 表
      (本文档只锁定了形状与依赖,真 SQL 属实施阶段交付物 —— 诚实标出)
- [x] founder design HTML 已做并发布 + 已报 Lead
      https://fw-reports-a53de2.vercel.app/r/5e15688839820a666a556bb01e280e3f/
      真机验两遍(本地 + 发布后真 CSP);脚本确实执行,不是只看 nonce 属性在不在
- [ ] stage set design_review + design-review.json + await-codex-gate
- [ ] complete --route phase_design_complete ← **Lead 明令不许自己走**

## 三轮收敛数据(判断是收敛还是原地踏步的依据)
| 轮 | 结论 | 上一轮闭合情况 |
|---|---|---|
| R1 | 2 BLOCKER / 3 HIGH / 3 MEDIUM / 1 LOW | — |
| R2 | 2 BLOCKER / 4 HIGH / 3 MEDIUM / 2 LOW | R1: 3 RESOLVED / 6 PARTIAL / 1 NOT |
| R3 | 3 BLOCKER / 4 HIGH / 1 MEDIUM / 1 LOW | R2: 4 RESOLVED / 5 PARTIAL / 1 NOT |

R3 自己做的 producer 审计说: 生产代码里能新建 lead_inbox 行的底层 INSERT
只有四处,A–G 七条旁路已覆盖全部已知 producer,补上 quiescence 后没找到第八条。
⇒ 攻击面在收口,但每轮仍在出真 BLOCKER。

## 现场观察
- 本 runner 自己发 flywheel-comm ask 时 stderr 反复打出
  "lead inbox nudge failed: This operation was aborted; durable queue row retained"
  → 正是本单要修的停摆在实时复现。消息本身 durable 入队没丢。


## 停 loop 时的真实状态(2026-08-01)

**51 提交,全部已 push。PR #744 (draft)。没 complete,没 merge。**

实现: A ✅ / B ✅ / C ✅ / F ✅(F 按 Tadashi 裁定走 seq 水位线)
Codex code review R1/R2/R3: **全部闭合**(逐条状态见 plan §1b.17/18/19)
  唯一保留标注: HIGH-4(questionAlreadyAnswered)**仅由代码路径验证,无测试**。
  这条标注**不许**改成绿勾 —— Tadashi 明确要求保留。

最后一条交付(Tadashi 收窄的范围,commit a75840cd):
  packages/teamlead/src/bridge/__tests__/fly1586-full-tick.test.ts
  整套改动跑通【一次真 tick()】:真 LeadInboxLoop 跑真 admit()
  (freeze → legacy reconciler,生产顺序)、真 CommDB + 真 StateStore、
  毒行在场、真 claim/deliver 拿真 adapter 收据。
  三方同时在场(毒行 + 存量 + 新增),因为「什么都没投」在 loop 仍卡住时也成立。
  ⭐ 变异判据: 把 A 的 expected 退回 input.content → result.ok true→false,
     整个 tick 失败、两条 claim 路径一条都没跑 = 重现 61 小时停摆本身。
  ⚠️ **它不是真机 E2E**,不覆盖 Discord / tmux / 真 Lead 进程 ——
     文件注释和 PR 描述里都写死了。叫它 E2E 就是本单在治的假标签病。

## 当前游标(重启后从这里接)

**在等两件事,等判决期间不 push(§1b.20 第④条: 边等边 push 会自己取消 CI,已犯 3 次):**
1. a75840cd 的 CI 终态 —— 上一次完整绿是 c904ba92 (9 pass / 0 fail)
2. Tadashi 对问题 0fb47f40 的答复: 真机 E2E 由我搭还是另外安排
   (QA room 在本 worktree 没配置,只有 test-slots.example.json;
    Tadashi 已说那是基建缺口不是我的问题、不要为它多花时间)

**剩下没做的:**
1. 真机 E2E: 验收 #1(真 runner question → Lead 真收到)、
   #3(lead_notified 也送到)、#6(loop_heartbeat last_success_at 推进,
   目标集合必须动态派生 —— **绝不硬编码 14 或 16**)
2. 部署前硬门(plan §9): **A+B+C 不带 F 是禁止组合** / rollout quiescence /
   D 与承接单必须是真 Linear issue 带 owner

**三条红线(Tadashi 定,持续有效):**
  A+B+C 不带 F 是禁止组合 / merge 与 ship 不动 / QA 不自报 PASS
  另: 收工前先问 Tadashi 再 complete。

**交接材料**: plan §1b.16(F 三条路的裁定与理由)、§1b.17–19(三轮 review 逐条状态)、
§1b.20(本单四条通用教训)、每条 commit message 都写了为什么而不只是做了什么。
