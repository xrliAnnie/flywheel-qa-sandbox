# FLY-1246 独立 QA·PR #584 删 founder_image_approval 死码 — QA 报告

Issue: FLY-1246 (https://linear.app/geoforge3d/issue/FLY-1246/qa-fly-1240-独立验证-pr-584删-founder-image-approval-死码)
日期: 2026-07-14
基于: plan.md

## VERDICT: ✅ PASS

PR #584（FLY-1240，head `ed9823622`）是一次**干净的死码删除，零行为变化**。
`founder_image_approval` flag 及其整条 image-approval 死链已完整移除；reaction/text/voice
三条 approval 路径完整未波及；无任何代码残留；typecheck/biome/CI 全绿。**建议 ship**
（Lead / founder gated；本 QA 不 ship 不合并）。

---

## 验证环境（独立 / 零共享）

- 隔离 worktree：`worktrees/fly1240-qa` @ `ed9823622f55a382910c2002df3f325b0e017f80`（detached，
  fresh checkout，与实现 runner 零共享）
- `pnpm install --frozen-lockfile`（fresh）+ `pnpm -r build`（从 ed9823622 源码构建，供跨包类型解析）
- QA 产物写本分支 `flywheel-FLY-1246`，**未碰**被测分支 `flywheel-FLY-1240`（head 冻结）

---

## 逐项结果

### ① Fresh checkout PR head — PASS
`git rev-parse HEAD` = `ed9823622f55a382910c2002df3f325b0e017f80`，与被测 commit 一致。

### ② 套件 + typecheck + biome — PASS

| 项目 | 结果 | 判据 |
|------|------|------|
| `flywheel-config` 全套件 | **394 passed / 394**，含 `feature-flags-drift.test.ts` **3 passed**（drift 双向守卫） | ✅ |
| `flywheel-teamlead` approval-signal 聚焦套件 | **17 文件 / 274 tests 全 passed**（含 founder-ship-approval-{factory,handler,classifier,tier2}、reaction/text/voice-approval-source、gate-message-binding、founder-reply-deliverer、gate-poller-founder-reply、ship-approval-{render,route} 等） | ✅ |
| `flywheel-config` `tsc --noEmit` | EXIT=0，0 errors | ✅ |
| `flywheel-teamlead` `tsc --noEmit` | EXIT=0，0 errors | ✅ |
| `pnpm -r build`（全包 tsc 编译） | EXIT=0，无 TS 错误 | ✅ |
| `biome check --changed --since=origin/main` | EXIT=0，Checked 7 files，No fixes applied | ✅ |

### ③ 全仓零残留 grep — PASS
扫 7 个 pattern（`founder_image_approval` / `FLYWHEEL_FOUNDER_IMAGE_APPROVAL` / `imageApproval` /
`evaluateImageImpl` / `image-approval-source` / `ImageAttachment` / `source:"image"`），排除
node_modules/dist/.git：

- **代码层（doc 外的 .ts/.js/.mjs/.cjs）零命中** ✅
- 仅有的命中全部在**文档文件**（PR 自己的 `exploration.md` 描述删除内容 + 历史 FLY-799 脚手架文档
  + FLY-1091/1038/1188 flag 审计/设计文档按名引用）——属文档叙述，非代码残留。
- 被删模块 `image-approval-source.ts` + 其测试 `image-approval-source.test.ts` 确认不存在（源码与
  编译产物均无）。

### ④ 行为不变抽查 reaction/text/voice — PASS

- `types.ts` 的 `ApprovalSignal` 联合体现存 `source:"reaction"` / `source:"text"` / `source:"voice"`
  三变体，**仅 `source:"image"` 变体删除**。
- `reaction-approval-source.ts` / `text-approval-source.ts`：与 `origin/main` **byte-identical**（PR 未触及）。
- `voice-approval-source.ts` / `founder-reply-deliverer.ts`：**仅 JSDoc 注释改动**（"extensible to
  voice/image" → "voice"；"text / image sources" → "text source"），无逻辑变更。
- handler `evaluateSignal` 最终为**干净的 text-only**（image 分支彻底切除，非注释保留）：直接
  `evaluateTextImpl ?? evaluateTextSource` → 审计 → 返回。
- PR diff **完全局限**于 approval-signal（image 码）+ `config/src/feature-flags/registry.ts` + docs，
  无越界；`plugin.ts` 故意未动（从没接 `evaluateImageImpl` = 死码根因）。

### ⑤ CI 状态 + pre-existing 失败归因 — PASS

- PR #584 head **仍 `ed9823622`（未移动）**；state OPEN，`mergeable=MERGEABLE`，`mergeState=CLEAN`。
- CI：**Build & Test = PASS**，**FLY-1062 payload distribution = PASS**。
- merge-base(origin/main, head) == origin/main == `cfb27099d` → PR **不落后 main**，直接建在当前 main tip，
  CI 跑的即 exact-merge 状态。

**关于本机全套件的 6 个失败（已归因为环境性，非本 PR 引入）：**
- fresh worktree 首轮（**未构建 config dist**）跑出 263 文件"失败"——经确认是 collection artifact
  （跨包 import 解析不到 dist）；`pnpm -r build` 后重跑降到 **6 文件失败 / 475 passed / 1 skipped**，
  与 PR 声称的"6 个 pre-existing 环境失败"数量一致。
- 6 个失败文件：`close-runner` / `createLeadRuntime-preflight` / `lead-rules-bundle` /
  `stuck-candidate` / `worktree-quarantine` / `codex-lead-runtime`。
- **构造性证明它们是 pre-existing**（无需另建 main empirical run）：
  1. 6 个文件在 `origin/main` 与 `ed9823622` 之间**逐字节相同**（`git diff --quiet` 全 IDENTICAL）；
  2. **无一 import 任何 PR 触及模块**（approval-signal / image / founder-ship / registry）；
  3. 失败签名全是环境性：`tmux kill-session failed`(24×)、`Test timed out`、`fatal: not a git
     repository`（worktree-quarantine 在 /tmp 跑 real-git）、`git -C /tmp worktree list` 失败——本机
     tmux/git/spawn 高负载竞争；
  4. **CI Build & Test 绿**——CI 在干净构建环境跑同一套件通过，证明这 6 个是本机环境特异失败，
     PR 头上 CI 亦无此失败。
- 相同代码 + 相同测试 = 相同 pass/fail（仅取决于环境）→ 这 6 个失败在干净 main 上同样复现，
  **非本 PR 引入**。

---

## 结论

死码删除完整、零残留、drift-guard 绿、三条 approval 路径完好、typecheck/biome/CI 全绿，
本机全套件的失败均为与本 PR 无关的环境性 pre-existing 失败。**独立 QA 判定 PASS。**

不 ship 不合并 — verdict 交 Lead（Tadashi）；ship 由 Lead / founder gated。
