# FLY-2808 非阻塞评审建议 — 调研
Issue: FLY-2808 (https://linear.app/geoforge3d/issue/FLY-2808/节点生命周期n1-设计主动退下与意外死亡的区分信号-六个会把退下当死亡的打断点怎么改-拉起的身份模型工作目录核对)
日期: 2026-09-22
基于: plan.md、review-receipt.json

有效设计 verdict=APPROVED（R2）。Lead 后续授权本单直接实现；以下 disposition 只说明当前代码是否覆盖建议，完整 findingKey 和理由仍见 review-receipt.json。生产与真实 QA 证据仍未执行。

| 优先级 | findingKey | 后续建议 / 验收关注 |
|---|---|---|
| MEDIUM | sweep-scope-misses-core-and-claude-runner | 已覆盖 core adapter contract、Claude/Codex adapter、completion/rework、Heartbeat、pane loss、auto reowner、expiry、recipient 与 fault budget；validation 记录消费者搜索及排除项 |
| MEDIUM | stale-worktree-context-after-head-advance | 已实现 lastObservedHead/current HEAD/dirty 比对，并在恢复首轮 prompt 前注入重读提示；真实模型收到提示待独立 QA |
| MEDIUM | single-issue-scope-vs-incremental-pr-landing | Lead 明确要求当前一张 PR 完成完整默认关闭实现；仍保留小提交、独立 code review/QA，未获得 ship 权限 |
| LOW | pane-loss-reconcile-missing-from-closure-list | 已接线：confirmed standby 跳过 pane-loss/monitor-lost 误报，并有定向测试 |
| LOW | carrier-term-collides-with-existing-ship-gate-carrier | 实现采用 `process_body` / process lifecycle 命名，未引入新的裸 `carrier` 类型 |

以上“已覆盖”只指当前分支源代码和定向本地证明，不表示生产启用或 QA 通过。

## 实现 code review R2 disposition

旧 head `3f03ea22` 的 gate `0afda40e-8a35-4302-bbb2-7e6687293f06` 为 `CHANGES_REQUESTED`。三个 HIGH（共享工作树被重建、失败后孤儿进程、无 lease 的永久 resuming）与 substantive MEDIUM 已在后续代码提交修正，并由当前 code-head focused/related/build/typecheck 复核；必须对新的 exact head 再请求 review，旧 verdict 不可复用。

仍保留两项 LOW，避免为默认关闭路径提前引入新的 scheduler 抽象：

- 同 worktree 串行、跨 worktree 最大 2 的 admission/queue limiter 尚未实现；设计默认值保留给后续实现单。
- `queueMs` 仍是占位，`totalMs` 当前止于身份确认而非首个模型消费回执；需要后续定义并接入可审计 receipt。

## 实现 code review R3 disposition

旧 head `09d931b99` 的有效 verdict 为 `CHANGES_REQUESTED`。本轮按 Ponytail 只处理评审指出的现有路径，没有新增 scheduler 或监控抽象：

- HIGH：恢复失败不再调用只接受终态 session 的通用 teardown；新增的物理 cleanup 只接受精确 process generation/demand/owner fence，保留 workflow lifecycle/CommDB 状态，并在 execution-wide liveness 证实死亡后才返回成功。cleanup 未确认仍阻止重试和 fresh fallback。
- HIGH：resume 同时观察 `StartResult.launchOutcome` 与身份回报。`absent`/`cleaned` 的 precommit failure 不做破坏性 cleanup；已启动或证据 unknown 才进入上述 fence 清理，避免后台 launch 留活。
- MEDIUM：resume lease 从 180 秒增至 5 分钟，明确长于 180 秒身份超时；非 generalized resume 也可选择观测 launch outcome。
- LOW：Claude/Codex adapter 的 `onRetired` observer 异常被隔离，不再把已成功 launch 改写为失败。

R3 关于 limiter、`queueMs`/首个模型消费 receipt 的 LOW 建议与 R2 已记录的两项相同，继续保留为后续单，未在默认关闭实现中提前扩面。以上 disposition 仍需新的 exact-head code review 才能生效，不能复用 R3 旧头 verdict。

## 实现 code review R4 advisories

Exact head `a351d044b` 的 R4 effective verdict 为 `APPROVED`；以下建议不阻塞该 review，但已通过 `ask --report` 交给 Lead：

- MEDIUM `resume-cleanup-unconfirmed-permanent-latch`：`cleanup_unconfirmed` 已只在物理死亡无法证明时 fail closed，但仍缺少 Lead 可审计的 reopen 操作；同时 founder activity DTO 对该 latch 仍可能投影 `canResume: true`。需后续把人工解锁权限、审计 receipt 与 `canResume` 语义一并设计，不能以直接改库代替。
- LOW `resume-metrics-and-concurrency-caps-missing`：与 R2/R3 已记录项相同，仍缺同 worktree 串行、跨 worktree 最大 2，以及 queue/首模型消费时点的准确 receipt。

QA full CI 后的首轮 implement rework 只修复 feature-flag governance 红项，没有修改无关真实 tmux/load-probe 测试。由于 head 已移动，R4 approval 不能绑定新头。

## 实现 code review R5 advisories 与 Lead 必修 disposition

R5 gate `14b2c500-dc14-46e4-9207-826823ffa26f` / request `4480df89-00ae-4bab-aac8-aac34fd81bc5` 对旧 head `b39a2ea75` effective verdict 为 `APPROVED`。Lead 随后以 `[lead-instruction ec413437-959a-4757-8b3a-d1d6f6e76d4d]` 明确要求交卷前处理 cleanup latch，因此该项不再作为可选 follow-up：

- MEDIUM `resume-cleanup-unconfirmed-permanent-latch`：已覆盖。latch 期间 founder activity DTO 返回 `canResume=false`；master-token-only、无 `/api/actions` alias 的审计 route 事务内记录 server-derived actor、时间、原因和 prior attempt 边界，再将 reason 改为 `operator_reopened`。旧尝试保留可审计，新的 resume budget 从审计边界后重新计数；fault replacement 额度不受影响。先红后绿与权限负例见 validation.md。
- MEDIUM `standby-enrollment-misses-two-admission-paths`：已在 QA 529 返工覆盖。fresh run 首节点与 Lead retry 都在 admission 时读取同一个 governed flag resolver 并传 `standbyResumeEnabled`；正例分别断言 generation 1 process body 建立，默认缺省仍为 false。没有引入第二套 flag read 或新抽象。
- LOW `resume-metrics-and-concurrency-caps-missing`：仍保留。缺同 worktree 串行、跨 worktree 最大 2，以及真实 queue/首模型消费 receipt。
- LOW `admit-env-param-now-dead`：仍保留。flag 已改走 governed boolean 后，admission API 的 `env` 参数不再使用；后续删除该参数及调用方传值，不重新引入 env flag read。

plan 批准后的追加实现与历次修正均通过 scoped code review 重新绑定移动后的 head；本轮 Lead 必修提交后仍必须以 literal-last exact head 请求 R6。R5 approval 不能复用为当前头证据。

## QA 529 返工 code review round 1 disposition

Gate `40109733-b033-48de-b546-71a1c2dc128a` / request `fbec17a0-fd25-4dc3-bf55-ccdb0dc980bc` 对旧头 `be80b3e2c` effective verdict 为 `CHANGES_REQUESTED`：

- HIGH `model-alias-vs-canonical-mismatch`：已覆盖。admission 在写 immutable runtime 与 audit 前，将 registry-owned alias 规范化为 canonical id；旧快照的 Claude `fable` 和 Codex `astra` 先红后绿，保证 initial launch、manifest 校验、fresh resume 与 adapter identity 比较都读取同一 runtime model。
- MEDIUM `retiring-state-has-no-watchdog`：未在本轮扩大。reviewer 指出 adapter timeout / standby confirmation refusal 可把 body 留在 `retiring`；需后续实现有界 watchdog、可审计失败态与 resident hold 收口，并做真实 timeout/restart 验证。
- MEDIUM `ledger-backfill-vs-immutability-trigger`：未在本轮扩大。reviewer 指出 rollback 后再 roll-forward 时旧 binary 可能写入待回填 purpose，而新 immutability trigger 会阻止 backfill；需后续把 trigger drop 移到 backfill 前或只在加列 migration 分支执行，并补回滚/前滚 DB 用例。
- LOW `resume-reason-code-unbounded-free-text`：未在本轮扩大。resume 原始异常文本可能含内部路径并经 activity DTO 暴露；后续应使用闭集 reason code，把诊断 detail 留在非 founder surface。

上述 advisory 已准备通过 mandatory report channel 交给 Lead 决定后续范围；本轮只修直接阻断启用后首节点的 HIGH，并对新 exact head 重新申请 code review。

## Implement 3/4→4/4 恢复批次 disposition

- MEDIUM `retiring-state-has-no-watchdog`：已覆盖。Claude/Codex 都从 durable `retirement_requested_at` 续算默认 60 秒 grace；到期只停止当代绑定的精确窗口/daemon 并验证物理消失。最终 controller 许可丢失、founder TUI 仍存活或消失无法证明时写 `retirement_unconfirmed`，不假报 standby。没有新增可漂移的 ambient grace env。
- R4 MEDIUM `resume-cleanup-unconfirmed-permanent-latch` 的同类退休失败面：已覆盖。`cleanup_unconfirmed` 与 `retirement_unconfirmed` 均在 founder surface 显示 `canResume=false`，同一个 master-token-only 审计 route 可在人工证明清理完成后重开；receipt 支持退休前尚无 demand 的 `demandId=null`，保留 actor/time/reason/latch reason 和旧 attempt。
- MEDIUM `ledger-backfill-vs-immutability-trigger`：仍保留，未在本轮 retirement/529 范围内改 migration。
- LOW `resume-reason-code-unbounded-free-text` 与 `resume-metrics-and-concurrency-caps-missing`：仍保留，未扩大 founder 诊断词汇或新增 scheduler。

这些 disposition 仍须由新 literal-last exact head 的 R8 code review 验证；此前 R7/旧头 verdict 不复用。

## R8 round 1 disposition

R8 exact head `34c5cf900` 为 `CHANGES_REQUESTED`；两条 HIGH 已在后续提交 `3f8565228` 修正：

- HIGH `resume-lease-reap-without-liveness-proof`：已覆盖。lease expiry 不再自动起下一 generation；先进入 `resume_lease_expired` fail-closed latch，founder `canResume=false`，必须由 master-token 审计重开后再恢复独立 resume budget。
- HIGH `ledger-purpose-backfill-aborted-by-immutability-trigger`：已覆盖。roll-forward migration 在 purpose backfill 前 drop 新版 immutability trigger，backfill 后重建；新增真实 SQLite rollback/roll-forward 用例固定顺序。
- MEDIUM `claude-retirement-evidence-is-window-absence-only`：保留 advisory。当前只证明绑定的精确 Claude tmux window 消失，未枚举逃逸 pane process-group 的 MCP/tool child；后续需以 PID/start-time/process-group 清单补强同 vendor 合同。
- MEDIUM `resume-budget-cannot-be-reopened-after-exhaustion`：保留 advisory。本轮只修 lease/cleanup/retirement 三类物理清理不确定 latch；普通两次失败与 fresh fallback 后的 broader operator recovery 需单独定义 closed-body 审计语义。
- LOW `completion-projection-keys-on-body-existence-not-state`：保留 advisory。当前调用前置条件使 reviewer 未构造可达路径；后续把 projection 与 retirement CAS 统一到 `state=active` predicate。
- LOW `admit-env-param-dead`：保留 advisory。删除未读参数及 engine caller 传值，不重新引入 env flag read。

这些 advisory 必须在下一轮 review 通过后按协议报告给 Lead；本实现节点不因非阻塞项扩大范围。

## QA@2 retiring 卡死 disposition

QA@2 在旧头 `ffb3136a9` 的 Claude `eng_design` 首节点复现了 process body 长期 `retiring`、PID/window 仍活的 blocking failure。本轮 disposition：

- `/api/runs/start` entry 已与后续 workflow-engine 启动对齐，显式传入当前 process body 的 `processLifecycle`；Claude 首节点测试固定 `active -> retiring -> standby`，不再遗漏退休 observer。
- Bridge 既有 patrol tick 新增 independent retirement reconciler。它从 durable `retirement_requested_at` 计算固定 60 秒 deadline，脱离 adapter wait 生命周期运行，并以 execution/node/process generation/request timestamp fence 清理精确身体。
- cleanup 只有在 execution-wide 物理死亡得到证明后才写 `standby`；无法证明则写 founder 可见且 `canResume=false` 的 `retirement_unconfirmed`。现有 master-token 审计重开保留 actor/time/reason/旧 attempt，不消耗 fault replacement budget。
- Claude/Codex 共用同一 StateStore/reconciler 代数；本轮回归先固定 Claude 真正暴露的入口，Codex 继续由共享 cleanup/fence 与 related 覆盖。

仍由 QA 负责在新冻结头重跑真 Discord 529 N-to-N 与 exact-head full CI；本地 584-file related 绿不替代这两项。R8 仍保留的非阻塞 advisory（Claude 逃逸 process-group 证据、普通 resume exhaustion 的审计重开、completion active predicate、dead env 参数）未在这次 blocking rework 中扩面。

## QA claim 1475 非阻塞 follow-up

- LOW `adapter-retirement-false-branch-observability`：已由 QA claim 1479 的 Lead R3 指令覆盖。`TmuxAdapter.retirementGraceExpired()` 的 lifecycle/observer 缺失、未批准、approval read 失败、grace 未到四条 `false` 分支现在各有闭集 reason code + execution id，并在单次 wait 内去重；完整红绿证据见 validation.md。

## R11 round 1 disposition

R11 gate `e8de2bcc-5343-45aa-ac2d-94cd8ac8437b` / request `f15a301c-8f20-405e-a640-73fa7fce8d5d` 对旧 head `be4aa4ee2` 返回 `CHANGES_REQUESTED`：

- HIGH `claude-resume-identity-is-self-referential-and-premature`：已覆盖。Claude resume 现在必须收到真实 `SessionStart` 的 `source=resume/session/model/canonical cwd`，callback server 传回实际值；controller 将同 generation durable 提交为 `active` 后才签发逐 launch ack，首个 prompt/tool 在 ack 前 fail closed。旧的 manifest 自报不再调用 identity callback。
- MEDIUM `context-loss-is-not-founder-visible`：保留 follow-up。当前 context loss 仍只进入 audit reason；后续应在 founder activity projection 使用闭集诊断并保持敏感 detail 不外露。
- MEDIUM `claude-cleanup-can-report-cleaned-after-refused-kill`：保留 follow-up。`cleanupExactWindow` 在 tmux unreachable 或 kill refused 后的物理死亡证明应与 Codex 路径同强度，避免仅凭后续 window lookup 把不确定清理记为 cleaned。
- MEDIUM `resume-reason-code-unbounded-free-text`：继续保留。异常 detail 不应直接成为 founder-facing reason；后续统一闭集 reason code 与私有诊断 detail。
- LOW `resuming-not-terminal-immune`：保留 follow-up。与 retiring/standby 的迟到终态免疫一致，后续应为同 generation 的 `resuming` 增加精确保护，同时保留真实 active completion。
- LOW `preexisting-run-dispatcher-test-failures`：评审环境信息，不归因本轮；本轮 teamlead related 在当前工作树 104 files / 1203 PASS。

这些 advisory 不扩入本次唯一 HIGH 修复；新 exact head 仍需独立 R12 code review，R11 verdict 不复用。

## R12 round 2 disposition

R12 gate `7064b216-55dd-437c-8dc3-49ea7135261d` / request `611cf9db-cbf5-4c22-942e-741932d233eb` 对旧 head `5445d6389` 返回 `CHANGES_REQUESTED`：

- HIGH `resume-hook-requires-model-absent-from-claude-resume-payload`：已覆盖。真实 resume SessionStart 不带 model 时，hook 现在按 plan §5.3 组合已确认 launch expected model 与精确 session transcript 的最后 assistant model 元数据；缺失、损坏、不匹配一律 exit 2，验证值才回传 callback。自测 fixture 明确不再注入 payload model。
- MEDIUM `resume-identity-gate-fails-open-if-the-hook-script-is-not-deployed`：保留 follow-up。Bridge 启动会同步脚本，但单次 resume launch 尚未在 preflight 验证 runtime 文件存在且可执行；后续应使缺失/不可执行在打开 tmux 前 fail closed，并避免依赖 exit 127 的非阻断语义。
- MEDIUM `context-loss-never-surfaces-to-founder`：继续保留。fresh fallback 的 context-loss 需要投影到 replacement execution 的 founder DTO，而不是只写在已 closed 的旧 body。
- MEDIUM `claude-retirement-evidence-accepts-a-refused-kill`：继续保留。Claude cleanup 应与 Codex 一样在 tmux probe 不可用时 fail closed，并要求 audited kill/物理消失证据一致。
- MEDIUM `resume-reason-code-unbounded-free-text`：继续保留。reason 需闭集化并把 host/path detail 留在非 founder audit。
- LOW `resuming-state-not-immune-to-late-terminal-status`：继续保留。后续以同 generation fence 扩展迟到终态免疫，不屏蔽真实 active completion。
- LOW `preexisting-run-dispatcher-test-failures`：评审环境信息，reviewer 已在 merge base 同样复现，不归因 FLY-2808。

这些 advisory 不扩入 R12 唯一 HIGH 修复；修正后必须对新的 literal-last exact head 开 R13，旧 verdict 不复用。

## QA claim 1479 code review round 1 disposition

Gate `930926b7-8e36-45a8-afa6-a3f58157ea30` / request `1479f158-f7f1-420b-bd5b-6e4d2e4e92f9` 对旧 exact head `caa176421` 返回 `CHANGES_REQUESTED`：

- HIGH `resume-spawn-before-turn-and-activation`：已覆盖。物理 standby resume 现在只发生在 activation admission、credential mint/rotation、TURN grant 与 TURN projection 之后；身份验证成功后才激活 holder 并 wake。顺序与失败路径由 coordinator 点名测试固定。
- MEDIUM `retirement-unconfirmed-never-latched`：按 Lead R2 明确语义保留。兜底只有正向存活证据 `failureConfirmed=true` 才能落 failure latch；探测 unknown 继续保持 `retiring`，避免把“确认不了”误报成故障。独立收口器/更强物理证据可另单加固。
- MEDIUM `runtime-model-canonicalized-outside-flag`：保留 follow-up。本轮只修 TURN-before-spawn，不移动既有 runtime model canonicalization 边界。
- MEDIUM `codex-resume-model-evidence-is-an-echo`：保留 follow-up。Codex 仍缺来自已恢复 daemon/session 的独立 model/cwd evidence；本轮不把 launch input 重命名为运行时证明。
- MEDIUM `codex-resume-not-gated-on-durable-verified`：部分风险由本轮消除：Codex 物理启动前已有 activation、credentials 与 TURN；但 resume verified 前的 vendor-side input gate 仍需独立设计，继续作为 follow-up。
- LOW `tmux-session-absent-reads-as-unknown`：按 Lead R2 fail-closed 语义保留。当前无法区分“session 确认不存在”和探针基础设施失败，不能把所有非零退出都当作 absence。
- LOW `retirement-wait-log-noise-on-every-session`：按 Lead R3 显式要求保留。四个 false 分支必须带 reason code + execution id；后续可在不损失 enrolled 诊断的前提下调低非 enrolled 噪声。
- LOW `duplicate-close-trigger-definitions-diverge`：保留 follow-up。本轮不触碰 schema trigger。
- LOW `pre-existing-host-dependent-test-failures`：环境记录，不归因本轮；本轮只跑 coordinator 点名文件，未把 host-dependent run-dispatcher suite 当成当前头失败或绿色证据。

旧头 verdict 不复用；修正后必须绑定新的 literal-last exact head 重新 review。non-blocking advisory 在新 review 通过后按 mandatory report channel 交 Lead。

## QA@1 FAIL（claim 1508，头 `29d3afe85`）返工 disposition

QA 真机「叫回来」Claude 0/1、Codex 0/2。本轮逐条先红后绿收口（提交 `07588f5a0`、`8cd3b1242`、`077da2e65`、`2137d4132`）：

- [A] Claude SessionStart 身份 hook 用 `curl --get` 发 GET，HookCallbackServer 对非 POST 回 405 ⇒ 每次 Claude 拉起都 `callback_failed`。改为 `--get --request POST`（字段仍在 query）。新增 vitest：真 hook 脚本 → 真 HookCallbackServer，修前红（405）、修后绿；旧 shell 用例的 curl 桩只加「必须 POST」断言，不再当唯一证据。
- [B] Codex `launch_snapshot_mismatch`：拉起请求没带原 Lead ⇒ Blueprint 不给 `commDbPath` ⇒ `sandboxWritableRoots` 少了 CommDB 根；也没带节点 ⇒ 线程所在的 agent home 从未被 admit（`identity_unresolved reason=no_role`，恢复会落进无关的 per-execution CODEX_HOME）。拉起请求改由纯函数 `buildStandbyResumeStartRequest` 构造：Lead 取自该 execution 在 CommDB 的原始登记（缺席即缺席，不另行推断），`processLifecycle.nodeId` 取自 runtime；Blueprint 在 resume 时用它 admit 原 home。Codex 适配器在身份核验前失败时立即以 `launch_snapshot_mismatch:<字段>` 回报 controller（不再等 180s 超时），日志同样写出差异字段。
- [C] fly1560 family-word 守卫：测试注释改词。
- [D] 前任退场杀掉 runner 会话的最后一个窗口 ⇒ tmux 销毁会话 ⇒ 后继 `set-environment` 报 `no such session`。TmuxAdapter 对会话级 `set-environment` / `new-window` 失败时，只在 `has-session` 证实会话确实不在时重建一次并重试；会话仍在的其它失败原样抛出。退场存在性判定把 tmux 明确答复的 `can't find session:` 视为窗口已不在（会话随最后一个窗口消失）；连接失败/权限等仍为 unknown。这收窄了上面 claim 1479 round 1 的 LOW `tmux-session-absent-reads-as-unknown`：只认服务器的权威答复，基础设施失败仍 fail closed。
- [E] 记账：拉起失败时，被拉起进程自己的退出信号走 legacy 完成路径把 `ship_parked` 改成 `blocked` 终态 ⇒ 清理被 `crash_preserve` 拒绝 ⇒ 每次都锁成 `cleanup_unconfirmed`、真实原因丢失、计划中的重试/兜底从未发生，最后掉进 dead-rollback 替换并记成 initial。现在 `retiring|standby|resuming|resume_failed` 的 body 在两个 sink（enrolled 与 legacy）里都拥有其 parked 会话；清理锁存时 body 仍记 `cleanup_unconfirmed`，但 attempt 行记录真实原因，失败 attempt 同时写入期望 session/model/cwd 与耗时。兜底路径的 `context_loss=1` / `fresh_fallback` 行补了断言。这覆盖了 R11/R12 的 LOW `resuming-not-terminal-immune`（只作用于 `ship_parked` 会话，active body 的真实完成不受影响；未按 generation 细分）。

仍保留的 follow-up：founder 面投影 context loss、reason code 闭集化、Claude cleanup 物理证据强度、resume hook 部署 preflight（见上文各轮）。
