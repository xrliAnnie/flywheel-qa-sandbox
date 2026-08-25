# FLY-2046 PR #947 exact head `c45f3645d` 独立复核 — QA 报告

Issue: FLY-2046 (https://linear.app/geoforge3d/issue/FLY-2046/qafly-2045-独立复核-pr-947-exact-head-c45f3645d-验收全链)
日期: 2026-08-25
基于: 无(独立 QA,入口为 PR #947 的 `engineering/doc/FLY-2045-milestone-table-conflict/acceptance-evidence.md`)

## Verdict

**PASS** — 六条必做项全部 PASS,零 BLOCKER。

另有 2 条**非阻塞**的文字准确性问题(见 §7),都在 PR body 里,**不涉及代码、守卫或验收结论**。

## 复核方式(先声明我的隔离姿态)

- **全程只读**,没有 push、没有 checkout `flywheel-FLY-2045`、没有碰任何 remote ref。
- 被测 head 用 `git fetch origin pull/947/head` 取到本地只读 ref;
  需要真跑脚本的部分建了一个**一次性隔离 clone**
  (`scratchpad/pinrig`,origin 指向 GitHub,detached 在 `c45f3645d`),
  变异全部在这个 clone 里做、逐条还原并 `git diff --quiet` 验证还原干净。
- 凡是「作者报告说 X」的地方,我尽量换一条**不依赖那份报告**的证据路径,§4 是最典型的一处。

---

## 1. exact-head CI — PASS

`run 32861053406`:

```
conclusion=success  event=pull_request  status=completed  run_attempt=1
headSha=c45f3645d0f1a9d5e3b87e00c269260599ab2364   headBranch=flywheel-FLY-2045
created 2026-08-25T14:41:12Z  updated 14:57:11Z
```

- **该 head 上的全集只有这一个 run**
  (`GET /actions/runs?head_sha=c45f3645d...` 返回 1 条,attempt=1)
  —— 没有「先红一次再 rerun 洗绿」的情况。
- **11 个 job 全 success,逐 job 核过**:

| job | 结果 | steps | 非 skipped | runner | 时长 |
| -- | -- | -- | -- | -- | -- |
| Classify CI scope | success | 5 | 5 | GitHub Actions 1000054514 | 15s |
| Quick Gate (build + typecheck + lint) | success | 20 | 20 | …515 | 3m33s |
| NPM payload distribution | success | 21 | 21 | …516 | 1m02s |
| Script Tests 1/2 — cmux/session | success | 34 | 34 | …517 | 14m56s |
| Script Tests 2/2 — fleet/setup/packaging | success | 64 | 64 | …521 | 13m30s |
| Unit (light) | success | 15 | 14 | …522 | 3m33s |
| Unit (heavy) | success | 15 | 14 | …519 | 7m45s |
| Unit (teamlead 1 of 3) | success | 15 | 15 | …523 | 6m30s |
| Unit (teamlead 2 of 3) | success | 15 | 14 | …520 | 5m48s |
| Unit (teamlead 3 of 3) | success | 15 | 14 | …518 | 6m49s |
| CI OK | success | 3 | 3 | …526 | 4s |

  11 个**互不相同的真 GitHub-hosted runner**,step 列表非空,时长真实(最长 15 分钟)。
- **重点排除「被 classifier 跳过所以假绿」**:classify job 日志实测
  `ci-classify: fail-closed: diff_not_inert` ⇒ `no_code=false`,
  所以 `unit-tests` / `script-tests` 的 `if: no_code != 'true'` 全部成立,heavy job 是**真跑的**。

## 2. 零丢失 pin 链 — PASS(我自己复跑 + 独立复算 + 三条阳性对照)

**复跑**(隔离 clone,detached 在 `c45f3645d`):

```
$ bash scripts/fly2045-pin-archive.sh --check-only --source-sha 5a8fe51bf…
source 5a8fe51bf: lines 39..224, 177 ledger rows, 167009 bytes
  sha256 cd8798182939362ca374a2c837758155a9e34ef5bbf088701a60e2655c81f09b
archive matches the source block byte for byte
check-only: guard pins match the source
EXIT=0
```

**逐字对上 evidence 的三个 pin**:177 行 / 167009 字节 / `cd879818…`。

**不用它的脚本再独立算一次**(直接从 `origin/main:CLAUDE.md` 抽 39..224 与 archive 哨兵之间比对):

```
src  167009 bytes / 186 lines   sha256 cd879818…f09b
cand 167009 bytes / 186 lines   sha256 cd879818…f09b
cmp: byte-identical
```

- 块内 186 行 = 1 表头 + 1 分隔行 + 177 账本行 + 7 空行;
  `grep -nvE '^\| '` 只捞出分隔行一条,**块内没有混进非账本内容**(over-capture 为零)。
- **under-capture 也自己验了**:整份 `origin/main:CLAUDE.md` 里账本形状的行 = **177**,
  块内 = **177** ⇒ 块外零遗漏,不存在「表被截断、后半段静默丢失」。
- PR head 的 `CLAUDE.md`:milestone 表头 **0** 个、`FLY-/GEO-` 账本行 **0** 条,
  文件 178,228 → **11,792 字节** ⇒ 确实搬净了。

**「权威=source 非 candidate」是行为验的,不是读注释**:

| 阳性对照 | 结果 |
| -- | -- |
| 删掉 archive 里的一条真行(`FLY-2014`) | 脚本 **FATAL**「archive does not match the source block byte for byte … refusing to write pins」;layout guard 同时 **30 PASS / 2 FAIL** |
| 传一个陈旧 SHA(`978e085eb…`) | **FATAL: source SHA is not current origin/main** |
| 传 implementation_sha(真实但非 main) | **FATAL: source SHA is not current origin/main** |

⇒ 尺子会红,而且**先证明 source 身份、再从 source 派生 pin**,不存在拿搬完的结果给自己盖章。

## 3. 交付 diff 纯净 — PASS

**a) `ci.yml` 对 main 的 diff 只有 quick-gate 一步:**

```
+      # FLY-2045: the milestone ledger must stay out of CLAUDE.md. …
+      - name: Enforce FLY-2045 milestone layout
+        run: bash scripts/__tests__/fly2045-milestone-layout.test.sh
+
```
7 行、一个 step,**没有台架的 `pull_request.branches` 扩写**。
两侧 `on:` 块逐字相同,head 与 main 都是 `pull_request: branches: [main]`。

**b) 台架零残留:**

