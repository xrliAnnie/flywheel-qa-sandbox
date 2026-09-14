# Design Review — plan.md (Round 1)

Date: 2026-09-13
Author: Codex
Status: CHANGES REQUESTED

## Summary

方案方向可行：现有 `flywheel-lead.sh`、Raya updater P2–P7 状态机、cursor seed 工具与 v2 receipt 已提供主要骨架；`register → Bridge 重启 → 账本 → 班车切换 → proof → 下一班 P7` 也符合 Lead 已裁定的责任边界。但当前草案仍有确定性 schema 错误，以及停机窗口边界、崩溃续跑、founder 授权、破坏性动作前置检查、SHA 冻结和 summary 验收方面的闭环缺口。按真实代码执行时，最早会在 P4b 因 seed 格式错误停止；即使修掉该点，现有 P3 算法仍可能跳过真实消息，且若在部分 bootout 或 Discord POST 后崩溃，不能保证下一班安全续跑。因此本轮结论为 `CHANGES REQUESTED`。

## What's Good (Keep)

- 人手只执行 `register`，`install` 仍归班车所有；`import-cos-context` 不再进入关键路径，准确落实问题 `02cdabc6-e34f-4614-af54-12171c574c71` 的裁定。
- H2 把 registry/manifest 生效与一次 founder 授权的全舰重启绑定；真实 `verify --stage installed` 会验证 Bridge health 与 nudge 202，适合确认重启后的 Bridge 已识别 Raya。
- 账本缺席时计划在拿 Raya 锁、写回执和告警之前退出，方向正确；`pending-install` 也明确同步了 restart lifecycle、restart-services、converge 与 host tmux gate 的现有分类消费者。
- proof 工具坚持 source-only、0600、只读数据库、零 token 输出，并复用真实 `raya_validate_proof` / `raya_p6_evidence_valid`，保留独立 QA 而不是执行者自证，这些约束应保留。
- 两班式 P5/P6/P7、manifest CAS、三份 digest 冻结、唯一 owner 与窗口消息逐跳证据都复用了 FLY-2445 已批准的机制，没有另造第二套迁移框架。

## Issues & Recommendations

1. **P4b 的 seed 对象不符合真实 `CursorSeed` schema。**  
   `findingKey: FLY2496-R1-SEED-SCHEMA`  
   **Issue:** §6.2（以及 research §1.4）遗漏必需字段 `expectedBeforeSha256`。真实接口在 `packages/teamlead/src/bin/seed-lead-inbound-cursor.ts:22-30` 要求该字段；`:48-52` 会把 `undefined` 当作非 `null` 且非 SHA-256，直接抛出 `cursor seed before digest is invalid`。  
   **Why it matters:** 班车 N 会在 P4b 确定性失败，无法 install，更不可能在 N+1 产生 v2 receipt。  
   **Suggested fix:** 把数据模型改为包含 `"expectedBeforeSha256": null`（H3 已要求 cursor 不存在）；若支持 resume，则按真实旧文件摘要填写。增加一条把计划产出的完整 JSON 交给真实 seed 工具的集成用例，并同步修正 research。

2. **“探针前最后一条消息”不是“旧 owner 已连续确认处理完的边界”。**  
   `findingKey: FLY2496-R1-CURSOR-BOUNDARY`  
   **Issue:** 批次 B 在停旧壳后 POST 探针，再用 `GET ...?before=<probe>&limit=1` 得到前一条消息并写成 `lastConfirmedMessageId`。这条消息可能是在 bootout 后、探针前由真人发出的未处理消息，也可能是旧壳停止前尚未完成副作用的消息。`seed id < probe id` 只能证明顺序，不能证明处理完成。FLY-2445 plan §6.2 P3/P4b（`:171-180`）明确要求“已确认完成的连续前缀 + 后续确定未处理的后缀”，未知副作用必须进入 `unresolved` 并阻止 P5。  
   **Why it matters:** 当前算法会把未处理消息放到 cursor 之前，标准 Lead 从其后开始 poll，造成永久漏信；这正是本迁移不能发生的错误。  
   **Suggested fix:** 在停机前从旧 owner 的实际 durable receipt/处理证据确定最后连续已完成 id；停机后分页枚举该边界到 probe 的完整区间。只有能证明区间消息均未处理时才以已完成边界 seed；任何可能已产生副作用但无法对账的 id 写入 `unresolved` 并停止。增加“bootout 与 probe 之间真人发信”“最后一条旧消息未回复”“超过一页窗口”三类失败用例。

