# FLY-2538 报告托管账号轮换 — Codex 设计评审记录
Issue: FLY-2538 (https://linear.app/geoforge3d/issue/FLY-2538/报告托管-vercel-账号轮换做成一条命令migratereport-hosting-retarget-凭据热切换-报告用量削减-水位告警)
日期: 2026-09-13
基于: plan.md

## 实施期合同澄清

Lead 于问题 `f180cf70-67ac-46a0-acf2-39e715fe65cb` 批准最小顺序修正：`putEpicPage` 内 audit list/del 延迟到 registry commit 成功之后；commit 冲突时保留 HTML 和 audit，按 C0 字面要求总计零 list/del，正常清理策略和保留期不变。plan blob 保持冻结。

## 实施授权

Accepted: Lead 于问题 `b2098977-9f2c-4cdc-b825-49fb885d6358` 确认 plan v5 blob `8a6d10c59a535565b920f5c2e9984de7fb9c23ff` 已获实施授权；完整原裁定为 `3088b6b9-9c1b-4884-b5fc-07079d60d22f`（leadAcceptance，不开 R5）。确认删除跨 token 同内容去重、采用专用 `REPORT_HOSTING_VERCEL_TOKEN`、水位告警仅覆盖存储。计划文件保持冻结。

Codex thread `01a09d06-47ad-7c51-a15b-e2a20d77d6b4`,effort xhigh,四轮:12 → 9 → 7 → 4 条(blocker 4 → 4 → 3 → 0)。
Lead 裁定(ask 3088b6b9):允许 R4 一轮只验 R3 七条;R4 仍非 APPROVED 则 leadAcceptance 收口,R4 条目逐字归档,只修阻断级,不开 R5。

## R4 处置(全部并入 plan v5)

| # | 级别 | 处置 |
|---|---|---|
| 1 | HIGH | 接受:Epic binding conflict 时 HTML 与 audit 都不删(交给 14 天 sweep);删除 `deleteExactPaths`;C0 测试改为断言零 del/零 list |
| 2 | HIGH | 接受:secrets 文件父目录 `mode & 0o022 === 0`;既有文件必须 uid/0600/单行合法 token 才 no-op;rename 后 lstat 终验;四条新测试 |
| 3 | MEDIUM | 接受:C0 双目标测试拆成「并发一成一败、恰一份备份」与「顺序 A→B→C 两份备份」 |
| 4 | MEDIUM | 接受:`retargetedFromOf(src, target)` 显式判定;来源有项目名无 hosting 标记 ⇒ 前置退出 2,补测试 |

无 advisory 遗留(四条均已修)。

## 逐轮原文

### Round 1

```markdown
# Design Review — plan.md (Round 1)

Date: 2026-09-13
Author: Codex
Status: CHANGES REQUESTED

## Summary

方案总体可落地，止血优先、双格式网关先行、私有 Blob store、失败关闭及分段 QA 的方向都与现有架构相容。但当前版本在在线切换原子性、journal 的状态绑定、14 天链接合同、共享 Vercel 凭据的影响面等处仍存在会产生错误 URL、丢 registry 更新或破坏既有消费者的阻塞问题，尚不宜进入实现。

## What's Good (Keep)

- C1/C2 先减少 operations，再做 gzip、凭据热读和账号轮换，顺序符合 Eng Lead 对 ops 为首要嫌疑的裁定；也没有把不可观测的 operations/transfer 指标包装成可验证承诺。
- gzip 采用“先部署可读明文和 gzip 的网关，再让 Bridge 写 gzip”的兼容策略是正确方向。当前 `@vercel/blob@2.8.0` 类型支持 `Buffer` body 和 `head().size`，Node zlib 类型也支持 `maxOutputLength`，实现基础成立。
- `access:"private"`、public-store 创建后立即删除、伪 token 必须 404、解压失败固定 502，以及复用 CSP scanner，都是值得保留的 fail-closed 防线。
- 继续沿用 registry 的 stage → remote side effect → commit/abort 事务形态，并让远端 API、时间和 fetch 可注入，便于精确覆盖断点、重放和错误响应。
- 默认不传 team scope、强制 fresh project name、保留旧账号资源由人处理，符合本次个人 Hobby 账号的已知边界，也控制了命令的破坏半径。
- QA 把空账号首跑、重跑、热切换、gzip 响应、digest skip 和水位阈值拆开取证，方向清晰；实现后应继续保留这些独立证据。

## Issues & Recommendations

1. **[BLOCKER] retarget 与在线 publish 之间没有跨进程栅栏，registry 切换也不是原子的。** 当前 `ReportRegistry.stageReport()` 在 stage 时捕获整份 `committed`，远端上传完成后再把其中的 `vercelProjectName`、`hosting` 和 `reports` 整体写回；`ReportCriticalSection` 只约束 Bridge 进程内请求。独立 CLI 在此期间执行 `commitRetarget()` 后，一个较早 stage、较晚 commit 的 publish 会把新 hosting 标记和同期 report 集合覆盖回旧快照。即使避开这一瞬间，步骤 9 已把 URL 域名切到新项目、人工却尚未改 Blob token，Bridge 仍可能把对象写进旧 store 并返回新域名 URL。建议增加一个由 CLI 与 Bridge 共用的跨进程 registry 锁/CAS，以及持久的 `retargeting` 发布栅栏；最终切换窗口内 `/publish` 应 fail closed（503），在同一受锁流程中重对账、提交 hosting、验证当前凭据确实指向目标 store 后再解除。必须加入 `stage(old) → retarget commit → publish commit`、CLI/Bridge 同时写、CLI 崩溃后重启恢复及 `.bak` 恢复不覆盖新写入的测试。

2. **[BLOCKER] journal 只按 token 记账，不能证明已上传、已部署、已验证的是当前 registry 状态。** Epic 固定 token 的 HTML/`createdAt` 可在迁移中变化；首次部署后新增的普通报告在第二次运行会被上传，但 `gatewayDeploymentId`、`verifiedAt` 和 registry 标记仍全部 skip。这样新对象可能不在冻结 manifest 中，网关会退回 Blob `uploadedAt`，既破坏原始 `createdAt` 的精确保留语义，也让“补切换窗口报告”并未真正闭环。建议冻结发布后取不可变 snapshot，或在 journal 中为每个 token 保存 `sourceSha256 + createdAt`，另存 manifest digest、deployment digest、verification digest；任何输入变化都必须重传、重部署并重验。重跑还应重新验证 project/store connection、deployment/alias 和目标 store 身份，而不能仅凭本地字段永久 skip；最终 marker 必须绑定最新一次完整 proof。

3. **[BLOCKER] C7 的 7 天同内容复用违反既有 14 天可访问合同，并会破坏 loopback hostOverride。** FLY-2283 的硬合同是“每次返回的托管链接从本次创建起完整可访问 14 天”；复用一个最多 7 天前的 token，计划也承认会少最多 7 天，因此不是可接受的小风险。hostOverride 更严重：本地报告 host 会随 Bridge 生命周期消失，重启后仅从 registry 去重并返回旧 token、却不重新 materialize/deploy，会直接得到 404。最简单修复是从本 issue 删除 C7；若必须去重，应创建新的 14 天 lease/report identity（或等价 durable mapping），并在生产 Blob 与 fresh loopback host 上都证明从每次响应时刻起的精确边界。

4. **[BLOCKER] 把全局 `VERCEL_TOKEN` 热切到新报告账号，会连带改变 `/api/publish-html` 的账号。** 现有 legacy 路由用同一 token 部署稳定的 `triage-<project>` Vercel 项目；计划却要求把 `~/.flywheel/.env` 的 `VERCEL_TOKEN` 改为 fresh 个人账号 token，同时又声明不改变 Simba 发布形态。项目别名全局唯一时，新账号通常不能接管旧账号的同名 `triage-*` 项目，这会让与报告轮换无关的 legacy publisher 失败。建议为报告网关管理引入专用凭据（例如 `REPORT_HOSTING_VERCEL_TOKEN`），让 `/api/publish-html` 继续使用既有 token；否则必须显式把所有 `triage-*` 项目迁移、验证并纳入范围和回滚，不能称其为不变。

5. **[HIGH] C4 在每个底层 SDK 调用时重新解析 token，会让一次逻辑操作跨两个 store。** `putEpicPage` 包含旧页 get、audit put、HTML put、audit list/del；sweep 也包含分页 list 和批量 del。若 `.env` 恰在中间更新，前半段可读旧 store、后半段写/删新 store，导致错误清理、缺 audit 或内容断裂。建议每个顶层操作开始时只解析一次 `{token, source, generation}`，随后所有内部请求使用该快照；下一次顶层操作再采用新凭据。补充在分页、Epic get→put 和 list→del 中途改 `.env` 的测试，并校验 resolver 来源按 key 记录，不能用一个全局 `source()` 模糊混合来源。

6. **[HIGH] C1 缺少 StateStore outcome parser 传播，而且“下一次刷新补齐 Epic audit”并不成立。** 当前 `EPIC_PAGE_REFRESH_OUTCOMES`/`parseEpicPageRefreshOutcome()` 只接受已有 `ok_unpublished` 原因；仅改 TypeScript 联合类型会使 refresher 写账本时被 StateStore 拒绝。另一方面，retarget 后 StateStore 仍保存旧 hosting 的相同 digest 和最近发布时间，C1 会连续 skip 最多 24 小时，所以未迁移的 audit sidecar 不会在“下一次小时刷新”自动补齐。建议同步更新 parser、allowlist、migration/ledger 测试；并把 publication proof 绑定到 hosting identity（至少 storeId/project），或在新凭据生效后强制一次 Epic publish，确认 HTML 的 audit URL 200 且 hash 正确后才结束 cutover。

7. **[HIGH] fresh store 的 Blob token 交接合同自相矛盾。** runbook 要求开始前同时 export `BLOB_READ_WRITE_TOKEN_NEXT`，但空账号的 token 只有命令创建并连接 store 后才存在；若省略该参数并在进程内 decrypt，命令既不打印秘密、也不改 `.env`，父 shell 又无法获得该值，最终 `envHint` 中的 `$<NAME>` 没有来源。需明确选择并测试一个安全流程：例如第一阶段创建/连接并落 journal 后暂停，operator 从 Vercel 安全地设置环境变量，再以同一 journal 恢复迁移；只有第二阶段 token 与 store binding 验证通过后才能提交 registry。相应统一参数是否可选、exit code、stdout JSON、runbook 和 QA，不能声称空账号一条命令到底同时又禁止任何安全交付渠道。

8. **[HIGH] `--team-slug` 没有传播到实际部署链路。** 新 `vercel-hosting-api.ts` 虽声明所有 URL 带 slug，但现有 `assertGatewayBlobEnvironment()` 只有 `(token, projectName)`，`deployFilesToVercel()` 的创建 deployment 与轮询请求也没有 scope 参数；C5 文件清单甚至未包含 `vercel-deploy.ts`。建议要么扩展这两个既有 helper 及所有调用者/兼容测试，逐项断言 env lookup、deployment POST 和 polling 都携带相同 scope；要么基于本次个人 Hobby/no-teamId 的既定事实删除该选项，避免提供半生效接口。

9. **[HIGH][SECURITY] 复用的 `redactSecrets()` 不能支撑“任何输出不含 token 值”的合同。** 该 helper 只匹配少数已知形态；任意 Vercel account token，或 Vercel JSON 中诸如 `{"value":"vercel_blob_rw_…"}` 的原值，并不会被可靠遮蔽。现有 deployment error 还会拼接远端 body snippet。建议在结构化错误进入日志/stdout 前，用本次已解析的所有 secret 原串做精确替换，再叠加前缀/字段级通用 redaction；解密 env 响应绝不能进入 exception body。测试应覆盖 raw JSON `value`、任意格式 account token、SDK/REST nested cause、body snippet 和所有 failed-step 输出，而不只覆盖一个匹配现有正则的 fake token。

10. **[HIGH] runbook 的 gzip rollout 顺序互相矛盾。** 第 1 步说 updater 已部署含 gzip 的 Bridge，第 2 步才要求“Bridge 重启前”部署双格式网关；若 updater 会重启进程，这正是风险表中的 502 窗口。应改为：合并并 build 产物但不启动新 Bridge → 对当前项目部署并 probe 双格式网关（明文、gzip、损坏/超限、`gzip;q=0`）→ 只有探针通过才让 updater 重启/发布 gzip Bridge。若现有 updater 不能拆开，必须设计显式 rollout gate，而非依赖人工“来得及”。

11. **[MEDIUM] usage check 的调度不能实现计划中的 40 分钟重试。** 它只挂在 24 小时 sweep tick 上，`attempting` 40 分钟后可重试在正常常驻进程中要到次日才会发生；research 中“API 失败也写 checked 并当天不再打”的语义还会吞掉整天的临时故障。建议把轻量 usage trigger 保持为小时级，用 date/store-bound receipt 去重成功结果，失败写 `failed/attempting` 并做有界退避；Blob sweep 本身仍可每日。加入 timer 驱动的 10/40 分钟、进程崩溃恢复、跨日以及 storeId 变化测试。

12. **[MEDIUM] 若按原始正则实现，`Accept-Encoding: gzip;q=0` 会被错误视为接受 gzip。** 这会在明确拒绝 gzip 的客户端上返回压缩体。建议解析 quality value（至少正确处理 `gzip;q=0`，并明确 wildcard 策略），始终保留 `Vary: Accept-Encoding`；增加大小写、空白、多值、`q=0`/`q=0.0` 和缺省头测试。另请把 QA C 固化为实际可执行的 token-size 命令或专用脚本；当前 `--usage-check` 输出 store 总量，不能替代 `headReportSize(token)` 的单对象前后对比。

## Verdict

CHANGES REQUESTED — address items above
```

### Round 2

```markdown
# Design Review — plan.md (Round 2)

Date: 2026-09-13
Author: Codex
Status: CHANGES REQUESTED

## Summary

v2 实质性关闭了 Round 1 的多数问题：删除不合法的去重、拆分 Vercel 凭据、把 gzip rollout 改为数据门、按顶层操作固定凭据、绑定 journal proof，并补齐 usage retry 与 Accept-Encoding q-value。剩余问题集中在并发 cutover 的 authority 绑定与 crash recovery：当前 fresh-merge 会把旧 store 的已上传对象登记到新 hosting，最终 marker 也可能在 retained set 已变化后仍宣告成功；此外新造的锁弱于仓库已有实现，因此仍需修改后再实现。

## What's Good (Keep)

- Round 1 的 C7 去重已完整删除，并明确保留 FLY-2283 的“每次返回起完整 14 天”与 loopback 生命周期边界；这个 scope cut 正确。
- `REPORT_HOSTING_VERCEL_TOKEN` 与 legacy `VERCEL_TOKEN` 分离且禁止 fallback，保住了 `/api/publish-html` 的旧账号/`triage-*` 项目，不再扩大 retarget blast radius。
- journal v2 为每个 token 记录 `createdAt/bytes/sha256`，deployment 与 verification 绑定 manifest；第二次运行在 retained set 改变时重部署、重验，方向比 token-only receipt 可靠得多。
- `gatewayFormat:"gzip-v1"` 只在 live probe 通过后写入，Bridge 以 registry 数据门决定是否压缩。这让 Bridge 重启与网关部署的先后顺序不再产生已知 502 窗口，应该保留。
- `gzip;q=0`、wildcard、恒定 `Vary`、损坏/超限 502 与 identity 响应都进入合同和测试；网关双格式设计可由当前 Node zlib 与 Blob SDK 实现。
- 凭据按顶层 Blob 操作固定快照、Epic digest 绑定 hosting key、usage tick 与每日 sweep 分离，以及精确原串优先的 `SecretRedactor`，都直接回应了 R1 的具体失败模式。
- 本地 `@vercel/blob@2.8.0` 实现确实以 `token.split("_")[3]` 解析 RW token 的 store id；Vercel 也把 private Blob URL 定义为 `https://<store-id>.private.blob.vercel-storage.com/...`，所以 store-binding 基础假设成立。[Vercel Private Storage](https://vercel.com/docs/vercel-blob/private-storage)

## Issues & Recommendations

1. **[BLOCKER] `stageReport.commit()` 的 fresh-merge 仍会把旧 store 的对象登记到新 hosting；C0 测试正在把错误结果写成成功。** 反例：Bridge 在旧 hosting 下通过 C4 guard 并 stage，随后把对象 put 到旧 store；CLI 完成 retarget；Bridge 再进入 commit。按 §1.3/C0，commit 会读取新 `vercelProjectName/hosting` 并把旧 stage entry 合进去，随后 `reports-route.ts` 又从当前 registry 生成新域名 URL——返回的 URL 在新 store 中不存在。§C0 明确要求 `stage(old) → commitRetarget → publish commit` 后“新 entry 在”，这正是应拒绝的状态。建议 stage 时捕获不可变 `hostingKey = project/storeId` 与本次已验证的 credential snapshot，commit 在 registry lock 内比较 fresh key；不一致就不写 entry，抛 typed conflict，让 `/publish` 返回 503、Epic 返回 transient，并用**原操作的 token snapshot**做 orphan cleanup。`markGatewayFormat`、`recordHostingStoreId`、`markHostingMigrated` 等“远端 proof 后落 marker”的 API 也必须接收 expected project/store/revision 并 CAS，避免旧项目 probe 的 deploymentId 被 fresh-merge 到新 hosting。增加 put 完成前/后两种 retarget 交错测试；成功标准应是“无错误 entry、无错误 URL”，不是强行并集。

2. **[BLOCKER] 步骤 9 没有证明 marker 覆盖锁内读取到的最新 retained set，第一次 exit 0 仍可留下永久缺口。** 若一个 publish 在步骤 6 snapshot 后、步骤 9 前完成 commit，它在旧 store 且已进入 fresh registry，但 CLI 仍用旧 `manifestDigest` 写新 hosting 并 exit 0；“operator 再跑一次”只是手册约定，进程崩溃、operator 中断或漏跑后，registry 会永久声称迁移完成。建议 `commitRetarget(expectedManifestDigest, expectedDeploymentId, expectedVerified)` 在锁内重新计算 fresh retained manifest；不相等则拒绝 marker，驱动程序回到上传→部署→验证并做有界重试。配合问题 1 对已在飞 stage 的 hosting-key fence，只有 manifest CAS 成功才允许第一次 exit 0；第二次命令可以保留为 no-op 复核，但不能承担 correctness。测试需覆盖 publish 在 snapshot 后且分别于 marker 前/后 commit 的两个真实时序，并断言任何 exit 0 marker 都覆盖当时全部 retained entries。

3. **[BLOCKER] 新设计的 `owner.json + 60s age steal` 锁不安全，而且重复实现了仓库已有的成熟 mkdir lock。** 只按 `startedAt` 删除目录会偷走仍活着但暂停超过 60 秒的 holder；旧 holder 恢复后仍会进入临界区，并可能删除/覆盖 replacement holder。`mkdir` 成功到 `owner.json` 写入之间崩溃时也没有定义恢复依据；若用同步 50×100ms 等待，还会阻塞 Bridge event loop 最多 5 秒。仓库已有 `flywheel-config` 的 `withMkdirLock()`，teamlead 已通过 `account-heal/mkdir-lock.ts` 复用：它使用 PID + process start time + 唯一 marker/inode，绝不按年龄偷 live PID，不递归删除 replacement，并异步 backoff。建议直接复用它，外包一层把 timeout 映射为 `ReportRegistryLockBusy`；相应把 `StagedPublish.commit()`/registry mutations 改为 async 并由两个 publisher await。新增 live holder 超过 staleMs 不被偷、missing/malformed marker、PID reuse、stale-break/release replacement race 及 event-loop 不被等待阻塞的测试，不再维护第二套较弱锁。

4. **[BLOCKER] C5 journal 没有整次命令的单写者保护，且 store create 仍有不可恢复的远端成功/本地未记账窗口。** registry 的短锁不保护 `retarget.<project>.json` 或步骤 1–8；两个同 target CLI 可同时 POST store、上传、部署并用同一 tmp/rename 覆盖 journal。即便只有一个进程，`createPrivateBlobStore` 远端成功后、`journal.storeId` 落盘前崩溃，重跑既无法从尚未连接的 project env 找到它，又会因同名 409 失败；research 已明确该 API 无 store list/name lookup。Vercel 的公开恢复面也是按 store id 查询，而非按 name 查询。[Managing Vercel Blob storage](https://vercel.com/docs/vercel-blob/manage-blob-storage) 建议增加覆盖整次 retarget 的 per-project migration lock；并关闭 create 的 ambiguous-commit 窗口：若已验证 create API 可用 `projectId` 原子连接，则使用它并由 env GET 恢复，否则给 `--retarget` 增加显式 `--store-id` recovery 路径（GET 校验 owner/access/name 后续跑），409 错误打印可执行恢复指令。测试必须在“POST 已成功但函数返回前/返回后 journal 写前”杀进程，并验证无需创建第二个 store 即可恢复。

5. **[HIGH] C4 guard 与 Blob 方法各自调用 resolver，仍可能在一次 publish 中使用两个不同快照。** §C4 先用 `cred.value` 做 registry/store 比较，随后 `putReport()`/`putEpicPage()` 在自己的入口再次 `this.resolve()`；外部刚好在两次调用间替换 `.env` 时，guard 验的是 A，实际 put 用的是 B。commit 失败后的 `deleteReports()` 又会取第三次快照，可能删错 store。建议由 route/Epic publisher 获取一次 snapshot，完成 missing/mismatch 验证后把同一 snapshot 显式传给整次 store operation 与补偿删除；或让 store 暴露一个“resolve + validate expected + execute”的单入口，绝不能 guard 和 I/O 分开解析。测试要把 `.env` 变化注入在 guard 通过后、`putReport` 入口前，以及 put 成功后、cleanup 前；只测 store 方法内部 resolver 变化不覆盖这个窗口。

6. **[HIGH] journal 的 verification 仍只绑定 `token:createdAt`，未绑定它自己用来判定重传的内容 sha；marker 的同项目重跑也不具备字面幂等性。** 当 `{bytes,sha256}` 变化而 `createdAt` 不变时，步骤 6 会重传，但 `manifestDigest` 不变，步骤 7/8 会跳过，新的对象内容没有任何 live verification。建议区分 retention manifest digest 与 content-set digest（例如排序后的 `token:createdAt:bytes:sha256`），`verified` 同时绑定 deployment/manifest/content digest；任何重传都至少重验受影响 token。另一步骤 9 每次构造 `migratedAt: now`，因此“已完全一致 ⇒ skip”永远不成立；同 target 第二次运行还可能把 `retargetedFrom` 改成自身。把首次 cutoverAt/原始 `retargetedFrom` 持久保存在 journal/hosting，后续补传只更新 deployment/proof 字段，并加入同项目 no-op marker 字节不变、原始来源不丢的测试。

7. **[HIGH] “每次运行都重验 store”与步骤 2/API shape 不一致。** §1.4 声称 project/store/connection 都 GET 重验，但步骤 2 在 env 无 storeId 时直接信任 `journal.storeId`，而 `getStore()` 只解析 usage 字段，不含 `access/name`；删除、换账号、journal 污染或 public store 都不能在使用前被识别。建议 journal store 路径必须调用 `getStore(id)`，响应合同至少验证 id、access=`private`、期望 name/owner scope（API 能提供什么就写死什么；不能验证的字段要明确标成假设），随后再验证 connection 与 token-store binding。最终验证抽样应只从当前 retained/uploaded 集选取，而非历史 journal 的全部 `uploaded` map。

8. **[MEDIUM] Epic C1/C4 的接口传播仍有两处自相矛盾。** §C1 用 `staged.vercelProjectName` 算 `hostingKey`，同时又要求 skip 路径“不 stage”；实现上变量在该分支不存在。应增加一次性 `registry.hostingBinding()` 读取（同一 registry load 返回 project/store/format），先算 key/skip，再在非 skip 路径 stage，并把同一 binding 传给问题 1 的 commit fence。另 `transient: publish_failed:credentials` 在 C4 中新增，但 §1.5 的 `EPIC_PAGE_REFRESH_OUTCOMES`/parser 合同与列出的 parser tests 只增加了 `unchanged_digest`；请显式把 credentials outcome 加入常量、parser 与 StateStore ledger 测试。Blob store-binding guard 还应明确只作用于生产 Blob 分支，不能让 529 hostOverride 依赖生产 Blob token。

9. **[MEDIUM] 还有几处 integration/QA 合同需要写死，避免实现各自猜测。** (a) `reportGatewayNodeHandler` 对重复的 `accept-encoding` 数组应以逗号 join，而不是只取首项，否则后续值中的 gzip 会丢失；(b) 两个 probe object 必须在 `finally` 中用本次 Blob snapshot 清理，损坏 gzip 必须走 raw-byte put seam，不能被普通 gzip wrapper 再压一层；(c) C4 的“未配置则不起 sweep/usage timer”会让启动后热添加 token 永远无法启动相应任务，两个 timer 应独立安装并在 tick 内按各自凭据 skip；(d) QA D 要求 `--usage-check` 的 `count` 不变，但 §C6 输出合同没有 `count`，请加入字段或删除该证据。为这些点各补一个 focused test 即可，不需要扩大架构。

## Verdict

CHANGES REQUESTED — address items above
```

### Round 3

```markdown
# Design Review — plan.md (Round 3)

Date: 2026-09-13
Author: Codex
Status: CHANGES REQUESTED

## Summary

v3 明显比 v2 扎实：复用了现有跨进程锁、把 journal 绑定到 manifest/content proof、引入单次凭据快照与 gzip 数据门，绝大多数 Round 2 问题已经关闭。整体架构可实现，但当前合同仍有三个会破坏切换原子性或 14 天保留期的阻塞窗口，以及几处崩溃恢复、Epic 补偿和秘密落盘问题。修正这些边界后即可进入实现。

## What's Good (Keep)

- 用 `flywheel-config` 的 `withMkdirLock` 代替自制 stale-lock 协议，并把 `StagedPublish.commit()` 改成异步锁内重读/合并，方向正确。
- journal 同时记录 `manifestDigest`、`contentDigest`、逐对象 `bytes/sha256`，验证 proof 绑定 deployment 与实际抽检 token；内容变化不必重部署 manifest 的拆分也合理。
- retarget marker 在锁内重算 retained set，并用最多三 pass 的上传→部署→验证→CAS 收敛，第一次 exit 0 即正确、不依赖人工第二跑，是重要改进。
- `CredentialSnapshot` → `BoundReportBlobStore` 把一次顶层操作固定到同一个 Blob token；热切换、分页 sweep、Epic 多调用链都有针对性测试。
- `gatewayFormat="gzip-v1"` 只在 live probe 通过后写入，Bridge 写入格式由 durable marker 驱动，消除了部署/重启顺序造成的 502 窗口。
- Epic digest 同时绑定 `last_hosting_key`，并补齐 refresher parser/常量；retarget 后下一次 refresh 会自然补 audit sidecar。
- 删除本 issue 的内容去重、拆开报告管理 token 与 `/api/publish-html` token、补齐 q-value 解析和按 store/date 的 usage receipt，都与既有合同一致。

## Issues & Recommendations

1. **[BLOCKER] 凭据守卫与 stage 仍不是同一份 binding proof，fence 可在 put 前被绕过。** §C4 的顺序是先读 binding A、校验并绑定 token A，然后调用 `stagePublish`；但 §1.3 又规定 `stageReport` 自己重新 `load()` 并捕获 binding。若 retarget 恰好发生在这两次读取之间，stage 捕获 B，上传仍使用 A，commit 看到 fresh B 等于 staged B 就会成功，于是 B registry 登记了只存在于 A store 的对象；Epic 路径同样受影响。现有测试只覆盖“stage 后 retarget”，没有覆盖“guard 后、stage 内 load 前 retarget”。让调用方把已校验的 `HostingBinding` 显式传给 `stagePublish/stageEpicPageRepublish`，stage 内若当前 key 已变就应在 put 前拒绝；或者先 stage，再只用 `staged.binding` 校验凭据、选择 gzip、上传和构造响应 URL，期间不得再取另一份 binding。另请明确空 registry 的 529 `hostOverride` 首次发布仍如何生成并原子提交 project candidate；当前 `HostingBinding.vercelProjectName` 非空，而现有实现是在 stage 内生成候选名。增加上述精确插点测试，并断言 zero put / no entry / no wrong URL。

2. **[BLOCKER] whole-command 锁按目标项目分片，两个不同目标仍能同时 retarget 并双双 exit 0。** `retarget.B.lock.d` 与 `retarget.C.lock.d` 互不排斥；两条命令都从 A 起步时，只要 report digests 未变，当前 `commitRetarget`（签名没有 `expectedSourceHostingKey`）就会先后通过，最后写者静默覆盖前者。相同秒内两次 `.bak-<epochSec>` 还会覆盖备份。把 whole-command 锁改成 registry 范围内所有 hosting mutation 共用的一把锁，并给 `commitRetarget` 增加 `expectedSourceHostingKey`/expected project CAS；同目标复核则显式接受已经等于目标的 binding。`markHostingMigrated()` 也不能只“迁入锁内、行为不变”：legacy migrate 若与 retarget 交错，仍可能把新 project 与旧 deployment/store marker 拼在一起；它也需要 expected binding，或纳入同一命令锁。备份名使用不会碰撞的时间戳加唯一后缀，并增加 A→B 与 A→C 并发、legacy migrate 与 retarget 并发测试。

3. **[BLOCKER] `cutoverAt` 在第一次 marker 尝试前永久冻结，会让成功 marker 包含 `createdAt > migratedAt` 的报告。** 计划在 pass 1 的步骤 9 首次写 `cutoverAt=now`，CAS stale 后保持不变；若新报告在该时间之后、第一次 CAS 之前 commit，pass 2 会迁移并接受它，但以后 `--deploy-gateway-only` 按 `createdAt <= hosting.migratedAt` 生成 manifest 时会把它丢掉，网关将回落到较晚的 Blob `uploadedAt`，破坏精确 14 天 retention proof。每个 CAS pass 都应生成新的 tentative cutover，stale 后覆盖它，只有成功 CAS 的那一版才永久写进 journal/hosting；或者由 `commitRetarget` 在锁内确定最终 cutover。增加带 fake clock 的回归测试：pass 1 cutoff 后并发 commit X、pass 2 成功、随后 deploy-only 的 manifest 仍携带 X 的原始 `createdAt`。此外 `retargetedFrom` 需要旧 `migratedAt`，但当前 `HostingBinding` 没有该字段；应在同一次源快照中明确携带它。

4. **[HIGH] store-create intent 的人工恢复路径按现合同走不通，零超时锁也不能在同一运行中回收死锁。** intent 存在且无 `storeId` 时步骤 2 无条件退出，因此提示中的“确认不存在后用新 `--store-name` 重跑”仍会再次命中同一 intent；`--store-id` 允许远端 name 不同，却没有说明清 intent、采用实际 name 并更新 journal。定义显式、可审计的 intent 放弃/替换操作（例如 `--abandon-store-intent --store-name ...`），仅在 operator 确认后归档旧 intent；`--store-id` 恢复必须清 intent并记录 GET 返回的实际 name。对确定未创建的 4xx 与结果不明的断网/进程死亡分别规定清理语义。另据现有 `withMkdirLock` 实现，`timeoutMs: 0` 在删掉 stale snapshot 后会先命中 deadline 并抛错，需第二次运行才成功；改为很小的非零 bounded wait，或提供“成功 stale-break 后立即重试一次”的封装。补齐无 store、找回既有 store、死 PID 三条 founder-path 测试。

5. **[HIGH] Epic binding conflict 时删除 HTML 不是 orphan cleanup，而是破坏稳定页和回滚。** 普通报告 token 唯一，commit 失败后删本次对象合理；Epic 使用稳定 pathname，`putEpicPage` 已覆盖旧 store 的有效页面，retarget conflict 后删除它会让旧域名以及凭据/registry 回滚失去页面。并且 C2 已把 `deleteReports` 改成只删 HTML，当前 `BoundReportBlobStore` 合同没有“仅删除本次 audit”的精确补偿能力，所以 §1.3 所称“删 HTML 与本次 audit”也不可实现。Epic conflict 时不要删除稳定 HTML；保留这次旧-store 更新是安全且利于回滚的。若确实要收掉新 audit，让 `putEpicPage` 返回包含精确 audit pathname 的 compensation receipt，只删除该路径、禁止 list。增加 retarget 发生在 Epic put 与 commit 之间的测试，断言旧 store 的稳定 HTML 未被删除。

6. **[HIGH] 两阶段 secret handoff 仍只规定最终 mode 0600，缺少抗 symlink、崩溃和错误覆盖的写入合同。** 对可由 `--reports-dir` 指定的路径直接写固定文件名，单靠 mode 无法防止已有 symlink/非普通文件、沿用旧文件权限、写到一半崩溃或无意覆盖另一个 store 的 token。规定父目录信任/所有权检查，`lstat` 拒绝 symlink 和非普通文件，在同目录用 `open(..., "wx", 0o600)` 创建唯一临时文件，写入并 `fsync`/close 后 atomic rename；已有目标只在内容绑定同一 store 时 no-op，否则 fail-closed 并给显式恢复说明。读取到的旧值和新值都先登记进 `SecretRedactor`，异常只输出路径。测试至少覆盖 symlink、已有不同 store 文件、rename 前 crash、最终 owner/mode/单行内容，并在 exit 3 示例中钉死一个实际可复制的环境变量名。

7. **[MEDIUM] store/connection shape 的“每次重验”合同仍有两处不一致。** `getStore` 声明返回 `count`，但 required-field 列表漏了 `count`，而 usage 输出和通知都依赖它；步骤 3 在 env 已指向 store 时直接 skip，只在新 connect 后检查 `projectsMetadata`，与“每次 GET 重验连接”的陈述不一致。把 `count` 设为 finite non-negative 必填，并明确每次运行以 env `contentHint.storeId` 与 `projectsMetadata.projectId` 的何种组合证明连接；无论走 create、journal、env 还是 `--store-id` 都执行同一套验证和 shape tests。

## Verdict

CHANGES REQUESTED — address items above
```

### Round 4

```markdown
# Design Review — plan.md (Round 4)

Date: 2026-09-13
Author: Codex
Status: CHANGES REQUESTED

## Summary

本轮严格只复核 Round 3 的 7 项：single-binding proof、registry-wide mutation lock/CAS、成功 CAS 时确定 cutover、intent 恢复、store/connection 重验等核心改动已落到合同中。仍有四处位于这 7 项内部的矛盾，其中 Epic conflict 后删除 audit 会立即破坏保留下来的稳定 HTML，secret handoff 对既有不安全文件仍会 fail-open；因此暂不能批准。

## What's Good (Keep)

- `stagePublish` / `stageEpicPageRepublish` 显式接收调用方已验证的同一个 `HostingBinding`，stage-load 前置冲突、put/commit/gzip/URL 共用该 proof；空 registry 的 hostOverride candidate 也保留了现有原子语义。
- `hosting-mutation.lock.d` 已提升为 registry 范围并覆盖 retarget、deploy-only、legacy migrate；`commitRetarget` 和 `markHostingMigrated` 都增加了来源 CAS。
- `cutoverAt` 改为成功 CAS 的锁内时刻，journal 在返回后记录；`HostingBinding` 也携带 `migratedAt`，fake-clock + deploy-only manifest 测试已写入 C0。
- intent 的明确放弃、`--store-id` 收养实际名称、确定性 4xx 与不确定失败的分流，以及 2 秒 stale-lock 重占合同都完整。
- `getStore` 的 required shape、非负整数约束与 env/store metadata 双重连接谓词已统一为所有来源每次重验。

## Issues & Recommendations

1. **[HIGH] Epic conflict 后删除“本次 audit”会让保留的稳定 HTML 立即出现断链。** `putEpicPage` 成功返回时，稳定 `index.html` 已被覆盖并引用 `auditPathname`；既然 v4 正确选择不删除该 HTML，那么该 audit 就不是 orphan。此时 `deleteExactPaths([auditPathname])` 会让旧 store 的稳定页以及 rollback 路径中的 audit 链接变成 404；若相同 digest 的 audit 路径此前已存在，删除还可能移除旧发布正在使用的对象。最简单且正确的补偿是 Epic binding conflict 时 HTML 与 audit 都不删除，等待正常 retention sweep；只有先恢复旧 HTML 并证明新 audit 无引用时才可精确删除，但这会引入不必要的补偿事务。相应地把 C0 测试改为断言稳定 HTML 和其 audit 均保留、`list`/`del` 均为 0；若采用简单方案，也无需新增 `deleteExactPaths`（它目前还遗漏于 §C4 的 `BoundReportBlobStore` 接口）。

2. **[HIGH] secret handoff 对既有同-store 文件的 no-op 仍未验证 owner、mode 和精确内容，父目录也只验 owner、不验可写权限。** 一个当前 uid 所有但 group/world-writable 的 reportsDir 仍允许其他本机用户替换目录项；已有 regular target 即使属于其他 uid、mode 0644，或包含额外行，只要解析出的 store id 相同就会 no-op，违背 0600 单行秘密文件合同。父目录至少应要求当前 uid 所有、非 symlink 且 `mode & 0o022 === 0`；已有目标必须要求当前 uid 所有、mode 0600、内容严格为一行合法 token（先加入 redactor），否则 fail-closed。rename 后再 `lstat` 验证最终 owner/mode/type。把已有同-store 但 0644、其他 uid（用 seam）、额外行，以及 group/world-writable parent 加入步骤 4b 测试。

3. **[MEDIUM] C0 的双目标测试同时要求“后到 CAS 拒绝”和“两份备份”，按当前 commit 合同不可同时成立。** §1.3 明确 source-key conflict 在备份前抛出，因此 A→B 成功、A→C 被拒的同一交错场景只应产生一份备份。将测试拆成两条：并发 A→B / A→C 断言一个成功、一个 conflict、一个目标、恰好一份备份；另用两个合法的顺序成功变更（A→B，再以 B 为 source 做 B→C）验证两个不会碰撞的备份名。

4. **[MEDIUM] C5 步骤 9 的 `retargetedFrom` 伪代码与新 `HostingBinding` 合同不一致。** 它引用不存在的 `binding0.project`，并把可选的 `binding0.vercelProjectName` / `migratedAt` 直接塞进要求两个字符串都存在的 `retargetedFrom`；对于“已有 project、尚无 hosting marker”的合法来源会产生不完整值。改成显式 helper/判定：仅当来源 project 与 target 不同且来源 project、`migratedAt` 都存在时构造 `{vercelProjectName: binding0.vercelProjectName, migratedAt: binding0.migratedAt}`；若业务要求这种来源必须留下 provenance，则把缺少 `migratedAt` 定义为前置失败。为 project 已有但 hosting 缺失补一条测试。

## Verdict

CHANGES REQUESTED — address items above
```

## Implement R1 / Lead R2 scope ruling

R1 code gate d6e5d2a3-84dc-4202-8e86-8dc7e07e1a23 reviewed e307d04802e61595a1fa16d284208061f90b4c69 and requested changes for two HIGH findings: retarget-manifest-freezes-epic-stable-token and store-id-lowercased-in-vercel-api-paths.

Lead question c1b16001-6dca-45f9-acc4-033258d55e40 authorizes the minimal fixes: persist a separate case-sensitive API store identity while keeping canonical comparisons; mark Epic registry entries mutable and recover legacy stable-token identities from authoritative publication metadata, excluding only those tokens from frozen migration retention. Do not use a global cutover timestamp fallback. Ordinary-token manifest/14-day semantics remain intact. The replay no-op advisory is included only if naturally covered by the mutable fix; sync-ps overhead and broader/null status alerts remain deferred. R2 closes only the HIGH findings and any naturally covered replay overlap.

R2 implementation: API identity fix f8682a636 preserves mixed-case resource IDs through create/connect/replay, registry reload and usage checks (43 tests passed). Mutable Epic fix covers new entries, read-only legacy identity recovery, retarget and deploy-only manifests, and day-15 refreshed Epic 200 versus ordinary-token 404 (122 focused tests passed). Replay-after-new-publications, sync-ps and broader status advisories remain follow-up scope; no global cutover fallback was introduced.
