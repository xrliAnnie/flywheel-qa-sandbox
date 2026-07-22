# FLY-1375 Ship 后全自动收尾 — land 流程 — 探索

Issue: FLY-1375 (https://linear.app/geoforge3d/issue/FLY-1375/ship-自动化-founder-说-ship-后全自动收尾-land-流程cool-merge-清-worktree-关全部)
日期: 2026-07-21
基于: 无

## 1. 背景与问题

Annie 两大困扰之二(2026-07-18 深夜深诊定案):

> 「我说可以 ship 之后,应该进入全自动流程(runner 清理 + merge 后清 worktree + 关进程 + archive thread),但基本没成功实行过。」

深诊结论(深诊页 https://fw-reports-a53de2.vercel.app/r/ca7d58bcf4b6a886d1951d12c295430d/):**级联后半段是好的**(FLY-1338 当晚人肉全套验证:标 Done + archive thread 这半段流程本身可行),坏在五个断点:

| # | 断点 | 深诊原话 |
|---|------|---------|
| ① | 「ship」不是系统事件 | merge 之后没有任何自动扳机;扳机长在 Lead(Tadashi)记性上 |
| ② | close_runner 资格陷阱 | awaiting_review / lease 状态的 session 拒绝被关闭 — 但 land 时这些状态是**预期的** |
| ③ | worktree 自动清理半途 | FLY-603 有未触发史,「另一半没建成的自动化」 |
| ④ | 一单 3 session 无一键原语 | design holder + implement + qa 需逐个关,易漏项 |
| ⑤ | runner 自身收尾无人唤 | runner 自己的收尾活(cleanup)没人给机会做 |

深诊指出的根本病因(同一模式三次现身):

> 「系统到处依赖『事件发出的那一瞬间一切正常』,没有任何循环回头核对『现在的真相到底是什么』。」

当晚失真实证:3 个死进程仍显 running;9 个 session 重启后集体误报 monitoring_lost;Discord 与 session 记录三次不匹配。深诊修法矩阵中,本单对应 **Fix-C:引擎执行 land 节点(清→关→存档),写进 DAG 工程模板**(Fix-A 进程对账并进 FLY-1369,Fix-B Discord 显示幂等重渲染进路由卫生小单,Fix-D 事件入队销账 = FLY-1373 已落)。

## 2. 目标(issue 已定,能力级验收)

founder 批准(:cool:)→ 一条自动链跑到底,**除批准外零人工介入**:

1. merge 走 🆒 sanctioned 流程(Annie 直令:不许裸 `gh pr merge --squash`;🆒 带 verify-approval 绑定 + 部署播报 + 级联起点)。
2. merge 成功 → **land 流程自动触发**(引擎/Bridge 持扳机,非 Lead 手调):
   a. 清理该单 worktree(把 FLY-603 半截自动化建完;含「烂 worktree 咬后人」防护)
   b. 一键关该单全部 session(新原语:close-all-sessions-of-issue)
   c. 修 close 资格陷阱:lease_stale / awaiting_review 给 land 路径豁免通道
   d. runner 收尾钩子:关前给每个 session 一次 cleanup 机会(shutdown-request 同款语义)
   e. 级联收尾:标 Done + archive thread(接上已验证好的后半段)
3. DAG 形态:land 作为 DAG 工程模板最后一个节点(design→implement→qa→land);legacy 在飞单由 Lead 人肉执行 1338 范式过渡。

**真机验收(issue 原文):**
① Annie 说 ship → 全链自动:merge(🆒)→ worktree 消失 → 该单全部 session 关闭 → issue Done → thread archived
② 故意留一个 lease_stale session → land 照样收掉
③ 烂 worktree 场景:land 后同分支新 runner 能干净起
④ 全程 Discord thread 里有链路播报(配合状态真相单)

## 3. 非目标

- 不改 :cool: 批准语义本身(verify-approval 绑定机制保持;founder-only-authority 合同不动 — merge 的授权仍然只来自 founder)。
- 不做「ship 前」的自动化(CI 修复、review 循环等已有机制);本单只管 **merge 成功之后** 的收尾链。
- 不重做 FLY-1369(进程↔sessions 表对账)与 Discord 显示重渲染(Fix-A/Fix-B 已各有归置);land 只消费它们的真相,不重建。
- legacy(非 DAG)在飞单不强行接自动链 — 过渡期 Lead 人肉 1338 范式,本单不为 legacy 造第二套扳机。

## 4. 设计空间与方向选择

### 4.1 扳机放哪(断点①)

| 选项 | 说明 | 评价 |
|------|------|------|
| A. Lead 记性(现状) | Lead 看到 merge 后手调各清理动作 | 已证失败 — 本单要修的就是它 |
| B. 纯事件驱动 | Bridge 观察到 merge 成功(🆒 流程回执)→ 直接触发收尾函数 | 扳机进了引擎,但收尾链没有执行体/状态/重试语义,失败即断(正是深诊批的「事件瞬间正常≠永远正常」) |
| C. DAG land 节点(issue 已定) | land 是 DAG 工程模板的最后一个节点;qa 后等 founder 批准,merge 成功作为 land 节点的入边事件;land 节点由引擎执行收尾链 | 扳机 = DAG 推进机制本身(已有 dead-exec recovery/FLY-1385 兜底);收尾链有节点级状态、可恢复、可审计 |

**方向:C**,同时吸收 B 的事件源(merge 成功回执是 land 节点的触发事件,而非 Lead 转述)。

### 4.2 land 节点的执行体:agent node vs engine node

- **agent node**(起一个 runner session 去做收尾):与现有节点形态一致,但为纯机械动作烧一个 session,且「关全部 session」的执行者自己也是 session,自噬问题(谁关它?)。
- **engine node**(引擎/Bridge 进程内直接执行,深诊 Fix-C 原话「引擎执行 land 节点」):无自噬、无额外 session 成本、失败语义落在 DAG execution 上;代价是 DAG 引擎需要支持「不 spawn session 的节点类型」。

**方向:engine node。** 深诊定案原话即此;「关全部 session」这个动作在语义上只能由 session 之外的执行体做。是否已有 engine-node 先例待 research 确认(若无,这是本单在 DAG 引擎上的主要增量)。

### 4.3 close 资格豁免(断点②)的形状

现状 close_runner 对 awaiting_review / lease 持有等状态拒关 — 这是对的默认(防误杀干活中的 session)。land 场景下这些状态是预期的(issue 已 merge,awaiting_review 的 QA、parked 的 design holder 都该收)。选项:

- **全局放宽资格检查** — 危险,削弱日常防误杀,否决。
- **land 专用豁免通道**(issue 方向):close 调用带 land 上下文(如 reason=land + 绑定 merged PR/issue 证据),资格检查对该上下文放行 lease_stale / awaiting_review / parked;对「正在实施中(未 merge)」的状态仍拒 — land 豁免不是无条件杀,是「带 merge 证据的收尾」。

**方向:带证据的 land 豁免通道**,豁免面精确到 land 预期状态集,证据绑定 merge 事实(防止豁免通道被日常误用)。

### 4.4 runner 收尾钩子(断点⑤)

关前给每个 session 一次 cleanup 机会(shutdown-request 同款语义):向 session 发收尾指令 → 限时等待(超时照关,fail-safe 向「关」收敛而非向「挂」收敛)→ 再物理关闭。要点:

- 收尾窗必须**有界**(超时上限),否则 land 链被单个僵 session 卡死,回到老问题。
- 对已死/僵 session(mailbox 无人读)不能等满窗 — 探活短路。
- cleanup 内容由 session 自决(commit 未落盘的 doc、上报最终状态等),引擎只给机会不管内容。

### 4.5 顺序与失败语义(草案,待 research 后在 plan 定稿)

收尾链内部顺序倾向:**播报开始 → cleanup 钩子(有界)→ 关全部 session → 清 worktree → 标 Done → archive thread → 播报完成**。理由:先给 session 收尾机会再关;关完 session 再清 worktree(避免活 session 的 cwd 被拔);Done/archive 放最后(它们是「收尾完成」的对外宣告,且是已验证好的后半段)。每步失败:记录 + 继续能继续的 + 终态明示(部分成功不得伪装全成)— 呼应深诊「回头核对真相」而不是「发出即当成功」。

### 4.6 legacy 过渡

在飞的非 DAG 单:Lead 人肉 1338 范式(issue 排期原文)。本单交付物中给 Lead 一份 land 检查单指针即可,不造 legacy 自动扳机。若新原语(close-all-sessions-of-issue、worktree 清理)以 API/CLI 形式存在,Lead 人肉时可直接调用 — 人肉范式与自动链共享同一套原语,只是扳机不同。

## 5. 留给 research 的关键问题

1. :cool: → merge 的现有链路:merge 成功的「回执」在系统里以什么形式存在?Bridge 能不能可靠观察到(事件 vs 轮询 vs GitHub webhook)?
2. DAG 引擎:是否已支持不 spawn session 的节点?节点失败/重试/recovery(FLY-1385)语义如何复用到 land?
3. close-runner 资格检查的精确代码位置与拒关状态全集;终态免疫(Finding K)与 land 的交互。
4. 按 issue 枚举全部 session 的数据通路(StateStore 里 issue↔session 映射)。
5. worktree↔issue 映射;FLY-603 半截自动化的残骸与未触发根因;FLY-1185/FLY-99 已有清理逻辑的可复用面。
6. shutdown-request 现有实现(mailbox/wake)能否直接当 cleanup 钩子用;对 no-transport runner(antigravity/kimi,FLY-493/494)的边界。
7. 标 Done + archive thread 的现有代码路径(FLY-1165 reconcile)— land 是直接调它,还是发事件让它收敛?
8. 1338 范式的成文位置(Lead 人肉检查单从哪来)。