```
$ git ls-remote origin | grep -i fly2045   → (零命中,不限于 refs/heads)
$ git ls-remote origin refs/heads/main     → 5a8fe51bf
$ git ls-remote origin refs/heads/flywheel-FLY-2045 → c45f3645d
```

**c) main 未被本单动过 —— 不止看 SHA,还查了可达性:**
rig commit `c02953804`、两个 merge commit `18190825d` / `d36b0a370`、
两条探针 head `876b02d41` / `8d4e1fc77`,
`git merge-base --is-ancestor <c> origin/main` **五条全部 not-on-main**;
main tip 仍是 `5a8fe51bf FLY-2037 (#944)`。

**d) 台架与实现的绑定我也复核了**(evidence 自己立的失效条件):
`c02953804^ == 25e072c768b176a3e148b40190f8f4d78d67358b` **精确等于 implementation_sha**;
该 rig commit 的**唯一** diff 是 `ci.yml` 一行;
`25e072c76` 是 PR head 的祖先,且

```
$ git diff --stat 25e072c76 c45f3645d
 acceptance-evidence.md | 209 +++++
 progress.md            |  11 +-
```

⇒ code review APPROVED 之后**只加了证据文件**,没有任何 guard / writer / layout / workflow 实现改动
⇒ evidence 的失效条件**未触发**。

## 4. 验收证据可信度 — PASS(这一条我换了证据路径)

**PR 终态与 GitHub 实况完全一致:**

| PR | 实况 | base | head | evidence 记的 head |
| -- | -- | -- | -- | -- |
| #948 | **MERGED** `18190825d` | `fly2045-accept-base` | `876b02d41` | `876b02d41` ✅ |
| #949 | **CLOSED** | `fly2045-accept-base` | `c455218a3` | `c455218a3`(步骤5)✅ |
| #950 | **MERGED** `d36b0a370` | `fly2045-control-base` | `9e4b14f45` | `9e4b14f45` ✅ |
| #951 | **CLOSED** | `fly2045-control-base` | `8d4e1fc77` | `8d4e1fc77` ✅ |

**四个 base 没有一个是 `main`** ⇒ 边界 ② 成立(与 §3c 的可达性检查互相印证)。

⚠️ **一个必须说清的取证限制:** base 分支已删,所以**现在** GitHub 对这四个 PR **一律**返回
`CONFLICTING / DIRTY` —— 那个关键的反向对照**已经无法再通过 API 原样复测**。
照抄 evidence 里那两行等于「作者说什么就是什么」。所以我**从 git 对象自己重建了这次对照**:

