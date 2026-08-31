# FLY-2104 周扫描裁决通知 — QA 报告
Issue: FLY-2104 (https://linear.app/geoforge3d/issue/FLY-2104/flage扫描-周扫描裁决页改发-discordflywheel-notification不再建-linear-单)
日期: 2026-08-27
基于: plan.md

## 结论

代码与自动化验证已通过，可以重新进入 code review。R1 提出的 `no_clock` 债务泛滥问题以及 7 项健壮性/文案建议均已修复并补回归测试；R2 已 APPROVED，其 2 条非阻断建议也在最终 head 中消除。真实 Discord 投递与真浏览器截图尚未通过，原因不是代码测试失败，而是 founder 管理的频道 access 还缺两项准入；本报告不把这部分记成 PASS。

## 验收覆盖

| 验收项 | 自动化证据 | 状态 |
| --- | --- | --- |
| `POST /api/flag-scan/run` 在 404 前可达并真跑一轮 | `flag-scan-route-mount.test.ts` 从 Bridge app 发 POST，走真实 scanner 的 compute → commit → effect，断言 HTTP 200 | PASS |
| 周日 08:00 PT 路径不变 | `flag-retirement-scan.test.ts` 保留 scheduler 入口、时区与单飞行为覆盖 | PASS |
| 候选裁决页经 `publish-report` 投到通知频道 | `flag-retirement-production.test.ts` 覆盖 canonical CLI 调用、频道绑定、结果 thread、Engineering handoff、重放与部分失败 | PASS（自动化） |
| 0 候选发「本周 0 候选」 | 同一生产适配器测试断言只发一条 root message，不建结果 thread/handoff | PASS（自动化） |
| 不再创建 Linear 裁决 issue | 生产适配器已移除 Linear client/issue leg；测试断言 delivery contract 仅含 Discord（及可选 Lead 通知） | PASS |
| 消费 `value_last_changed` | config + StateStore + runtime 测试覆盖 `(flag, scope)`、`*` 回退、NULL 首次登记、`no_clock` 两次采样与不完整时钟 fail-closed | PASS |
| 浅色页、批注框、一键复制真浏览器 | markup 测试通过；当前 sandbox 无法启动 Chrome | PENDING |
| 真实结果出现在 `#flywheel-notification` | live access preflight 不满足，未发送 | PENDING |

## 自动化命令

- `pnpm lint`: PASS（仅仓库既有 warning，无 error）。
- `pnpm -r build`: PASS。
- 变更聚焦测试：config 19/19，teamlead 129/129，合计 148/148 PASS。
- `pnpm --filter flywheel-teamlead test:run`: 725 个文件、9,658 个测试通过、6 个跳过；8 个高负载/环境型用例在整包并发下失败，另有 1 个 worker teardown timeout。8 个失败按文件或单用例串行隔离复跑均 PASS，其中 `shell-publish.e2e` 需要把 npm cache 指到 sandbox 可写的 `/private/tmp/fly2104-npm-cache`。
- `pnpm test:packages:run`: 代码测试跑完后仅 `flywheel-core` 两个真实 macOS Terminal/osascript 用例因 sandbox 无 GUI 权限失败；排除这两个环境型用例后 core 219/219 PASS。
- `flywheel-config` 整包 679 个测试通过、1 个 5 秒并发超时，隔离复跑 PASS；`flywheel-claude-runner` 整包 912 个测试通过、2 个跳过、4 个超时/真实 tmux 竞态，逐项隔离复跑 PASS；`flywheel-comm` 整包 1,648 个测试通过、2 个跳过、1 个 5 秒 CLI 超时，隔离复跑 PASS。
- 排除上述已核验 package 后，未到达的其余 17 个 workspace package 全部 PASS。
- `git diff --check origin/main...HEAD`: PASS。

## Code review R1 修复证据

- 成熟的成功型 `no_clock` 回退只参与候选判断，不再同时进入 Lead 债务/ACK 队列；仍在等待第二次采样的记录继续 fail-closed。
- 手动 `force` 与定时扫描并发时会排队补跑一轮新的强制扫描；settlement 恢复后也重新计算，不再返回旧的 `not_due` 结果。
- 每次 `/reports/deliver` 调用都重新解析 infra sender token；Discord 网络请求增加超时；扫描可见租约由 2 分钟提高到 5 分钟。
- `commCliPath` 由 `flagScanRepoRoot` 显式派生，删除未使用的 core channel 常量。
- `value_last_changed` 按单个 managed flag 隔离读取；一条损坏 audit 只把该 flag 降级为 `no_clock`，不会拖垮整个 console/scan。
- 报告 hero 与 helper 文案改为准确描述 store 时钟和当前 Discord 结果 thread。

## Code review R2 与 rebase 证据

- R2 verdict 为 APPROVED。首次登记或刚变值的 `no_clock` 记录现在进入普通 sampling 状态，不产生候选，也不再制造 `lead_notify` 债务；异常的 NULL streak start 仍 fail-closed。
- 删除已失去生产调用方的 `recoverPending()`；定时入口与手动入口仍各自在运行前恢复 pending run。
- rebase `origin/main` 时仅 `plugin.ts` 有两处相邻新增冲突：holder 声明同时保留 FLY-2076 的 alert-duty 与 FLY-2104 的 flag-scan；Bridge options 同时注入两者。没有使用 `ours/theirs` 整体策略。

## 真实环境阻塞与后续清单

当前通知频道 ID 已配置，但 Engineering Lead 的 `access.json` 仍然：

1. 缺少该频道的 `groups[channelId]`；
2. `allowBots` 不含实际 infra sender bot。

这两项只能由 founder 通过 `/discord:access` 授权。生产代码会在每次投递前重新读取 access 与 `/users/@me` 身份并 fail-closed，因此现在强行发送只会绕过验收意图。Lead 已上报 founder。

授权与部署完成后必须补做：

1. 调用真实 `POST /api/flag-scan/run`，确认 200 且审计显示完整一轮；
2. 在 `#flywheel-notification` 确认 root、浅色裁决页与结果 thread；
3. 用真浏览器验证批注框与一键复制，截图附回本报告；
4. 确认没有新建 `flag 周扫描 · N 个候选` Linear issue；
5. 另跑一次 0 候选 fixture/窗口，确认只有「本周 0 候选」一行。

## 浏览器尝试记录

本 runtime 没有 `proofshot` skill。已尝试全局 ProofShot CLI 与 Playwright Chromium；两者都在 macOS sandbox 的 Chrome/Mach port 初始化阶段被 `Permission denied` 拒绝，未产生可用截图。没有用合成图或测试截图替代真实证据。