3. **P2/P3 的外部副作用没有达到计划宣称的可续跑语义。**  
   `findingKey: FLY2496-R1-CUTOVER-RESUME`  
   **Issue:** `raya_quiesce_legacy_owner` 当前按 brain→voice 顺序 bootout（`updater-raya-deploy.sh:220-234`），直到两者都成功才写一次 `old_stopped_at`（`:237-251`）。若 brain 已停而 voice 校验/bootout 失败，下一班仍会因 brain plist 存在而再次 bootout 一个已 unloaded job，不能保证收敛。类似地，批次 B 先 POST Discord，再 GET/write seed，最后才把 `cutover_probe` 写账本；在 POST 成功到落账本之间崩溃，重跑无法知道消息已经发送，会重复发探针，和 RED→GREEN 判据矛盾。  
   **Why it matters:** P2 之后明确没有旧脑回退；任何非幂等重试都会把 Raya 留在 maintenance，且重复窗口消息破坏唯一证据关联。  
   **Suggested fix:** 为 brain/voice 分别记录预期身份与 quiesce checkpoint，并把“匹配 plist 存在但 job 已确认 unloaded”视为已完成，而不是再次 bootout；probe 在 POST 前持久写 intent 与稳定 nonce/marker，恢复时先通过 nonce/marker 对账已有 Discord 消息再决定是否发送。为“第一项 bootout 后崩溃”“POST 返回后崩溃”“seed rename 后、账本 CAS 前崩溃”逐点写恢复测试。

4. **legacy stop 授权仍可被 ambient env 或自报 CLI 参数绕过。**  
   `findingKey: FLY2496-R1-AUTH-FENCE`  
   **Issue:** 批次 A 明确说调用环境已有 `RAYA_MIGRATION_ALLOW_LEGACY_STOP=1` 时保持，而真实 quiesce 唯一授权判断就是该 env（`updater-raya-deploy.sh:227`）。因此 malformed/missing authorization 的账本只要继承该变量，就可能停旧壳；这违反“账本中的 founder 授权由班车派生为 env”的固定裁定。H3 又允许操作者仅用 `--granted-by founder --authorization-message-id ...` 自报授权，却未读取并核对该消息的频道、作者和三项授权正文。  
   **Why it matters:** 这是退役旧生产 owner 的权限边界，不能依赖调用者环境或未经验证的字符串声明。  
   **Suggested fix:** 每次 pass 入口先清除/覆盖 caller 提供的 stop env；只在当前账本 authorization 完整、证据消息由已登记 founder 身份发出且正文覆盖 register/割接/紧急重启时，在最窄子调用内设为 1。账本补 `evidence_channel_id`（必要时补 evidence digest）。测试 caller 预设 env=1 + 账本缺失/字段缺失/伪造作者/正文不全均不得触发任何 bootout。

