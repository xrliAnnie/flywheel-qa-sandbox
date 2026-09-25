# Design Review — plan.md (Round 1)
Date: 2026-09-25
Author: Codex
Status: CHANGES REQUESTED

## Summary

方向正确，根因与生产证据也基本闭环，但当前计划还不能安全实施。主要问题集中在两类：一是 W2/W3 对“可归属进程/可杀进程”的权威条件写得比现有代码弱或与现状不符；二是 W4/W5/W8 的接口与持久化契约不足以实现计划声称的行为。按现计划落地，最坏会把 resident 证据链缩成单一 socket 探针、用含糊的“终态”授权提前收割，或把未完成的 Claude sweep 标成已处理；同时，“切号后 2 分钟内全部更新”和 pool-exhausted 告警格式目前都没有可实现、可重放的证据路径。

评审基于当前 HEAD `8a13199423a622ddcae1c90626844acbb8f30630`；相关源码与计划声明的基线 `e1fde75c2` 一致，HEAD 相对基线只有 FLY-2830 文档/证据变更。未运行测试，也未读取真实账号凭据或发起网络请求。

## What's Good (Keep)

- exploration/research 把生产现象、R1–R5 根因与具体代码缝隙对应得很清楚；W1 的“只改变 lsof 探测路径、不改变持有者/PGID/canonical-home 判定权”是正确边界。
- W4 保留共享 snapshot 的“最后开始者才能发布”规则，同时让调用者使用自己那次 inventory 作答，是修复竞态的正确分层。
- W5 复用现有 GatePoller、Codex single-flight、quota daemon wake，而不是再加调度器；Vercel 明确不进入周期刷新，范围控制合理。
- W7 明确区分 Claude 用量与卡片的观测时间，并坚持不碰浏览器 cookie、不推算扣费日，符合已有产品裁定。
- RED/GREEN、局部测试、`FLYWHEEL_CODEX_HOMES_ROOT` 隔离和生产只读 QA 边界写得明确，应保留。

## Issues & Recommendations (numbered: issue, why, fix)

1. **W2 必须保留完整 resident 权威链，且客户端 argv 判定要无歧义。**

   **Issue:** 计划写成“找 daemon：`probeDaemonProcessBinding` 返回 `bound`”，随后仅凭客户端的 execution id/home/start identity/`--remote` 归属进程（plan.md:58-64）。但现有 `residentEvidence` 不只做 daemon binding：它还核对 CommDB、StateStore 活状态与 adapter、project/role、持久 home binding、launch snapshot，最后才调用 `probeDaemonProcessBinding`（`resident-home-evidence.ts:67-130`）。此外 research 要求 argv “精确”为 TUI 形状，计划却只要求 `argv[1] === "resume"` 且“含”一个匹配的 `--remote`；重复 `--remote` 或额外冲突参数会被错误放行。

   **Why:** W2 会让 readiness 从 manual 变 automatic。若把复合证据缩成 socket binding，或接受含糊命令行，就可能把并非该活执行体的 Codex 进程解释掉，直接扩大自动凭据切换的安全边界。

   **Fix:** 明写“两遍”中的 daemon 必须通过现有 `residentEvidence` 全链路，不能直接以 `probeDaemonProcessBinding` 代替；只有同组至少一个 daemon 完整 verified 后，才可分类客户端。客户端要求唯一一个 `--remote`，其下一 token 全等预期 URI，拒绝重复/缺值/`--remote=...`/额外冲突形状。测试增加 StateStore 状态、launch snapshot、persistent-home 任一不一致仍阻塞，以及重复 `--remote` 阻塞。

2. **W3 的终态时间权威未定义，且计划声称的 start-identity 门在收割器里并不存在。**

   **Issue:** `terminalSince` 只写“status 为终态时返回其结束时间”（plan.md:80），但代码库有多个语义不同的 terminal 集合。这里唯一合适的是 `isStateStoreIrreversibleTerminalForZombie` 配合 `Session.terminal_at`；`TERMINAL_STATUSES` 明确包含仍活着的 `awaiting_review`，`OPERATIONAL_TERMINAL_STATUSES` 还包含这里刻意保守排除的 `approved`（`StateStore.ts:823-861`）。`terminal_at` 才是首次进入不可逆终态并在 revive 时清空的 SQLite 时钟锚（`StateStore.ts:1395-1402,15419-15436`）。同时，plan.md:43 宣称“start identity 必须一致”，但 orphan reaper 的 `ps` 行只有 pid/ppid/pgid/etime/command，`sameCandidate` 只比 pid、pgid、command 和解析出的 socket/home，没有 `lstart`（`codex-runner-orphan-reaper.ts:38-45,148-180,484-506`）。

   **Why:** W3 把可杀年龄从 2 小时缩到 10 分钟。含糊的终态集合可能授权收割 parked/review 中的活执行体；PID/PGID 复用时，不存在的 start-identity 门也不能作为安全论据。

   **Fix:** 把调用方契约固定为：session 存在、`isStateStoreIrreversibleTerminalForZombie(status)` 为真、`terminal_at` 用现有 SQLite UTC parser 严格解析、非未来且距今至少 10 分钟，否则返回 null。补 `awaiting_review`、`approved_to_ship`、`approved`、缺失/非法/未来时间、revive 后清空的 fail-closed 测试。另在 reaper 的初始与每次 fresh `ps` 证据中加入 `lstart` 并全程固定；若团队决定不加，则必须删除“start identity 不变量”的声明并显式接受/论证 PID 复用风险，不能按当前文字实施。

