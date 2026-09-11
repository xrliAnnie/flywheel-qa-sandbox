# FLY-2504 返工内容送达围栏 — 实施报告
Issue: FLY-2504 (https://linear.app/geoforge3d/issue/FLY-2504)
日期: 2026-09-11
基于: plan.md

## 实现结果

M0–M4 已实现。替身启动前解析持久化返工目标、加入稳定返工上下文和可选 QA 摘要。issue delivery 的 prepared/committed 证据携带内容 digest；原子启动标记仅接受当前 owner generation、delivery attempt、activation、preparedEventUid 对应的已提交证据。receipt UID 绑定 request/revision/execution，支持同请求第二代替身。

开放返工目标的 replacement completion 必须有本 revision/execution 的内容 receipt。拒绝会回滚 completion，原子写入单次 refusal/alert，并通过既有 undeliverable finalizer 开 operator hold。身份冲突只拒绝和告警，不改变 healthy delivery。CLI 收到这两类 409 不重试、不写 completion marker。操作员 public cancel 后可再次 complete。wake 绑定、普通非返工路径保留现有行为。

plan.md 保持 pinned blob 不变；FLY-2278 合同按本计划追加第二种 cause，inventory 仍是原有 19 种 hold shape。没有新数据库表、迁移、配置开关或 rendered UI。

## 验证证据（持续更新）

- RED：N1a 原实现返回 ok:true；CLI 两例原实现写 marker；enrolled completion 原实现返回泛化 transition_refused；M1 committed payload 丢 digest；dispatcher envelope 不含返工上下文；M2 原子方法不存在。
- 聚焦：8 套件 307 tests green；后续扩充 fly2504 到 24 tests green，含 N6 三种 wake 状态、N13 reconstruct fail-closed、N2b 两 revision、N14 通用 rollback/converge 的第二代 receipt。
- CLI complete 70 tests green；hold registry/undeliverable 等 M3 回归 77 tests green；Teamlead typecheck green。
- pnpm lint：通过，3346 files，15 个现有 warning、0 error。
- pnpm -r build：通过。
- pnpm test:packages:run 首轮失败：Teamlead 3 files failed / 969 passed；11 tests failed / 13083 passed / 7 skipped，另有 onTaskUpdate timeout。两项 transition loop 夹具未模拟返工送达结算，已复用同文件既有 settle fixture，76 tests green。未改动的 quota probe / StructuredInboxRouter 9 项失败与超时，单独重跑共 32 tests green；这不把首轮全仓失败改写为通过。完整第二轮在未改动的 claude-runner 停止：50 files / 1256 tests passed / 2 skipped，另有 onTaskUpdate worker timeout，exit 1。Teamlead 单包补验中，本改动相关 112+24+76 tests 全通过，但 quota probe 的负载相关失败复现；最终 package 统计见 PR。两轮全仓均未通过。
- 未新增 scripts/__tests__/*.test.sh。
- 本地日志：/tmp/fly2504-{all-focused,m3-focused,cli-green,final-matrix,full-lint,full-build,full-tests}.log。日志为本机执行记录，不是 host/production 演练证据。

## §4(a) 生产只读预检

受管快照工具返回 snapshot_owner_unavailable，owner endpoint 返回 401；未绕过 owner、未复制数据库、未作生产修改。Lead 回答问题 7f537a8f-bbf0-4c79-9a89-0104989b506c，要求原样收录下述回执：

> 裁定 7f537a8f:§4(a) 预检 SQL 我已在生产库只读试跑(sqlite3 -readonly ~/.flywheel/teamlead.db,plan 原文逐字,含 R4 #2 的 length=64 + NOT GLOB)。收据:ts=2026-09-11T03:37:34Z rc=0 命中 count=5(全部 wake_delivered 行共 17 条);命中行:rework:bd1185a3a0a2af8a2bac043ba935433a13d42f0b2e24aaefdb248f9d80977f19  2         78205324-f115-415b-879c-1a6cfca3f56b  2026-08-20T19:29:52.439Z;rework:bbc284f0a189e145f93d18c6da18d70dbba02c4cd671cc4d68c30b91091c0ab1  2         d15df6e8-288a-44d8-aaf0-1d9c7c3b135f  2026-09-07T22:52:56.701Z;rework:f1553bddfd0fbfa611ffb815f3a576459d45800983d55b45650bee2d7b22ad1d  3         6ea20bb7-7cd8-4127-8308-899771fb36df  2026-09-07T22:53:07.513Z;rework:d20282f2c3e95876bf75122aba5983f93f80ef03464e20d67319d6d94726c99b  2         cf7b4751-b632-402d-aa4b-a68697490214  2026-09-09T10:00:26.457Z;rework:25512c659。你把这条收据原样写进 implementation-report 的 §4(a) 段即可,不需要 snapshot owner;真正的 deploy 前后各跑一次由部署清单承担。

以上是 Lead 提供的生产查询回执，本 runner 未独立读取生产库。count=5 是 Lead 报告的计数。Lead 后续消息 a75ce8f1-c291-4fc5-8703-efe1bf80398e 补全第五行（与前四行同一 03:37:34Z 查询）：

| request_id | revision | preferred_actor_execution_id | updated_at |
| --- | --- | --- | --- |
| rework:25512c659b9b3c11b87320e9e74aa84f5a625a22eddbeaa35fce4a141908ab85 | 2 | 383d876a-3505-40be-b0cd-9bc870477b5f | 2026-09-09T10:00:33.738Z |

## 部署与回滚交接

部署方应在部署前后各执行 pinned plan §4(a) SQL，保存完整命中项与处置结果。旧 wake_delivered 缺 receipt 的行在新代码下下一次 complete 会进入 operator 面；由 Lead 通过 public hold cancel 处置。不要直接改 delivery 数据。

回滚有条件：先按计划列出 replacement_pending 的返工目标，确保不存在靠新围栏等待收敛的 intent，或由 Lead 先处置。否则旧版可能恢复本 bug 的裸启动。此处仅记录部署/回滚清单，未执行部署、重启、回滚或生产 mutation。

## 尚待交接门

代码审查已注册（gate c33c64f8-3943-409d-bccf-1da174f2a1c1，request f9b08a94-8d0b-4899-8950-2f1aff004cb4）。两轮全仓失败已记录；代码审查结果、PR exact-head CI 三分片及 needs_review completion 尚待完成，结果由 PR/正式交接回执补充。N4b 的 dispatcher 测试验证 owner redrive 与逻辑 session/binding 复用；真实物理 session/goal 属运行器既有幂等协议，不将 fake dispatcher 称为现场证据。


## 已知限制与 Lead 裁定

Lead 对问题 1e48f297-c5b8-4d6c-aab6-2b5ca27140ea 裁定：不扩 scope、不改 pinned plan 合同，明确 defer legacy completion-hold-first 的组合恢复。

已验证 N13：无内容 receipt 时，completion_receipt_missing 的 public resume 内部 reconstruct_completion 抛 rework_content_not_delivered，整个 resume 回滚，run 仍 held，无 completion 行。已验证 N15：active run 的 enrolled complete 先被 M3 拒绝并建立 rework operator episode，再 public cancel，随后 complete 成功。

未验证、且当前 public producer 无法顺序建立的组合：两个 hold 同时存在并逐一恢复。两个 producer 都要求 run.active；completion hold 先发生时，public resume 也会被新 guard 拒绝，因此不能把“先 resume 回 active，再 complete 开 operator episode”写成可执行恢复方案。已将此证据回报 Lead；这项 legacy 恢复属于后续工作，本 PR 不声称已解决。

M0/M3 按 plan SQL 仅查 state <> completed。计划另述的 completed+receipt 分支不可达，实现未引入该死分支；pinned plan 字节未改。

最终补充：N4b 验证新 owner gate token 不同于旧 token，旧 generation 的 fencedCommit 被拒绝；dispatcher 全部 112 tests 再次通过。批准计划 blob 保持 da823d2cb14183c5924e4257ebf2edcb87a3ef57。

## Code review R2 阻断项修复

Gate c33c64f8 的 current-head request 426a4f76 在 f75b9e09f 返回 CHANGES_REQUESTED，唯一 HIGH findingKey：rework-content-episode-root-uniqueness。

旧 attempt 的 open episode 可以在 remint 后继续存在；新 producer 仅按 attempt_id 关闭 episode，但唯一索引按 family/root_id 限制 open 行，导致整个 refusal 抛 UNIQUE 错误。新增测试复现精确错误（/tmp/fly2504-review-root-red.log）。最小修复改为按 family='rework' + root_id 关闭 open episode；保留同一事务和既有关闭原因。GREEN：4 files / 43 tests，包括新测试的旧 episode 关闭、新 episode 唯一、completion 无写入、hold/alert/refusal 和重复拒绝幂等（/tmp/fly2504-review-root-green.log）。

本轮仅修该 HIGH。以下四项 advisory 留待后续，不改 pinned plan：
- replacement-markstarted-silent-noop-on-nonreplacement-binding：无已知可达正常入口，保留作为防御性后续。
- replacement-fast-complete-window-holds-run：极快 completion 在 receipt 落盘前会 fail-closed 进入 hold。
- rework-digest-base-revision-normalization-skew：现有所有 writer 已规范化，仅防御性统一建议。
- dead-mark-rework-replacement-launched-wrapper：当前作为严格兼容 wrapper 留存，仅两个旧测试调用；后续可迁移并删除。

f75b9e09f 的 CI 全部通过，但它不包含此 HIGH 修复。修复后的 HEAD 需新审查与新 CI；保留先前两轮本地全仓失败回执，遵循 Lead 不重跑 host contention 的裁定。

## R3 修复与最终 R4 送审范围

R3 request 2e5a479f 在 5dd5239c8 返回 HIGH findingKey=rework-content-episode-id-not-projector-stable。按 Lead 要求先停代码并提问；问题 b17d891a-f90c-40a3-8dcb-f1683e8c835a 明确授权限定修复，同时要求合并 MEDIUM-1，一次推送后 R4 封顶。

- HIGH：真实 DeliveryContractWatch.runPass 在活接收者下删除自定义 episode，在死接收者下重建为 NULL run_id 的 episode，破坏 public cancel。两条 RED 见 /tmp/fly2504-review-sweep-red.log。projector 现在仅保留同 family/root、同 live attempt、确定性 refusal-owned ID、stage=undeliverable 且记录 run 仍 held 的 episode。run 不再 held、attempt settled/superseded/consumed 或其它 terminal 时走原清理逻辑。稳定 ID 生成由 producer/projector 共用，未改变 ID 字节。
- MEDIUM-1：原子 replacement start 对 binding 缺失/非 replacement 明确返回 rework_replacement_binding_required；两条 RED 原本返回 ok:true/updated:false，见 /tmp/fly2504-review-binding-red.log。dispatcher 已有的 !ok 处理负责拒绝标记，无额外正常路径改变。合法 receipt 的幂等重放仍通过。
- GREEN：5 files / 161 tests（含真实 sweep 后 public cancel 的 live/dead 两例、settled/superseded 负向清理、missing/wake binding 拒绝、合法 receipt 重放）；8 files / 50 projector/hold/reroute/retention 回归。日志 /tmp/fly2504-r4-focused.log、/tmp/fly2504-r4-projector.log。
- MEDIUM-2 保留：receipt 落盘前极快 completion 进入 hold 是 pinned plan 的 fail-closed 选择；不提前认定内容已送达。上面的修复确保此 hold 不被正常 sweep 破坏，仍可由操作员处置。两项 LOW 继续作为后续建议，不修改 pinned plan。

R4 若非 APPROVED，按 Lead 上限停止并请求裁定，不自行继续改代码。新 HEAD 的审查/CI 结果由 PR 与正式交接回执补充。本地 aggregate 失败仍单独保留，不由 focused/CI 结果替换。
