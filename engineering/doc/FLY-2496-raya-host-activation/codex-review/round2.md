# Design Review — plan.md (Round 2)

Date: 2026-09-13
Author: Codex
Status: CHANGES REQUESTED

## Summary

v2 明显收敛，且 R1 的 `SEED-SCHEMA`、`LEDGER-INFO-COUNT`、`MEMORY-CHECKPOINT`、`SUMMARY-PROVENANCE` 已正确关闭；dry-run、版本比较和 empty-channel proof 映射也已补齐。其余改动中，逐 job quiesce、Raya target pin、ambient stop env 清除和 alert 双面文件清单都朝正确方向推进，但仍有六个原 finding 的关键部分未闭环：Discord 上任意一条 Raya bot 消息不能证明全局连续处理前缀；probe 恢复只看 50 条仍会重复发送；founder scope 仍由执行者自证；停旧壳后仍重复 build；Flywheel SHA rebind 与真实 restart/deployed-sha 顺序及下一班路径不相容；新增 alert kind 仍遗漏穷举 copy 源。它们分别会造成漏信/重复副作用、越权停旧壳、不可逆窗口内可避免失败、无法 rebind 或确定性编译失败，因此本轮仍为 `CHANGES REQUESTED`。

## What's Good (Keep)

- §6.2 已与真实 `CursorSeed` 对齐，明确首写用 `expectedBeforeSha256: null`，并要求把生成物交给真实 seed CLI；`FLY2496-R1-SEED-SCHEMA` 可关闭。
- 账本缺席分支现在只设 state/detail，由 `update-flywheel.sh:727` 输出唯一日志；`FLY2496-R1-LEDGER-INFO-COUNT` 可关闭。
- H1 已移除 blanket `|| true`，并在 clone 后验证 clean、HEAD 与 tree；`FLY2496-R1-MEMORY-CHECKPOINT` 可关闭。
- P7 被准确收窄为 carrier activated，summary merge receipt 改为 P7 后、roundId 绑定的观察项，且不再声称 GitHub actor 是 Raya bot；`FLY2496-R1-SUMMARY-PROVENANCE` 可关闭。
- 逐 job `stopped_at`、matching plist + unloaded 视为已完成，修正了 brain 已停而 voice 失败后的重试死角；这部分应保留。
- `target_raya_sha`、scratch worktree、两份 legacy plist、TS/shell informational mirror、kind contract 和 direct/queued 测试均是正确的收敛方向。

## Issues & Recommendations

1. **P3 仍未得到 FLY-2445 要求的“已确认完成的连续前缀”。**  
   `findingKey: FLY2496-R1-CURSOR-BOUNDARY`  
   **Issue:** §5 B 把“最后一条 Raya bot 自己发的消息 B”视为 B 之前全部消息均已处理。生产旧壳精确在 `0f77e977`；它同时启动 voice 与 meeting 两个独立 Discord gateway（`~/.flywheel/raya/code/apps/brain/src/cli.ts:147-226`），各 listener 都以 detached async 方式处理消息（`voice-mode.ts:629-639`、`meeting.ts:1036-1046`），两个 controller 也只有各自的 queue（`voice-mode.ts:116-135`、`meeting.ts:874-902`），不存在一条 Raya bot outbound 能充当所有入口的全局 drain fence。B 还可能是 voice/meeting/定时状态消息，而不是对某条普通文字的处理回执。此外 `old_stopped_at` 来自秒级 `raya_now_iso`；用 Discord 毫秒 timestamp 与它比较，会把同一秒内、实际停机前的消息误分到新 owner suffix。§7 的 `resolve --message-id` 只是清空 unresolved，也没有说明“已处理”时如何推进连续边界、或“未处理”时如何保留 replay；`boundary_search_exhausted` 甚至没有可传的 message id。  
   **Why it matters:** 任意旧消息可能被 seed 到 cursor 之前而永久漏掉，或已产生 calendar/meeting 等副作用后又被新 owner 重放。这仍违反 upstream plan `:171-180` 的硬合同。  
   **Suggested fix:** 不再以 author==Raya bot 推断全局前缀。边界必须来自 source-message 逐条绑定的 durable receipt/reply reference 与能够证明全入口 drain 的 fence；拿不到时，把待核区间全部保留为 unresolved。`resolve` 需写不可变 resolution receipt，至少区分 `confirmed_processed`、`confirmed_unprocessed`、`side_effect_reconciled`，且只有从旧边界起连续的 processed 项才能前移 seed；unprocessed 项必须留在 suffix。为 search exhaustion 提供显式、带证据的 boundary resolution，而不是删除一个伪 message id。增加双 gateway 交错、无关 bot outbound、同秒停机、processed/unprocessed 两类 resolve 测试。