3. **W4 的返回类型无法表达计划行为，canonical auth 读失败时的判定也不成立。**

   **Issue:** 当前 observer 的 `refreshInUse` 只返回 `(accountKey, slot) => boolean | "unknown"`（`codex-accounts-observer.ts:57-65`），catch 也只合成为匿名 `unknown`（:360-369）；因此 plan.md:91-92 所说的 `collector_failed:<code>` 没有通道传到 `noteDetail`。同时，在 `canonicalChainActive=true` 且 canonical auth 读失败时，系统根本不知道“哪个号是 canonical”，所以不可能做到“只有 canonical 号 unknown、其它号照常”。现有实现正确地对无法归属的 canonical chain 返回 unknown（`occupancy.ts:66-76`）。最后，`writeCodexAccountQuotaStore` 当前直接序列化，不做 `validReading` 校验（`codex-account-quota-store.ts:218-245,302-324`），与“读写校验同一正则/恶意 noteDetail 被拒写”不符。

   **Why:** 强行塞进现有 primitive contract 会丢失失败原因；在 canonical 身份未知时把其它账号判 false，会让实际在用凭据走隔离 app-server 路径，破坏“不碰活凭据”的核心围栏。

   **Fix:** 定义显式结果，例如 `{ verdict: boolean | "unknown"; detail?: string }`，贯穿 occupancy → observer → store。逐 key 规则应为：`activeUnsharedAccountKeys` 命中先返回 true；canonical chain 不活跃返回 false；chain 活跃且 identity 已知才比较；chain 活跃但 identity 不可读则其余未证实 key 全部 unknown。collector 失败统一返回带已净化 detail 的 unknown。把 `codex-account-quota-store.ts` 纳入切片，写入前也执行与读取相同的结构/正则校验，并补对应测试。

4. **W5 的 sweep receipt 会把“未全量完成”永久确认，state schema 也少了一个实际写入字段。**

   **Issue:** 计划只把 `lastSweepRequestId` 加入严格白名单，却又要持久化 `lastSweepRequestOutcome`（plan.md:124-125）；后者未列入 interface、白名单、默认值、解析/迁移和测试。更关键的是，计划在 monitor-only/model-limit/scope 阻塞时仍消费 requestId。现有 `sweepCandidates` 还会在缺 active credential、identity 读取失败、witness 改变等情况下提前返回 `void`（`quota-monitor.ts:373-430`）；调用方无法区分“全部号已 sweep”与“零个/部分号完成”。

   **Why:** 一旦把该 requestId 写成已处理，同一请求以后不会再强制 sweep，切号后的 `claude-accounts.json` 可能没有全量更新，却被 state 标为 `swept` 或永久 `blocked`，直接违反 plan.md:10、177 的验收承诺。严格 state parser 若漏加 outcome 字段，还会把自己写出的 state 当 corrupt。

   **Fix:** 将 `lastSweepRequestId` 与一个闭集、限长的 outcome 字段一起加入 V2 schema、默认/旧文件兼容、parser、writer 和测试。让 `sweepCandidates` 返回结构化结果（至少 completed、updated/skipped accounts、阻塞/提前退出 reason）；只有证明目标集合已完整处理后才 ack requestId。scope/model 等瞬态 gate 应保留 pending 并在 gate 清除后重试；若 monitor-only 被定义为最终拒绝，需把它与“满足 2 分钟全量刷新”明确区分。增加 identity failure、witness change、partial sweep、重启后重试测试。

5. **W5 的 trigger/编排与最坏延迟无法保证“每次切号后 ≤2 分钟”。**

   **Issue:** 对合法 generation 回退“只记录、不更新 baseline”（plan.md:113）会在 DB/store 恢复或重建后把 trigger 卡住，直到新 generation 超过旧高水位。`refreshAfterSwitch` 又被写成先 `requestClaudeSweep`、再 Bridge refresh；前一步文件写失败会阻断另一条本来独立的刷新通道。延迟预算也没有闭合：wake 被限流/不支持时最多先等 60 秒，而现有 Claude sweep 串行执行 active usage、identity、每个候选号的 token verify + usage，每个网络动作默认可到 10 秒；60 秒检测延迟再加串行 sweep 已可能超过 120 秒，尚未计锁等待和持久化。

   **Why:** 这不是偶发一次丢信号：generation 回退会造成持续漏触发；单路失败会级联；按现有最坏界限，QA 3 的硬 SLA 无法由设计保证。

   **Fix:** 合法的较小 generation 应更新为新 baseline但不触发（读取失败才保留旧 baseline），并加 store reset 测试。Claude request/wake 与 Bridge refresh 用独立 try/catch 或 `allSettled`，任一路失败不得阻断另一路，尾随轮同样适用。最后给出端到端 120 秒预算并在实现中约束它：缩短 request 检测上界、给 sweep 总轮次设 deadline/并发上限，或明确降低验收承诺；增加 wake throttled/unsupported + 各网络调用临界超时的时钟测试。

