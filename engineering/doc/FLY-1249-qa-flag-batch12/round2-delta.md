# FLY-1249 QA · Round-2 delta（#588 rebase → 新 head 5c0f51b80）

Issue: FLY-1249 (https://linear.app/geoforge3d/issue/FLY-1249/qa-fly-1243-独立验证-pr-58811-flags-固化-default-on本批最重)
日期: 2026-07-14
基于: qa-report.md (Round-1 @ c9aab973a)

## 裁决：✅ delta PASS

对象：PR #588 rebase 到 flag-batch main（origin/main 已含 #584/#585/#589/#590）+ 手工解冲突 + Codex 7 轮复审 → 新 head `5c0f51b80`。Round-1 PASS 绑 c9aab973a；本轮只验 rebase/冲突解决的 delta。**不 ship**。

## ① 逐 hunk 语义审（冲突主战场 = registry.ts）

**delta 铁证**：`git diff origin/main..5c0f51b80 -- registry.ts` = **只含 11 个 FLY-1243 flag 移除**（alert_threads/stuck_errorsig/pane_multiframe/detection_gap_scan/detection_escalation/auto_repair/account_self_heal/notify_digest_expect/xhs_review/roundtable_reply_in_thread/roundtable_enabled），净 -235/+3。无其他 flag 被删、无删除 flag 复活、#590 未被碰。由此结构性证明：

| 检查项 | 结果 |
|---|---|
| 11 固化 flag 保持固化/退休 | ✅ registry 里 0 个；生产 src 0 个真 env-gate（非注释）|
| #584/#585/#589 删的 3 flag 保持删除 | ✅ `founder_image_approval` / `lead_pane_readiness` / `codex_lead_read_deny` 均不在 registry delta（origin/main 已删，5c0f51b80 未复活）|
| #590 新 flag 完好 | ✅ `three_stage_codex_design_toggle` / `FLYWHEEL_THREE_STAGE_CODEX_DESIGN` present（registry:352/356）|
| content-coordination 未复引入 | ✅ `read-deny-profile.ts` 已删；生产 src/scripts 零 content-coordination 引用 |
| 两处测试改名 | ✅ resolve-test 改用 `lead_chrome_enabled`（feature-flags-resolve.test.ts:28）；gate 名对齐 `assertFullAccessLeadActionsConfigGate/SandboxConfig`（codex-lead-tui-home.test.sh）|
| runner_autocontinue 仍在 | ✅ registry:1954 |
| envVar 总数 | 87(Round-1) → 85（-3 sibling 删 +1 #590，净 -2，一致）|

## ② registry drift + config 套件重跑 @ 5c0f51b80

- **config 套件 23 files / 400 tests 全绿**，含 feature-flags-drift(3) = 冲突主战场守卫绿 → 合并后 registry 与代码双向同步（11 flag 零残留 gate + 每个注册 flag 含 #590 有 readSite）+ resolve(13, lead_chrome_enabled 改名) + registry(9) + direct-toggle(12)。

## ③ CI @ 5c0f51b80

- **双绿**：`Build & Test` = pass (15m41s)、`FLY-1062 payload distribution` = pass (49s) @ run 29363320688。

## ④ Round-1 结论的触碰面处理

`git diff c9aab973a 5c0f51b80` 对 FLY-1243 consumer 代码：
- **9 个文件逐字相同**（roundtable-config / account-store / account-switch-repair / infra-notify / LeadWatchdog / stuck-candidate / stuck-escalation / notify-receipts / notify-digest-expect）→ **引用 Round-1 结论**（Type-A/B/C 语义、Type-C boot-sim、detection_escalation 互锁 INV-4+C4a 全部原文未动）。
- **2 个文件被触碰**（plugin.ts -65 / codex-lead-runtime.ts -101）—— 系 sibling 删除（#589 read-deny / #584 image-approval）的 main-advancement，**非** FLY-1243 flag 逻辑改动：#588 对这两文件的自身 footprint 与 Round-1 同（plugin +200 / runtime +19）。→ **补跑**：
  - plugin.ts FLY-1243 gate 标记逐一核对 @ 5c0f51b80 全对：`multiFrame: true`(8061) · `accountPoolConfigured()`(7012) · `unifiedAlert && repairChainResolves`(7353) · 退休变量 refs=0 · `detectionEscalationEnabled` refs=0 · gap-scan 早退已删。
  - codex-lead-runtime.ts roundtable 老门 `REPLY_IN_THREAD==="1"` 已删（no-throw 语义保留）。
  - FLY-1243 teamlead 套件 **16 files / 344 tests 全绿**（含被触碰的 codex-lead-runtime.test.ts 124）。
  - shell 测：codex-lead-tui-home **7/7 FLY-1243 marker cases 全绿**（Round-1 的 14 个 host-codex 假失败在本轮消失——#589 删 read-deny profile 后那些 sandbox/read-deny 测试案例随之移除）；token-usage-daily-failloud **8/8**。

## ⑤ build

- `pnpm -r build` exit 0 → 冲突解决后的代码**干净编译**（TypeScript 全仓，含 -101 行的 codex-lead-runtime.ts 冲突解决未引入类型错误）。

## 结论

rebase + 冲突解决**语义无回归**：11 flag 固化/退休保持、3 sibling 删除保持、#590 完好、content-coordination 未复引入、两处测试改名对、drift 守卫绿、编译绿、相关套件全绿。Round-1 的 PASS 结论对未触碰面继续成立，触碰面已补验。**delta PASS**。2 条 Round-1 minor 不变（→ follow-up，不阻批）。
