# FLY-2045 CLAUDE.md 里程碑表顶部插入 = 并行 PR 100% 互斥 — 调研

Issue: FLY-2045 (https://linear.app/geoforge3d/issue/FLY-2045/repo流程-claudemd-里程碑表顶部插入-并行-pr-100percent-互斥每合一单全舰-dirty分支失去-ci-能力8-25)
日期: 2026-08-24
基于: exploration.md

> **⚠️ 本文是过程稿。唯一执行权威是 `plan.md`(v17)。** 已被后续实测推翻/更新的结论:
> - **已裁定方案 B**(整表搬出并从 CLAUDE.md 删净,Tadashi 2026-08-25 07:05 复议改判);本文 §5 的目标布局方向对,但路径必须是 `engineering/doc/milestones/`。
> - **真实 PR 验收已获授权由本节点执行**(临时 base,永不碰 main)—— §7(1) 那句「不属于本实现节点」已作废。
> - **`ci.yml` 的 `pull_request.branches` 只有 `main`**,所以临时 base 上的 PR 不会触发 CI;台架需要单独补 trigger(plan §6.3)。
> - 「186 条里程碑」是**行数**;**数据行是 177 条**(其中 7 条是 `| v0.x` 旧格式,守卫正则必须覆盖)。
> - 校验和从 `md5` 改 `sha256`,且 pin 的 authority 必须绑定 `origin/main@<sha>`,不能拿 candidate 自证(plan §5.1)。
> - 本文 §5 结尾「A/B 未决」的说法已 **superseded** —— 见上：已裁定 B。

---

## 1. 现状实测(全部来自本仓,不是推断)

### 1.1 CLAUDE.md 的真实构成

| 量 | 值 | 命令 |
| -- | -- | -- |
| 总行数 / 字节 | 441 行 / 178,228 B | `wc -l -c CLAUDE.md` |
| 里程碑块(第 39–224 行) | 186 行 / **167,009 B** | `sed -n '39,224p' CLAUDE.md \| wc -l -c` |
| 该块 sha256 | `cd8798182939362ca374a2c837758155a9e34ef5bbf088701a60e2655c81f09b` | `sed -n '39,224p' CLAUDE.md \| shasum -a 256`(不用 `md5`:那是 macOS 专有命令,Ubuntu CI 上没有) |
| 块内 `\|` 开头行 | 179(含表头 + 分隔行)⇒ **数据行 177 条** | — |
| 块内空行 | 7 | — |

⇒ **里程碑块占 CLAUDE.md 的 93.7%**。搬走之后 CLAUDE.md 只剩 ~11 KB。

> 注:块内那 7 个空行,在 markdown 语义上已经把它切成了若干张独立的表。这是既有状态,搬迁时**逐字节保留**,不顺手"修好"(scope discipline;而且任何清洗都会破坏零丢失的字节级证明)。

### 1.2 写入形态:40 个 commit 的统计

`git log --numstat -40 -- CLAUDE.md`:

- **38/40 是纯加性**(`+1 -0` 或 `+2 -0`)。
- 只有 2 个带删除:`9b87759d6`(+2/−1)、`bda55d01b`(+17/−3,是 `## CLI Contract Changes` 那次结构性改写)。

⇒ CLAUDE.md 在实际使用中就是**一本只追加的流水账**,而它同时还是全项目 agent 的指令文件。这两个身份混在一个文件里,正是本单的根因。

### 1.3 插入位置:5/5 落在同一 hunk

见 exploration.md §1。`@@ -38..39,6 +38..39,7 @@`,上下文全是 `Current version: see doc/VERSION` + 表头。两个并行分支必然产生同位置加性冲突。

---

## 2. 谁在写这一行(完整清单)

grep 全仓(排除 node_modules / 历史 doc)得到的**全部**写入指令来源:

| 文件:行 | 内容 | 本单是否要改 |
| -- | -- | -- |
| `.flywheel/agents/engineering/engineer-executor.md:29` | "Put the CLAUDE.md milestone + `git mv` doc archive as the PR's **last commit**" | ✅ 必改 |
| `.claude/commands/spin.md:342` | "its tracked bookkeeping (CLAUDE.md milestone + `git mv` doc archive) ships **inside the PR**" | ✅ 必改 |
| `.claude/commands/spin.md:359` | "Update CLAUDE.md: add milestone to table..." | ❌ **不改** —— 现查确认它位于 `Non-flywheel repos (generic path)` 段,Flywheel 在 :341-351 已被要求 skip。改它会破坏其它仓库的流程(Codex R1 #1) |
| `.claude/commands/spin.md:369` | "the CLAUDE.md milestone + `git mv` doc archive were the PR's last commit" | ✅ 必改 |
| `.claude/commands/orchestrator.md:452-453`(步骤 F) | "Update CLAUDE.md + VERSION / Add milestone to the milestone table" | ⚠️ **现查确认这是 post-merge 步骤**(在 C 清 worktree、D 验归档、E 改 MEMORY 之后)。只换路径仍会 post-merge 往 main 写 tracked 文件。做法改为:A0 加 Flywheel 里程碑步 + F 加 Flywheel skip 分支,**non-Flywheel 语义不动**(Codex R1 #1) |
| `CLAUDE.md` 自身 §Current Phase | 表本体 | ✅ 必改 |

其余出现 `CLAUDE.md` 字样的地方(`product-designer-executor.md:76`、`pm-executor.md:188`、`packages/edge-worker/src/Blueprint.ts` 的若干 prompt、`release-execution.md`)指的都是"读 CLAUDE.md 拿上下文/doc 规范",**不涉及写里程碑**,不动。

## 3. 谁在读这张表(消费者 sweep)

按 CLAUDE.md §CLI Contract Changes (FLY-1914) 的要求做了消费者 sweep —— 虽然这不是 CLI 子命令删除,但同样是"删掉一个别人可能在消费的结构"。

sweep 时间:2026-08-24。范围与结果:

| root | 命令 | 结果 |
| -- | -- | -- |
| `scripts/` | `grep -rn 'CLAUDE\.md' scripts/` | 4 处,全是 `git diff` 的 **exclude pathspec**(`v2-retirement-cleanup.test.sh:92`、`fly1680-v1-extinction.test.sh:109`)与 FLY-1674 residue 的 **allowlist 键**(`fly1674-residue.test.sh:41-43`)。都是"忽略 CLAUDE.md"或"允许 CLAUDE.md 出现某关键词",**没有一个解析表结构** |
| `.github/` | `grep -rn 'CLAUDE\.md' .github/` | 0 处 |
| `packages/*/src` | 同上 | 全部是 prompt 文本里的"去读 CLAUDE.md",无结构解析 |
| `scripts/ci-classify.sh` | 读 inert 判定 | ⚠️ **本行原先写错,已更正** —— 见下方「§3.1 更正」 |

### 3.1 更正(Codex design review R1 #2 抓出,我已现查复核)

原稿这一行写的是「`.md` 已在 inert allowlist;CLAUDE.md 与新的 `engineering/milestones/*.md` **分类相同**,CI 跳过语义零变化」。**这句是错的。**

实测 `scripts/ci-classify.sh:51`:

```python
allowed_prefixes = (b"doc/", b"product/doc/", b"engineering/doc/", b"content/doc/")
```

inert 判定要求 **prefix 与 suffix 同时命中**。因此:

- 根目录的 `CLAUDE.md` **不在** inert 前缀内 ⇒ **今天**带里程碑行的 PR 就已经在跑全量 CI;
- `engineering/milestones/` 也**不在**前缀内 ⇒ 按原路径迁移后每个里程碑 PR 仍跑全量 CI;
- 只有落在 `engineering/doc/` 之下才是 inert。

另一条同源的错误判断:`v2-retirement-cleanup.test.sh:88-93` 与 `fly1680-v1-extinction.test.sh:104-111` 的 residue 扫描只排除 `engineering/doc/**` 与 `CLAUDE.md`。历史表里 FLY-1631 / FLY-1497 / FLY-1549 三行含 `flywheel-v2-kernel`、`v2-issue-display`、`FLYWHEEL_V2_DB_PATH` 等被禁标识符,放进 `engineering/milestones/` 会**确定性打红**这两个 guard —— 原稿「CLAUDE.md 文件仍在,所以行为不变」的推断只对 pathspec 排除成立,对被搬走的**内容**不成立。

⇒ 目标路径改为 **`engineering/doc/milestones/`**(plan.md §2.1)。

⇒ **没有任何程序消费里程碑表的结构。** 搬迁只影响人和 agent 的阅读,不破坏任何自动化。

⚠️ 三处 residue/exclude 引用要在实现时逐个复核。`fly1674-residue.test.sh:41-43` 的 allowlist 键是 `CLAUDE.md|no-three-stage` 等 —— 如果那些关键词只出现在里程碑行里,搬走之后 allowlist 会变成 stale(FLY-1455 类账目漂移)。**实现时必须实测这三个键在搬迁后是否仍命中**,不能假设(plan.md §8)。

> 原稿在这里还写过「pin 的是路径 CLAUDE.md,文件本身仍存在,所以不需要改」。这个推断只对 §3.1 说的 **pathspec 排除** 成立,对 **allowlist 键** 不成立,也对被搬走的**内容**不成立。

---

## 4. 方案对比的实测数据

沙箱脚本 `scratchpad/mergetest.sh`(5 个 case,git 2.x,同一 base 切两个分支):

```
CASE 1  现状(表顶插入)                   → CONFLICT
CASE 2  .gitattributes merge=union        → MERGED CLEAN
CASE 2b union + rebase                    → REBASE CLEAN
CASE 2c union 用在规则文件上              → MERGED CLEAN,静默保留两条互相矛盾的规则
CASE 3  per-issue 文件                    → MERGE CLEAN + REBASE CLEAN
CASE 4  追加到表底部                      → CONFLICT
```

### 4.1 CASE 4 的意义:issue 里的第三个候选被证伪

issue 原文:「新行追加到表**底部** + 定期排序(顶部插入是冲突率 100% 的写法,**底部追加只在同刻双合时冲突**)」。

**实测:底部追加同样 100% 冲突。** 机制是:两个分支从同一 base 各自在 EOF 追加 ⇒ 同一个 hunk 的两次加性修改 ⇒ 与顶部插入完全同构。"同刻"与否无关 —— git 比较的是 base 与两个 tip,不是时间。

这条要在 plan 里明确写为**已排除**,否则将来会有人拿它当"低成本折中"再试一次。

### 4.2 CASE 2c 的意义:union 对 CLAUDE.md 是危险的

union 的语义 = "冲突区两边的行都保留"。对纯加性表格正确;对**规则文本**会静默产出自相矛盾的指令,且不留任何冲突痕迹。CLAUDE.md 里有 `## Non-Negotiables` / `## Core Behaviors` / `## Codex Lead Deployment` 这些硬规则段,不能承受这个失败模式。

另外两点:

- union 是 git **内置** driver,不需要 `git config merge.union.driver`,本地 merge/rebase 都生效(CASE 2/2b 已证)。
- **GitHub 服务端计算 PR `mergeable` 时是否读取仓库 `.gitattributes` 的 merge driver,我没有验证。** 如果不读,PR 仍然 DIRTY,验收第 1 条直接不过。这是一个可以去验但没必要去赌的未知数 —— per-issue 方案不依赖任何服务端行为。

### 4.3 CASE 3 为什么是结构性的零

两个分支各新增**不同路径**的文件时,git 三方合并对这两个路径的 base 都是 "不存在",两边一个是 "不存在"、一个是 "新增",各自独立判定 ⇒ **不存在可冲突的对象**。这不是"冲突概率低",是"没有冲突这件事"。merge 与 rebase 两种形态都实测过。

---

## 5. 目标布局

> ⚠️ 本节写的是**原始草案**。最终路径按 §3.1 改为 `engineering/doc/milestones/`;是否搬走历史块由 plan.md §3 的 A/B 决定,**不默认搬**。以 plan.md 为准。

```
engineering/doc/milestones/
├── README.md                    # 格式约定 + 单写者合同 + 为什么不是一张表
├── ARCHIVE-pre-FLY-2045.md      # (仅方案 B)CLAUDE.md 里程碑块逐字节搬入,冻结
└── FLY-<NNNN>.md                # 每单一个文件,ship 时新建
```

### 5.1 单条里程碑文件格式

沿用现有表两列(Milestone / Status)的语义,展开成文件:

```markdown
# FLY-2045 — <短标题>

**Status**: ⏳ Pending ship
**PR**: #NNN
**Date**: 2026-08-24

<正文:原来写在 Milestone 列里的那一大段>
```

`Status` 允许后续单独更新(`⏳ Pending ship` → `✅ Merged (PR #NNN)`)—— 因为改的是**本 issue 自己的文件**,不与任何别的 PR 抢同一 hunk。

### 5.2 为什么历史用**一个** ARCHIVE 文件而不是拆 177 个

- 零丢失可以用 sha256 做**字节级**证明(`cd8798182939362ca374a2c837758155a9e34ef5bbf088701a60e2655c81f09b`),拆分做不到 —— 拆分要解析 177 条含大量 `|`、`**`、代码块的 markdown,任何解析 bug 都是内容损坏,而收益是零(历史块已冻结,38/40 commit 证明没人回头改它)。
- 冲突面:冻结块没人写 ⇒ 已经是零。

---

## 6. 守卫怎么放(CI 约束实测)

关键约束:**里程碑相关的回归全是 `.md` 改动;迁到 `engineering/doc/milestones/` 之后它们同时命中 inert 的 prefix 与 suffix ⇒ 重格子被跳过**(判定要 prefix+suffix 双命中,见 §3.1)。所以守卫必须放在**永远运行**的 lane 里,否则等于没放。

实测到的 CI 结构合同:

| 约束 | 出处 | 对本单的影响 |
| -- | -- | -- |
| 每个 `scripts/__tests__/*.test.sh` 必须在 `ci.yml` 里被字面枚举,或进 `ci-shell-suite-manual-only.txt` | `ci-shell-suite-enumeration.test.sh` | 新 guard 必须写进 ci.yml |
| `script-tests` 分片有**精确顺序清单** `expected_shard_tests` | `ci-structure.test.sh:682-706` | 放进 script-tests 要同步改这个清单 |
| `quick-gate` **没有**精确顺序清单,只对个别具名 step 做 exactly-once 断言 | `ci-structure.test.sh:545-578` | ✅ 放 quick-gate,加一个 step 即可 |
| quick-gate 前几步在 `pnpm install` **之前**执行 | `.github/workflows/ci.yml` quick-gate | guard 必须是**零依赖纯 bash**(与 `fly1773-delivery-semantics.test.sh` 同款) |

⇒ **结论:新增 `scripts/__tests__/fly2045-milestone-layout.test.sh`,纯 bash 零依赖,挂在 quick-gate 的 `fly1773-delivery-semantics` 之后。**

(备选的 vitest doc-sentinel 形态 —— 仿 `packages/teamlead/src/__tests__/fly1135-doc-sentinel.test.ts` —— 被否掉:它跑在 package 测试格子里,而 `.md`-only 的回归 PR 会被 inert 分类跳过该格子,守卫将对**它最该抓的那类 PR** 静默失效。)

---

## 7. 已知边界 / 未验证项(诚实登记)

1. ~~**GitHub 服务端 mergeable 计算**:…合并那一步标为 QA/ship 窗口。~~
   **已作废。** Tadashi 2026-08-25 授权本节点在一次性 base 分支上跑真实 PR 台架(永不碰 main),验收 1/3 因此是**本节点的硬完成门**,不移交。见 plan §6。
   仍成立的边界:`ci.yml` 的 `pull_request.branches` 只有 `main`,临时 base 上的 PR 不会自动触发 CI,台架必须自带 trigger(plan §6.3)。
2. **`fly1674-residue.test.sh` 的 3 个 CLAUDE.md allowlist 键**:搬迁后是否仍命中,必须实测,不能推断(见 §3 末)。
3. ~~**上下文行为变化不可测量**…~~ **已裁定 B**,本单直接消除 167 KB/session 的装载税(CLAUDE.md 178,228 B → 约 11 KB)。代价——177 条历史从「被动吸收」变成「主动读目录」——Tadashi 明确接受:「指令文件只装指令,历史要用就主动读目录」。
4. **`Active Explorations` 列表(CLAUDE.md 12–19 行)** 是同类共享写点,频率低。本单**不碰**,只在 plan 风险节点名。