6. **W8 不能从现有 capacity fact 可靠生成所示表格，也不能保证重放正文稳定。**

   **Issue:** 计划只改 `outbox.ts` 并按 incident 取“最新 fact”（plan.md:153-162），但当前公开 API 只有按当前 root/current guard 返回的 `getCurrentPoolExhaustionFact(rootKey)`；它不是按 incident/digest 的不可变读取，事实被 resolve 或 generation 前进后可能拿不到。若发送失败后同 generation 又写入更新 fact，“latest”还会改变同一 outbox event 的重放正文。更根本地，持久化的 `CodexQuotaWindow` 只有 `usedPercent/resetsAt`，canonical serialization 还会对 windows 排序，不保存 primary/secondary 或“周/5h”标签，因此无法真实渲染示例中的“窗口=周”。此外，`recordPoolExhausted` 只有在 pool 每个成员都 valid、fresh、scopeKnown 且 limited 时才接受；“两号 100%、一号读不到”的 fixture 不可能形成 `pool_exhausted` fact。

   **Why:** 直接实现会猜测窗口类型、在重试时改变告警内容，或测试一个生产状态机永远造不出的状态。对 founder 严重告警，这三者都不可接受。

   **Fix:** 在 `recordPoolExhausted` 同一事务里把不可变 evidence digest（或一个限长、已规范化的 alert snapshot）写入 outbox payload；delivery 必须按该 digest/snapshot 重放，不能读“当前最新”。若产品必须显示“周/5h”，先扩展 observation/fact schema保存可信窗口维度，并把相关 store/coordinator 文件纳入切片；否则删掉窗口名，绝不能按数组顺序猜。定义每个账号 recovery 为其所有 exhausted window reset 的最大值，fleet 最早恢复为各账号 recovery 的最小值。集成 fixture 应全部为真实的 pool-exhausted；“读不到”只可作为隔离 formatter 的防御性测试。补 ambiguous retry 正文逐字不变测试。

7. **W1 漏了跨 package 导出缝隙，现有 runtime 测试目标也不可直接调用。**

   **Issue:** reaper 从 `flywheel-claude-runner` package root 导入共享函数（`codex-runner-orphan-reaper.ts:22-32`），但 plan.md:16、31 只列 `codex-daemon-runtime.ts`，没有把新 `resolveSocketProbePath` 加到 `packages/claude-runner/src/index.ts`；按现有导入方式 teamlead 无法复用。runtime 的 `defaultSocketHolderPids` 还是私有函数（`codex-daemon-runtime.ts:1401`），而 plan.md:50 要直接断言它的真实 socket 结果。

   **Why:** 这是直接的编译/测试可达性缺口；临时改成深层 import 或仅为测试扩大内部 API 都会破坏 package 边界。

   **Fix:** 把 root `index.ts` 和导出回归测试列入 W1；共享导出的应是纯 resolver。真实 lsof 集成测试通过现有公开 ownership/process-binding API间接覆盖 runtime 默认 holder，或明确、审慎地把 holder helper 作为公共 API，而不是让实现者临场选择深层 import。

## Advisory

- W2 计划新增 `ppid`，但任何新判定都没有使用它。若不是为了明确的诊断/测试，删掉该字段和 `ps` 变更，减少三快照 parser 的风险；若要作为 TUI 证据，就把规则与测试写清楚。
- W6 复用 `createAccountQuotaRefresh` 时，Claude 失败会让组合 promise reject，即使 Codex store 已前进（`account-quota-refresh.ts:141-164`）。当前 stale 状态机最终以最新 Codex 时间为健康权威，因此不会误报，但 scheduler 日志/`failureCode` 会把 Claude 错误记成 `refresh_failed`。建议为周期刷新返回分路 outcome，Codex 作为健康主结果，Claude 仅独立记录告警/日志。
- `sweep-request.json` 除文件 0600 外，计划应明确父目录 0700、读取前 size 上限、临时文件清理，以及 `requestedAt` 的合法时间/最大陈旧度；这些可沿用现有原子 store 写法。
- W7 的“沿用 HH:MM 读数”需为 `observedAt=null` 明确定义“从未读到”，避免格式化 null；页面已有统一 `escapeHtml`，保留 view 层结构校验作为第二道防线。

## Verdict

CHANGES REQUESTED

请先修订上述 7 项后再进入实现。优先级最高的是 W2/W3 的进程身份与终态权威，以及 W5 的请求确认/2 分钟 SLA；这些直接决定自动切号是否仍然 fail-closed。
