# FLY-1240 删除 founder_image_approval 死 flag — 探索

Issue: FLY-1240 (https://linear.app/geoforge3d/issue/FLY-1240/flag-cleanup-delete-founder-image-approval-dead-flag-dead-code-path)
日期: 2026-07-14
基于: 无

## 1. 背景 / 意图

FLY-1136 逐条 flag 审计,Annie 圈选 `founder_image_approval` = **①删**(2026-07-14)。
工程事实(Tadashi):该 flag 即使 `=1` 也 **inert**(生产从未接线),纯死码,移除无行为变化。

flag 来源 = FLY-799「founder ship-approval」的 default-off fast-follow scaffold:图片镜像确认作
批准。当时把 ImageSource 代码建好 + 测好,但生产 evaluator 从未接上,flip-on 一直没做。

## 2. 死代码路径全貌(审计结果)

grep 全仓后,`founder_image_approval` / `FLYWHEEL_FOUNDER_IMAGE_APPROVAL` / image-approval 相关
生产代码只落在下面这条链上(其余命中全是历史文档,见 §4):

| # | 文件 | 死码内容 |
|---|------|---------|
| 1 | `packages/config/src/feature-flags/registry.ts` | `founder_image_approval` registry 条目(envVar `FLYWHEEL_FOUNDER_IMAGE_APPROVAL`) |
| 2 | `.../approval-signal/founder-ship-approval-factory.ts` | `imageApprovalEnabled()` 读 env + `evaluateImageImpl` config 字段 + 两处传给 handler(`imageApproval` / `evaluateImageImpl`) |
| 3 | `.../approval-signal/founder-ship-approval-handler.ts` | `imageApproval` / `evaluateImageImpl` dep + `msg.imageAttachments` 字段 + `evaluateSignal` 里的 image 分支 + `ImageAttachment` import |
| 4 | `.../approval-signal/image-approval-source.ts` | 整个 ImageSource 模块(`evaluateImageSource` + `ImageAttachment` 等类型),**仅**被其自身单测引用 |
| 5 | `.../approval-signal/types.ts` | `ApprovalSignal` 联合里的 `source: "image"` 成员(仅 `evaluateImageSource` 产生) |

**测试**:
- `__tests__/image-approval-source.test.ts`(整文件,只测已死的 ImageSource)
- `__tests__/founder-ship-approval-handler.test.ts` 里的 `describe("... image approval ...")` 块(228–296)

## 3. 两条关键工程事实(决定"必须一起删"和"确实全死")

1. **生产 composition root 从未接线**:`plugin.ts:5086` 的 `makeFounderShipApprovalCallback({...})`
   **不传** `evaluateImageImpl`。handler 的 image 分支门槛是
   `deps.imageApproval && deps.evaluateImageImpl && msg.imageAttachments?.length>0` —— 生产
   `evaluateImageImpl` 恒 undefined ⇒ 分支可证死。且 `msg.imageAttachments` 在生产也从未被填充。
   → 整条 image 路径(含 `image-approval-source.ts`)确实全死。

2. **drift-guard 逼着"registry + 读码"必须同时删**:`feature-flags-drift.test.ts` 的
   "no silent new gate" 用例扫生产 `src` 里的 `process.env.FLYWHEEL_*` 布尔门,凡未注册且不在
   allowlist 的一律 CI 红。
   → 若只删 registry 条目、留下 `imageApprovalEnabled()`(`process.env.FLYWHEEL_FOUNDER_IMAGE_APPROVAL === "1"`)
   → CI 红;若只删读码、留 registry 条目 → drift 另一条"registered 但 readSite 找不到"用例红。
   **两边必须同一 PR 一起删**,drift guard 自然回绿。

`imageHashes` / `evidenceAttachmentIds` / `source: "image"` 在生产代码里除本死路径外**零消费者**
(grep 确认),所以 §2 第 5 项的联合成员也是真死码。

## 4. 明确不动(历史记录,非源码)

- `product/doc/FLY-1091-feature-flag-policy/{audit,exploration}.md`(审计母单记录)
- `engineering/doc/FLY-799-founder-approval-self-ship/{impl-progress,plan}.md`(799 实施记录)
- `.claude/skills/*/SKILL.md`(runner 运行时注入文件,非仓库源)

这些是"当时发生了什么"的历史事实,不是活代码,按 scope discipline 不改。

## 5. 唯一范围决策点(带去 brainstorm gate 确认)

**要不要连 §2 第 4、5 项一起删?**(即删掉整个 `image-approval-source.ts` + `ApprovalSignal` 的
`source: "image"` 联合成员)

- **A(推荐)— 删整条**:flag、wiring、ImageSource 模块、联合成员一起删。理由:它们就是 flag 门控的
  同一坨 scaffold,`evaluateImageSource` 只被自身单测引用、`source: "image"` 只由它产生,留着 = 半拉子
  清理(reviewer 会问"image 变体为啥还在")。已验证零外部消费者,低风险。
- **B — 只删 flag + wiring**:保留 `image-approval-source.ts` 和联合成员作"未来 image 批准"占位,
  仅摘掉 flag 门和 handler 分支。缺点:留下无生产者的孤儿模块/类型,仍是死码,不满足 issue 的"死代码路径"。

推荐 **A** —— issue 原文即"移除 flag 定义 + 所有引用 + 死代码路径",A 才是完整闭环。`source: "voice"`
联合成员**不动**(voice 是独立在建功能,不在本 issue 范围)。

## 6. 实施方式

纯删除,无新行为 → TDD 形态 = 先跑相关 suite 建立绿基线 → 删死码 + 对应测试 → 再跑 suite + drift
guard + typecheck/lint 全绿,证明**零行为变化**。
