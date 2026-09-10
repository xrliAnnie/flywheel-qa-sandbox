# FLY-2456 529 房真机重启演练 — 实测报告
Issue: FLY-2456 (https://linear.app/geoforge3d/issue/FLY-2456)
日期: 2026-09-10
基于: plan.md; recomputed/replay-receipt.json; host-runs/r1/; host-runs/r2/

## 一句话

**#1128 消除了本轮观察到的 capability drift：修前 2 条，修后 0 条；但 recovery owner 提交前失败在修前修后均存在，完整 reown 尚未恢复。** 两轮由 Lead 在宿主机执行，本报告用同一份原始证据重算分类，不是再次演练。整体判定仍为 FAIL，不能据此宣称 FLY-2352 已达到「修后全部认回、生产零影响」的验收条件。

### 认回成功率：R1 0/2，R2 0/2

分母仅含 B1 多 activation 与 B2 单 activation。B3 是非 TURN holder 阴性对照，不计分母；换体也不计为原体认回成功。

## 修前：原病复现并换体

R1 使用 slot 4，main `d6cda1fc13080f9c188cbfc5f354eea5a2c28f65`。

- B1 `8798137e-39ef-4906-8075-7b2d095a5f0e`：17:15:33 与 17:20:33 UTC 的 attempt 1/2 均报 `workflow capability drift for 8798137e-39ef-4906-8075-7b2d095a5f0e`（session event 34、41）；17:25:33 出现 `episode_exhausted`（51）。随后 workflow seq 39 → 41 → 42 为 `rework_delivery_replacement_pending` → `rework_replacement_materialized` → `rework_replacement`，新体为 `4240e1e9-3dca-4a34-8521-0ea86533207e`。重算标签 `replaced`，证明修前病灶和换体链成立；此体没有 owner failure 的实证，不混写成另一种失败。
- B2 `316a116c-b44d-41ba-bdad-e8fcec8ff92f`：attempt 1/2 均为 `recovery owner failed before commit`，随后 `episode_exhausted`，无满足证明条件的换体链。重算标签 `failed_exhausted_no_replacement`。
- B3 `0c1c8174-bf92-444d-b408-9da04d66311a`：not-turn-holder 后接 superseded skip，重算标签 `skipped_not_holder`；仍是阴性对照。

## 修后：drift 消失，另一处恢复故障仍在

R2 使用 slot 1，main 本地合入 #1128 的头 `85d516e6c42404326aad0f081489b457a33146f7`（完整 SHA 见重算 verdict）。下界后全库 `capability drift` 事件 0 条。B1、B2 各有 2 条 prepared 事件，两个 attempt 的失败原因均为 `recovery owner failed before commit`。

- B1 `3835df15-3676-4717-a094-00b63bfde129`：仍标为 `other`。原始观察含 attempt 1/2 失败（session event 31、40），但第一 episode 的观察区间内没有 `episode_exhausted` 事件，因此不能证明预算耗尽，也不能把它补判为已换体或无换体耗尽。本轮不为它修改分类规则。
- B2 `8914c4c2-ff29-464c-9efb-3b61b945e5b5`：attempt 1/2 失败（25、38）后有 `episode_exhausted`（42），重算标签 `failed_exhausted_no_replacement`。
- B3 `4176c67b-ee4b-485c-a93e-761a7c57a60d`：`skipped_not_holder`，与原判定一致。

`failed_exhausted_no_replacement` 在真实两轮中触发 **2 次**（R1 B2、R2 B2），不再是仅合成夹具覆盖的标签。owner failure 的实证是 R1 B2、R2 B1、R2 B2 三具；其更深层异常原话因本轮未保留对应 Bridge 日志而缺失，不补造根因。

## 生产影响与已知发现

生产零影响尚未通过。重算没有重新采集或放宽任何生产证据：R1 verdict 保留 13 项失败、2 项待归因，R2 保留 12 项失败、2 项待归因。两轮均含 proc/live、launch-commits 与 alerts 失败；R1 另有 fleet/live、fleet/postTeardown 失败。两轮 proc/postTeardown、proc/teardown 仍待归因。逐项原文与证据 SHA 见 [R1 判定](recomputed/r1-verdict.json)、[R2 判定](recomputed/r2-verdict.json)。

- F1：slot 体内 daemon 写入生产停体账本。
- F2：拆房后 slot CommDB 被重建，写者未定位。
- F3：slot Bridge 告警写入生产 alerts 目录。
- F4：修前已在返工途中的 B1 换体，普通运行的 B2 未换体。
- F5：修后 drift 为 0，但 owner 提交前仍失败；更深层根因原话未捕获。

`unbounded-production-evidence-projection`：宿主 StateStore 派生产物为 245668155 bytes；由 FLY-2503 承接上限改进，本 PR 不提交该大文件。

## 夹具、残留与证据边界

两轮均使用隐藏 room-info 解除排除、gate-held 满足 reown 资格的夹具；B3 为非 holder 对照。维护观察采用已批准的墙钟至少 600 秒与 tick `UNAVAILABLE(structural: no_unconditional_tick_observable)` 回执，不伪造两次 tick。活 WAL 生产库不作逐字相等声明。

Lead 已回报清掉 `fly2454-decoy` 窗口；这是宿主清理回执，本实现节点没有操作生产 tmux。原始报告记载的 launch receipts、归档、沙箱分支/PR 等历史残留与当时状态保留，不能用后续清理覆盖演练窗口的污染事实。

[DEVIATIONS 原件](host-runs/driver/DEVIATIONS.md) 使用混合编号：`1.`–`5.` 的编号段落与 #6–#17 小节，共 17 项；不是只有 #5–#17。本轮保持原件字节不变。

## 产物、自查与建议

原宿主归档仍为 [host-runs/r2/drill-report.md](host-runs/r2/drill-report.md) 与 [host-runs/r2/founder-report.html](host-runs/r2/founder-report.html)，供历史审计。本次重算的 [双轮报告](recomputed/drill-report.md)、[pair.json](recomputed/pair.json) 与 [逐体差异及原证据哈希回执](recomputed/replay-receipt.json) 单独保存；本页为当前结论。两轮 observation 原始派生证据 SHA 不变，原 76 份 host-runs 文件字节不变。

自查使用右侧字面量规则 `(TOKEN|SECRET|KEY)=[A-Za-z0-9._-]{16,}`，覆盖归档及重算产物，实际匹配 0；driver 中合法 shell 变量引用不算秘密泄漏。未提交 ps.txt、ps-comparison.txt、alerts.json、identity.json、state.evidence.json、comm.evidence.json 等原始大文件。

建议由 Lead 将「drift 2 → 0，但完整 reown 0/2 → 0/2」与 owner failure、生产影响未闭合项交给 founder。是否批准仍由 FLY-2352 原 ship 流程决定；本报告不替代批准或上线。
