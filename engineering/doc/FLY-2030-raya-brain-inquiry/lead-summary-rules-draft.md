# FLY-2030 M1-1.2 规则层段落 + 共享命令接口 — 草案
Issue: FLY-2030 (https://linear.app/geoforge3d/issue/FLY-2030/rayav2-大脑状态吸收-追问总管先行权限第一批全给)
日期: 2026-08-28
基于: summary-contract.md(路径/格式的权威在那份,本文不复制细节)

> 状态:草案,随 M1 实现 PR 落 flywheel 仓:规则段 → `packages/teamlead/lead-rules-base/`(新文件 `summary-inflow.md`,**只装载给部门 Lead**——audience 由 registry-owned 谓词 `hasSummaryDuty` 定,CoS/companion/external/infra bot/Raya 本人不装载,见 plan M1-c';R2v2-1 更正旧「全体 Lead」措辞);命令 → 形态由 implement 定(建议 `flywheel-comm summary`),**本文只钉接口合同,不写实现**。
> 原则:**写一遍,11 处生效**(Tadashi 3f707089);⛔ 不许任何 Lead 各自造轮子。

## 一、规则层段落逐字稿(英文,落 `lead-rules-base/summary-inflow.md`)

```markdown
# Summary inflow to Raya (FLY-2030 M1; PRD FLY-1846 §8.8)

> Universal base rule — loaded for every department Lead. The founder decided
> this mechanism herself (PRD §8.8): each Lead periodically writes a summary
> of their project INTO Raya's repo as a PR; **open PR = unread for Raya,
> Raya's merge = her read receipt**. CoS-only and infra-bot roles without a
> department are out of scope.

## Your obligation

- Produce a summary per the cadence configured for this mechanism
  (【旋钮① 拍定后此处引用那一句】). Producing it is part of your Lead duties,
  not a favor.
- Content contract lives in Raya's repo at `summaries/README.md` — path,
  naming, frontmatter, and the **Facts + Judgment** requirement. The Judgment
  section is REQUIRED (PRD §8.8.2): an issue list alone tells the chief of
  staff nothing.
- Use the shared command (below). Do NOT hand-craft the PR flow yourself, do
  NOT push directly to Raya's default branch, do NOT merge your own summary
  PR — the merge is Raya's read receipt, not yours.
- **The ONLY exception anywhere in this mechanism is Raya's own read-receipt
  merge**, defined in `founder-only-authority.md` → "Narrow exemption —
  Raya's read-receipt merges": it applies to Raya alone, in her two repos
  alone, and only to PRs passing that exemption's two machine-checkable
  conditions. **No other Lead may invoke that exemption**; these two rules
  are two faces of the same founder decision (PRD §12.3.3/.4), not a
  conflict.

## The shared command

Write your summary in a file yourself (the command can print a template to
stdout to start from), then run:

    flywheel-comm summary --file <your-summary.md> --project <name> --period <start>/<end>

The command owns ONLY the mechanics: target naming, contract validation
(path prefix, frontmatter, **non-empty Judgment**, nothing executable), and
opening/updating the PR against Raya's repo via `gh`. **The Judgment must be
yours, written by you into the file** — the command never generates it.
Re-running with the same `{project, author, period}` updates the same open PR.

## What NOT to put in a summary

No secrets or tokens; no full transcripts; no other project's judgment calls
(your slice only — same discipline as the roundtable); nothing executable.
```

## 二、共享命令接口合同(implement 的验收面,非实现)

| 面 | 合同(R1v2-5 修订版:作者协议 = `--file`,Lead 亲笔) |
|---|---|
| 调用 | `flywheel-comm summary --file <Lead 亲笔的.md> --project <name> --period <start>/<end> [--dry-run]`(名字可由 implement 改,语义不变);`--template` 只打印模板到 stdout,不写任何文件 |
| 输入 | 当前 Lead 身份(既有 env/身份机制,⛔ 不新增身份体系)+ **Lead 自己写好的内容文件**——命令不生成 Judgment,只校验它非空 |
| 产出 | 定目标名(合同的路径/命名)→ 校验(前缀之下、frontmatter 齐、Judgment 非空、无可执行文件含兜底口径)→ `gh` 在 Raya 仓开/更新 PR,PR body 带 project/period |
| 校验失败 | fail-loud 列出违反哪一条合同行;⛔ 不静默修正 |
| 凭证 | 账号级 gh token(已可行,PRD §8.8.3);⛔ 不新增凭证 |
| 幂等 | key = `{project, author, period}`:同 key 且 PR 仍 open → 更新同一 PR;**PR 已 merge 后同 key 重跑 → fail-loud 或显式 next-seq 更正**;并发创建 → fail-loud |
| dry-run | **不写 fs/git/gh 任何一处**,只校验并打印 canonical plan(QA 用) |
| merge 侧 | 作者侧校验**不授权** merge——Raya merge 前另有只读 verifier 对 PR **当前 head** 全量核对并输出 verified SHA,merge 必须 `gh pr merge --match-head-commit <sha>`(见 plan M1-d';防校验后追加文件的 TOCTOU) |

## 三、边界(决定,非遗漏)

- **不做** Lead 侧的自动内容生成(判断必须是 Lead 自己的,机器只管骨架与投递)。
- **不做** 提醒/催交机制(**决定,不是遗漏**)——一个 Lead 那周没写 summary,**本身就是信息**(没进展,或被别的事吃掉了);装上催交器之后,收到的每一份 summary 都可能只是被催出来的,**从此再也分不出「有话说」和「被催了」**——把一个信号变成噪声的典型形状(PRD §10.5「沉默=一等信号」;理由经 Tadashi 2026-08-28 加硬)。
- CoS 与无部门的 infra bot 不在义务范围(11 个真·部门 Lead 的口径,PRD §8.8.3 的减法)。
