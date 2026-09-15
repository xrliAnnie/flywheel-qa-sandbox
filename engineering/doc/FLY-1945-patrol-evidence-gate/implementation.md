# FLY-1945 巡检证据与机制缺陷 — 实施记录
Issue: FLY-1945 (https://linear.app/geoforge3d/issue/FLY-1945/巡检体系-仪器假报修复-机制缺陷完成门并-1952)
日期: 2026-09-14
基于: plan.md

## 实现与边界

按有效设计审批 `919671d9-769e-4ed6-bd8b-f20cf0238601` 实施；本轮重新查询返回 APPROVED。设计的非阻塞建议保持原 follow-ups.md 范围。

- `patrol-continuity.ts` 提供语义/远端 ref reducer、v2 sidecar、完整性检查。计时不再来自终端渲染行；旧 TSV 保留用于整体回滚。
- `patrol-continuity-collector.ts` 只读 StateStore/CommDB，核对 exact execution、不可变 worktree binding、workflow activation/TURN 和项目注册表。普通实施节点没有 optional baseline/PR 仍可观测 root ref。真实 activation 使用 `activation:...`，不是仅 UUID。
- `patrol-report.ts` 扩展 schema=2 和机制声明/三选一去向的一一对应，保留原 Bridge 与 DWELL 的 awk 检查。JSON receipt 校验是报告闭合证据，不能代替服务端权限或 Lead 对根因的判断。
- `patrol-continuity-cli.ts` 和可信 realpath launcher 提供 sample、validate-report、原候选 recheck。快照一次采集所有 owned executions，逐 pane 输出 ACTIVITY_EVIDENCE/ACTIVITY_RECORD，错误仍保留完整行数与既有 quota/menu/capture/hash 证据。
- 发行 allowlist、strict symlink、payload audit、shell CI 枚举与 retention consumer 分类一起更新。SIGKILL 仅针对测试创建的锁 helper；kill inventory 记录为 qa-only。

没有生产 schema 迁移、状态机写入、派工器、定时器、GitHub/Linear 写 API或服务重启。Linear 去重、写后回读及不立原因由 Lead 按规则执行，helper 只检查报告闭合。

## TDD 证据（最终汇总待补）

| 批次 | RED | 当前 GREEN |
|---|---|---|
| 语义 reducer | 12 个行为断言失败；包含原日期 %7/%8 四次观测 | 12/12；21:37:49 两行 ACTIVE，%8 保持原始 3489 秒窗口 |
| sidecar | 初始 7 项失败；另复现 identity 不可读后错误累计停滞时间 | 9/9；包括真实 SIGKILL/重取 kernel lock |
| 报告门 | 初始 24 个断言失败，补充 STALLED 关联及毫秒边界 RED | report 50 + 原 awk 33 通过 |
| CLI | 缺入口失败；篡改机器身份反例先红 | 4/4；纯报告验证不打开数据源 |
| collector | 缺实现 RED；真实 composite activation 反例先红 | 29/29；未知 exact-node 与 node-less run/loop 跃迁明确断开覆盖 |
| snapshot | 375 通过 / 10 失败（8 项新功能、2 项测试日志计数）；第二轮 383 通过 / 2 失败（capture/hash 原因被覆盖） | 已修复原因优先级，第三轮日志缺结束回执，不能计为通过；已启动新一轮完整验证（新增原候选 recheck、legacy TSV 字节不变此前已通过） |
| package-onboard | 33 通过 / 1 失败（helper 未入发行闭包） | 34/34 |

详细终端日志在本轮 `/tmp/fly1945-*.log`；最终 summary 将记录退出码、测试数与日志摘要哈希。完整聚合测试仍在运行，以上定向 GREEN 不替代聚合 gate、代码评审、exact-head CI 或 QA 接受。

## 已验证的发布路径

`pnpm -r build`、`pnpm lint`（现存 warnings）、`fly1577-cmux-bin-closure.test.sh` 31 项、`package-onboard.test.sh` 34 项、source/managed/payload launcher smoke、CI shell 枚举、retention consumer gate，以及 kill inventory 5 项通过。

## 运行边界

活动结论仅对观测区间成立。ref 轮询不能证明区间里绝无 A→B→A 推送；保留 STALLED 的原区间、精确 ref 和复核入口，任何精确同期反证都必须撤销相应唤醒动作。新 ref 进展可使当前候选失效，但不把 PR updated_at 或提交作者时间冒充推送时间。

测试只使用临时数据库、假 gh/tmux 和本地打包树。本阶段未进行真实生产巡检、部署、重启、QA 派发或 merge；后续 host/QA 验证由独立流程负责。

## 代码评审第一轮修复

有效 verdict `CHANGES_REQUESTED`，reviewed head `07b777d39dbfc441dd6896c2b4a47e5ffa871382`。唯一 HIGH `competing-writer-veto-stale-running-row`：竞争 writer 必须同时在 StateStore 处于 running；completed/terminated 的 CommDB 残留不再阻断 exact head 反证。真实临时 DB collector → reducer 测试先得到 2 failed / 30 passed，修复后 collector + reducer 为 44 passed，退出 0。日志 `/tmp/fly1945-stale-writer-{red,green}.log`。其余五项非阻塞建议保留在 code-review-round-1.json，未扩展本次修复范围。新头复审、全量验证收尾、PR 和 exact-head CI 尚待完成。

## PR 前验证更新

2026-09-14：修复 HIGH 后 `pnpm -r build` 退出 0；`pnpm lint` 先发现测试 import 排序错误，整理后退出 0（既有 warnings 保留）；可信 launcher source/managed/payload smoke 退出 0。对应日志为 `/tmp/fly1945-build-review2.log`、`/tmp/fly1945-lint-review2-green.log`、`/tmp/fly1945-launcher-review2.log`。快照全套 session 52927、包门 session 2112 正在运行；旧聚合 summary 没有 finishedAt，不能计为完整通过。代码复审 question `321bcba9-26b8-4e81-9010-64a7a88674b9` 已注册。最终门回执通过 Comm 报告及 PR validation 更新补齐，不将这些 pending 项当绿。

## Lead 追加的有界评审修复

依据 `[lead-instruction b8a77904-1bc7-4a1b-87b5-475d812a943c]`，恢复指定 stash `2f94527593c2f09ea56a138445c5b30940428a89`，在 HIGH 之外处理三个 MEDIUM：

- `long-task-declaration-ignored`：识别有到期时间且未过期的 long_task，续期不制造状态进展，到期/缺期限不豁免。此项由新 Lead 指令覆盖 plan §3.2 原 long_task 取舍。初始 1 failed/32 passed；补期限反例仍先红，再绿。
- `sidecar-entries-never-pruned`：CLI 显式传递 inventoryComplete；snapshot 只在 owner index 完整、无冲突、pane 清单可读且全部 owned targets 被采集时声明完整。达到 2000 行上限的 index 不冒充完整；不完整时保留条目。CLI 先 2 failed/9 passed，再 11 passed。
- `unknown-activity-suppresses-step2-findings`：连续性 UNKNOWN 不覆盖真实 finding 的 STEP 2 状态，同时保留逐 pane UNKNOWN 和 UNAVAILABLE_CAUSE；hash/capture 等既有故障规则保留。

快照集成反例在真实临时 DB/假 tmux/gh 上得到 39 passed/2 failed（`/tmp/fly1945-snapshot-medium-red3.log`），最小接线后 41 passed/0 failed（`/tmp/fly1945-snapshot-medium-green.log`）。测试准备中的错误 execution ID/非法 CommDB status 已纠正，不将其当作产品 RED。七组定向检查共 170 passed（`/tmp/fly1945-medium-focused.log`）；MEDIUM 前的完整快照为 387 passed/0 failed，最终完整快照与包门继续收尾。两个 LOW 明确留在 follow-ups.md。

恢复 stash 还持久化 canAttributeRemote，避免跨不明确 writer 区间将分支变化归功给当前 runner；有分支变化但无法归属时 UNKNOWN，不允许 STALLED。此改动随同本轮复审。

PR 前补充：最终规则/注入 59 passed，source/managed/payload launcher 退出 0，lint 退出 0。日志 SHA256 索引见 implementation-verification.json；全量快照、package gate、code review、PR CI 仍为独立 pending 门。

## PR #1198 首轮 CI 修复

精确头 `5ded28ea26ca75b5347f704e83695ed72f414788` 的 CI run `34907636431` Quick Gate 在 CI structure 守卫失败：workflow 已加入 FLY-1945 launcher 测试，但 `ci-structure.test.sh` 的固定 script-tests-3 清单漏同步。只补一项，原命令先退出 1、再退出 0；shell/Node CI 枚举也退出 0。日志 `/tmp/fly1945-ci-structure-{red,green}.log` 和 `/tmp/fly1945-ci-enumeration-final.log`，不是产品断言放宽。旧 CI 保留 failure，不借其他 job 的成功改写结论。

## 精确头 CI 第二轮与最终快照

完整快照测试退出 0：392 passed / 0 failed，日志 hash 见 implementation-verification.json。`9dfc0c6cd` 的 CI run `34907860983` 已通过 Quick Gate、全部 unit 分片和 payload 分发；两个 shell job 的失败已定位：

1. converge-fly1389 / fly1577-alert-arrival 的临时可信仓库与稳态链接清单遗漏新增 launcher，触发不属于测试场景的缺失源告警。只补 fixture：前者 9 passed / 13 failed → 22 passed / 0 failed；后者 4 passed / 10 failed → 7 passed / 0 failed。普通 converge-flywheel-bin 15 passed。
2. fly1674-residue 需为已批只读 collector 登记现存 three_stage_turn 表访问。只加两个 exact path/token 例外，沿用已有只读巡检和 QA 消费者格式；旧 dispatcher 仍被禁止。76 passed / 1 failed → 79 passed / 0 failed。

本轮只改上述三份测试，不修改产品逻辑。保留失败 CI 记录，新提交头需重新通过 CI。新 review request `3db3bb4e-7435-435c-a3ae-94142e09d523` / gate `caab0840-f3c2-495e-bf0b-c58f9e6c28e2` 在超时后幂等重试获得 accepted=true、duplicate=true；有效 verdict 仍待返回。

## 宿主容量指令：停止本地聚合

依据 `[lead-instruction 87babdab-fcc9-4169-870a-828818781d16]`，本地完整 package gate（session 2112）已发送中断并确认 handle 消失，日志无完整 finishedAt。状态记录为 **interrupted — not relied on**；部分结果与争用红均不作为交接依据，不重启该聚合。保留聚焦结果；最终精确头 CI 是交接测试权威。未停止任何生产服务。
