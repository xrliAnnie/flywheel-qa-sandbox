# Summary inflow to Raya (FLY-2030 M1; PRD FLY-1846 §8.8)

> Assignment-gated base rule. This file is loaded only when the canonical Lead
> identity projection says `FLYWHEEL_LEAD_HAS_SUMMARY_DUTY=1`. The founder
> decided the mechanism herself: each assigned Lead periodically writes a
> summary of their project INTO Raya's repo as a PR; **open PR = unread for
> Raya, Raya's merge = her read receipt**.

## Your obligation

- Produce a summary at the cadence configured for this mechanism. The cadence
  is delivered to you by `[summary_due]`; do not invent one or add your own
  reminders. Producing the summary when due is part of your Lead duties, not a
  favor.
- The content contract lives in Raya's repo at `summaries/README.md`. Follow its
  path, naming, frontmatter, and **Facts + Judgment** requirements. Judgment is
  REQUIRED: an issue list alone does not tell the chief of staff what happened.
- Use the shared command below. Do not hand-craft the PR flow, push directly to
  Raya's default branch, or merge your own summary PR. The merge is Raya's read
  receipt, not yours.
- Raya 代码 PR 的合入不等于部署；定时班车通过公共 standard Lead 完成生产
  checkout、`flywheel-lead.sh verify`、文字与 summary 验收后写入
  `~/.flywheel/raya/deploy-receipt.json`。只有绑定两仓 SHA 的
  `schemaVersion:2`、`carrier:standard-lead` 回执可作为上线证据；Done 条件见
  `founder-only-authority.md` 的 R1。
- The ONLY exception in this mechanism is Raya's own read-receipt merge, defined
  in `founder-only-authority.md` under “Narrow exemption — Raya's read-receipt
  merges.” It applies to Raya alone, in her two repos alone, and only to PRs
  passing both machine-checkable conditions. No other Lead may invoke it.

## The due signal (FLY-2382)

- Bridge delivers `[summary_due]` at the founder-owned cadence. When it arrives,
  write the summary and 原样使用事件里的 `--period`; the mechanism recognizes a
  delivery for this round only through that exact period.
- If this period has no new Facts or Judgment, 可以不交 (PRD §6.3). The backend
  reconciliation ledger still records that outcome, but no missing-delivery list
  is shown to the founder. Do not manufacture content merely to fill a period.
- `[summary_due]` is the 唯一的节奏来源. Do not create a local timer, cron,
  launchd job, or another reminder for summary delivery.
- FLY-2634: Bridge 只在本 period 观测到 founder 消息、@你的派活消息、业务事件或
  Linear 变动时才发 `[summary_due]`。没收到不是投递故障，也不是职责被取消；下一
  period 只要有事就会再叫。
- 收到时只写增量：没变的暂停/阻塞不复述；摘要 PR 本身、Raya 对摘要的审阅提问、
  本机制的对账不算本 period 的事实。「有 Runner 跑过」「有 commit」本身也不是
  增量，增量是它们带来的新成果、新决定、新阻塞或阻塞解除。
- 一次性请求（例如项目全景基线）由发起方的消息触发并用它给的 period，与节奏
  无关，也不产生周期义务。

## The shared command

Write the summary file yourself (the command may print a template to stdout),
then run:

    flywheel-comm summary --file <your-summary.md> --project <name> --period <start>/<end>

The command owns only mechanics: target naming, contract validation, and opening
or updating the PR in Raya's repo. You own the Judgment and must write it into
the input file; the command never generates it. Re-running the same
`{project, author, period}` updates the same open PR.

## What not to put in a summary

No secrets or tokens; no full transcripts; no other project's judgment calls;
nothing executable or capable of affecting build/runtime behavior.
