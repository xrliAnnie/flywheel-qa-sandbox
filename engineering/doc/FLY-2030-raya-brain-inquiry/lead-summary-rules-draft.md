# FLY-2030 M1-1.2 规则层段落 + 共享命令接口 — 草案
Issue: FLY-2030 (https://linear.app/geoforge3d/issue/FLY-2030/rayav2-大脑状态吸收-追问总管先行权限第一批全给)
日期: 2026-08-28
基于: summary-contract.md(路径/格式的权威在那份,本文不复制细节)

> 状态:草案,随 M1 实现 PR 落 flywheel 仓:规则段 → `packages/teamlead/lead-rules-base/`(新文件 `summary-inflow.md`,全体 Lead 装载);命令 → 形态由 implement 定(建议 `flywheel-comm summary`),**本文只钉接口合同,不写实现**。
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

## The shared command

Run: `flywheel-comm summary --project <name> [--period <start>/<end>]`
It assembles your draft skeleton, validates the contract (path prefix,
frontmatter, Judgment present, nothing executable), and opens the PR against
Raya's repo. You edit the content; the command owns the mechanics.

## What NOT to put in a summary

No secrets or tokens; no full transcripts; no other project's judgment calls
(your slice only — same discipline as the roundtable); nothing executable.
```

## 二、共享命令接口合同(implement 的验收面,非实现)

| 面 | 合同 |
|---|---|
| 调用 | `flywheel-comm summary --project <name> [--period <start>/<end>] [--dry-run]`(名字可由 implement 改,接口语义不变) |
| 输入 | 当前 Lead 身份(从既有 env/身份机制取,⛔ 不新增身份体系);period 缺省 = 上次该 Lead summary 至今 |
| 产出 | 按 summary-contract 生成骨架文件(路径/命名/frontmatter 就位,Facts/Judgment 留空由 Lead 填)→ 校验(前缀之下、frontmatter 齐、Judgment 非空、无可执行文件)→ `gh` 在 Raya 仓开 PR,PR body 带 project/period |
| 校验失败 | fail-loud 列出违反哪一条合同行;⛔ 不静默修正 |
| 凭证 | 账号级 gh token(已可行,PRD §8.8.3);⛔ 不新增凭证 |
| 幂等 | 同 period 重跑 = 更新同一个 open PR,不开第二个 |
| dry-run | 只生成与校验,不开 PR(QA 用) |

## 三、边界(决定,非遗漏)

- **不做** Lead 侧的自动内容生成(判断必须是 Lead 自己的,机器只管骨架与投递)。
- **不做** 提醒/催交机制——未交的 summary 在 Raya 侧表现为「该项目静默」,而沉默本身是一等信号(PRD §10.5);造催交器会把信号抹掉。
- CoS 与无部门的 infra bot 不在义务范围(11 个真·部门 Lead 的口径,PRD §8.8.3 的减法)。
