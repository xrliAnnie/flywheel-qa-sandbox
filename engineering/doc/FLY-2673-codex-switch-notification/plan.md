# FLY-2673 Codex 已换号通知 — 实施计划
Issue: FLY-2673 (https://linear.app/geoforge3d/issue/FLY-2673/codex-额度b3-n1已换号通知完全照抄-claude-现有切号通知格式只改抬头与窗口行)
日期: 2026-09-18
基于: 无

## 锁定范围与假设

- 规格只取 `product/doc/FLY-2591-codex-quota-switch/prd.md` §6.2 与附录 D.2：N1 与现行 Claude `formatSwitchNotification` 同形，仅把抬头换成 `Codex 已切号`、窗口行换成 `weekly`。
- N1 继续走现有 `switch_notification` durable outbox；不新建通知通道、不改 Claude 通知、不打开 `codex_quota_auto_switch`、不做真实换号或 Discord 发信。
- 邮箱取已校验的 Codex account registry；额度只取触发本次选择的探针 observation。缺少任一格时输出 `n/a`，不从 `usageLimited`、profile 名或其它间接状态猜数字。
- FLY-2688 PR #1258 尚未合入，且其 `buildCodexRows` 明确只接受 `codex.source === null`；本单不依赖该分支，也不另造账号额度页口径。

## 已确认的测试 seam

以 `createCodexQuotaOutboxDelivery` 的公开 `send(payload, attempt)` 端口为行为 seam：断言实际交给既有 notifier 的完整 `AlertPayload`。纯格式器测试只固定 PRD 正本文字和缺值规则；StateStore 测试固定崩溃重放所需的 durable context。测试不用真实凭据、真实换号或真实 Discord。

## 实施切片

1. **红：N1 正本文字。** 在 Codex quota outbox 测试加入逐字期望，覆盖 `business → personal`、`quota:weekly`、两个账号分块、邮箱、`text` 代码块、四列表头与唯一 `weekly` 行；当前英文摘要必须失败。
2. **绿：最小格式器。** 增加 Codex N1 纯格式器，复用 Claude 当前的 PT 时间渲染规则与列宽，只保留 PRD 点名的供应商抬头和窗口行差异。成功通知设为 non-mention、`info`、`deliveryStyle: "plain"`，避免 notifier 再包一层标题。
3. **红/绿：缺值不编造。** 增加无 observation/部分缺失用例；输出 `n/a`，不把“触发了 usage limit”硬写成 `100%`。
4. **红/绿：durable 重放。** 给既有 `codex_quota_install_material` 增加可空的通知快照字段；选择后、安装提交前保存 from/to profile、registry email 与当次窗口读数，`commitGeneration` 将同一快照带入 outbox。迁移、安装恢复与 outbox 重放测试证明重启后仍渲染同一读数。
5. **回归验证。** 跑新增/受影响的 Vitest 文件、teamlead build、仓库 lint 与新增 shell 结构测试（若有）。遵照 Lead 指令，不在本机跑全量 `pnpm test:packages:run`；整包结论只取 PR 精确头 CI。

## 完成边界

- 代码评审只接受当前精确 HEAD；阻断 finding 修完后重新评审。
- 提交并 push 代码与计划后，创建 PR；`engineering/doc/milestones/FLY-2673.md` 必须是 PR 的最后一个提交。
- 不 merge、不部署、不启动 QA、不修改宿主 flag/凭据/服务。