5. **仍有太多可预见失败被放在停旧壳之后。**  
   `findingKey: FLY2496-R1-PRESTOP-PREFLIGHT`  
   **Issue:** H3 只验证 brain plist，真实 P2 会同时触碰 brain 与 voice；H3 的 `GET /channels/<id>` 只证明可读，不证明 probe bot 能 POST。更关键的是 `raya_prepare_source` 先在 `:709` 停旧壳，随后才 fetch、fast-forward、`pnpm install`、build 与 materialize（`:710-732`）。其中任一步失败都会在无自动旧脑回退的状态下中止。  
   **Why it matters:** 这些不是只能在割接后发现的条件；把网络、依赖、构建、第二个 plist 和发信权限风险留在不可逆边界之后，会无谓扩大停机概率。  
   **Suggested fix:** 在 quiesce 前完成两份 legacy plist/loaded-owner 的全量身份核验、probe bot 实际发信能力验证、目标 SHA fetch、依赖安装、build 和候选 artifact/persona 校验；持锁后做一次轻量 revalidation，再执行两个 owner 的精确 quiesce、cursor/probe 与 pointer/install commit。测试 voice 异构、probe POST 403、fetch/build 失败均断言两个旧 job 完全未动。

6. **N→N+1 能成功依赖两个未写进冻结协议的 SHA 条件。**  
   `findingKey: FLY2496-R1-SHA-FREEZE`  
   **Issue:** 计划验收硬编码 Raya `deployed_sha=9d63a2b2…`，但 P2 实际在停旧壳后读取当时的 `origin/main`（`:721-727`），账本 init 没有目标 Raya SHA。另一方面 N 把当时 `~/.flywheel/deployed-sha` 写入账本，P6/P7 在 `raya_validate_p6_manifest:394-400` 要求 N+1 时全局 deployed SHA 仍完全相同；H0 冻结清单没有冻结 Flywheel 部署。  
   **Why it matters:** Raya main 在 H1/H3 后前移会部署非验收 SHA或在停机后因 persona 占位漂移失败；N 与 N+1 之间任何正常 Flywheel 发布都会令 finalize fail，序列不能按计划到达 v2 receipt。  
   **Suggested fix:** H3 账本记录并验证精确 `target_raya_sha=9d63a2b2…`，pre-stop 只准备该 SHA；同时明确 N 到 P7 的 Flywheel deployment freeze（或设计一个不削弱证据绑定的安全 rebind 事务）。为 Raya origin 漂移与 Flywheel deployed-sha 漂移各加一条 fail-before-quiesce/可恢复验收用例。

7. **新增 `activation_probe` 只改 shell 白名单会破坏 alert kind 双面契约。**  
   `findingKey: FLY2496-R1-ALERT-KIND-CONTRACT`  
   **Issue:** 批次 E 只列出 `scripts/lead-alert.sh:207` 与 shell 测试。真实仓库的 `kind-contract.test.ts:393-439` 明确要求 shell allowlist（除两个历史例外）中的每个 kind 都存在于 `LeadAlertNotifier.ALERT_EVENT_TYPES`；TS union 新增后又必须在 `KIND_CONTRACTS` 中有 owner/ARC contract，info 行为还由 TS 与 shell 两份 `INFORMATIONAL_KINDS` 镜像约束。  
   **Why it matters:** 按当前文件清单实现会直接导致 TS/contract 测试失败，或者 queued/Bridge 路径拒绝该 kind；proof 因 `alert_reachable` 缺失而不能进入 P6。  
   **Suggested fix:** 批次 E 同步修改 `packages/teamlead/src/LeadAlertNotifier.ts`（union + informational set）、`packages/teamlead/src/bridge/kind-contract.ts`（明确 owner/ARC）、shell informational mirror及 parity tests；若有共享 copy 的穷举约束也一并更新。测试 strict delivery 的 direct 与 queued 两条路径。

