# FLY-1246 独立 QA·PR #584 删 founder_image_approval 死码 — 探索

Issue: FLY-1246 (https://linear.app/geoforge3d/issue/FLY-1246/qa-fly-1240-独立验证-pr-584删-founder-image-approval-死码)
日期: 2026-07-14
基于: 无

## 验证对象

PR #584（分支 `flywheel-FLY-1240`，head `ed9823622f55a382910c2002df3f325b0e017f80`）——
FLY-1240 [flag-cleanup]：删除 `founder_image_approval` feature flag 及其整条死码链。

来源决策：FLY-1136 flag 审计 → Annie 决定 ①删（2026-07-14）。FLY-799 的 founder
image-approval 脚手架当初 default-off 作为 fast-follow 建好但**从未接线**——生产
composition root（`plugin.ts`）从不传 `evaluateImageImpl`，所以
`FLYWHEEL_FOUNDER_IMAGE_APPROVAL=1` 即使置位也 inert（registry 自己的 note 都这么写）。
纯死码，删除是运行时 no-op。

## 本 QA 是独立验证（与实现者零共享）

我是 QA runner，与实现 runner 无共享上下文。在隔离 worktree（fresh checkout `ed9823622`）
上从零验证。

## PR 声称删除了什么（我逐条核对 diff 后确认吻合）

| Layer | Removed |
|-------|---------|
| config registry | `founder_image_approval` flag 项（`registry.ts`，删 21 行） |
| factory | `imageApprovalEnabled()` + `evaluateImageImpl` config 字段 + 两处 handler 传参 |
| handler | `imageApproval`/`evaluateImageImpl` deps、`msg.imageAttachments`、`evaluateSignal` 里的 image 分支、`ImageAttachment` import |
| module | `image-approval-source.ts` 整个模块（只被自己的测试引用过） |
| types | `ApprovalSignal` 的 `source:"image"` 变体（`reaction`/`text`/`voice` 保留） |
| tests | `image-approval-source.test.ts` + handler 的 image `describe` 块 |

`plugin.ts` 故意不动——它从没接 `evaluateImageImpl`，这正是该路径为死码的原因。

config **drift-guard** 强制 registry 项与 `process.env` 读点必须同一 PR 内一起删（留任一
边都会 CI 红）。两边都删了 → guard 保持绿。

## 风险面（什么可能被误伤）

1. **reaction / text / voice 三条 approval 路径**——必须逐一确认未被波及（image 与它们同处
   ApprovalSignal 判别联合体 + 同一 handler）。
2. **config drift-guard 双向守卫**——registry 项与 env 读点必须同步删，否则 CI 红。
3. **零残留**——flag 名 / env var / `imageApproval` / `image-approval-source` / `ImageAttachment`
   / `evaluateImageImpl` / `source:"image"` 在代码里不得有任何悬挂引用（编译不过或死引用）。

## 验证维度（对应 issue 五项）

① fresh checkout PR head → ② 全量相关套件（teamlead approval-signal + config 含 drift 双向
守卫）+ typecheck + biome → ③ grep 全仓零残留 → ④ 行为不变抽查 reaction/text/voice →
⑤ CI 状态核对 + PR 声称的 6 个 pre-existing teamlead 失败在干净 main 复现。