```
# 旧机制:控制 base 合掉 #950 之后 × #951 head
$ git merge-tree --write-tree d36b0a370 8d4e1fc77
rc=1  CONFLICT (content): Merge conflict in CLAUDE.md      ← 真冲突,三方 stage 都在

# 新机制:accept base 合掉 #948 之后 × #949 head
$ git merge-tree --write-tree 18190825d e96d7caab   → rc=0  (步骤4 的那个 head)
$ git merge-tree --write-tree 18190825d c455218a3   → rc=0  (步骤5 推完 QA 报告的 head)
```

⇒ **反向对照真实成立**:旧机制在 `CLAUDE.md` 上真冲突,新机制两个 head 都干净合并。
这不是转述 evidence,是**从提交对象独立重算**的。

探针内容也核过,和声称的机制一致:
#948/#949 加 `engineering/doc/milestones/FLY-9101.md` 与 `…/FLY-9102-probe/qa-report.md`(不同路径,无可冲突对象);
#950/#951 各在 `CLAUDE.md` 加 **1 行**(同位置,必冲突)。

验收第 ③ 条也复核了:`run 32859585210` = `success / pull_request / fly2045-probe-9102 / c455218a3`
⇒ 新 head **确实有自己的 exact-head run**,不是只看 mergeable。

## 5. 守卫真会红 — PASS(抽了 5 条,其中 4 条是我自己出的变异)

干净基线:`fly2045-milestone-layout` **32 PASS / 0 FAIL**;`ci-structure` **PASS**。

| # | 变异(我自己设计,非照抄 evidence) | 声明应该红哪一项 | 实测 |
| -- | -- | -- | -- |
| M1 | 往 `CLAUDE.md` 重新塞回一个里程碑表 + 一条账本行(**这单存在的意义就是拦它**) | layout guard | **30 PASS / 2 FAIL** ✅ |
| M2 | 从 archive 删掉一条真行 | layout guard + pin 链 | guard **30/2 FAIL**;pin **FATAL 拒绝盖章** ✅ |
| M5 | `ci.yml` 里删掉 FLY-2045 那个 step | `ci-structure` | **FAIL: quick-gate must contain exactly one FLY-2045 milestone layout step** ✅ |
| M6 | **保留** step 但从 quick-gate **搬进 `script-tests` 分片**(更阴的一种绕法) | `ci-structure` | **FAIL**(同上)✅ |
| M7 | 给 step 加 `if: github.event_name == 'push'` | `ci-structure` | **FAIL: … must not be conditional** ✅ |
| M8 | 给 step 加 `continue-on-error: true` | `ci-structure` | **FAIL: … must fail closed** ✅ |

> 过程记录:M6 我第一次写的 python 变异脚本在 `assert` 处提前抛错、**文件根本没被改**,
> 于是 guard 报了个 PASS —— 那是**空过绿**,不是「守卫漏了」。我给变异脚本加了
> 「不改成功就明说 VACUOUS」的自检后重跑,三条才真红。这条写在这里是因为我是当场发现的,
> 不是拿到结果再解释。

作者自带的变异 harness 我也整跑了一遍作交叉:
`fly2045-milestone-layout-mutations` **27 fixtures 全部 held(PASSED=27 / FAILED=0)**,
含 GEO 正向 fixture(合法形状不许误红)与 checksum fail-closed。

顺带跑通的相邻门:`fly1674-residue` **59/59**;
`ci-shell-suite-enumeration` **216 suites 全分类(163 CI / 53 manual-only)**,
新的 mutations harness 已登记进 `ci-shell-suite-manual-only.txt`。

## 6. 披露复核 — PASS(结论成立;其中一条的**举证写错了**)

**a) `v2-retirement-cleanup` —— 双向对照,确认是既有 baseline red,不是本单引入。**

```
在 PR head c45f3645d:   PASSED=4 FAILED=1
在 origin/main 5a8fe51bf: PASSED=4 FAILED=1     ← 同一失败签名
失败项两边逐字相同:
  FAIL: hermetic Lead dry-run failed or emitted retired v2 MCP config (rc=1)
  [lead] companion role detection inconclusive (state='error') for test/test-lead.
```

⇒ **实测两边一模一样**,本单没有引入它。
（一处口径修正:它在我这里**不是间歇性**,两次都是确定性地 4/1;PR body 写的是
「既有 baseline red」,那个说法更准。）

⚠️ **但支撑这条披露的那句话是错的**,见 §7-F2。

**b) `pnpm test:packages:run` 的 3 个失败 —— 说法成立,而且有比「本地隔离重跑」更强的证据。**

