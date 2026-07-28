# FLY-1500 复验报告（epoch 8，head 37c99b31）

Issue: FLY-1500
日期: 2026-07-28
基于: qa-report.md（第一轮 FAIL）+ implement 修复 commit 37c99b31

> **落盘说明（Lead 裁定）**：本文以**纯文档 commit** 落盘。今晚立的三分法是
> **重跑的判据是产物、绑定的判据是 head** —— docs-only commit 改的是 head、不是产物，
> 因此需要**重新披露绑定关系**，但**不需要重跑跨族评审**（照 FLY-1498 的先例：评审绑
> `fa4c0273`、gate 绑 `35a6e523`，中间一个 docs-only commit，以 `git diff --stat` 实证
> 零产品改动）。
>
> **QA PASS 与跨族评审均绑 `37c99b31`**；本 commit 之后的 head 与 `37c99b31` 之间
> **仅为本报告（docs-only），产物零变更**。
>
> **本报告由 Claude QA 会话所写**，经 initiator-family 路由存在**有界的同族自审窗口**
> —— 照 FLY-1498/1499 的口径原样披露。

---

## verdict 落库实证

| 项 | 值 |
|---|---|
| submission credential | id=70，consumed `2026-07-28T12:29:55.418Z`，claim=67 |
| decision capability | id=**56**（cred70 的真实配对，非指令里写的 54），consumed **同一刻** `12:29:55.418Z` |
| workflow_claims 67 | FLY-1500 / run `2e0732e7` / node=qa / `qa_verdict` / attempt=1 / **`qa_passed`** / git_head `37c9…` |
| run node | `attempt=1 running` 保持不变；**`attempt=2 state=done` 于 `12:29:55.421Z` 由 verdict 落库创建**（结果行，非前置） |

与 FLY-1498 已知成功形状逐字同形（cap51/sub67 同刻消费）。CLI 回执未被采信，以上为回查库所得。

## 结论：PASS

六项 blocker 全部在 `37c99b31` 上修好，**每一条都通过了变异对照**：把修复从构建产物里
撤掉，对应断言立刻变红；修复装回去，立刻变绿。所以这些断言是在量修复本身，
不是搭"测试绿了"的便车。

## 1. 头与前置（我自己核的，不是转述）

| 项 | 证据 |
|---|---|
| head 四处一致 | local HEAD / origin 分支 / `ls-remote` / PR #720 headRefOid **全部 = `37c99b31a560…`** |
| worktree 干净 | `git status --porcelain` 空；我全程的探针都在 gitignore 的 `dist` 与临时目录里跑，跑完复核仍为空 |
| CI 真绿 | `gh pr checks 720` **exit 0**；9 pass / 0 fail / 0 pending |
| 跨族评审绑同一 head | `codex_review_record`：head=`37c99b31…`、status=approved、**author=codex / reviewer=claude**、exec=`d20d8c54` |
| 跨族成立的原因（我查了根据，没有只看字段） | `sessions.adapter_type`：implement `d20d8c54` = **codex-tmux**，我 `23af3193` = claude-tmux。所以该 head 的增量是 codex 作者、claude 评审 —— `author_family !== reviewer_family` 成立 |
| 构建 / lint | `pnpm -r build` 通过；`biome check` 两包干净 |
| 包内测试 | v2-kernel **126 passed**、v2-actions **12 passed** |

关于 Lead 点明的那段历史（11:06 那条 author=reviewer=codex、无 request_id 的记录）：我核到的
当前行是干净形状，且**产物在此期间未变**，所以我复验的对象就是 `37c99b31` 本身。那条不合格
记录我没有、也无法把它当前置消费 —— 我这侧只认现在这条绑定。

## 2. 六项 blocker 逐条复验（含变异对照）

变异方法：修复后的构建产物在 `packages/v2-kernel/dist/`（gitignored）。我把每条修复从
dist 里撤掉 → 跑同一条断言 → 必须变红；再还原 → 必须变绿。源码分支全程零改动。

