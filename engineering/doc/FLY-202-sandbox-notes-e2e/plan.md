# Plan: 重建 doc/qa/sandbox-notes.md + PR — FLY-202（slot-2 E2E 轮）

**Issue**: FLY-202 — https://linear.app/geoforge3d/issue/FLY-202/qa-sandbox-fixture-slot-harness-real-runner-e2e-task-do-not-pick-up
**Date**: 2026-07-19
**基于**: 同文件夹 `exploration.md` + `research.md`（事实以 research 实测为准）

---

## 总则

- 分支：直接用 `project-slot-2-FLY-202`（= 本轮 feature branch，见 research §1），不另建。
- 全部写操作限于沙箱 clone；不碰 `packages/` 代码;不 merge PR。
- 提交序：C1–C4 可合为一个 docs commit（产物是同一个文件的四个 section），C5/C6 是
  push + PR。中途每完成一个 chunk 更新 progress ledger。
- 文档语言跟随仓库现状：sandbox-notes.md 用英文（历史 #29/#30 版本为英文，读者含 CI/QA 脚本）。

## Chunks（implement 段的执行合同）

### C1 — 新建 `doc/qa/sandbox-notes.md`：用途说明（2-3 段）
- 内容要点：① flywheel-qa-sandbox 是 Flywheel test-slot E2E harness（FLY-96/FLY-115）
  的**靶仓库**——真 Runner 在隔离 clone 里跑完整 pipeline 而不碰生产 repo；
  ② 它是生产 flywheel 仓库的结构镜像（packages/、doc/ 等同构），使 E2E 行为逼真；
  ③ 本文件本身就是 FLY-202 fixture 任务的产物，每轮 E2E 重建/刷新。
- 验收：文件存在；恰有 2-3 段;首行 `# ` 标题。

### C2 — 追加顶层目录表
- **只收目录**（12 个，见 research §3；杂散文件 `=` 与其它顶层文件不进表）。
- 用 `find . -maxdepth 1 -type d`（或逐项 `[ -d ]`）现场重测，不照抄 research——
  防 tip 变动。每行:目录名 + 一行英文描述。
- 验收：Markdown 表含 12 行数据（若现场重测数目不同，以现场为准并在 PR body 说明）。

### C3 — 追加 qa-framework README 摘要（~10 bullets）
- **通读** `packages/qa-framework/README.md`（316 行）后归纳;覆盖主要 section：
  Architecture / Quick Start / 5-Step Protocol / Config Schema / Test Slot Framework
  (FLY-115) / FLY-60 hard-gate suite / Mirror Mode (FLY-153)。
- 验收：8–12 条 bullet；每条一行。

### C4 — 附 `ls -R doc/ | head -50` 输出
- 在 C1 写盘**之后**执行（输出应含新建的 sandbox-notes.md，见 research §4），
  原样贴进 ```text fenced block，命令行本身注明。
- 验收：fenced block 存在，内容为真实命令输出（QA 段可重跑比对）。

### C5 — commit + push
- `git add doc/qa/sandbox-notes.md` + 本设计文件夹（若有未提交增量）;
  commit message：`docs(FLY-202): recreate QA sandbox notes — slot-2 real-Runner E2E`。
- `git push -u origin project-slot-2-FLY-202`。
- 验收：`git status` clean;远端分支存在。

### C6 — 开 PR（不 merge）
- `gh pr create` → base `main`（flywheel-qa-sandbox）;标题同 commit 主题。
- body 含：`## Linear Issue`（FLY-202 + URL）、变更摘要、test plan
  （复述 C1–C4 验收 + 「QA 段将重跑 step 4 命令比对」）、
  尾注 `🤖 Generated with [Claude Code](https://claude.com/claude-code)`。
- **到此为止**：不 merge、不 approve;ship 由 founder gate 决定。implement 节点按其
  dispatch 的 route 收尾并回报 PR URL。
- 验收：PR URL 可访问,base=main,head=project-slot-2-FLY-202。

## 风险与对策

| 风险 | 对策 |
|---|---|
| tip 在 implement 前变动（harness 重置） | C2/C4 现场重测;research 仅作参照 |
| `doc/qa/sandbox-notes.md` 意外已存在 | 视为刷新（#30 先例）:整文件重写,PR body 注明 |
| push 权限/网络失败 | 重试一次;仍失败 → `flywheel-comm ask` 上报 Lead,不静默 |
| PR 与历史同名 PR 混淆 | 标题带 slot-2 字样 + body 引用本轮 exec 579f84aa |

## QA 段可验证断言（handoff to QA node）

1. `doc/qa/sandbox-notes.md` 存在且四个 section 齐全（用途/目录表/README摘要/ls输出）。
2. 目录表行数 == 现场 `find . -maxdepth 1 -type d | grep -v '^\.$' | wc -l`。
3. 重跑 `ls -R doc/ | head -50` 与文内 fenced block 一致（允许因后续 commit 产生的
   本文件夹新增行差异,须逐行解释）。
4. PR open、base=main、未 merge。
