# 提案:founder-only-authority.md 的「Raya 已阅回执 merge」窄口径例外 — 措辞逐字稿
Issue: FLY-2030 (https://linear.app/geoforge3d/issue/FLY-2030/rayav2-大脑状态吸收-追问总管先行权限第一批全给)
日期: 2026-08-28
基于: scope-final.md §1 1.3 + Tadashi 指令(6afa31aa 答复 ①:此件单独逐字审,不许顺手加)

> 状态:**提案,未落任何文件**。scope-final 1.3 的规则改动部分已标暂停,以本件送审为准;Tadashi 判后再定是否上 founder。
> 修订史:R1(2026-08-28)Tadashi 逐字审 = 实质通过,唯一必改:**What 判据由「summary 类(自证)」改为两条机器可核条件的合取**(自证判据与「声称我读完了」是同一个洞,PRD §12.3.4);其余逐字保留。本版 = 改后版。⛔ 在他说「可以落」之前不碰 rules 文件;落文件由他执行。

## 一、要加什么(逐字稿,英文与目标文件一致;插入位置 = R1「Reserved actions」列表之后、「Recognising a founder authorization」小节之前)

```markdown
### Narrow exemption — Raya's read-receipt merges (founder-decided 2026-08-18; FLY-2030)

The reserved actions above do NOT cover the following single, narrowly-defined
case, which the founder decided explicitly (FLY-1846 PRD v1.7 §12.3.3, narrow
scope confirmed in §12.3.4 option a):

- **Who**: the Raya cross-project chief-of-staff Lead only. No other Lead, no
  Runner, no bot inherits this exemption.
- **Where**: pull requests in Raya's OWN repositories only —
  `xrliAnnie/raya` and `xrliAnnie/raya-memory`. Never any project repo.
- **What**: a PR qualifies ONLY when BOTH of the following machine-checkable
  conditions hold — this is a **check**, not a claim (a self-asserted "this is
  a summary" would be the same hole as "I read it", PRD §12.3.4):
  1. **every** file changed by the PR lies under the fixed summary path
     prefix defined by the FLY-2030 summary contract (§1.1, e.g.
     `summaries/…`); AND
  2. the PR changes **no executable file or configuration** — no code, no
     scripts, no workflows, no dependency manifests.
  If either condition fails, this exemption does not apply and the normal R1
  prohibition stands. For a qualifying PR, **merge = the "已阅" read receipt**
  (PRD §8.8: open PR = unread, merge = read).
- **Why this is not a hole in R1**: these PRs carry no Linear issue, so the
  server-side founder-consent gate cannot even evaluate them (the evaluator is
  issue-bound — PRD §12.3.1: "对一个没有 Linear issue 的 PR,那个闸根本无法求值");
  and nothing in them ships code to any production `main` that R1 protects.
- **What this still does NOT allow** (unchanged by this exemption):
  merging any PR in any project repository; responding to `approve_to_ship`
  gates; calling any ship API; and any generalized reading of the form
  "the Lead read it, so the Lead may merge it" — the founder's own record
  warns that widening this scope "不是给总管开一个口子,是把门拆了"
  (PRD §12.3.4).
```

## 二、为什么现有条文挡住了(不加就违规)

R1「Reserved actions」的收尾条是全称禁令,逐字:

> "Any other path that causes the PR to merge into `main`, including manually responding to the `approve_to_ship` gate via `flywheel-comm respond`, **calling `gh pr merge` on the Lead side**, or any future ship API."

本合同对**每个 Lead 角色**装载;Raya 走 Lead 形态后同样装载。她对自己仓里 summary PR 执行 `gh pr merge`,在字面上正落进「calling `gh pr merge` on the Lead side」——尽管目标是她自己 summary 仓的 main、不是任何产品代码库,条文没有给这个区分留位置。⇒ 不加例外,M1 的「merge = 已阅」每一次都是违反红线合同;绕开写法(比如不用 gh、直接 push)只会更糟。PRD §12.3.1 早已把这一冲突定位在**规则层**(「改的是 rules 文件,不需要动 Bridge」,§12.3.5)。

## 三、加完之后哪些东西变成允许的(全集,恰好一条)

**新允许的动作只有一个**:Raya(仅她)对 `xrliAnnie/raya` 与 `xrliAnnie/raya-memory` 两仓里、**满足两条机器可核条件(全部改动在 summary 路径前缀下 ∧ 不改任何可执行文件/配置)**的 PR,执行 merge 作为已阅回执。

**没有变化的(明写防误读)**:任何项目仓的任何 PR 的 merge;`approve_to_ship` 门的应答;任何 ship API;其他 Lead/Runner 的任何 merge 权;「读完即可 merge」的一般化推理。执法面也没变:这个例外**删除的是一条文字禁令**,不新增任何服务端权限(那两仓的 PR 本来就进不了 issue-bound 的 consent 闸);审计面 = 两仓的 merge 历史,天然留痕。

## 附:一个被考虑过但未选的落点(一行)

把例外写进 Raya 自己的 identity 层而不动 base 合同——未选:base 合同是全体 Lead 的红线,任何一个角色悄悄持有一条别人看不见的豁免,比在 base 里具名、划死范围地写明更危险;PRD §12.3.5 指的也是改这份 rules 文件。**此判断是决定,不是遗漏;Tadashi 可推翻。**