8. **账本缺席分支按计划会输出两行，而不是 Lead 裁定的一行。**  
   `findingKey: FLY2496-R1-LEDGER-INFO-COUNT`  
   **Issue:** 批次 A 要在 pass 内调用 `raya_log` 一行；但 `scripts/update-flywheel.sh:727` 在 scheduled 分支之后无条件再打印一行 `raya shuttle: <state> <detail>`。  
   **Why it matters:** 这直接违反已冻结的“一班一行 info”运维契约，也会让日志验收和告警降噪测试出现歧义。  
   **Suggested fix:** 缺账本分支只设置 `RAYA_DEPLOY_STATE=not_configured` 与 `RAYA_DEPLOY_DETAIL=migration-ledger-absent`，统一让外层 `:727` 输出唯一一行；不要在 pass 内额外 `raya_log`。集成测试捕获完整 scheduled wake stdout/stderr，并断言该 detail 恰出现一次。

9. **H1 的 `commit ... || true` 会吞掉真实 checkpoint 失败。**  
   `findingKey: FLY2496-R1-MEMORY-CHECKPOINT`  
   **Issue:** §4 H1 `git add -A && git commit ... || true` 无法区分“没有变更”和 hook、签名、身份或 I/O 导致的 commit 失败；随后 local clone 只复制 HEAD，不包含失败后仍在 index/worktree 的那一行。  
   **Why it matters:** 计划声称迁移完整 memory 历史，但该命令可静默让新 Raya 缺少最新记忆；旧仓还在并不能让激活后的行为正确。  
   **Suggested fix:** 先显式检测 dirty 状态；有变更时 commit 必须成功，否则停止。clone 后校验两仓 HEAD 相等、旧仓 clean、关键树 digest 相等；仅在明确 `nothing to commit` 时跳过 commit，禁止 blanket `|| true`。

10. **summary merge 既未进入 P6 gate，“Raya bot 合并”也无法由当前 receipt 证明。**  
    `findingKey: FLY2496-R1-SUMMARY-PROVENANCE`  
    **Issue:** H4 prose 要求至少 merge 一张 summary PR，但 research §1.5 与真实 `raya_p6_evidence_valid:349-354` 只验证 `summary_round_id/summary_delivery_id`，proof/P7 不读取 merge receipt。当前 `SummaryMergeReceiptRow`（`packages/flywheel-comm/src/summary-pr-merge.ts:48-59`）也没有 actor 字段，merge 是用宿主 `gh` 凭据执行（`:197-212`）；§8 却要求“merge 者为 Raya bot”，§9 又承认来源不可辨识时再开 follow-up。  
    **Why it matters:** 班车可以在从未完成 summary merge 时写出 deployed v2 receipt；独立 QA 也无法满足当前硬验收，导致“已激活”和“端到端已验收”状态相互矛盾。  
    **Suggested fix:** 二选一并写清状态机：(a) 若 summary merge 是 P7 前置，把与本轮 `roundId` 绑定的 merge receipt（repo/PR/head/ts）纳入 proof 与 P6 validator，并在本 PR 实现可验证 actor provenance；(b) 若它是 P7 后观察项，则把 P7 定义为 carrier activated，另设独立 acceptance receipt/status。未实现 actor provenance 前，验收只能证明“Raya round 触发并留下 roundId-bound merge receipt”，不能声称 GitHub actor 是 Raya bot。

## Advisory (non-blocking)

- H2 代码块只展示一次 `register`，注释才说先 dry-run。作为生产 runbook，建议展开成两条完整命令，第一条显式带 `--dry-run`，避免执行者直接复制后跳过预览。
- H1 停止线要求与 `~/.codex-mufasa` 比较版本，但证据命令只打印新 home 版本；补一条精确、机器可判定的版本相等命令。
- seed 支持 `emptyChannels`，但 P6 要求 `cutover.channels` 非空（`updater-raya-deploy.sh:361-363`）。proof 工具应明确把空频道表示成 `{channel_id, seeded_after:"0"}`，否则数据模型允许的分支无法过 P6。
- 本轮为 source-grounded static review；已确认计划引用的主要脚本、TS 源与测试文件存在并核对相邻代码，但未执行会生成构建/测试产物的套件，以遵守“除反馈文件外不修改任何文件”的边界。

## Verdict

CHANGES REQUESTED — address items above