| # | blocker | 修好的证据 | 变异对照（撤掉修复） |
|---|---|---|---|
| B1 | canonicalize 静默塌成 `{}` | Date / Map / Set / 类实例 / `Object.create(proto)` / function / bigint **7 种全部被拒且零行落库**；symbol key 与 non-enumerable 字段被拒；**嵌套**的 Date 也被拒（不是只查顶层） | 撤掉三道 guard → **B1a / B1c / B1d 三条同时变红** |
| B1' | 假 replay 路径 | 第一个 Date payload 就在门口被拒 → **根本不存在 `{}` 行可供第二次撞上**，假 replay 从源头消失 | 同上 |
| B1'' | 工具返回非 JSON | wrapper 抛错且行**诚实停在 intended**、无 `{}` 结果 | 同上 |
| B2 | 重复 key 绕过 DB 闸 | 六例：banned 在前 / banned 在后 / 多余 key / 键序颠倒 / 只写 banned **全拒**；canonical 合法形式**放行** | 撤掉 `retry_basis = json_object(...)` 子句 → **B2 变红**（banned-SECOND 又被接受） |
| B3 | envelope 过严 | 同一 invocationUid 的三种形态（理由文本重新生成 / 审计元数据整体丢失 / 逐字相同）**全部 replay 回原 action**；而 payload 真变了仍然 **fail loud** | 恢复对 supersedes / retry_basis 的比较 → **B3 变红** |
| L2 | 0005 空转 | 迁移链 = 0001/0002/0003/0004/**0006**，无 0005；全新库迁移通过，`foreign_key_check` 空、`integrity_check=ok`；`commands` / `command_dependencies` / `obligations` 全消失、共享 `events` 保留；`attempts` 六个探针列一个不剩；仓内无 `0005-commands` 残留引用 | （删除类改动，以链完整性 + 全新库真迁移为证） |
| C1 | 崩溃窗用例不完整 | 真跑一次 effect 后刻意不写 outcome：行停在 `intended`；同 invocation 重入 = `replayed + intended`，**effect 总调用次数恰为 1** | （测试完整性类，以次序断言为证） |
| C2 | capability 回滚覆盖不全 | prepare **成功消费** capability 后 intent INSERT 撞主键失败 → 整事务回滚：effect 零执行、**capability 仍未消费**（一次性授权没被烧掉） | （同上） |

## 3. 回归：第一轮的 10 条独立探针重跑

全部仍然 **10/10**：上游 agents 缺失时迁移响亮失败、崩溃窗诚实、intended/failed 重放不冒充
成功、世代围栏（含接班世代）、terminal 五种裸 SQL 篡改全拒、读动词零写、supersede 六条规则、
四条事故查询计划。修复没有回退任何我上一轮已验的性质。

## 4. 跨单待验（Lead 已记账，我按规则点名，不打勾）

按 Lead 立的通用规则——**验收项若依赖本单范围外的前置，必须显式标注待验并写明解锁条件**：

1. **`listActions.createdBefore` 仍是时间戳过滤器，不是完整 keyset 游标。**
   本轮实测未变：三行同 `created_at`，`limit:2` 第一页 2 行、第二页 **0 行**，第三行看不到。
   **解锁条件**：第一个真实消费者接入之前，必须改成 `(createdBefore, createdBeforeId)` 复合
   游标并同步 mapping §5 的公开 options。仓内边界用例会在改完后变红作为提醒。
   **状态：待验，不是已验。**
2. **FLY-1499 + FLY-1500 合入后，全新库的联合 `migrateDatabase` 验收。**
   本单内物理上做不了：上游 `agents` migration 未合入，本单迁移在全新库上按设计
   响亮失败（实测仍抛 `no such table: main.agents`）。
   **解锁条件**：两单合入且迁移编号对齐（1499 占 `0005-agents-config-mailbox-rebuild`，
   1500 保持 `0006`）后，在全新库上真跑一次 `migrateDatabase`。
   **状态：待验，不是已验。**

## 5. 我没验的（诚实边界）

- **真实外部副作用**一次都没发生：本批交付的是黑匣子与薄壳，`perform` 全是测试替身。
  这是设计边界（终稿把外发交还给 Agent），不是漏测。
- **`~/.flywheel` 生产库上的迁移**：机器上不存在 v2 库，无从演练。
- **本单仍是零接线**：全仓除 v2 两包自身外无任何 import，所以以上修复对生产行为的影响是零。
