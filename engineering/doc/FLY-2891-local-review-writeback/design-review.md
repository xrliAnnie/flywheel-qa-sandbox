# FLY-2891 本地评审逐轮写回 — 设计评审记录
Issue: FLY-2891 (https://linear.app/geoforge3d/issue/FLY-2891/病根修复-claude-线本地-codex-评审每一轮结论-评审模型写回-bridge设计-代码评审门校验模型-4)
日期: 2026-09-25
基于: plan.md

Codex 线程 `01a0daac-4191-7e53-96b9-6aad71a2701f`(codex-companion,`--model gpt-6-astra --effort xhigh`)。每个回合的真实模型已从 `~/.codex/sessions/.../rollout-*-01a0daac-….jsonl` 的 `turn_context` + `task_complete` 核对。

| 轮 | 回合 turn_id | 真实模型 | 审的 plan | 结论 |
|---|---|---|---|---|
| R1 | 01a0daac-4597-7c90-9003-f9b11377791d | gpt-6-astra / xhigh | v1(commit ff94ac722) | CHANGES REQUESTED 0C/6H/3M/0L |
| R2 | 01a0dab7-7b1e-7881-8c1a-19e20252e63d | gpt-6-astra / xhigh | v2(commit 2200cc08d) | CHANGES REQUESTED 0C/3H/2M/0L;⑤ 删除降级签核 |
| R3 失败×2 | 01a0dac2-bda2-7983-9bce-f24a2c1a92b6 / 01a0dac4-9589-7611-8311-45e4c061cdca | gpt-6-astra / xhigh(回合启动) | v3 | 无结论:两次 401 Unauthorized(OpenAI 侧 15:38–16:44 PDT 凭据故障),已报 Lead(e3a612bc) |
| R3 | 01a0daf6-0866-7141-9c46-948d3eb2f049 | gpt-6-astra / xhigh | v3(commit 5cc72dd4e) | CHANGES REQUESTED 0C/0H/1M/0L;R2 五项全部关闭;1M 为 v3 自引入 |
| R4 | 01a0dafd-7535-73e2-a9b9-26e0603d1b33 | gpt-6-astra / xhigh | v4(commit 9063b8210,plan blob 85e4f59f8f) | **APPROVED** 0C/0H/0M/0L(Lead 941d7d55 授权的限定验证轮) |

处置映射见 plan.md §11。

---

## R1 原文
## Issues & Recommendations

1. **[high] “最后一个 turn_context”不能证明产生该轮结论的实际模型。**

   **问题与证据：** plan:105–106、117、134–135 只按 thread 找最后一个 context，结果 schema 没有必填 turn ID。延迟补报前线程又续了一轮，或 APPROVED 后在同一线程追问，都会让旧结论绑定到新 turn 的模型；新 turn 甚至可能尚未完成。计划引用的现成读取器并非这种语义：`packages/teamlead/src/lead-backends/codex/lead-turn-evidence.ts:50–55,81–96` 要求指定 `turnId`，只接受对应 turn 的证据，并拒绝冲突 context。

   **影响：** 逐轮模型记录可能错误；门核对的是线程最后一次运行模型，而非产生 APPROVED 的模型。把声明值改成当前读到的值，也无法补上这个绑定。

   **建议：** 在每轮结束时冻结同一份 `{threadId, turnId, verdict, target, reviewedAt, observedModel, observedEffort}`，结果 JSON 与重试使用该证据。门验证指定 turn，不能静默改用线程最新 turn；同一轮重复提交的核心事实冲突应显式报告，避免靠通用 upsert 重写历史。C1/C4 增加“旧审批后出现其他模型的新 turn”“补报前发生下一轮”“指定 turn 缺失／冲突”测试。

2. **[high] 混合版本仍能绕过模型门，且在飞旧 CLI 不能靠补 JSON 字段恢复。**

   **问题与证据：** plan:221、233 明确认可旧 Bridge 忽略设计模型字段。当前 `design-review-validation.ts:22–45,132` 只校验原有投影并返回 `{allowed:true}`，`await-codex-gate.ts:320` 只看该布尔值。因此新 CLI + 旧 Bridge 下，只要“声明模型=rollout 模型”，错误路由模型仍能通过。反向组合也未闭合：旧 CLI 的设计请求在 `await-codex-gate.ts:297–304` 中根本不会转发新增字段，修改 JSON 无效；旧代码门则继续走未改变的 `codex_review_result`，`bridge/codex-review-ingest.ts:25–56` 没有模型检查。

   **影响：** “同一 PR、同一次部署”不是协议能力保证；进程、CLI 路径或回滚出现版本交错时，可能静默放行或持续拒绝，与计划描述不同。

   **建议：** 校验响应增加明确的协议版本／模型检查结果，新门拒绝缺少该能力的响应；写清旧 CLI 的升级或排空方案，不能只提示补字段。对在飞旧代码授权入口给出明确策略：校验新收据，或有可验证的旧 runner 排空前置条件。C4/C5 补齐 old/new Bridge × old/new CLI 的设计和代码矩阵，断言既无静默放行，也有准确恢复提示。

3. **[high] §4.7 的轮次与通过定义仍不统一，会直接产生错误比较。**

   **问题与证据：** plan:161–167 同时把“最早收到的行”“客户端 round”“job round”“门接受的审批”用作指标依据，有以下具体反例：

   - 仅收到 `source=gate, round=3, APPROVED` 时，现有公式得到 `firstPass=true`；实际上第一轮结论未知，不能把缺失当通过。
   - research:40–42 允许 fresh 线程重置轮号。线程 A 的 R1=CR，线程 B 的 R1=APPROVED 且门接受，计划会得到通过轮数 1；实际已有两轮。仅按“行数=最后 round”也不能证明连续、完整。
   - Astra 的 `round` 来自所有请求的 `COUNT(*)+1`，按 execution/type/**target_repo_identity** 分区（`StateStore.ts:23153–23168`，`review-request-coordinator.ts:1069–1074`），不是筛选后的有效结论序号。失败请求后首个有效 APPROVED 可以是 round=2；多个 repo 可以同时有 round=1。
   - `codex_review_job.verdict` 是策略处理后的 effective verdict，原 reviewer verdict 另存（`review-request-coordinator.ts:1705–1711,1808–1818`）；MEDIUM/LOW 可把 CR 转成 APPROVED（`review-verdict-policy.ts:126–131`）。本地 `--verdict` 是原始结论。且 job 可以已经 done+APPROVED、却未成功交付门，尚无审批 authority（coordinator:1846–1862）；计划仍把它当“通过”，local 却要求 `gate_accepted_at`。

   **影响：** Claude 线漏报越多越容易虚增首过率；换线程少算轮数；两条线对失败尝试、严重性策略和真正过门的处理不同。覆盖度标签不能修复错误的分子／分母。

   **建议：** 先明确一个共享指标定义，再由两个数据源适配：稳定的轮身份与跨线程序号；第一轮缺失时返回 unknown；明确原始 reviewer approval 与 gate acceptance 各自用途；用真实接受证据计算通过轮数；明确 failed/skipped、多个 repo、复用 review、返工和 `asOf` 的处理。可以用一个小的归一化读侧函数，无需新评审状态机。C7 必须覆盖上述反例，不能只验证普通 2/3 轮 fixture。

4. **[high] 最后一轮投递失败后没有继续重试的责任方。**

   **问题与证据：** plan:119、139 只在该 execution 下次 `review-round` 或 gate 时冲刷。最后 gate 校验成功、补写失败后仍退出 0，runner 可以结束并删除 worktree；之后没有规定谁再读取 spool。标记文件和 stdout 也没有被指定的巡检消费者，Bridge 报表无法看见本机 pending 文件，更无法仅凭已收到的行判断完全未送达的轮次。仓内搜索未找到计划所依赖的通用 review failure marker 消费者；现有 `codex-review-result.ts:194–240` 只是写一个按 execution 命名的标记。

   **影响：** “落盘等待下次调用”不能覆盖最后一次调用失败；数据可能永久不进 Bridge，失败也未必到达 Lead。这是逐轮写回的正常故障路径。

   **建议：** 指定一个不依赖该 runner 存活的持久重试入口及告警消费者，优先接已有常驻巡检／重试循环；无需新增 Discord 通道。明确结束后的重试、恢复后确认删除、坏请求隔离，以及磁盘写失败时的处理。验收必须包含“最后补写失败 → runner 结束／worktree 删除 → 服务恢复 → 无新评审调用仍送达”的场景。

5. **[high] spool 的锁只保护冲刷，追加与原子替换可以丢记录。**

   **问题与证据：** plan:119–121 规定失败追加 JSONL，冲刷拿 `O_EXCL` 锁，拿不到锁就跳过冲刷。交错是：A 读旧行开始网络投递；B 拿不到锁，继续投本轮，失败并追加新行；A 用先前读到的剩余行 rename 覆盖 spool。B 的新行消失。原子 rename 只能保证替换完整，不能保住期间追加的数据。进程崩溃遗留的 `O_EXCL` 锁也没有恢复规则。

   **影响：** 明确允许的并发路径会永久丢轮；“重复投递幂等”无法挽回客户端已删除的数据。

   **建议：** 使用同一锁保护所有读改写，或更简单地采用每条记录一个原子发布文件、成功后只删除该文件，避免重写共享日志。可参考 `stage-queue.ts:330–338,352–390` 的 execution ID 校验和先持久化模式，并复用已有锁机制。补充并发 append/drain、进程中断和陈旧锁恢复测试；同时保护 spool/marker 路径免受非法 execId 影响。

6. **[medium] 逐行同步冲刷让 ≤4.6s 的延迟预算不成立。**

   **问题与证据：** plan:119–121 要求先逐行冲刷全部积压再投本轮，plan:214 却只计算本轮两次 HTTP。若有 20 条 pending，即使旧行每条仅试一次、各超时 2s，再投本轮也至少约 44.3s；逐条沿用双重尝试则更久。gate 同步冲刷同样增加等待。计划没有整次命令 deadline、条数上限或首个暂时失败即停止的规则。

   **影响：** Bridge 慢或失联时，轮次越多，评审附加等待越长，违反非阻塞和无明显延迟增加的验收。

   **建议：** 给整个命令的投递工作设总预算；当前轮先持久化，积压由有界 opportunistic drain／第 4 项的独立重试入口处理。测试 0、20、200 条积压和慢响应，测端到端耗时，而非单个 fetch 耗时。

7. **[high] 在配置解析期间调用全局 `resolveAllowedEffort` 会递归加载配置。**

   **问题与证据：** plan:179 明确要求在 model-config 解析 arm 时调用 `resolveAllowedEffort(model, effort, {surface:'workflow'})`。实际调用链是 `getModelConfigSnapshot` → `loadSnapshot` → `createSnapshot` → `parseRuntimeModelSplit`（`model-config.ts:580–600,807–829`）；`resolveAllowedEffort` 在未传 snapshot 时再次调用 `getModelConfigSnapshot`（884–896），而 cache 要等加载返回才设置。冷启动／配置变更会重入同一加载；`validateModelConfigDocument(candidate)` 路径还会拿全局现网模型表来校验候选文档，可能核错能力。

   **影响：** 本来合法的 effort 配置可能导致递归、异常或错误校验，影响所有依赖模型配置的派发。

   **建议：** 在 parser 中直接使用已有参数 `lookup` 所指向的候选 registry entry 的 `effortsBySurface.workflow`，或抽一个不读全局配置的纯检查函数。保留菜单层校验。C8 增加空 cache 首次加载、热更新、候选文档能力与全局配置不同的测试。

8. **[medium] 每轮 target 的输入和取证时机没有闭合。**

   **问题与证据：** plan:112–118 把 `--target` 设为可选，设计只明确从 `design-request.json` 取 requestId，却直接使用未定义来源的 `<plan>`；plan:150、240 下发的完整示例也不带 target。延迟 stage/inbox 路径并不保证本地存在 design-request 文件。另一个问题是回报时才执行 `git hash-object`／`rev-parse HEAD`，只能证明回报时的对象，不能自动证明 Codex 读到的对象。现有 Bridge job 在评审前冻结 head，并在返回时复核（coordinator:1519–1527,1752–1783），这里没有对应约束。

   **影响：** 合规照抄指令也可能无法定位设计文件，或收到目标缺失的轮记录；评审后已改动时可能把结论标到错误 blob/head。

   **建议：** 明确 design 的 planPath 来源与缺省失败行为，code 的 repo/PR/head 来源；将评审开始时的 target 标识随本轮结果携带，在任何修改前冻结记录。补齐命令 schema、指令、仓外补丁和测试；文件缺失不能静默当作完整 target 证据。执行 Git 时复用安全参数风格，例如 `design-review-manifest.ts:143–161` 的 `--no-filters --`，避免 plan 参数被当作选项或触发 clean filter。

9. **[medium] 回滚时仅删除 models.json 的 effort 不能恢复已有冻结 assignment。**

   **问题与证据：** plan:223 的回滚步骤只删现网 effort。新的 effort 同时保存在 `assignment.basis.nodes`（`workflow-menu.ts:890–898`）；每次节点启动都会验证冻结 assignment（`workflow-dispatch-resolution.ts:100–121,191–203`），验证器再次解析冻结的 `basis.nodes`（`workflow-model-assignment.ts:309–331`）。旧 parser 拒绝 effort 键（`model-split.ts:177–180`）。删当前配置不会改变这些已持久化的 basis。

   **影响：** 已按新配置创建、尚未启动后续节点的工作流，在 revert 后仍会以 `workflow_dispatch_model_assignment_invalid` 失败；报表的旧解析器也无法读取新收据。

   **建议：** 把回滚约束写准确：带 effort 的新格式工作流必须先排空，或回滚版本保留新格式的解析／版本验证兼容。不要通过改写冻结历史来消除字段。增加“新配置创建 run → 改回旧配置／回滚 → 启动剩余节点”的兼容验证，并把该限制写入上线说明。

## Verdict

CHANGES REQUESTED — address items above

## R2 原文
## Issues & Recommendations

1. **[high] 最终轮补写还没有与逐轮记录一致的数据合同，正常 fresh-thread／补证路径会冲突。**

   **问题与证据：** plan:102 将 `round` 定义为线程内序号，plan:172 却将结果 JSON 的 `rounds` 定义为跨线程总数；plan:158 要用结果补写最终轮，但没有传递最终线程内序号或冻结的逐轮请求体。线程 A 的 R1=CR、线程 B 的 R1=APPROVED 时，结果必须写 `rounds=2`，B 的数据库记录却必须是 `round=1`。现有 `await-codex-gate.ts:355–366` 只有结果中的总 rounds，没有另一个轮号来源。此外，plan:127/174 允许代码逐轮命令不带 target，现有 gate 却要求非空 `reviewedTarget`（同文件:164–168）；拿最终结果重建请求会从 NULL 变成 PR URL。plan:124 还允许先记录 unavailable，稍后 gate 能取到模型时，NULL→真实模型也会触发 plan:104 的核心事实冲突。

   **影响：** 合法的最终补写可能永久 409；若原行尚未送达，补写还可能先插入错误的线程内轮号，随后原始记录变成冲突。最终补写无法稳定承担“修复漏报并记录过门”的职责，已获得的实际模型也可能无法补进原先未知的记录。

   **建议：** 明确区分线程内轮号与总轮数，让回执／结果携带最终轮的冻结记录，gate 按同一 turn 使用它补写，不从总 rounds 或当前工作区重新推导核心事实。统一逐轮与最终 target 的表示；确需额外保存 gate 核验对象时，与中间轮参考对象分开。为 unavailable→已核实证据定义明确的补证规则，已知事实之间的冲突仍然 409。C2/C5 加入 fresh-thread、代码未传 target、证据稍后可读，以及 HTTP/spool 两种到达顺序的测试。

2. **[high] 仅检查已收到 series 的连续性，仍会把缺失数据算成完整首过。**

   **问题与证据：** plan:185/189/190 只验证每个已观察到的线程是否从 1 连续。若 A:R1=CR 完全漏报，换线程后只收到 B:R1=APPROVED，则唯一可见 series 是连续的 `[1]`，结果必然是 `complete / firstPass=true / roundsToApproval=1`。结果 JSON 虽有跨线程总数 2，但表和归一化输入没有保存或核对它。plan:249 的“runner 漏调时判 incomplete”因此不成立。Astra 侧还有同类缺口：plan:188 先排除缺少 `reviewer_verdict` 的 done 行，再重新编号，会把未知历史抹掉；源码确实允许这种行，`StateStore.ts:22737–22757` 的 details 可选，coordinator:1474–1478 的恢复路径、1808–1820 的 policy-disabled 路径都不保证写入 raw verdict。

   **影响：** 两条线仍可能因为缺数据而提高首过率、减少轮数；共享同一个计算函数并不能保证输入覆盖完整。这直接影响本 issue 的指标验收。

   **建议：** 为 local 定义可核对的预期覆盖范围，例如持久化最终总轮数并与去重后的回合数对账，或使用跨线程连续序号；无法证明覆盖时返回 unknown。Astra 的 done-but-raw-unknown 行要作为覆盖缺口处理，不能像 failed/skipped 一样无痕过滤，也不能用 effective verdict 冒充 raw verdict。C8 补“整个旧线程缺失”和“unknown done 行后出现 APPROVED”，均不得得到完整首过。

3. **[high] “4xx 不落 spool”会丢掉可恢复的投递失败，混合版本时尤其明显。**

   **问题与证据：** plan:128 的分类表述不够明确，而 C4（plan:216）直接要求全部 4xx 不落 spool、exit 0。当前 Bridge 只有原有校验路由，尚无 `/review-rounds`（`packages/teamlead/src/bridge/plugin.ts:3087–3117` 及路由搜索）；新 CLI 遇到旧 Bridge 的 endpoint 404 是版本窗口，不是坏评审记录。401 等认证故障也不等于 payload 校验失败。仅打印 stderr 后丢弃请求体，随后升级或恢复服务无法重投这些中间轮。

   **影响：** 新门 fail-closed 的兼容修复保护了批准，却没有保护每轮数据。最后一轮 gate 不能恢复早先已被丢弃的 CR 及其实际模型，也无法让 Bridge 的 pending/quarantine 计数暴露它们。

   **建议：** 用明确的状态码加结构化错误类型分类：endpoint 不支持、暂时认证／服务故障等保留到 spool；确认的 payload 错误和事实冲突不无限重试，但应保留到 quarantine 并告警。保持单次 POST 和 exit 0 即可，不必增加同步重试。C4/C6 增加“旧 Bridge 404 → runner 结束 → Bridge 升级 → 自动入库”及认证恢复场景，另验证真 400/409 的隔离。

4. **[medium] 临时文件 O_EXCL 加 rename 不保证最终文件不被覆盖，同名直接成功也绕过了冲突检测。**

   **问题与证据：** plan:142 只对临时文件使用 O_EXCL，最终路径用 rename；两个写入者都观察到最终文件不存在后，各自发布不同内容，后一次 rename 会替换前一次。已在本机临时目录验证该行为。即使串行，按“同名文件存在就成功”也不会比较核心事实。于是同一 turn 的冲突提交在到达 plan:104 的 ingester 之前便被覆盖或隐藏，无法产生预期 409／quarantine。

   **影响：** 共享 JSONL 的丢追加问题已经解决，但“已排队原记录不改写、冲突必须可见”仍不成立；C3 的当前同名测试反而会固化这个漏洞。

   **建议：** 最简单的是给每次投递使用独立文件名，让数据库按 turn 身份去重并报告冲突；或使用真正不覆盖目标的原子发布，并在目标存在时核对内容。无需引入共享日志或锁。C3 应测试同键同内容，以及同键不同内容的并发发布与巡检，断言原事实不会静默被替换、冲突可见。

5. **[medium] Astra 使用投递时间作为评审时间，会改变固定 asOf 的结果，与 local 的完成时间不一致。**

   **问题与证据：** plan:188 使用 `responded_at ?? updated_at`，local 则使用 task_complete 对应的 `reviewed_at`。实际 `completeCodexReviewJob` 在评审完成时写 `updated_at`（`StateStore.ts:22745–22754`），之后成功回答 gate 才单独写 `responded_at`（:23113–23118）。中间失败会留下 done+unstamped，后续仅重投已有结果（:23123–23131；coordinator:1846–1862）。例如 09:00 完成、10:00 补发，同一个 09:30 asOf 在补发前包含该轮，补发后反而排除它。

   **影响：** 没有新增评审也会改变历史窗口、第一轮排序及分母；Astra 将投递延迟混入指标，Claude 则没有，仍不满足相同定义。

   **建议：** 两个适配器都使用稳定的评审完成时间。核实 done 状态的 `updated_at` 是否能充当该值；若仍可能被后续操作修改，保存专用完成时间，历史无法确定的记录明确标注覆盖限制。`responded_at` 只用于交付状态。C8 加入“固定 asOf，done 后延迟补发，指标不变”的测试。

## Verdict

CHANGES REQUESTED — address items above

## R3 原文
## Issues & Recommendations

1. **[medium] 新 acceptance 的“全字段相等”包含接收元数据，会把正常重投判为冲突。**

   **问题与证据：** plan:119–120 给 `review_gate_acceptance` 定义了 `accepted_at` 和 `received_at`，plan:131 又要求同主键“全字段相等 → no-op；不同 → 409”，未像轮记录那样限定参与比较的业务字段。正常交错是：HTTP 已提交数据库，但响应丢失或超时；CLI 按 plan:156–159 保存同一请求，巡检稍后重投。第二次的服务端 `received_at` 必然不同，按当前规则即为 conflict，并按 plan:178 隔离。重新执行 gate 时，若 `accepted_at` 每次取当前时间，也有同样的问题；现有 gate 允许读取同一结果后再次验证和上报（`packages/flywheel-comm/src/commands/await-codex-gate.ts:412–428`）。

   **为什么重要：** 独立 spool 文件方案依赖服务端识别重复投递。这里会把已成功写入的数据误报成永久失败，产生虚假的 quarantine 计数与告警，使正常重试不再满足幂等合同。这是 v3 新表引入的问题，不是重开 R2 的轮记录冲突问题。

   **建议：** 明确列出 acceptance 的稳定业务事实比较集合，排除 `received_at` 等投递元数据；首次插入后保留原接收时间。定义 `accepted_at` 的来源和重投规则：同一接受事实重投不应因重新取时间而冲突，也不应覆盖首次接受时间。C2/C3 增加“HTTP 入库成功但回执丢失 → 较晚 spool 重投”，断言 duplicate、清除 spool、无 quarantine，且首次时间不变；再覆盖同一结果重跑 gate。真正的 turn／轮数／模型／目标事实冲突仍返回 409。

## Verdict

CHANGES REQUESTED — address items above

## R4 原文
## Issues & Recommendations

无。限定范围内没有剩余阻断项，也未发现本次修改引入的新缺陷。

## Verdict

APPROVED — ready to implement