- 结构上:`git diff --name-only origin/main...HEAD` 里
  **`.ts` 文件 0 个、`packages/` 文件 0 个**;
  `git diff --name-only origin/main...HEAD -- packages/ pnpm-lock.yaml package.json` **为空**。
  ⇒ 一个只动 Markdown + shell 的 diff **不可能**改变 TypeScript 测试结果。
- 更强的一条:被点名的三个测试(`verify-report` / `qa-result.realgit` / `founder-review`)
  **都在 `packages/flywheel-comm`**,而 exact-head CI 的
  **`Unit (heavy)` = `pnpm --filter flywheel-claude-runner --filter flywheel-comm --filter flywheel-edge-worker test:run`**
  在干净环境里跑了 7m45s、**success**。
  ⇒ 那三个失败在 CI 上不复现,本地是并发负载产物,**不影响本单判定**。
- **诚实边界**:我**没有**在本机重跑那三个文件。理由是它们分别要真 Chrome 和**真 git push**,
  而我这一节的授权是只读复核 —— 为了确认一句已被 CI 绿和 diff 空集双重证明的话去触发真实 push,
  代价与收益不成比例。上面两条是我实际用的证据路径。

## 7. 发现(非阻塞,全部在 PR body 文字里,**本单引入**)

**F2(值得修)** —— PR body 的既有-red 披露写着:

> `git diff origin/main...HEAD -- scripts/ packages/` 为空

**这句是错的。** 实测该命令返回 **6 个文件**:

```
scripts/__tests__/ci-shell-suite-manual-only.txt
scripts/__tests__/ci-structure.test.sh
scripts/__tests__/fly1674-residue.test.sh
scripts/__tests__/fly2045-milestone-layout-mutations.test.sh
scripts/__tests__/fly2045-milestone-layout.test.sh
scripts/fly2045-pin-archive.sh
```

真正为空的是 **`-- packages/`** 那一半(我实测确认),而承重的也正是这一半。
所以**结论没错、举证写错了**:多写的 `scripts/` 让这句从「真」变成「假」。
我用 §6a 的双向对照独立把结论顶住了,但 PR body 那句应该改成 `-- packages/`,
否则下一个读的人按原句一验就会以为整条披露不可信。
**归类:本单引入(纯文字)。不阻塞 ship,建议 ship 前顺手改一句。**

**F1(小)** —— PR body 的 Test plan 表格里两个数字是旧的:

| 项 | PR body 写 | head 上实测 |
| -- | -- | -- |
| `fly2045-milestone-layout.test.sh` | 27/27 | **32/32** |
| `fly2045-milestone-layout-mutations.test.sh` | 21/21 | **27/27** |

方向是**低报**(实际测得更多),不误导安全性,但和交付 head 对不上。

**F3(不是缺陷,是取证限制,记下来给后人)** —— 四个探针 PR 的 base 分支已删,
GitHub 现在对它们**一律**报 `CONFLICTING/DIRTY`。
也就是说 evidence 里最关键的那格反向对照(#951 DIRTY vs #949 CLEAN)
**再也无法通过 API 原样复测**。谁要复核这条,得走 §4 的 `git merge-tree` 重建路径
(merge commit `18190825d` / `d36b0a370` 目前仍可按 SHA `git fetch` 到)。

## 8. 顺带核到的一条 ship 前置(不在我 6 条里,但 Lead 需要知道)

PR body 自己声明的 cutover 阶段一/阶段二,**当前实况与它写的完全一致**:
现在仍有 **7 个 open PR 在改 `CLAUDE.md`** ——
`#946 #943 #941`(活跃)、`#772 #343 #338`(陈旧)、`#216`(整表刷新,解法不同)。
本单落地后它们会 modify/delete 冲突(这是**机制**,不是承诺,§4 的 merge-tree 已证同类形状会真冲突)。
PR body 说「全部完成前 FLY-2045 不算 Done」,这一点**没有被本次 QA 推翻**,
但它是 ship 之后的排期项,不是本 PR 的缺陷。

## 9. 验收边界(我做了什么、没做什么)

| | |
| -- | -- |
| 做了 | exact-head CI 逐 job(含 runner 身份 / step 非空 / classifier 未跳过)、pin 链复跑 + 脚本外独立复算 + 3 条 fail-closed 对照、`ci.yml`/ref/main 可达性三重纯净核查、台架-实现绑定核查、**从 git 对象独立重建反向对照**、5 条自出变异 + 27 条作者变异、`v2-retirement` 双向对照 |
| 没做 | 没本地重跑那三个 package 测试(要真 Chrome / 真 git push,见 §6b);没重测已删 base 的 live mergeable(物理不可得,见 F3);没有 push / 没有 checkout `flywheel-FLY-2045` / 没碰任何 remote ref |
