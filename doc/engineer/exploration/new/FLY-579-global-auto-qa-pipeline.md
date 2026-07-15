# Exploration: 全局自动 QA 流水线 — FLY-579

**Issue**: FLY-579 ([pipeline] 代码+review 全过后自动 spawn 独立 QA session 做 E2E → 过了才通知 founder（结构性、全项目）)
**Date**: 2026-06-26
**Status**: Draft（vision 待 Annie 确认；plan / design-review / 实现 HOLD）

## 背景与来源

Annie（2026-06-25）现状痛点：流程跑到 `Code Review` 后，Lead 来问 founder「要不要 ship」，founder 几乎总是回「你先开一个 parallel QA 测、过了再来」。她要**去掉「Lead 问 / founder 答」这一环**、把它**自动化固定下来**。

Annie 原话：『在跑完之前所有的流程、代码都做好之后，它会自动 spawn 另一个 QA session（这个 QA 和原来的 session 不能是同一个）去做 End-to-End 测试。测试做完之后，你再来找我……我永远是等你们所有东西都 implement 好了，QA 也测过了，你才来找我。』

**方向转向（Tadashi 转达 Annie，2026-06-26）**：不是 flywheel 单仓的窄实现，而是 **GLOBAL 机制** —— 所有用 Flywheel 的项目（flywheel / GeoForge3D / growth / tidal-echo …）都套同一套 Design → Implement → CodeReview → QA 自动流水线，整个运行尽量全自动。本 runner（Jonah）own 这件事。

## 核心洞察

Flywheel 的流水线**本来就是全局的**。每个 issue：Runner spawn → stages：onboard → brainstorm(gate) → research → plan → design_review(Codex) → implement(TDD) → test → code_review(Codex) → pr_created → approve gate → ship。Bridge **已经**会对 `stage_changed` 自动触发动作（`design_review` / `pr_created` 自动触发 Codex review，见 `handleCodexAutoTrigger`）。Gate（brainstorm / approve_to_ship）与 founder-only-authority（merge/ship）都已是跨项目 config。

所以本 issue **不是从零造流水线**，而是两件事：
1. 把**缺失的 QA 段**也变成自动的 —— 用同一个「Bridge 对 stage 钩子自动触发」模式。
2. 让 **founder 的 ship 通知**挪到 QA 过之后。

## 框架：3 个结构性增量（全部跨项目，住在 Bridge pipeline，不靠 Lead 记得 / 不靠每个项目改 prompt）

### A. QA 作为自动流水线段
main Runner 跑到「代码+review 全过」时，Bridge 自动派一个**独立** QA Runner：不同 session、`sessionRole=qa`、隔离 worktree（pin 到刚 review 过的 commit `pr_head_sha`），与实现者分离（qa-developer-separation —— 别让实现者自证）。

### B. QA verdict 卡住 founder 的 ship 通知
- **QA PASS** → 触发「ready + QA 过」通知 → founder 在**对应 issue thread**被通知 → founder 仍做**必需的** ship 审批（merge/ship 永远 founder-gated，FLY-175，**绝不自动 merge**）。
- **QA FAIL** → QA 报告经 `feedback_wake` 喂回实现 Runner（现成 changes-requested loop）→ Lead 驱动修 → 重 review → 重 QA。**founder 完全不打扰**，循环到 PASS 或真死锁（升 **Lead** 不升 founder）。

### C. per-project + per-issue QA 策略（解决「有的活不需要 QA」）
项目在 `.flywheel/config.yaml` 声明 `qa:` 块：`qa.auto: on|off`（项目默认）、`qa.skip_labels: [docs, chore, …]`（这些 label 的 issue 跳过 QA 段）、`qa.agent:`（用哪个 QA executor，默认 = 一个 shipped、项目无关的 qa-executor）。加 per-issue label override（如 `no-qa` / `qa`）+ 全局 env kill-switch。统一-by-default、按项目/issue 可调。

## founder 触点：前 vs 后

- **前**：`awaiting_review` 就 ping founder → 她说「先去 QA」→ Lead 手动派 QA → QA 报 → 再 ping founder → ship。（2 次打扰 + 手动 Lead 步骤）
- **后**：全自动到 implement+review+E2E 全绿，founder 只在 issue thread 被 ping **一次**去 ship。（1 次打扰）

## Tadashi 的 engineering 裁决（Q1–Q4，他自己拍，不烦 Annie）

