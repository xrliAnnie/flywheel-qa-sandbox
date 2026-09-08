# FLY-2443 Claude Lead Discord 入站 fail-closed — 实施记录
Issue: FLY-2443 (https://linear.app/geoforge3d/issue/FLY-2443/通路claude-claude-lead-的-fail-open-旁路改-fail-closed缺-env-不再绕过-mailbox)
日期: 2026-09-08
基于: plan.md

## 结果

Claude Lead 的 Discord 入站在 `FLYWHEEL_COMM_CLI`、`FLYWHEEL_LEAD_ID`、`FLYWHEEL_EXEC_ID` 任一缺失或 capability probe 失败时，不再直接推进会话。插件先持久化 rejected intent，再添加 `⛔` 回执；主仓 CLI 将失败记录为 held mailbox 行并触发告警。恢复后，插件按原始顺序把 held intent 重放进 mailbox，正常路径仍是 mailbox → batch → MCP channel 注入。

Codex 入站路径未修改。

## 最小实现

### 主仓 `flywheel`

- `discord-chat-ingest` 接收 `--held-reason` / `--held-since`，原子写入 held mailbox 行；同一来源键保持幂等。
- held 行使用每个 Discord chat 独立的 collapse key；claim 只对该精确 key 放宽普通 30 秒时间窗，因此同一故障期间的消息合并成一条恢复说明，同时保持原始 `created_at`、顺序、分区和批量上限。
- CLI 输出协议升级为 v2，显式返回 `deliveryState`，DEAD 行不会触发会话 nudge。
- stale held 行转 DEAD 与告警 intent 创建在同一事务中；审计脚本和回滚身份测试覆盖新协议及产物。

### 嵌套仓 `claude-plugins-official`

- 插件在正常路由前执行 mailbox capability probe；缺配置或 probe 失败即进入 broken mode。
- broken mode 先以原子 rename 持久化 rejected intent，再添加 `⛔`；写入失败时不发送误导性回执。
- 恢复 probe 后按文件顺序、单头阻塞和指数退避重放；成功落入 mailbox 后才删除 intent，避免丢失或重复推进。
- malformed attachment 若无法通过 rejected-intent 校验，会保留消息、route、ID 和时间，仅丢弃非法附件元数据后再持久化；随后仍走 hold + `⛔`。
- 插件版本从 `0.0.6` 升至 `0.0.7`；本任务未执行部署或 Lead 重启。

## TDD 与验证

- 三种 env 缺失分别覆盖：不推进会话、持久化 rejected/held 状态、Discord 显示 `⛔` 未投递。
- capability probe 失败、恢复重放、写盘失败、重复回调、乱序/头阻塞、stale DEAD、malformed attachment 和同 chat 故障批次均有回归测试。
- 健康路径覆盖 mailbox 入队、batch claim 与 MCP channel 注入；既有行为不变。
- `flywheel-comm`：143 个测试文件通过，2068 个测试通过，2 个跳过。
- Discord 插件：14 个测试文件通过，227 个测试通过，599 个断言；bundle 成功（742 modules）。
- TeamLead healthy injection：25/25；审计 shell：10/10；插件运维 shell：26/26。
- `pnpm lint`：退出码 0，保留 14 条与本任务无关的基线 warning。
- `pnpm -r build`：22/22 workspace 成功。
- 本地全包门禁使用单进程执行，并明确排除会打开 Terminal.app 的 `tmux-viewer.macos.test.ts`；精确结果与 PR exact-head CI 记录在 PR。

## 评审与裁决

- 主仓 code review 在 `771cca376b647a0f23c11204820e70449c80a9ee` 通过；Lead 要求把同 chat 的故障补充说明折叠为一条，已由 `23d56b937` 修复并由 `1fd0b66ec` 格式化。
- 插件 code review 在 `64659e3a2b9ff36014a65cd6863ae689cae4c5a7` 通过；Lead 要求 malformed attachment 仍能 hold + `⛔`，已由 `e5731de` 修复。
- 两项均按 Lead 指令修复后直接进入 QA，不再开启新评审轮次。

## 明确留待后续

主仓：

- 审计脚本会把预期的 `discord_wiring_broken_stale` DEAD 计为失败。
- DEAD nudge 抑制目前是独立 shell/source guard，不是 CI vitest；该 guard 可能静默回归，应单独建项。
- CLI 支持仅传 `held-since` 而无 `held-reason`，诊断不完全对称。
- TypeScript 类型未在编译期编码 held 字段成对约束。
- 回滚测试比较整棵树，但未单独断言 identity 行。

插件仓：

- protocol-v2 不可用且 rejected 队首损坏时，可能要等新流量或重启才再次尝试。
- shared state dir 配置错误时，无 `leadId` 的旧 held intent 可能在迁移中被另一 Lead 接管；这是 Raya 多 Lead 共享状态目录的独立迁移风险。
- 若能力永久不恢复，rejected spool 尚无保留期限。
- 已存在的损坏 intent 会被归类为 conflict，标签不够精确。

以上均为本次评审的非阻塞 follow-up，不改变 FLY-2443 的验收结论。