2. **probe intent 已持久化，但恢复搜索的 50 条上限仍允许重复 POST。**  
   `findingKey: FLY2496-R1-CUTOVER-RESUME`  
   **Issue:** §5 B 在 POST 后崩溃时只执行 `GET ...?limit=50` 查 nonce；若崩溃到重跑期间频道已有 51 条以上新消息，已发 probe 会落出窗口，代码按计划再次 POST。intent 先写并不能弥补这个盲区。  
   **Why it matters:** 这直接打破“同一 P3 重跑不重复发探针”和唯一 window message 证据；高流量或长时间 maintenance 恰是最需要可靠恢复的情形。  
   **Suggested fix:** 恢复时按页回溯到 `intent.at`/可证明的 Discord snowflake 下界；找到 nonce+author 即复用。若达到明确总页数/时间预算仍无法证明不存在，写 `probe_delivery_ambiguous` unresolved 并停止，绝不能盲目重发。增加 51+ 条、500+ 条/搜索耗尽、分页 403/timeout 三类“零第二次 POST”测试。逐 job quiesce 的 R1 修复可保留。

3. **founder authorization 的 scope 仍由执行 Lead 自证，且计划又引入了第二个 runtime env 旁路。**  
   `findingKey: FLY2496-R1-AUTH-FENCE`  
   **Issue:** H3 只机器核验 founder 作者和正文含 `FLY-2496`，三项 scope 来自调用者传入的 `--attest-scope`。因此 founder 发出的“FLY-2496 暂不批准”也能与操作者自报 scope 组合成可停旧壳的账本。另，批次 A 提议生产代码识别 `RAYA_TEST_ALLOW_LEGACY_STOP` 一类不同名变量；只要 runtime 能读它，它就是新的 ambient 授权后门，而不是测试 seam。founder id 也不应自行在两个 env 名中任选，应复用已有 `packages/flywheel-comm/src/founder-attribution.ts` 的 canonical/mismatch 规则。  
   **Why it matters:** 旧 owner 退役的 founder-only 权限仍可由执行者或环境变量提升，R1 finding 的核心边界没有关闭。  
   **Suggested fix:** 规定 founder 消息包含机器可判定的 canonical authorization 行，例如 issue、target SHA 与精确三项 scope；工具直接校验这些固定 token，不需要 NLP，也不接受调用者扩张 scope。复用公共 founder identity resolver，并在两个 identity env 冲突时 fail-closed。生产路径只认账本派生的原变量；测试使用完整账本 fixture、函数注入或 source harness，禁止任何第二个 `*_ALLOW_LEGACY_STOP` runtime 开关。补“founder 拒绝文本含 FLY-2496”“CLI scope 超出消息”“两个 founder env 冲突”“测试变量在生产路径置 1”负向用例。

4. **pre-stop 仍未把可避免失败全部移出不可逆边界。**  
   `findingKey: FLY2496-R1-PRESTOP-PREFLIGHT`  
   **Issue:** H3 的真实 POST 可能比班车 N 早约 40 分钟；N 的 `raya_prestop_prepare` 只重新 `GET /users/@me`，不证明此刻仍有 #raya 发信权限。批次 B 的测试栏自己保留了“POST 403 发生在 pre-stop 还是 P3？”的未决问号。更直接的是 scratch worktree 已成功 install/build 后，P2 仍在 quiesce 之后对主 checkout 再执行 `pnpm install --offline` 和 build；这两个命令仍可失败，因而“确认能成才停旧壳”的核心承诺不成立。  
   **Why it matters:** 权限漂移、offline store/脚本差异或第二次 build 失败都会在无自动旧脑回退后才被发现；这些均可在停机前消除。  
   **Suggested fix:** N 的 pre-stop 用稳定 intent 做一次当场 POST 能力探针（明确标记并从迁移输入隔离），而不仅是 @me。把 scratch 产生的、已做完整 artifact/persona digest 的候选版本作为唯一待 promote 产物；quiesce 后只做身份 revalidation、原子 pointer/materialization 与必需的 Lead install，不再运行包安装或构建。主 checkout 的 ff 可在停机前完成或在 P5 后对账，但不能重新决定运行字节。测试 N 前撤销 SEND_MESSAGES 与“第二次 build 本会失败”时，均断言旧 jobs 未动且候选字节不变。

