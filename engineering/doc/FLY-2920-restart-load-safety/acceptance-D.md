# FLY-2920 审查尝试退休 — 实现验收
Issue: FLY-2920 (https://linear.app/geoforge3d/issue/FLY-2920)
日期: 2026-09-26
基于: plan.md

D 的局部实现、端到端恢复、相关守卫与依赖验证已完成；最终结果见末节及 verification-D.json。下方早期子批记录保留红/绿与失败修复证据，不代表有效 review gate、完整 CI、QA 或生产验证。

## 持久化子批

StateStore additive migration 增加 attempt_generation/retired_at、复用绑定退休原因与来源代数、codex_review_attempt、review_recovery_notice。认领 CAS 加代数，所有异步写入口可带代数 fence；退休不答门、不自动排队，原预算与身份不可因重启续期。通知 delivery 与 acted 分开。缺原预算/身份的 legacy 一次转 operator_required，不编造新预算。现有 session-not-found fallback 的窄身份更换保留原预算。

子批 RED 7/7 缺功能失败；初始 GREEN 7退休 +49既有review +11稀疏迁移=67通过。加强后12退休通过，另保留 FLY1560 teardown7通过。子批 typecheck 曾通过（在最终 fallback 与后续修订前）；最终联合检查另行运行。

规格复核发现 follower 退休通知 (own R,source generation,stage) 与后续 own lane 初代冲突。新增回归在旧实现红（期望2，收到1），release 事务现在从已有 own-R 通知最高代数开始，下一认领不会重用旧键。修后13/13通过：`/tmp/fly2920-D-{follower-generation-red,store-final}.log`。

扫描排序保留原预算到期优先，未到期按 next_probe_at/request_id 推进持久游标。新增慢项公平性回归最终旧查询红、修后绿：`/tmp/fly2920-D-cursor-{red-final,green-final}.log`。此前 cursor-red/green 的夹具用了真实退休时间却查询更早时间，均失败，不能算该修复证据；最终夹具固定 retiredAt 后已重做。规格 blocker 已关闭，存储质量复核通过。

## 上层早期验证记录（最终结果见末节）

- coordinator boot/stop 两条原实现行为红，基本退休/停止 fence 两条绿：`/tmp/fly2920-D-coordinator-red-original.log`、`/tmp/fly2920-D-coordinator-green-initial.log`。最初 red 日志混入尚未完成的存储 API，已另用原始 StateStore 副本重做，不能将前者当全部行为红证据。
- CLI 新 checkWithReviewRecovery 保留同步 check 兼容；只有原 owner 的 pending review gate 查询认证 status，其他 gate 零 HTTP；网络/数据库失败仍 pending。真实隔离 HTTP +临时 CommDB 测试及既有 commands/completion-obligations 合计3文件59通过：`/tmp/fly2920-D-check-{red,green,regression}.log`。
- status 方法门绑定用例红/绿：`/tmp/fly2920-D-status-{red,green}.log`。生产 endpoint 已写，实际生产组合根 HTTP 接线验收仍待完成。
- 本子批当时尚未完成作者 hold、恢复 pass、身份预算与端到端接线；后续完成证据在下文。


## 上层完成与回归补证（尚待最终选集、构建、有效评审）

- 真实 StateStore/CommDB、生产 notice sink、MailboxQueue/RunnerMailboxLane/production delivery adapter、持久 gateHold 和真实 daemon runtime 的组合测试 8/8：`/tmp/fly2920-D-integration-holder.log`。只有物理 reviewer/transport 被隔离。作者实际工作 turn 执行 HTTP check/reissue；覆盖 CommDB/marker 两条路径、ACK 后 daemon 重启、首次 enqueue 失败、enqueue 后未 stamp 重放、held→ready 再唤醒、并发同 R/Q 一次 spawn、原 verdict/另一门不变、已存 verdict 与已提交 authority 的重启复投。新增投递成功且 ACK 后节点换人用例，两条 hold 路径均零作者 turn。
- 生产 `/review-requests/status` composition root 的实际 HTTP 鉴权、原门绑定、缺 coordinator/数据库失败和最终答门 1/1：`/tmp/fly2920-D-status-http.log`。
- reader 对已过期 gate 的红/绿后，CommDB 8/8；当前增加 workflow TURN fence 后 RED 原实现仍返回旧 notice，GREEN 9/9：`/tmp/fly2920-D-holder-reader-{red,green}.log`。消费时精确检查 execution/run/node/attempt；不以传输 ACK 当模型处理完。
- sink 原 holder replay 的 queued wake 撤销与 marker RMW 竞态已修；13/13：`/tmp/fly2920-D-sink-review-green.log`。生产 sink 不写 optional marker hint，避免覆盖最终 answeredAt；独立持久投影提供同一唤醒来源。
- 原 follower own lane release 也必须标旧 notice acted，原红/修后绿：`/tmp/fly2920-D-follower-action-{red,green}.log`。
- 作者 gate-hold 修复经过规格/质量复核：pause 必须确认，owned repair turn 结束前不 resume；缺 response turn id 时使用 buffered started id，旧实现 timeout 红，修后两例绿：`/tmp/fly2920-D-author-turnid-{red,green}.log`。
- Coordinator 既有回归曾发现6条quota认领代数问题及2条旧语义预期，已修。全文件153通过、2条既有5秒夹具在重负载超时；两条不改代码单独重跑通过，日志 `/tmp/fly2920-D-coordinator-regression2.log`、`/tmp/fly2920-D-retry-focused.log`。不能把第一次全文件结果写成全绿。
- 无真实宿主 ps 权限，physical identity 仍是隔离快照/真实子进程接缝证据；不声称生产机器身份探测已验收。
- 2026-09-26 12:23 PDT 宿主 load 82/111/131。kill inventory 3条、FLY1560 lexical 1条仅计时超时，需不改断言的重跑；未以扩大超时或完整包测试绕过。设计注入初加的 DOC-FLOW fixture 缺 Codex 工作树，改由现有 Codex prompt fixture 承担该断言。

- 恢复回合新发现 cross-kind 饥饿：原实现慢 probe 或100条 due attempt 会占满每轮，通知/acted 无法执行。红2条，修后10/10及 test-file related10/10。现为先处理原期限到期项，probe≤50条/2秒，通知+acted 依持久 delivery_attempt_order 合并≤50条，共享剩余总5秒；不增加总100条预算，不把迟到 probe 当有效回调。
- 独立质量审查找到 boot failed-source 分支仍会自动放出 follower。新测试原实现 spawn=1（期望0）RED；boot 排除退休原因、own-lane helper 在异步前后拒绝非显式退休释放后 GREEN。`/tmp/fly2920-D-boot-follower-red.log`、`/tmp/fly2920-D-boot-follower-green-final.log`。第一次绿色候选仅 fixture 将可选 released_at 误期望为 null，已改按既有 undefined 类型合同断言；生产零 spawn 当时已通过。
- affected package+dependencies build通过：`/tmp/fly2920-D-build-final.log`，但发生在最后 boot/follower 与嵌套 target repo 修正之前；最终重建仍待执行。稀疏迁移11/11通过，`/tmp/fly2920-D-sparse-final.log`。
- kill inventory、FLY1560 lexical、child-process census、compatibility hash、wall-clock AST、feature flag drift 均不改断言重跑通过；对应 `/tmp/fly2920-D-{kill-inventory-retry,teardown-retry,census-retry,compat-final,timeout-guard,flag-guard}.log`。
- `consumers-D.json` 完成46条明确保留测试、189条测试匹配逐项排除；新嵌套仓库测试仍需追加到同一选集，不能把全包当相关测试。

- 当前 runner `vitest related src/CodexTmuxAdapter.ts src/codex-daemon-client.ts src/codex-daemon-goal-runtime.ts --run --config /tmp/fly2920-D-claude-runner-related.config.mts` 在已发现的明确文件白名单内选中4文件，338/338通过；edge `vitest related src/Blueprint.ts --run --config /tmp/fly2920-D-edge-worker-related.config.mts` 2文件44/44通过。白名单仅避免大入口/共享类把 unrelated 全包带入，未替代显式 lexical/API 守卫。配置输入名单来自 consumers-D.json。

- 分别执行7个 CommDB/marker/response/TURN 消费者文件与14个 runner/Blueprint/request-review/StateStore/gate/review/alert/ship-judgment 直接消费者文件，全绿。每个 pnpm 命令只传一个明确文件，未跑目录、glob 或全包；精确保留名单见 consumers-D.json，日志均为 /tmp/fly2920-D-<case>.log。该批保留既有 auto-approval negative guards，不表示申请或授予 ship 权限。


## 最后质量复核修正

嵌套 target repo 原恢复提示遗漏 --target-repo，导致同 requestId 重发被既有绑定校验以409拒绝。保留各自作者的 immutable worktree，推导已存 canonical target 的安全相对 selector；无法证明/越界/替换 symlink 时不生成执行命令，提示补 operator evidence，不放宽接受校验。notice/status/CLI 都保留 selector；所有字符串参数用 equals-form，原 R/Q、plan、repo 的前导连字符与单引号不会被 parseArgs 当选项。

RED/GREEN 最终：CLI20/20 `/tmp/fly2920-nested-cli-final.log`；真实 HTTP3/3 `/tmp/fly2920-nested-http-final.log`；StateStore退休14/14 `/tmp/fly2920-nested-retirement-final.log`。HTTP覆盖实际 shell tokenization+parseArgs 后 source/follower × code/design × notice/formatter 共8次原R/Q重发，保持held/gen1，无重复 reviewer；遗漏selector409、越界/绝对路径400、替换symlink422仍拒绝。局部质量复核关闭 boot follower 与 nested repo 两项；这不是有效 review gate 的批准。

consumer矩阵合并该修正的26个路径/名字/父目录/文字查询，现47个明确保留文件，所有匹配有处置，无pending。最终代码上的 lint通过，保留25条既有warning；未据此声称完整CI。

## D 已完成的局部验证

最终修订上的 owning-package related：runner4文件338、edge2文件44、comm11文件210、teamlead21文件368，合计38文件960项全绿。相关测试选集包含新 nested 回归；没有使用本机全包/全库测试。最终 affected+dependencies build通过 `/tmp/fly2920-D-build-frozen.log`；lint通过 `/tmp/fly2920-D-lint-frozen.log`。依赖方7个package typecheck：6个初次通过，voice-codex因缺voice-bridge dist前置失败，补 `pnpm --filter 'flywheel-voice-bridge...' build` 后仅重跑该依赖方typecheck通过。此为构建前置修复，无业务源改动。相关日志 `/tmp/fly2920-D-dependent-{typecheck,preflight-build,typecheck-retry}.log`。

D本地规格与独立质量复核已关闭全部所报blocker。后续E/F/G、最终有效 code-review gate、PR及handoff尚未完成；本节不构成完整CI/QA/生产身份探测或ship证明。

## 后续 guard 补核（E 后、F 前）

F 留存影响面核查发现本组新增三表未登记。`fly-2413-retention-registry.test.ts` 初始化真实临时两类数据库后复现 2 failed / 34 passed，报 `schema_unclassified:teamlead:codex_review_attempt,review_recovery_notice`。补三个独立 JSON fragment：teamlead 的 attempt 与 notice 归 `protectedAuthority`，CommDB 的 notice projection 归 `protectedCurrentOrAuthority`（与现有 runner wake retirement 分类一致）。这些记录维持 generation fence、原预算、通知幂等与未消费恢复状态；不将它们误当作可清扫历史表。

未修改 D 业务代码、SQL schema 或公共守卫。相同守卫重跑 36 passed；retention consumer gate 具体测试文件 10 passed；三个 JSON 的 Biome check 通过。日志 `/tmp/fly2920-D-retention-{red,green}.log`、`/tmp/fly2920-D-retention-consumer.log`。发现记录与 manifest blob 追加到 consumers-D/verification-D；此前 D 检查清单不包含这个守卫，不能称作当时已经通过。
