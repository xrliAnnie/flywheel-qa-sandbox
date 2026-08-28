# FLY-2030 M1-1.1 summary 存放合同 — 草案(落 Raya 仓 `summaries/README.md` 的逐字稿)
Issue: FLY-2030 (https://linear.app/geoforge3d/issue/FLY-2030/rayav2-大脑状态吸收-追问总管先行权限第一批全给)
日期: 2026-08-28
基于: scope-final.md §1 1.1 + Tadashi「继续 scope-final 其余部分」(05cf0960 答复)

> 状态:草案,随 M1 实现 PR 落进 `xrliAnnie/raya` 仓的 `summaries/README.md`。
> 🔴 **固定前缀就此定死:`summaries/`** —— 它同时是 founder-only-authority 例外条款条 1 要逐字填入的那个前缀(exemption-proposal 条 1)。
> ⚠️ 两处标 【旋钮】 的地方依赖 founder 未拍的频率/粒度,两个变体都写死了形状,拍完删一个,⛔ 不许实现方自选。

## 一、逐字稿(英文,落 `summaries/README.md`)

```markdown
# Summary inflow contract (FLY-2030 M1; PRD FLY-1846 §8.8)

Leads write summaries INTO this repo as pull requests. Raya reads them here.
**open PR = unread · merge = read receipt** (the founder's own mechanism, PRD §8.8).

## Path & naming — the single fixed prefix is `summaries/`

Every summary file lives under `summaries/` and ONLY there:

    summaries/<project>/<YYYY-MM-DD>--<leadId>--<seq>.md
    (【旋钮②=B 按项目聚合 时改为】 summaries/<project>/<YYYY-MM-DD>--<seq>.md, authored by that project's aggregating Lead)

- `<project>`: the `projectName` from the projects registry, verbatim.
- `<YYYY-MM-DD>`: the period's end date, founder-local time.
- `<seq>`: 2-digit counter within the same day (`01`, `02`, …) so multiple
  summaries on one day never collide.
- One PR SHOULD carry exactly one summary file (granularity of the read
  receipt = granularity of the merge).

A summary PR MUST NOT touch anything outside `summaries/`, and MUST NOT add
any executable file or configuration (no code, scripts, workflows, dependency
manifests — anything that is executable or affects build/runtime behavior is
not a summary). PRs violating either rule do not qualify for Raya's
read-receipt merge and will sit until a human looks.

## File format

    ---
    project: <projectName>
    lead: <leadId>
    period: <ISO start>/<ISO end>
    ---
    ## Facts
    (what actually happened this period: shipped / merged / blocked / silent.
     Reference issues and PRs by id so claims are checkable.)

    ## Judgment
    (REQUIRED, not optional — PRD §8.8.2, the founder's words: issue lists
     alone leave the chief of staff with no concept of what happened.
     What does this period MEAN for the project: on track? drifting? stuck?
     what deserves Annie's or Raya's attention?)

A summary missing the Judgment section is incomplete; Raya will not treat it
as read material and will ask the Lead for the judgment instead of guessing.

## Cadence

【旋钮① 待 founder 拍,两变体:A 定时(默认挂各 Lead 的既有节奏,如每 6h/每日)
/ B 各 Lead 收工时(事件驱动)。拍完此节写成一句话。】

## What this is NOT

- Not a status form: no filling tables for their own sake (PRD §6.4).
- Not a transcript archive: distilled facts + judgment, not logs.
- Not a place for secrets: no tokens, no credentials, no private founder text.
```

## 二、合同外的三条工程注记(不进 README)

1. **前缀与例外条款的绑定**(与 plan §2.1 同口径,R2v2-2 更正:两处在**不同仓**,不可能同一 PR):随 **M1 成对 PR** 落——raya PR(本合同)与 flywheel PR(例外条款+validator)互链并钉 exact head;merge 前**必过机械门**从两个 head 读三处 canonical prefix(本 README、founder-only-authority 条 1、validator 常量),机器断言均且只均为字节串 `summaries/`,证据留 PR;顺序先 raya 后 flywheel,第二步失败不激活。⛔ 人工对拍不算门。
2. **Belle**:按 1.4 实核,personal-assistant 已是 git 仓(remote = belle-workspace),belle-lead 走同一合同;implement 前终核一次,若形态又变才按 PRD「不许假装六个仓都在」另开通路(这是决定过的不预建,非遗漏)。
3. **`<seq>` 的存在理由**:粒度/频率两旋钮无论怎么拍,同日多文件都可能出现(补写、更正);不靠时间戳到秒是为了文件名可读、diff 可读。
