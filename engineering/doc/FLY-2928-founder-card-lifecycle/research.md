# FLY-2928 founder 决定卡生命周期（沙箱核验） — 调研
Issue: FLY-2928 (https://linear.app/geoforge3d/issue/FLY-2928/病根修复-11-founder-决定卡只绑-run-不绑提问的体体死卡不作废作废必改写原消息两套提醒合一8-张-24-2)
日期: 2026-10-01
基于: exploration.md

## 1. 证据等级

本文所有数字都是本节点在两个钉死提交上的**实测**，不是转述：

- 基线 `BASE = 5d262f8c24917d6febf623e00059dfcd8865efed`（生产分支最近一次并入的 main 提交，是 `HEAD` 的祖先）
- 头 `HEAD = b89b10716a5e47e0cc4c1d58569564c31f386df4`（PR #1445 在观测时的头）

读取方式：对生产仓对象库做 `git cat-file` / `git grep <rev>` / `git rev-parse <rev>:<path>`，不 checkout、不 fetch。
它们证明的是「这两个提交之间的静态差异」，**不是**运行时行为，也不是生产验收。

## 2. 五处改动面 → 可静态观测的事实

每处改动面挑「在基线与头之间发生翻转」的事实：旧路径的标识符从有到无（删了），新机制的标识符或文件从无到有（加了）。

| 检查 | 组 | 类型 | 路径（生产仓） | 标识符 | 基线 | 头 |
|---|---|---|---|---|---|---|
| A1 | A 体死卡不作废 | 删 | `packages/teamlead/src/StateStore.ts` | `terminateSessionlessWorkflowGate` | 有 | 无 |
| A2 | A | 删 | `packages/teamlead/src/StateStore.ts` | `listSessionlessWorkflowGateCandidates` | 有 | 无 |
| A3 | A | 新文件 | `packages/flywheel-comm/src/founder-gate-ownership.ts` | — | 无 | 有 |
| B1 | B 不按体路由 | 加 | `packages/flywheel-comm/src/db.ts` | `runOwnedFounderResponseRoute` | 无 | 有 |
| B2 | B | 加 | `packages/teamlead/src/bridge/runner-mailbox-lane.ts` | `adoptRunConsumedFounderResponse` | 无 | 有 |
| B3 | B | 加 | `packages/teamlead/src/bridge/founder-review-response.ts` | `founder_review_answer_awaiting_receiver` | 无 | 有 |
| C1 | C 作废改写原消息 | 加 | `packages/flywheel-comm/src/db.ts` | `founder_card_edit` | 无 | 有 |
| C2 | C | 新文件 | `packages/teamlead/src/bridge/founder-review-card-void.ts` | — | 无 | 有 |
| D1 | D 铸卡预检 | 删 | `packages/teamlead/src/bridge/workflow-decision-routes.ts` | `expectedProducerMirrorHead` | 有 | 无 |
| D2 | D | 加 | `packages/teamlead/src/StateStore.ts` | `gate_entry_completion_fence` | 无 | 有 |
| D3 | D | 新文件 | `packages/teamlead/src/bridge/founder-card-delivery.ts` | — | 无 | 有 |
| E1 | E 提醒合一 | 删 | `packages/teamlead/src/bridge/orphan-founder-review-monitor.ts` | `FLYWHEEL_FOUNDER_REVIEW_ORPHAN_STALE_HOURS` | 有 | 无 |
| E2 | E | 删 | `packages/teamlead/src/bridge/orphan-founder-review-monitor.ts` | `ageBucketHours` | 有 | 无 |
| E3 | E | 删 | `packages/config/src/feature-flags/truth.ts` | `FLYWHEEL_FOUNDER_REVIEW_ORPHAN_STALE_HOURS` | 有 | 无 |

选取规则与诚实说明：

- 「删」类取的是 issue「删什么」点名的旧路径的入口标识符（无体即终止 run、按提问体镜像做铸卡前置、第二套提醒的分桶配置）。
- 「加」类取的是新机制的落点标识符；它只证明代码里**出现了**这个机制，不证明机制正确。
- D 组实测：`expectedProducerMirrorHead` 在 `StateStore.ts` 里基线 14 处、头仍 14 处；只有路由层 `workflow-decision-routes.ts` 从 4 处降为 0。所以 D1 只断言「铸卡入口路由不再把它当前置」，**不**断言整个仓库已删除该字段。
- E 组实测：`FLYWHEEL_FOUNDER_REVIEW_ORPHAN_STALE_HOURS` 在头上只剩一处测试文件引用（证明设了也不生效的反例），产品代码与开关登记表里都已消失，所以按文件精确断言而不是按目录断言。

## 3. 「⛔ 不改批准语义与 R1 边界」→ 可静态观测的代理

| 检查 | 路径（生产仓） | 基线 vs 头 |
|---|---|---|
| R1 | `packages/teamlead/lead-rules-base/runbooks/founder-authority.md` | blob 完全相同 |
| R2 | `packages/teamlead/lead-rules-base/founder-only-authority.md` | blob 完全相同 |
| R3 | `packages/flywheel-comm/src/commands/verify-approval.ts` | blob 完全相同 |

这是**代理指标**：两份 R1 规则文本和本地批准核验命令逐字节没动。它**不能**证明批准语义没变——例如批准写入口 `write-gate-response.ts` 在这次修复里有改动（+11 行），其语义是否等价只能靠生产侧的代码评审与测试判定。本合同对此只报「规则文本未动」，不报「语义未变」。

## 4. 「8 张原单各构造一次原现象」→ 可静态观测的代理

生产侧实现记录把每张原单对应到了具体测试文件。静态上能看到的是：这些测试文件在头上存在，且相对基线是新增或已修改。

| 检查 | 原单 | 测试文件（生产仓） | 基线 | 头 |
|---|---|---|---|---|
| K-2087a | FLY-2087 | `packages/flywheel-comm/src/__tests__/db.fly2928-founder-gate-teardown.test.ts` | 无 | 新增 |
| K-2087b | FLY-2087 | `packages/teamlead/src/bridge/__tests__/founder-card-dead-asker.fly2928.test.ts` | 无 | 新增 |
| K-2590 | FLY-2590 | `packages/flywheel-comm/src/__tests__/founder-run-response-route.test.ts` | 无 | 新增 |
| K-2378 | FLY-2378 | `scripts/__tests__/lead-patrol-snapshot.test.sh` | 有 | 已改 |
| K-2124 | FLY-2124 | `packages/teamlead/src/__tests__/workflow-decision-routes.primary-pr-identity.test.ts` | 有 | 已改 |
| K-2267 | FLY-2267 | `packages/teamlead/src/bridge/__tests__/gate-origin-preflight.test.ts` | 有 | 已改 |
| K-2290 | FLY-2290 | `packages/teamlead/src/bridge/__tests__/founder-review-card-void.test.ts` | 无 | 新增 |
| K-2568 | FLY-2568 | `packages/teamlead/src/bridge/__tests__/founder-card-delivery.test.ts` | 无 | 新增 |
| K-2596 | FLY-2596 | `packages/teamlead/src/bridge/__tests__/orphan-founder-review-monitor.test.ts` | 有 | 已改 |

「测试文件存在且被改过」≠「测试通过」≠「原现象不再出现」。测试是否全绿以生产 PR #1445 的精确头 CI 为准，本合同不代为宣称。

## 5. 读取机制

| 需求 | 选用 | 依据（本机实测） |
|---|---|---|
| 路径在某提交是否存在、是不是文件 | `git ls-tree --full-tree <rev> -- <path>` | 路径不在树里：退出 0、输出为空；在：一行「模式 类型 对象id」；中间的树对象读不出来：退出 128（按「无法核验」，不能当「不存在」） |
| 文件对象读不读得出来 | `git cat-file blob <blob id>` | 对象缺失或损坏退出非 0（按「无法核验」） |
| 文件里有没有某标识符 | `git cat-file blob <blob id> \| grep -q -F -e <lit>` | 退出 0=有、1=无、其他=出错（出错不能当「无」）；不经 pathspec，所以与当前目录无关 |
| 两提交间文件是否逐字节相同 | 比较两边树条目里的 blob id | blob id 相同即内容相同 |
| 路径不被当通配符 | 环境变量 `GIT_LITERAL_PATHSPECS=1` | 路径里即使有 `*`、`[` 也按字面匹配 |
| 不抢锁、不刷新索引 | `GIT_OPTIONAL_LOCKS=0`，且只用读对象的子命令 | 自测对夹具仓库 `.git` 下全部文件做前后校验和比对，逐字节一致 |
| 不因「读」而补取对象 | 部分克隆直接拒绝（查仓库配置里的 promisor / partialclone 项）+ `GIT_NO_LAZY_FETCH=1` | 自测造一个真的 `--filter=blob:none` 克隆：退出 2，且克隆的 `.git` 前后逐字节一致 |
| 不被继承的环境带偏 | 启动时清掉全部 `GIT_*` 变量，再只设所需；不读全局/系统 git 配置 | 自测把 `GIT_OBJECT_DIRECTORY`、`GIT_DIR`、`GIT_TRACE` 指向哨兵目录：结果不变，哨兵目录为空 |
| 仓库参数不被向上「发现」成别的仓库 | `GIT_CEILING_DIRECTORIES=<仓库父目录>` | 给仓库子目录或普通目录都报 `repo_unreadable` |
| 基线确是头的祖先 | `git merge-base --is-ancestor` | 0=是、1=不是、其他=出错，三态分开处理 |
| 生产头是否已前进 | 读本地 `refs/heads/flywheel-FLY-2928`，没有再读 `refs/remotes/origin/…` | 候选构建目录是生产仓 worktree，生产 Runner 一提交本地分支就前进，无需联网 |

不用的手段及原因：

- **不 `git fetch`**：会改写生产仓的 remote-tracking 引用，不是只读。
- **不 `git worktree add` / checkout**：会改生产仓的 worktree 元数据；也就意味着本合同**不运行**生产测试。
- **不调 `gh`**：网络与鉴权状态会引入「查不到」的第三态；合同只做离线、可复现的对象库读取。PR 状态只在文档里记录观测时刻的值。

## 6. 原型实测（草稿目录，未入库）

| 项 | 结果 |
|---|---|
| 原型脚本对真实生产对象库（默认钉死的 BASE/HEAD） | 退出 0；首行 `VERDICT: PASS checks=26 failed=0`；第 3 行 `freshness=CURRENT` |
| 原型自测（夹具仓库，48 例） | 末行 `SELFTEST: PASS cases=48 failed=0`，退出 0 |
| 原型自测在带毒环境下（对象目录等指向哨兵目录） | 同样 `cases=48 failed=0`；哨兵目录 0 个文件 |
| 去掉核验脚本只留自测（先红） | 末行 `SELFTEST: FAIL cases=48 failed=44`，退出 1 |
| `shellcheck -s sh` 两个脚本 | 无输出，退出 0 |
| 耗时 | 真实核验约 7 秒；自测约 1.5 分钟（本机当时负载很高，自测要起上千次 git 子进程） |

自测覆盖的负例：五种检查类型各违反一行；文件对象缺失、中间树对象缺失（都必须是「无法核验」，并有「文件真被删除仍算通过」的对照）；部分克隆；继承的 `GIT_*` 变量；仓库子目录；基线=头；基线不是祖先；提交对象缺失；仓库路径不存在/不是仓库；没给仓库也没有环境变量；SHA 参数多行夹带、过短、大写；未知参数；检查表为空、缺组、未知类型、未知组、重复编号、缺标识符、多余标识符、列数不对（3 列、6 列、连续 TAB、行尾 TAB、行首 TAB）、路径越界、含回车、含 NUL 字节、文件不存在；新鲜度三态。

## 7. 输入边界

- **外部输入只有命令行参数**。`--base/--head` 按整串校验：长度恰为 40 且只含 `0-9a-f`（不是按行匹配，多行夹带一行合法 SHA 会被拒）。校验通过后才传给 git，且总是作为 `<rev>` 或 `<rev>:<path>` 的一部分，不拼进 shell 命令。
- **检查表是入库数据**，随 PR 评审；脚本先校验整个文件只含 TAB、LF 和可打印 ASCII（回车、NUL 等一律拒绝），再用 awk 按 TAB 逐行校验「恰为 4 或 5 列且无空列」（shell 的 `read` 会把连续 TAB 折叠掉，不能靠它数列），最后逐行校验语义（编号字符集与唯一性、组、类型、路径不得以 `/`、`-` 开头且不得含 `..`、`:`），任何不合格都以「无法核验」退出而不是跳过该行。
- **空表或缺组不能通过**：至少要有一行，且 A/B/C/D/E/R/K 七组每组至少一行；自测另外钉死入库表恰为 26 行，防止有人删行让结果变绿。
- 输出里出现的路径和标识符都来自检查表（单行、无控制字符），不来自 git 输出。

## 8. 未知项与风险

| 风险 | 处置 |
|---|---|
| 生产头继续前进（当前正在第 8 轮评审） | 输出第 3 行给出 `freshness=CURRENT / MOVED:<新头> / UNKNOWN`；implement 发现 MOVED 时对新头再跑一次并分别记录，新头失败要报 Lead，但不改写钉死样本的结论 |
| 对象被 gc、对象库不完整或换了机器 | 退出 2「无法核验」，不得写通过；「读不出来」绝不折算成「路径不存在」 |
| 生产侧后续重构改了标识符名 | 新头上对应行会失败——这是如实反映「静态证据变了」，由人判断是重构还是回退 |
| 静态事实被误读成「修好了」 | 报告与 HTML 都单列「没有证明什么」；合同不输出任何「已修复」字样 |
| 公开仓泄露私有内容 | 只入库路径名、标识符、SHA；不入库生产文档或源码正文 |

## 9. 结论

静态核验能回答「改动面是否到位、规则文本是否未动、回归测试是否到位」，回答不了「行为是否正确」。
plan.md 据此把交付定为：一张检查表（唯一事实来源）+ 一个只读核验脚本 + 一个封闭自测 + 一份核验报告，并把「未证明项」写进验收口径。
