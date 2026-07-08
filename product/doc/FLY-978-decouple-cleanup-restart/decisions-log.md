# FLY-978 决策记录 — Annie 拍板(经 Honey Lemon relay)

Issue: FLY-978
日期: 2026-07-07
用途: 记录共创过程中 Annie 已拍的方向,供写 PRD 时逐条落地(restart/compaction 也不丢)。

## Round-2 clarification batch —— Annie 已答 3/4(2026-07-07)

### ② 重启当独立定时的事 —— 频率 + 触发 ✅ 已定(含 anchor 修正)
- **拟定值**(经 Lead 写 PRD 时更新):主机 **6h**-变更才重启(注:Round-2 relay 曾说 3h,以 6h 为准);
  卫星机 / 普通项目每日巡 release;支持 ad-hoc 手动重启。
- core 部署策略:**『定时批量部署』+『清理跨重启不丢』两个都要**(= 我提的 a+b)。
- **⚠️ Anchor 修正(Cass catch,Lead relay,instruction f6a07bba):重启 cadence 的权威定义归『多机部署 PRD』,
  不在 978 写死** —— 978 只拥有『重启与清理解耦』的**不变量**(清理不等重启、不被任何 cadence 的重启
  race/打断);cadence 具体值在 PRD 里以「见多机部署 PRD;当前拟定 …」的 cross-ref 形式出现,防两份 PRD drift。
- 推论:普通项目的清理**根本不等重启**,merge 落地当场清;重启只为上新代码,与清理彻底解耦。

### ③ 自动清理里怎么尊重 ship gate ✅ 已定 = 严格 Founder-Gate(我的 A,稳)
- **只有能证明『这次 merge 是 Annie 批过的』才自动清 + 归档;证不出 → 挂起报她**(不误清一次未授权的 merge)。
- merge 门本身不变(产品 issue = 你/Lead review;eng = ship gate);merge 落地后清理+归档全自动、不用她再点第二次。

### ④ 什么算『真做完』+ 清干净清单 ✅ 已定
**5 条『清干净』清单(缺一不可):**
1. 关该任务**所有 runner session**(三段式 impl / design / QA 都要关)
2. 清**这三个 worktree**
3. **PR merged to main**
4. **关 / 归档 Discord thread**
5. **关 CMux Tag**(cmux window/tag)
- 没 PR 的任务(QA/文档/纯配置):绑**『真实的 close / 完成动作』**,**不**光凭 Linear 翻 Done 就归档(呼应 FLY-962 误归档担忧)。

### ① 北极星 north star ✅ 已定 = A(Annie 拍)
- **A = 『done 必清必归档、一次不漏』为 north star;『残留可见性』做兜底**(万一真漏要能被看见/自愈,绝不静默,
  兜底层 = FLY-942 watchdog)。

## Annie 终审锁定(2026-07-07,instruction 00bd1bc7) —— 全部定案

- **block 1 = 方案 1(持久化收尾状态机),唯一实现路径。** 方案 2/3 从正文降为备选/已弃。
- **清干净 5 条,两处细化:**
  - #1 session 数:**三段式 = 3 个 session**(设计/实现/QA 都关);**普通 = 1 个 session**。权威 inventory 按此填。
  - #3 加 **:cool ship-flow**(Annie 新加,重要):很多 repo 走 :cool —— PR comment `:cool`(hook)→ CI/CD →
    deploy → **deploy 过了才 merge to main**。repo 有 :cool → 「merge 落地」= :cool flow 完成的那次 merge,
    cleanup 在其后触发,Founder-Gate 授权 = 那次 :cool 由 Annie 授权;repo 无 :cool → 直接 merge。`merge_detected`
    要认两种。其余 3 条(worktree/thread/CMux tag)不变。
- **Founder-Gate:维持现状(Annie 拍 ship)。** future note:Annie 希望最终 Lead 能替她做 ship 决定(渐进放权,
  接 **FLY-816**),但现在仍 founder gate。
- **重启不 race:确认不变。**
- **block 5 误归档护栏 = 定了:** ① Done issue 别急着归档(还在讨论的不归);② **不做自动 unarchive**(需要的情况
  少,真要 Annie 手动;以后手动太多再开 issue 议);③ no-PR close authority = 保守默认 Lead/founder 显式 close(不变)。
- **流程:** 落定稿 → Lead 末轮 codex(重点 verify :cool flow)→ 过了 Lead merge 入库 + 我拆 E1–E5 build issue 给
  Tadashi。仍别 ship/清/merge/归档,等 Lead。

## 写 PRD 时要核实 / 注意的点(不改变已定方向)
- **worktree 数量语义**:Annie 说『清这三个 worktree』。但代码里三段式常**共享一个 worktree**
  (post-ship-finalization 注释:shared worktree removed once by removeCleanWorktree)。PRD 要按真实机制
  写成『清掉该任务**所有**关联 worktree(1 个共享 or N 个 per-phase,取决于 three-stage keep-alive 配置),
  一个不留』,并在给 Tadashi 的 build issue 里点明这个歧义,别照字面锁死『恰好 3 个』。
- 严格 Founder-Gate 的证明机制:复用现有 `verifyApproval` / founder-attributed `{approved:true}` +
  `pr_head_sha` 精确匹配(见 exploration §4 / external-merge-reconcile Path 2)。
- 『清跨重启不丢』要解决 exploration §2.5 的杀手:finalization 的原子 claim 行不能在被重启打断后
  永久吞掉级联 —— 需要 durable/resumable 的收尾(claim + 完成证据分离,或重启后可安全重放)。

## 约束(Lead 定,写 PRD 时遵守)
- product issue:验收 = Annie + Honey Lemon review,**没有 QA**。
- **draft only;不 ship / 不清 / 不 merge / 先不 create-issue**(先只出 PRD + 拆分方案)。
- review.html 用 Apple 浅色(给 Lead 前 curl+grep 自查 0 处 prefers-color-scheme)。
- PRD 落 `product/doc/FLY-978-decouple-restart-cleanup/prd.md`,要具体:状态机 + 时序图(mermaid)+
  清理步骤清单 + 重启调度 + 验收『done 必清必归档、一次不漏』。
- 定稿后 build 部分拆 eng issue(Flywheel 标签)交 Tadashi(先出拆分方案,暂不真 create-issue)。