5. **Flywheel SHA rebind 与真实部署顺序及 scheduled updater 路径不闭合。**  
   `findingKey: FLY2496-R1-SHA-FREEZE`  
   **Issue:** H4 要求 Raya `process_started_at` 晚于“该次部署”，但真实 `restart-services.sh` 先执行 Lead wave（`:3237-3256`），之后才写 `~/.flywheel/deployed-sha`（`:3271-3276`），再写全局 `leads-restart-status.json`（`:3315-3324`）；当前没有把 exact Flywheel SHA 与 Raya pid/start tuple 绑定的 durable receipt，`verify --stage live` 也只要求 Bridge health 有任意非空 buildSha（`flywheel-lead.sh:855-862`），并不证明该 Raya 进程承载当前 SHA。并且每次 scheduled Flywheel deploy 完成后会立即调用 Raya pass（`update-flywheel.sh:711-727`）；账本仍在 P5 且 SHA 尚未人工 rebind 时，现有 `raya_prepare_source:703-706` / `raya_verify_frozen_source:569-570` 会先报 `source-prepare-failed` severe。若部署发生在 proof 写好之后、N+1 之前，旧 proof 又会失效，而 N+1 在 collect 前就被 frozen-source 拦住；现方案既不会自动 rebind，也没有 proof invalidation/recollect 协议。  
   **Why it matters:** “Flywheel 自身部署不冻结”在真实路径上会产生误告警、无法证明进程/代码绑定，并可能让两班序列永久多出人工步骤或停在 P5。  
   **Suggested fix:** 二选一：(a) 在 restart wave 持久写 exact `{codeDeployedSha, leadKey, pid, processStartedAt, recordedAt}` receipt，P5 SHA 漂移先进入非告警 `awaiting_rebind`，proof 只凭该 receipt CAS rebind 并作废旧 proof；覆盖 deploy-before-proof、deploy-after-proof-before-N+1、多次 deploy 与 race；或 (b) 允许 H4 前 rebind，但从 proof 成功到 P7 设置短冻结。无论哪种，都要求 Bridge buildSha==current deployed SHA，并保证 N+1 不会在合法漂移时先走 severe frozen-source 分支。

6. **`activation_probe` 的 TS alert face 仍少一个确定性编译依赖。**  
   `findingKey: FLY2496-R1-ALERT-KIND-CONTRACT`  
   **Issue:** 批次 E 已补 union、informational set 与 `KIND_CONTRACTS`，但遗漏 `packages/teamlead/src/bridge/alert-kind-copy.ts`。其中 `titleFor` 与 `bodyFor` 是无 default 的 `AlertEventType` 穷举 switch（`:204-462`、`:486-725`），仓库 `tsconfig.base.json:18` 开启 `noImplicitReturns`；向 union 加 `activation_probe` 而不加两个 case 会确定性 build 失败。`severityFor` 当前也只把 `model_family_updated` 判为 info（`:464-476`），而 shell 默认 severity 是 warning（`lead-alert.sh:112`）；research §1.5 的命令简写又遗漏 shell 必需的 `--title/--body`（`:173-176`）。  
   **Why it matters:** 实现 PR 无法通过 build，或 probe 以 warning 而非计划声明的 info 发出，P6 的 `alert_reachable` 仍不可依赖。  
   **Suggested fix:** 批次 E 加入 `alert-kind-copy.ts` 的 title/body 与 info severity case，并更新 `alert-kind-copy.test.ts`；同步扩展 `kind-contract.test.ts` 的 exact informational set。计划写出 proof 工具调用的完整 shell argv（含 `--severity info --title --body --signature --strict-delivery`），direct/queued 测试断言相同 info 语义和唯一机器输出行。

## Advisory (non-blocking)

- `research.md` §4/§6 仍写 `GET ...limit=1` 与“探针前最后一条即 seed”，和 v2 的分页/unresolved 方案直接冲突；`exploration.md` 也保留同一旧结论。实现前应同步这些依据文件，避免工程师按“research carries evidence”采用已否定算法。
- H4 §4 写“summary 观察（不是 P6 门）”，但真实 `raya_p6_evidence_valid:352-354` 仍要求 `summary_round_id/summary_delivery_id`。建议明确：summary round delivery 仍是 P6 gate，只有 roundId-bound merge receipt 是 P7 后观察项。
- H3 pre-check 是“先 POST、后写账本”；工具在两者之间崩溃会留下重复消息，且同一 probe bot 还需同时读取 #flywheel-engineer 与写 #raya。建议为 pre-check 也使用持久 nonce receipt，并把双频道权限列入 H0 选 bot 条件。
- 建议命令 `bash lead-alert-strict-delivery.test.sh lead-alert-external-kind.test.sh` 只会运行第一个脚本，并把第二个路径作为 `$1`；应拆成两条独立命令。
- P7 后若当轮没有 open summary PR，当前观察项永远无法满足。建议定义可审计的 `no-candidate` 结果，或在激活前确认有一张合规候选 PR；这不应反向影响 carrier P7。
- 本轮按要求做 source-grounded static review；未运行会生成测试/构建产物的命令，以保持“除反馈文件外不修改文件”的边界。

## Verdict

CHANGES REQUESTED — address items above