| Q | 裁决 |
|---|------|
| **Q1 触发点** | **`awaiting_review`** 状态（代码+review 全过、请求 ship 的现成信号，带 `pr_head_sha` + review binding，codexSkip 项目也适用）。**不要**更早（`pr_created` 时 review 还没过）。 |
| **Q2 QA FAIL 回路** | **复用现成 changes-requested / re-review loop**：QA 报告当 feedback 喂回 engineer runner，Lead 驱动修。不发明新机制。 |
| **Q3 notify 范围** | **FLY-579 自己 own QA-passed ready 通知的重新落地**（in-thread、gate 在 QA-PASS 后、绝不进 alert 频道）。原「复用现有 #351」前提作废（#351 已 revert，见 O1，已澄清确认）。这就是 issue 标题的「fold FLY-523」。 |
| **Q4 rollout** | **flywheel 灰度先 → 再全局翻 ON**。默认 **OFF / opt-in**，flywheel 验过再全局 ON + 全局 env kill-switch。 |

## Open Questions（待澄清，不自行拍板）

### O1（✅ RESOLVED，Tadashi 确认 questionId fe4dd4ee）— notify 现状前提
Tadashi Q3 原假设「in-thread ready 通知 #351(FLY-523) 已实现 + FLY-592 PASS、复用即可」。核实结果：
- **main（ea944bb9，= 真实 remote HEAD）上 #351 已被 #360 revert**（commit `aa5c6653`，`FounderGatePendingNotifier.ts` 等已删）。FLY-592（DONE）验的就是被 revert 掉的那版 #351。
- **FLY-598 ≠ notify 重写** —— 它是「做 founder-facing UX 前必须先跟 Annie brainstorm 的强制 gate」（PR #359），正 born 自 FLY-523 把通知塞 alert 频道这个反面教材。

**Tadashi 裁决**：「复用现有 notify」前提作废。**FLY-579 自己 own QA-passed ready 通知的重新落地** —— **in-thread**（issue 的 [FLY-XX] thread）、gate 在 QA-PASS 之后、**绝不进 alert 频道**。无别的 PR 在重落 notify，FLY-579 = issue 标题的「fold FLY-523」。

**设计原则（写死，吸取 #351 revert 教训）**：**通知（completed / ready-to-ship 这类「活儿好了」）→ 落对应 issue thread**；**alert 频道只放错误 / 异常**（stuck / crash / rate-limit）。alert ≠ notification。

### O2 — 触发点 fork（已由 Q1 裁决为 awaiting_review，记录备选）
备选 B = `code-review.json` APPROVED @ `pr_created`：更早、跟 Codex review 并行更快（贴合 qa-executor「spawned in parallel with Codex」自述），但耦合 Codex 内部 + 不覆盖 codexSkip。Q1 已否。

## 给 Annie 的 vision 级问题（Tadashi 只取核心「中间全自动、只在最后联系她一次做 ship 审批」去问；其余记录备查）

- **V1 QA 失败的自治上限**：auto-QA 反复 fail 时，Lead+Runner 自己 loop 多久才拉你进来？（N 轮 / 时间盒 / 别烦我一直修或先搁置）
- **V2「有的活不需要 QA」谁决定**：(a) 按 issue 类型/label 自动跳、(b) Lead 每 issue 判断并告诉你、(c) 默认全 QA 除非你说跳？
- **V3 一个 founder 触点够不够**：「QA 过、可 ship」落 issue thread 是唯一想要的 ping 吗？还是 QA 启动 / 反复失败时也想要「知会但不用动手」的可见信号？
- **V4「QA」在不同项目类型的含义**：工程项目（flywheel/GeoForge3D）有真 E2E；内容项目（growth/tidal-echo）「QA」= 内容达标/发布没。全局机制 = (a) 现在只对工程类 issue 上 QA 段，还是 (b) 通用「独立验证段」、CHECK 由项目定义？（Q4 的 flywheel 灰度先天然先回避了这层，内容项目随全局 ON 再议。）

## 边界 / 非目标

- merge / ship **永远 founder-gated**（FLY-175）。auto-QA + auto-notify，但 founder 按 ship 键。**不自动 merge。**
- brainstorm gate（scope confirm）不变。
- `qa-framework`（FLY-529 4-slot Room）= Flywheel **自测房**，不是本机制的积木，别混。
- 旧的 flywheel-单仓窄实现已按 Tadashi 指示**挂起保留**（代码不删）。

## 下游

→ Research（已基本完成，见 `doc/engineer/research/new/FLY-579-pipeline-mechanism-audit.md`）→ Plan（HOLD 等 Annie vision 确认）→ codex design-review → implement（TDD）→ code-review → QA。
