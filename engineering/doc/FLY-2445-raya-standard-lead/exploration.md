# FLY-2445 Raya 标准 Lead — 探索
Issue: FLY-2445 (https://linear.app/geoforge3d/issue/FLY-2445/raya-raya-迁为标准-codex-lead注册进-flywheel走-mailboxraya-仓删掉-ingest-名册)
日期: 2026-09-08
基于: 无

## 目标与授权边界

Raya 使用与 Mufasa 相同的收信、持久邮箱、投递和 Bridge 出站路径。Raya 仓只拥有 persona / prompt、跨 Lead 的 CoS 业务、summaries、日报及会议业务，不再拥有 Discord 收信、名册、服务安装器或 Codex 进程/会话驱动。

本节点只有设计 TURN；产出探索、调研、实施计划、可评论 HTML，经过有效设计评审后交接。没有实现、上线或合并权限。设计交付不等待 founder 页面评论；Lead 已明确不增加额外实现hold，后到反馈由当前TURN holder增量修改，不把页面意见标记当批准。

## 必须保持的结果

1. 在 #raya 打字，经同一 comm.db 的 mailbox 表 → LeadInboxLoop → Codex 适配器 → Raya → Bridge 出站，日志串起同一个消息身份；与 Mufasa 对照。
2. Raya 仓的生产源、安装入口、依赖和生成发布物都不再拥有旧传输与驱动；逐文件对齐 FLY-2439 v3 §C，不能只删一个入口或保留隐式备用脑。
3. `summaries/` 内容、未读 PR、已阅 merge 语义、日报和会议业务状态保持；summary 至少完成一次迁移后收件。读回执例外只适用于 Raya 两仓的纯 summary PR，不能扩到代码。
4. 合入不等于上线。独立 updater 完成部署且生成可验证的 deploy-receipt，才能声称上线。

## 已核实的现状

- FLY-2439 `build-v3.py` C1/C2 明确记录旧名册、brain/voice 两套 job 和旧文字补丁；C2 的行数是可行性尚未验证的推演，不能作为最终删除依据。
- 其 §D 指出 voice 自己也 spawn Codex 并保存 thread。因此“删 app-server 驱动”和“保留会议业务”需要拆开业务与设备/模型基础设施。
- `founder-only-authority.md` R1 目前要求旧 brain 重启、旧 CLI preflight，并指定旧 install-launchd 修复身份；这些引用需要与实现一起迁移，原部署授权和独立班车规则不变。
- `scripts/lib/updater-raya-deploy.sh` 直接依赖两个旧 label、`apps/brain/dist/cli.js preflight`、PID 与旧 env；不是改一个 registry 行即可上线。
- PRD FLY-1846 §8.8 的收件权威是 Raya 仓的 PR，不是旧 Codex thread，也不是 14 人 profile 目录。

## 方案比较

| 方案 | 结果 | 选择 |
|---|---|---|
| 继续给旧脑补 mailbox 转发 | 两个运行时、名册和恢复系统仍然存在 | 拒绝，违反删除目标 |
| 注册标准 Lead，业务调用共享接口，删旧基础设施 | 收信/会话/出站单一所有者，Raya 保持自己的业务 | 采用 |
| 本单重写所有语音与 CoS 功能 | 越过 ⑤/⑥，扩大迁移风险 | 拒绝；明确交接接口与最低连续性验收 |
| 删除整个 brain/voice 目录而不提取业务 | 日报、问 Lead、会议与凭据隔离会丢 | 拒绝 |

## 调研问题

逐文件盘点删除、保留与提取；核对标准身份是否已存在；核对 ①/③ 合同与当前实现；检查 runtime state、4 个名册附加字段和所有外部消费者；定义 cutover/rollback 的单写者边界及证据。

Lead 已答问题：`9c72c361-ffb0-4da1-85bf-8607ee4bb06e`（voice ⑤ 边界、R1 验收迁移、实现开始授权）。裁定详见 plan.md §8。
