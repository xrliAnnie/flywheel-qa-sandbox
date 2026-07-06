# Exploration: FLY-887 status-line 真机检查载具 — FLY-896

Issue: FLY-896 (QA sandbox: FLY-887 status-line real-machine check — throwaway, safe to close) (https://linear.app/geoforge3d/issue/FLY-896)
日期: 2026-07-05
基于: 沙箱快照 `c9324ee`(分支 `project-slot-3-FLY-896`,529 Room slot 3)、FLY-895 先例(slot-2 同款载具,`d27053d` design.md)、`engineering/doc/FLY-887-phase-session-keepalive/`

## 问题定义

FLY-887(三段式 phase-session 并存保活 + founder-visibility status line)已 build 进本沙箱快照,需要一轮真机 QA 观察它的实际行为。观察需要一条**干净、无历史污染的 Discord chat thread**——所以造出 FLY-896 这个合成 issue 作为载具。

- **真正的交付物不在仓库里**:是 [FLY-896] thread 上那条**单条 in-place-edit 的三段状态行消息**(`🎨design(…)·🔨implement(…)·🧪qa(…)`)随 pipeline 各 transition 的完整叙事,由外部 QA 观察者(harness / founder)在 Discord 侧核验。
- 仓库改动刻意最小;沙箱分支/PR 用完即关,**永不合回真分支**(Lead 底线)。

## 方案选项(implement 载荷)

| 选项 | 内容 | 评价 |
|---|---|---|
| **A(选定)** | doc-only:创建 `doc/qa/sandbox-notes.md`(`## E2E run log` 节 + 一条 FLY-896 条目),单 commit + PR | FLY-895 先例已验证;状态行由 phase transition 驱动,与载荷内容无关,载荷只需真实 commit/PR 即可 |
| B | 小段代码 + 单测(qa-fly896/ 下脚本) | 多出的 TDD 面对观察目标零增益,违反"改动最小"底线 |
| C | 纯 engineering/doc 文档,implement 无独立载荷 | implement 段没有真实 commit/PR → transition 不真实,削弱观察价值 |

## Brainstorm gate 结论(Lead flywheel-test-3,已批)

1. 目的/交付物/Design 产出/Implement 合同 —— 全部按上述确认。
2. **流程裁剪批准**:Codex design review 按 FLY-895 先例 **self-approve**(doc-only 沙箱 fixture,无需真跑 `design_review --plan`);founder-UX gate 不适用(非 founder-facing 产品 UX);TDD 豁免(无运行时面,以 QA 结构检查替代)。
3. **Lead 硬性要求(QA 阶段)**:必须**真跑一轮 deliberate FAIL→wake implement→fix→RE-TEST→PASS**,让 qa 态在状态行叙事上先 FAIL 再翻 PASS——不允许只做一次性 structural PASS 收工。structural verify 维度(文件/章节/条目/句号风格)保留。

## 三段协议(FLY-887,本次即被观察对象)

Design/Implement/QA 全程共享分支 `project-slot-3-FLY-896` 单一 worktree;各段完成后按 park 协议保活(`complete --route phase_design_complete` → `park`,动 worktree 前 `turn` 自查);Bridge 在 ship 后统一收尾三段。
