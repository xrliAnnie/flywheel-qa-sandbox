# FLY-1831 Flag 治理 A9 收尾 — 实施计划
Issue: FLY-1831 (https://linear.app/geoforge3d/issue/FLY-1831/flag治理a9收尾包-每周扫描运行合同-finalize-qa-脚本退役-flag-墓碑对齐并1881-8-个直读-env-残余逐条对账)
日期: 2026-08-21
基于: research.md

## 1. 验收不变量

1. 每周日 08:00 `America/Los_Angeles` 固定槽；漏槽补跑，同槽至多一次；无周期 env/config 旋钮。
2. 每个槽都尝试发布 HTML、Discord 根消息和自动 thread，包括 0 候选；外部故障不可伪装成功，也不可永久挡住未来槽。
3. Flywheel founder 面精确落到 `1516209289406971965`；根消息含 N 条摘要 + report URL。
4. sender 固定为 Cass bot；thread 内只精确 mention Tadashi，并另有带 thread 指针的 durable Lead inbox event；只有 mailbox `ACKED` 算 intake，Tadashi `DEAD` 或 Lead lease liveness 明确非 `alive` 才 fallback Cass。
5. thread 回复仍由 Lead 按 FLY-1781 runbook 写 verdict + preflight；不回复不改变任何 flag；永不自动删。
6. 五个 FLY-1808 workflow 墓碑不再由 `qa-generalized` 注入、断言或 attestation。
7. pending run 固定 24 小时上限；超时/跨槽时 durable escalation + unsettled legs degraded，下一槽继续，无周期旋钮。
8. 8 个 env 的最终分母严格为：3 delete + 3 exemption + 2 existing registry；0 new flag。

## 2. TDD 波次

### Wave A — 固定周槽与“0 候选也到货”

RED：

- 在 `flag-retirement-scan.test.ts` 加 PT Sunday 07:59/08:00、PST/PDT、missed-slot catch-up、同槽不重跑、下周重跑。
- 把现有“空 DB 后等固定 7 天”改成日历槽合同。
- 增加 0 candidate 仍欠 `linear/report/discord` 的断言。
- 增加永久 ambiguous run 在 24 小时后告警、按原状态 settle degraded、释放下一 Sunday slot；跨槽恢复也不得只返回旧 pending。
- 增加 founder root+thread 未到货时 askCount CAS 回滚；root+thread 已到货但 mailbox 未 ACK 时不回滚；run-level `published` 只表示 settled，腿级状态才表示 delivery。

GREEN：

- 在 `flag-retirement-scan.ts` 增加纯日历函数和固定常量；`scanIfDue` 只比较 latest committed 与最近槽。
- `owedLegs()` 始终创建 founder 三腿；clock debt 继续额外欠 `lead_notify`。
- `StateStore` 增加一个 CAS 式 stalled-run settle 方法：保留已完成腿，把其余腿写成带原状态/固定原因的 `degraded`；仅当 Discord evidence 缺 root/thread 时，同事务回滚本 run 尚未被后续 run 取代的 askCount；scanner 先投 durable Lead inbox failure event，后 settle，并在同一入口继续 due 计算。
- 更新 registry 文案为“Sunday 08:00 PT”，稳定值 7d 文案保留。

### Wave B — Discord root → thread → handoff

RED：

- `flag-retirement-production.test.ts` 覆盖：sender token `/users/@me` 必须是 Cass、精确频道、单根消息、`markAutomatedDiscordText` 的 canonical prefix、thread、只 mention Tadashi、四证据 + mailbox delivery JSON。
- 覆盖 bounded preflight 的 post/thread/send 三步权限、21 天/fingerprint 再探规则、archive+seed-delete cleanup 非阻塞，以及 FLY-1726 canonical identity 路径下 Tadashi `access.json` core group + `allowBots` Cass membership。
- 覆盖 root 已存在但 thread/handoff/mailbox ACK 缺失的 reconcile；primary `QUEUED/LEASED` 不 done，`DEAD` 或 liveness 明确非 `alive` 才触发 Cass，fallback `ACKED` 才 done。
- 每个 `LeadAlertNotifier` receipt outcome 加反向测试：`sent` 也不替代 mailbox ACK，`queued_durable/deadlettered_durable` 更不得 settle handoff。
- 覆盖 Flywheel channel 配错、owner/fallback bot id/token 缺失、host/announcer fallback 时 fail loud。
- Bridge 不托管 Flywheel 项目时不构造 scanner 且不告警（隔离 QA slot / 其它部署的正常形态）；只有 roster 中存在 Flywheel、但 channel / Engineering Lead / CoS sender 等 owner contract 非法时，才经现有 `flag_scan_failed` 治理告警面上报并把 scanner 标为 unavailable，不新增 alert kind，也不得只 `console.warn` 后静默关停。

GREEN：

- 扩展 `resolveFlagScanOwner()`，返回 Engineering Lead 与绑定 core channel 的 CoS sender/fallback；sender 只取 CoS lead 的已解析 token/id。
- 增加可注入 fetch/fs 的 bounded preflight；它在 Discord leg 内运行，因此失败受 24 小时 stall breaker 管辖；dry-run 不执行。Cleanup 不要求 `MANAGE_THREADS` 且不阻断真实周报。
- 根消息直接走单 POST、强制 `<=1900` 且 marker 第一行；root/probe/handoff 全部调用 `markAutomatedDiscordText`，不手写/改动 shared prefix；增加窄 helper ensure thread 与 handoff。
- `findDiscordBatch()` 在找到 marker 后继续 ensure thread/handoff，并以 Lead mailbox settlement 为 intake authority。
- Discord 根消息改为 report-first；Linear 是台账链接，不把 founder 引向 issue thread。
- Handoff/扫描失败都投 `LeadInboxRuntime`：先 Tadashi，`DEAD` 或现有 lease liveness 明确非 `alive` 后投 Cass；只有 `ACKED` 算完成。新增 `flag_scan_handoff` 到 `ALERT_EVENT_TYPES` 与 `INFORMATIONAL_KINDS`。Unified alert 可保留为运维旁路，但其 receipt 不参与 leg done。证据记录实际 recipient/deliveryId。

### Wave C — 退役 qa-generalized 五变量

RED：

- 把 `test-deploy-generalized.test.sh` 改为反向断言：五个墓碑在 helper、wrapper、test-deploy 字节和生成的 Bridge/Lead env 中均为 0 引用。
- 保留 generalized config/engine authority/ambient scrub 的正向测试。

GREEN：

- 删除 `qa_generalized_feature_env`、`qa_generalized_write_env_attestation`、Bridge wrapper 的 attestation 参数/文件、test-deploy 注入与 room-info 字段。
- 同步 `doc/qa/framework/529-room-playbook.md`，不再教 operator 设置墓碑。
- 明确删除 `scripts/qa-fly-1707-incident-dispatcher.ts` 的四个墓碑注入；纯历史测试 fixture 留在 test-only 文件并由 FLY-1808 “ignored input”反向测试覆盖。

### Wave D — 8 个 env 逐条对账

RED：

- 新增 A9 exact-set 测试，逐项断言 delete/exemption/registry 三集合，避免以后又退回 `NON_FLAG_ALLOWLIST`。
- 对 3 条删除先把现有 off-path 测试改成“注入旧 env 不改变行为”或字节零引用墓碑测试。

GREEN：

- `ALERT_ROUTING`：Router 恒启用；unified alert channel guard 恒启用（仍要求 channel id 匹配）；删除 env 文案与 non-flag 项。
- `ALERT_TICKETS`：TS ticket enrichment/header 默认恒启用，保留构造参数做 hermetic test seam；shell 路径在 unified channel 恒渲染 ticket；删除 env/non-flag 项。
- `DETECTION_AI_CLASSIFY`：两个 runtime 构造点恒注入 classifier；删除 env/non-flag 项。
- 三个安全/QA seam 从 `NON_FLAG_ALLOWLIST` 移入 `FLAG_EXEMPTIONS`，均 `persistentEnvAllowed:false`，理由和 owner 必填。
- 两个既有治理 gate 不改行为，只由 exact-set 测试证明仍在 registry。
- 将三条删除的 env 名加入 `RETIRED_FLAGS`，`retiredBy: FLY-1831`，防复活。
- 删除 `flywheel-claude-profile` preserve allowlist 和 `qa-fly-1252`/`qa-fly-1082` 注入残余；逐项扫尽生产/QA 字节。
- 明确接受 ALERT 两项对“不继承 production .env”调用方从 OFF→ON 的收敛，补 FLY-529 mirror/sparse profile/liveness 定向测试，不再写成 byte-compatible。

### Wave E — 文档与运行合同

- 重写 `engineering/doc/FLY-1781-weekly-flag-scan/runbook.md` 的调度、频道、thread、答疑、失败与 generic adoption 章节。
- 记录 Flywheel 当前 exact channel 与零 LLM；明确 Linear 是 ledger、Discord 是 founder surface。
- 更新 `CLAUDE.md` milestone，最后一个 PR commit 再做文档收尾，避免过程里伪报测试结果。

## 3. 文件范围

| 范围 | 文件 |
| --- | --- |
| scheduler/orchestrator | `packages/teamlead/src/bridge/flag-retirement-scan.ts` + tests |
| Discord delivery | `flag-retirement-production.ts` + tests；Cass sender、bounded preflight、单根消息、thread/handoff/mailbox settlement helper；`LeadAlertNotifier.ts` 注册 informational `flag_scan_handoff` |
| persistence | 不加列；Discord 四证据仍装进现有 `discord.evidence` JSON；StateStore 增加 stalled-run settle 操作 |
| qa retirement | `scripts/lib/qa-generalized*.sh`、`scripts/test-deploy.sh`、对应 shell tests/playbook |
| flag truth | `truth.ts`、`exemptions.ts`、runtime read sites、`flywheel-claude-profile` preserve、qa-fly-1252/1082 注入、flag truth/drift/runtime tests |
| docs | 本文件夹、FLY-1781 runbook、最后更新 `CLAUDE.md` |

## 4. 风险与防线

| 风险 | 防线 |
| --- | --- |
| DST 导致 07:00/09:00 | IANA timezone pure tests 覆盖冬夏两个周日 |
| root 成功、thread 失败后假 done | reconcile 的 found 必须同时证明 root/thread/handoff |
| sender 无频道/thread 权限 | 固定 Cass token/id；Discord leg 内最多每 21 天/指纹变化做 post→thread→thread-send；cleanup 非阻塞，权限失败受 24h stall breaker 管辖 |
| bot message 被 Tadashi intake 丢弃 | canonical identity 解析 access path，检查 core group/`allowBots`；thread 只 mention Tadashi；另要求 Tadashi/Cass mailbox `ACKED` |
| mention 放开 `@everyone` | `allowed_mentions={users:[Tadashi exact bot id]}`，不设 parse；Cass 只走 mailbox DEAD/Lead 非 alive fallback |
| 单根消息拆分导致 thread anchor 漂移 | marker 第一行、直接单 POST、超 1900 fail loud |
| pending 永久杀死后续槽 | 固定 24h/跨槽上限；先 durable escalation，再把未结腿 settle degraded 并继续当前槽 |
| 未到货却增加“已问” | 只在 Discord evidence 缺 root/thread 时回滚本 run askCount；mailbox 未 ACK 但 founder surface 已到货不回滚 |
| `published` 被误读成全成功 | 文档/测试固定其 legacy 语义为 settled；delivery 只读 leg `done/degraded` |
| 0 candidate 报告被优化掉 | exact owed-leg + report HTML + Discord tests |
| alert rollout 固化使 sparse/QA caller OFF→ON | 明确接受行为变更；跑 Router/Notifier/lead-alert、FLY-529 mirror、sparse-profile/liveness 套件；依赖注入 seam 保留故障分支测试 |
| exemption 被常驻进 `.env` | `persistentEnvAllowed:false` + `validateFlagTruthEnvironment` 测试 |
| “推广”变成 inert config | 本单只写接入合同，不加入无 consumer 字段；多仓 adapter 单独实现 |

## 5. 验证矩阵

定向：

```bash
pnpm --filter flywheel-config test -- --run src/__tests__/flag-truth.test.ts src/__tests__/feature-flags-drift.test.ts src/__tests__/feature-flags-registry.test.ts
pnpm --filter flywheel-teamlead test -- --run src/bridge/__tests__/flag-retirement-scan.test.ts src/bridge/__tests__/flag-retirement-production.test.ts src/bridge/__tests__/lead-inbox-runtime.test.ts src/bridge/__tests__/lead-recipient-liveness.test.ts src/bridge/__tests__/infra-event-router.test.ts src/bridge/__tests__/infra-alert-wiring.test.ts src/bridge/__tests__/chat-thread-routes.test.ts src/__tests__/LeadAlertNotifier.test.ts src/__tests__/sync-flywheel-hooks.test.ts src/__tests__/claude-profile-cli.test.ts
pnpm --filter flywheel-comm test -- --run src/__tests__/mailbox-settlement.test.ts
bash scripts/__tests__/test-deploy-generalized.test.sh
bash scripts/__tests__/lead-alert-fly927.test.sh
bash scripts/__tests__/check-flag-truth.test.sh
bash scripts/__tests__/bridge-liveness-probe.test.sh
bash scripts/__tests__/qa-room-env.test.sh
```

全仓 gate（按 runner role）：

```bash
pnpm lint
pnpm -r build
pnpm test:packages:run
```

宿主资源规则指出全量 Vitest 会压生产 Bridge；若 canonical aggregate 因已知 host GUI/load 基线失败，必须保留原始失败并逐个 isolated 归因，不能把定向绿冒充整门绿。

## 6. 交付路线

1. 设计 review 直到 `APPROVED`。
2. TDD 实现并每个 Wave 更新 `progress.md`。
3. 提交、push，注册 code review gate；`CHANGES_REQUESTED` 必须修后开新 gate。
4. 创建 PR；最后 commit 更新 milestone/过程文档。
5. 交接中列出 updater 部署顺序：原子删除 live `.env` 的 `FLYWHEEL_ALERT_ROUTING`/`FLYWHEEL_ALERT_TICKETS` 两行 → static `check-flag-truth` → 后续独立部署窗口启动新 Bridge → 新进程健康后再跑 `--live`；旧进程仍保留启动时 env，不得用作部署前 live 判据。本 Runner 不改 live env、不重启。
6. `complete --route needs_review --pr <number>`；本 implement 节点不请求 ship、不 merge、不部署。

## 7. 会过期的结论

| 结论 | as-of | 重核 |
| --- | --- | --- |
| 当前 head 已含 FLY-1781/1808 | 2026-08-21 `aa9d05f5b` | `git merge-base --is-ancestor e54ece67b HEAD && git merge-base --is-ancestor 2df1fd06b HEAD` |
| production channel/env 事实 | 2026-08-21 | 见 exploration §7 |
| test 命令与 package 名 | 2026-08-21 | `pnpm --filter flywheel-config test --help`; `pnpm --filter flywheel-teamlead test --help` |
| sender/recipient live intake 事实 | 2026-08-21 | `jq` roster + Tadashi `access.json`；每个 due slot 仍以 runtime preflight 为准 |
