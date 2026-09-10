# FLY-2456 529 房证据工具 — 实施记录
Issue: FLY-2456 (https://linear.app/geoforge3d/issue/FLY-2456/529-房演练-2352-真机重启演练slot-里起-2-3-具-codex-体-重启-slot-bridge-测-reown)
日期: 2026-09-10
基于: plan.md

实施起点为设计交付 commit `43fa995728e4811c477871d708e579bc844ac718`；计划保持原样。实现 TURN 为 epoch 2、attempt 1，execution `054db913-0874-4f0f-9539-40c933e162b6`。

## 验收游标

1. 已读现有三份设计文档、项目 onboarding 材料，核对 Lead 的 `aa0f4fe9-a035-44ba-a4c9-52351b01bb4e` 与 `ae9c9345-c4f6-4c1f-bfd5-6352c88368c8` 原始裁定。前驱的报告 `0acc96c5-9693-4e4b-8188-e83672ace84a` 记录 R4 APPROVED 和三条实施残留。
2. 工具 CLI、证据收养、比较、单轮 verdict 与双轮报告已经实现；下文保留各批次当时的状态，最新状态以本节和末节为准。
3. 完整宿主路书已接入 62 个 Bash 段（辅助函数、E01–E39 执行顺序、恢复与停手说明），独立审阅已关闭阻断发现。尚未进行真机演练。
4. hermetic 用例、实际 liveness wrapper fixture 和真实 guard scanner 已有回执；最终脚本套件本地 EPERM 失败已记录。CI 显式登记最终路书 scanner 和 Python 嵌入代码反例测试。
5. 全仓 lint 首次 5 个本次文件错误，最小修复后 exit 0；递归 build exit 0；两次全 packages 命令和下游补跑的失败均已记录，按 Lead 裁定停止追跑。正式代码评审和远端 CI 尚未开始。
6. 按 Lead 最新指令 `c03424ef-0435-45bb-875c-3d68b7b560bb`，本节点交付工具与路书；前置安全演练及 R1/R2 两轮归 Lead。合成 fixture 不代表真机成功。
7. 工具与路书完成后，一次普通 push、exact-head review、CI 14/14，再走 `complete --route needs_review`。零表格真机报告与 FLY-2352 thread 投递依赖 Lead 之后取得的真机证据。

## 当前核验与实现约束

- `pnpm install --frozen-lockfile` exit 0；安装时工作区 dist 尚未构建，出现缺少 bin 目标警告。这不是 build 或全测试通过的证据。
- 当前源码的 open-gate SQL 包含 `relay_state != 'terminal_disposed'`、`superseded_at IS NULL` 和无 response 子查询。资格与收养共用该谓词。
- 当前 StateStore 的 binding 使用 `activation_id/execution_id/run_id/node_id/attempt/mode/bound_at`；事件下界使用 `session_events.id` 和每 run 的 `workflow_run_event.seq`。
- 只读证据工具接收副本或文本文件，不连接活库、不调用起房/重启原语。生产快照的宿主命令遵守本次 runner 的硬约束，使用 `scripts/flywheel-snapshot-control.mjs runner`，由该管理路径完成一致性快照；副本保留在 `/tmp/flywheel-snapshots/<exec>/`，而非直接复制活库。路书另记副本的 observedAt 与 sha256 供收养时核验。
- 所有真机副作用由 Lead 执行。此刻尚未执行 slot 部署、起体、cycle、生产快照或生产进程操作；没有真机成功率可报告。

## TDD 回执

- 污染扫描：`node --test scripts/__tests__/qa-fly-2456-scan.test.mjs`。从空实现观察 RED，依次补 comm schema/污染、生产 StateStore、字节校验与输入异常。最终 **35/35 PASS**。测试直接使用当前 `MAILBOX_SCHEMA` 的 poison views，并提取当前 StateStore 的建表声明。
- scanner 独立规格检查通过；独立质量检查发现 SQLite TEXT affinity 接受 BLOB、NUL 会让 LIKE 漏查。8 个回归用例 RED 后新增 storage guard，质量复查确认关闭。异常证据返回 `status=fail, hitCount=null`，不冒充零污染。
- manifest：`node --test scripts/__tests__/qa-fly-2456-drill-tools.test.mjs`。空实现 4 个失败；实现后 4/4。新增 symlink/writer 与缺 cycle pre-state 两例 RED 后 6/6。独立检查再发现空 run 下界、不可用 lstart、错绑 issue、残缺 manifest 和目录同步缺口；回归 RED 后修复，最终 **9/9 PASS**，独立复查确认关闭。
- manifest cycle 只接受三具 start receipt 对应的三个唯一 `workflowRunId` 全集下界；原子文件写入与 parent directory 均 fsync。当前 receipt 是落盘接口，尚未实现向数据库权威收养，不能拿它代替 adopt。
- 合并测试命令 `node --test scripts/__tests__/qa-fly-2456-drill-tools.test.mjs scripts/__tests__/qa-fly-2456-scan.test.mjs`：**44/44 PASS, exit 0**；本地记录 `/private/tmp/fly2456-foundations.log`。
- CI 登记测试先以“两个 Node suite 未登记”失败，登记 `.github/workflows/ci.yml` 后 `bash scripts/__tests__/ci-shell-suite-enumeration.test.sh` 通过（含删除既有 suite 的负向变异）。
- `pnpm -r build` 在本批开始时 exit 0；仅作依赖构建，不是最终 HEAD 的全 gate。Node 22 的 manifest 初始 6 例通过；完整脚本测试目前由本机 Node 25.6.1 验证。最终 CI 执行另行取证。
- scanner imports 的 Biome 排序检查曾失败，已用 `biome check --write` 修复。未运行或声称最终全 lint/packages gate、外部 code review 或 CI 已通过。

## 下一批精确入口

- `scripts/lib/qa-fly-2456-manifest.mjs`：当前导出 `manifestInit(path, config)`、`manifestIntent(path, step, detail)`、`manifestReceipt(path, step, result)`。主 CLI 已有 init/intent/adopt；receipt CLI 尚未接线。init 要求精确 B1/B2/B3 三个标签。其余辅助 execution（前置体、QA）应通过有来源的步骤回执登记，不能混入三具主靶标签。
- `scripts/lib/qa-fly-2456-scan.mjs`：导出 `commScan(path,{slot,executions,lead})`、`prodStatestoreCheck(path,{executions})`；后续主 CLI 映射为计划中的 `comm-scan` 和 `prod-statestore-check`。扫描器只打开 hash 校验后的 immutable Buffer，拒绝 WAL/SHM sidecar。
- `qa-fly-2456-adopt.mjs` 目前只覆盖 start/gate；使用 `qa-fly-2456-db.mjs` 的 `openSnapshot` / `openGates`。后续需覆盖 deploy、adoption、marker/PR/complete 三段 park、QA-fail、operator rework、terminate 两类、decoy、room-info、teardown、cycle。inspect 函数只判四态，主 CLI 才原子补写 adopted receipt。
- `qa-fly-2456-shape.mjs` 导出 `activationParse(dbPath,executionId)` 和 `campaignShape({dbPath,commPath,livenessPath,bodies})`，其中 bodies 为 `{B1:exec,B2:exec,B3:exec}`；livenessPath 是完整 probe array。
- `qa-fly-2456-observe.mjs` 导出 `eventBounds(dbPath,runIds)`、`observeRound({dbPath,bounds,bodies})`；observe 的 bodies 为 `{B1:{executionId,runId,nodeId},...}`。`status=pass` 仅说明解析成功；每具的 classification 才是终局。最终 verdict 尚未实现。
- 主 CLI `scripts/qa-fly-2456-drill-tools.mjs` 已创建，但目前只有 manifest init/intent/start+gate adopt 可用，未声称其他子命令存在。`host-runbook.md` **尚未创建**。不要把当前模块误当作计划 §3 已全部交付。

## 核心证据批次回执

- start/gate 收养：**71/71**。已覆盖 responded+response、所有中间 stage fail-closed、权威与本地回执冲突、缺失/过期/早于 intent/未来/错误 hash 副本，以及 gate disposed/superseded/response/重复。独立检查发现 raw issue ID 与别名占位的冲突判断缺口，补了 `workflow_run_issue_alias` 真实表查询和回归；复查关闭。
- shape：**23/23**。通用 parser 接受 replacement/wake/wake 并保留全部绑定，而 campaign 拒绝；资格拒绝无 gate、错 TURN、held run、不匹配 PGID/holder 等。空 binding 也必须检查 latest-node schema，缺表不能返回 pass；独立复查关闭。
- observe：**36/36**。测试使用真实列名、保留 raw payload；按 cycle 下界和第一个 episode 分类；`exhausted` 不补造 episodeId；换体链要求同 run/node/newExecutionId/launchOrdinal/requestId、顺序正确、launched 在新 execution 且新 session 存在。独立检查纠正 `attempt` 与 `recoveryAttempt` 混淆：准备证明检查 binding `attempt===2`，允许 recoveryAttempt=1；两个反例 RED 后修复并复查关闭。
- CLI：**3/3**。实际子进程验证 init/intent 稳定回放、坏参数、向 responded 权威补收养回执并再次 replay；额外 B4 标签必须拒绝（回归使用全新 manifest，避免已有文件冲突掩盖问题）。
- liveness 实执行：sandbox 为 **FAIL/unknown**，`ps`/holder 观察被 EPERM 拒绝；不跳过、不替换成手造 JSON。Lead 在宿主运行同一测试于 **2026-09-10T06:50Z，1/1 PASS、exit 0**，回执 question `0c001d47-0f36-470b-a191-b8e4ed0e179a`，完整日志 `/tmp/fly2456-liveness-host.log`。这是临时 Node socket fixture，**不是房内真 Codex 体验收**。
- 宿主回执对应源文件 hash：`qa-fly-2456-liveness.mjs` = `f5be3dcd11854d8a497e5df08366786f553e2a61a21f953398d538e4fb19c8ab`；测试文件 = `781d36437e5a71ca74c5a41302ff1ce849ea5292fd9d8dee5d02d3df38eab7c4`。核对时未变化。生成命令指定独立 `FLYWHEEL_BRIDGE_SYNCOP_DIR`，因为实际 probe 的默认诊断 marker 否则会写宿主 `.flywheel`。
- 核心工具六个本地 suite 共 **177 用例**，最终运行日志 `/private/tmp/fly2456-core-tools.log`；liveness 的宿主 1 例单列，不混称本地全绿。七个 suite 均已显式登记 CI。尚未执行最终全仓 gate、exact-head CI 或请求驱动评审；未 push。

## 文件证据批次

- `qa-fly-2456-proc.mjs`：`procAttribution({baselinePath,afterPath,slotDir,checkout,mode})` 接收原始 `ps -axo pid=,ppid=,lstart=,command=` 文件。PID 与 lstart 联合识别；只认规范绝对可执行路径、解释器紧邻脚本路径或同快照父链。非 slot 新进程在 live 时 fail，非 slot 消失为 needs-attribution。独立复核发现路径 traversal 与父 PID 重用的假 SLOT，两例 RED 后修复，复核关闭；8 项通过。
- `qa-fly-2456-room-info.mjs`：`roomInfoCheck({slotDir,phase,identity})` 只读检查四阶段，hide-precheck 返回 sha256/mode/inode/mtimeMs；后续传这个 identity。双名并存、缺失、symlink、身份变化均 fail，不移动或覆盖文件。4 项通过，独立复核无阻断。CLI 已接 `proc-attribution` 与 `room-info`，合计 CLI 4 项通过；尚需接入 manifest 身份持久化与完整宿主步骤。
- `qa-fly-2456-alerts.mjs`：`alertDirsAttribution({beforePath,afterPath,slotLead})` 输入 JSON 数组 `{path,content,sha256}`，path 是 `meta-alert/<basename>` 或 `alert-deadletter/<basename>`；逐项核 hash，按 JSON 内容 leadId 归属，输出不含原文。4 项通过；独立复核进行中。
- `qa-fly-2456-fleet.mjs`：`fleetIdentity({dbPath,tmuxInventoryPath,prodSocketRoot})` 输入实际 tmux inventory 文件与生产 StateStore 副本；`fleetDiff({beforePath,afterPath,mode,declaredSockets,decoy,sidecarPath,dbPath,killLedgerPaths,window:{from,to}})` 使用真实 fleet-snapshot 与 kill-ledger 格式。32 项初验后独立复核发现运行中缺 window、SQLite UTC 时间、事后 sidecar 三个缺口；回归修复后49项通过，最终复核进行中。sidecar 的不可变写入仍待 CLI 接线；PID/PGID ledger 无 execution 归属时保守 fail。
- Lead `b5b4ea4b-18ea-4335-8f48-7a3bbd71681f` 的精度裁定已记 progress：Node 零 spawn；`qa-fly-2456-guard-receipt.py` 是显式 Python scanner 命令，导入真实 `scan_block`，不执行待查命令，独占创建回执。`qa-fly-2456-dry-run.mjs` 只读核 inputsDigest、scannerSha256 与每条 command sha256；missing=not-run、mismatch/deny=fail。实际 scanner 的官方三原语 ALLOW 与 P1/P2/P3 DENY、缺失/漂移/不完整路书反例共4项通过。绝对路径与 intent/adopt 完整检查，以及路书/CI 对最终路书的显式 Python 调用仍待接线。
- 本批五个新 Node suite 的 CI enumeration 先以未登记失败，登记后通过：302 shell suites classified、33 Node suites enumerated，含 deletion mutation。尚未执行或声称本次完整仓库 gate、exact-head CI 或正式 review。
- 十个本地 suite（尚未包含 fleet 与宿主 liveness）共 **198/198 PASS**，`/private/tmp/fly2456-file-evidence.log`。这是批次测试，不是最终全 gate。下一步：完成剩余 effect adopt（QA/operator 正在实现）、launch delta、runner windows、verdict/报告、完整 CLI 与 host-runbook。
- 最终复核：fleet 三个发现全部关闭；alerts 补当前 MetaAlertNotifier 的真实 `.txt` 格式，无法归属为 needs-attribution；dry-run 拒绝缩进/tilde fences 隐藏未扫描命令。两个新增回归 RED 后修复并独立复核关闭。此时 alerts 5、dry-run 5；十一个本地 suite 最终 **249/249 PASS，exit 0**，`/private/tmp/fly2456-file-evidence-final.log`。宿主 liveness 仍单列，不在此本地数字中。

## 副作用收养批次

- `qa-fly-2456-rework-adopt.mjs` 导出 `inspectReworkAdoption({manifest,step,dbPath,commPath,now})`。detail kind 为 `qa-fail` / `operator-rework`，label B1，包含 issueId、runId、qaExecutionId（QA 路径）、preferredActorExecutionId、targetNodeId=implement、targetAttempt=2；operator 另含 actor、leadFeedback、founderQuote、principal 与稳定 intent.clientRequestId。QA 用 CommDB activation 的凭据 hash 对 StateStore submission credential，检查 consumed、revoked、permanent 与真实 request/route/delivery；operator 按 event_uid 与实际 payload、request.source_event_id 链。result 为 requestId/runId/targetNodeId/targetAttempt/preferredActorExecutionId/routeRevision/state。主 inspectAdoption 已接 rework 路由。
- rework 独立复核发现 unsolicited escalationAck 与 permanent QA expiry 两处，均 RED→GREEN；附带补 present evidence digest 必须匹配预期，保留产品 legacy absence 语义。复核关闭，53 项；主 dispatcher 新集成回归 RED→GREEN 后54项。无原始凭据输出。
- `qa-fly-2456-terminate-adopt.mjs` 导出 `inspectTerminateAdoption({manifest,step,dbPath,now})`；kind=terminate，detail `{executionId,reason,purpose:'precondition'|'qa-fallback'}`。前置要求 terminated、terminal_at/last_error 和实际 `lead_events` 中完整匹配的 action_executed；QA fallback 对当前 canonical irrecoverable set 返回明确 noop/not-executed 回执。29项通过并独立复核无发现。**当前源码精度**：actions.ts:175–184 使用 appendLeadEvent，不是计划写的 session_events；已通过 report `21d28ce5-cb3a-4c9d-a3b9-2cbb0f6dd000` 告知 Lead。动作证据不等于物理 cleanup 成功。该模块尚未接主 dispatcher/CLI。
- `qa-fly-2456-file-adopt.mjs` 导出 `inspectFileAdoption({manifest,step,evidencePath,now})`，目前仅 deploy/adoption/cycle。输入为宿主捕获 JSON + 同名 `.meta.json` observedAt/sha256（严格晚于 intent、10分钟内），必须有 scope `{slot,checkout}` 精确匹配 manifest。deploy 输入 slotExists/roomInfo/health/bridgePid/processes（pid/ppid/lstart），adoption 输入真实 per-lead adoptionYaml，cycle 输入 bridgePid/processes/launchSpecSha256/cycleFailed。cycle pre-state 复用从 manifest 模块提取的 `validateCyclePreState(manifest,detail)`，包含三具 start receipt 的精确 run 下界。初验5项，独立复核的跨 slot 证据与不完整 pre-state 两项 RED 后修复，7项+foundation9项通过，复核关闭。宿主 capture/CLI 接线仍待完成。
- `qa-fly-2456-launch-delta.mjs` 导出 `launchCommitsDelta({beforePath,afterPath,manifest,dbPath?,cycleStep?})`。目录清单 basename 无后缀；已记录成功 start 只接受 B1/B2/B3/QA/PRE，拒绝未知或重复 label，核已有配置 issue 绑定。replacement 不读手填列表：指定 dbPath/cycleStep 后，按 manifest 原始 start 身份与 cycle 下界重新调用 observeRound，只收养 B1 的完整换体证明。5项+observer中新增真实DB匹配/不匹配因果链1项通过；独立复核的任意 start label 漏洞已修复关闭。辅助 QA/PRE manifest 登记接口尚未实现，不能声称已能跑全路书。
- 主 CLI 新增 `alert-dirs-attribution --before --after --slot-lead`，实际进程调用验证生产/slot 分支；CLI 共5项。其余已有模块的主 CLI 接线仍不完整。
- 四个新 suite 的 CI enumeration 先红后登记，当前37个 Node suites、302个 shell suites 分类检查通过。最终本地十五个 suite **346/346 PASS，exit 0**，`/private/tmp/fly2456-adoption-batch.log`；排除宿主 liveness，不代表最终 full-repo/CI gate。

## 下次继续的精确缺口

1. effect adopt 尚缺：marker/PR/complete 三段 park、decoy、room-info hide/restore、teardown；file-adopt 的 deploy/adoption/cycle 已实现但待宿主 capture 与 dispatcher 接线；terminate 待 dispatcher 接线。
2. manifest 辅助 PRE/QA 身份登记（不可混入核心三标签配置）；receipt CLI；所有已完成模块的 CLI 参数与输出（immutable fleet sidecar 落盘、room-info identity 落 manifest、bounds/observe/shape/scans/liveness 等）。
3. runner-windows 计数及有差异时的生产事件解释；verdict/零表格 ship report 与 founder-report.html；固定 R1/R2 条件、cycle1 零事件、九面零影响不能漏项。
4. 完整 host-runbook.md **仍未创建**。每步单条绝对路径命令、期望输出、落盘、停手；intent/adopt/receipt、managed snapshots、slot env、四次采样/三组对照、真实 scanner Python 单条命令与 receipt。dry-run 绝对路径/adopt 前置检查还缺，最终路书 CI Python 调用还缺。
5. playbook §7 三条追加、最终 lint/build/packages/scripts、milestone literal last commit、一次普通 push、PR、exact-head CI14/14、正式 request-review、needs_review completion。当前未 push/未 PR/未实际起房；目标持续 active。

## CLI 与报告判定批次

- 所有已实现的 effect 类型已由 CLI 路由：start/gate/rework 经 inspectAdoption；park-complete/terminate 直接进入专门模块；deploy/adoption/cycle/park-marker/park-pr/decoy/room-info/teardown 经 file-adopt。adopt-existing 才补原子 receipt；execute 不执行任何宿主动作。
- file-adopt 新增五类，现14项：marker 远端 ref → commit tree → recursive tree → blob SHA1/文本；PR 的 repository/head/open 查询 scope；decoy 必须是声明的 `/private/tmp/tmux-<uid>/default`；room-info 的精确 identity/no-clobber 四态；teardown archive 必须是目录、出生时间晚于 intent 且不晚于采集。三个独立发现（外部查询 scope、旧归档、非递归 tree 漏项）逐个 RED→GREEN，复核关闭。宿主采集时 JSON 字段必须与本模块一致，不可手造缺失字段。
- park-complete 实际 source 是 StateStore `workflow_engine_park_outbox.event='park_opened'` 与 CommDB `workflow_engine_park.state='open'`/source_row_id，不能把 event 列放在 projection。36项通过，独立复核通过；与 ship_parked/session、implement1 done、最新 outbox、identity/时间都匹配。
- `runnerWindows({beforePath,afterPath,beforeIdentityPath,afterIdentityPath,dbPath,window})`：相等计数可直接 pass；差异必须由前后 identity sidecar 匹配实际 runner-flywheel window 个数与身份，再由生产副本的 bounded session_started/session_completed/session_failed 事件逐项解释。独立复核发现 view 可伪装物理表，RED后加 physical schema/text guards；改成真实 StateStore DDL fixture，最终5项通过并复核关闭。
- observe 现在返回全 session_events 的 `id > bound`、payload 含 capability drift 的 `capabilityDriftEvents`，不只三具标签；真实 DB 反例 RED 后通过。R2 verdict 必须此数组为空；observer现38项。
- `verdictRound({round,manifestPath,shapePath,observePath,zeroImpactPath,fixturePath})` 返回 JSON + `markdown`/`html` 字符串，CLI `verdict --round --manifest --shape --observe --zero-impact --fixture` 输出完整 JSON；非 pass 非零。现11项，CLI合计16项。轮次绑定 slot/HEAD/issue/core bodies，cycle1绑定同三具且零事件，R1要求B1 replaced/B2 succeeded/B3 skipped，R2另要求 attempt2PreparedProof/global drift 0。失败和 needs-attribution 不冒充通过。
- zero-impact JSON 是文件路径索引：fleet {live,postTeardown}；proc {live,postTeardown,teardown}；comm {before,liveAfter,postTeardown}；launchCommits {liveAfter,postTeardown}；prodState {before,liveAfter,postTeardown}；alerts {liveAfter,postTeardown}；runnerWindows {full,teardown}；health {before,liveAfter,preTeardown,postTeardown}；killLedger 单文件。路径指向对应工具输出；health 需 ok/buildSha/uptime，killLedger 需 status/refusals。fixture 需 roomInfoHidden/gateHeld、完整 cycle1 observe、precondition {status,waitedMs>=600000,maintenanceTicks>=2,termination{purpose,status,noop},fleet,archivePath}。前置与主轮的 fleet needs-attribution 均需匹配 removed 行的实际 terminalEvidence，明细会写入 Markdown/HTML。该来源契约仍需由完整宿主路书产生文件。
- verdict 独立复核的轮次/issue、cycle1 身份、bare pass、归因漏渲染、前置 needs-attribution 缺证明等发现全部 RED→GREEN 并复核关闭。HTML 文本转义，不以测试 fixture 冒充真机报告。
- CLI 实际进程16项通过（含 immutable sidecar wx/0444、完整扫描/形状/事件/路由/报告正负路径）。`fleet-identity --prod-statestore --tmux-inventory --prod-socket-root --out`；`liveness-command --runtime-module --state-dir --socket-root --marker-dir --exec` 只生成命令。`observe --db --manifest --step` 自动取 cycle 下界与 start 身份，或显式 --bounds/--bodies JSON。其他参数定义在主 CLI，可直接读 usage switch。
- CI 新增 park/runner-windows/verdict 三个 suite，enumeration 先红后绿，目前40 Node suites 与302 shell suites 分类通过。本批最终本地十八 suite **417/417 PASS，exit 0**，`/private/tmp/fly2456-cli-verdict-batch.log`。Biome 曾因全局名 escape 失败，改为 escapeHtml 后相关检查通过。最终全仓 gate/CI/正式评审仍未开始，未 push。

## 最新继续入口（覆盖前面的过时缺口）

1. **start digest 预检接缝**：当前 start intent 要求 selectionDigest，路书执行前必须可计算。它在 `workflow-template-selection.ts:297–320` 根据 binding/revision、category/tier、model overrides/assignments 算出，不能等 reservation 出现才补 intent。已问 Lead `a834b11d-61e8-4762-b0cf-8bea9ecb5cca`，当前 `not yet`，属于非阻塞精度问题，不是 blocked。可继续追实际纯 helper/只读 snapshot：resolveWorkflowTemplateSelection 的 store 读取 getWorkflowCategoryBinding/getWorkflowTemplate/getWorkflowTemplateRevision/getWorkflowStartReservation/getActiveWorkflowRunForIssue，首次写是 materializeWorkflowRun(startReservation.selectionDigest)。考虑只读 facade 到此截获 digest；必须严禁调用真实 materialize/活库/进程。路由输入见 runs-route.ts:2943–2967，menu override转换见2719。
2. **辅助 PRE/QA manifest 身份**仍缺。PRE 需要独立预生成 start key；QA 是引擎自动派出的 attempt1，不能伪造一次 /runs/start。应向真实 workflow node/binding/activation 与 sessions 收养其身份，供 launch delta 声明集与 QA fallback。当前核心 config 只允许 B1/B2/B3，不得扩成混合核心标签。
3. **完整 host-runbook.md 仍未创建**：先解决以上实际可执行入口，再写每步命令+预期+证据+停手；宿主 capture JSON 必须匹配当前文件证据字段、所有DB用managed snapshots、保留 slot隔离env。dry-run 仍缺绝对路径/adopt前置语义检查；CI还需显式Python对最终路书生成真实guard receipt（现只fixture实跑）。
4. 单轮 report渲染已在verdict；两轮合成 `drill-report.md`/`founder-report.html` 与playbook§7追加尚缺。proc需要逐项生产解释时目前保留 needs-attribution（不自动放行），任何这种真机分支都要由Lead实际证据解决，不能造 pass。
5. 完成这些交付后，最终 lint/build/packages/scripts、milestone literal last commit、一次普通push、PR、exact-head CI14/14、正式 request-review、runner closeout与needs_review。保持目标 active；仍未起房或重启生产。

## PRE / QA 身份与 selection 预检批次

- `manifest precondition-body --manifest <path> --issue FLY-202` 为 PRE 原子登记独立请求身份；B1/B2/B3 配置不扩容。PRE start 的 issue 与独立身份由收养器核验。恢复时相同登记原样 replay，不能换 issue。
- `qa-identity` intent 使用 `{kind:'qa-identity',label:'B1',issueId}`；CLI adopt 从新鲜 StateStore/CommDB 副本核 engine 派出的 qa attempt 1、同 run/issue/project/session 和唯一 activation，落 source=workflow-engine 的稳定身份，不返回凭据。缺失不是手动 start 许可。launch delta 仅从这个来源登记 QA，start 标签已排除 QA。独立复核发现全局 NULL execution_id 校验误拒 pending node、旧 QA start 白名单绕过来源；均先 RED 后修复并复核关闭。
- `selection-preview --db <snapshot> --request <raw-start.json> --checkout <tested-absolute> --host-repo <absolute> --model-config <absolute>` 调用被测 checkout 实际 built resolver，在首个 materialize 调用前截获实际 selectionDigest。要求进程启动前 `FLYWHEEL_MODELS_CONFIG` 精确绑定该文件；不自行改 env，不读默认模型文件。必须使用新 Node 进程且冻结 built checkout、菜单与模型文件。当前只接受可确定的 FLY-N issue identity，UUID/不一致 hydration fail-closed；active/reservation 提前拒绝，不进入 liveness/quiescence。
- Lead question `a834b11d-61e8-4762-b0cf-8bea9ecb5cca` 裁定没有现成预检配方，要求实际源码 digest 与真实 reservation 对照。测试已用相同 synthetic 输入调用真实 StateStore/resolver，将 reservation 落到临时 SQLite 文件，关闭后只读重开核 selection_digest 与预检值相等。不是事后补 intent，也不是生产 /runs/start admission 全路径证明。独立 selection 复核无 HIGH/MEDIUM。
- 本批六个相关 suite **122/122 PASS，exit 0**，日志 `/private/tmp/fly2456-selection-batch.log`；CI enumeration **42 Node suites / 302 shell suites**，含删除变异。新增两 suite 已显式登记。未执行真机、未 push；全仓 gates、pair report、完整 host-runbook 与最终 guard receipt 仍待完成，cursor 保持 4/7。

## 双轮报告组合器

- `report-pair --r1 <verdict.json> --r2 <verdict.json>` 验证 verdict 引用文件的 hash，并以当前 `verdictRound` 重算两轮；只从实测输入计算成功率，不接受手填汇总替代。要求 r1/slot4 与 r2/slot1、三具体身份与 activation/holder 形状；保留 fail/needs-attribution，B3 不进分母。
- 输出零表格 markdown/html，包括精确 SHA、首 episode 原始事件、换体证明、生产逐阶段证据/归因、夹具与残留。HTML 已 escape。`drill-report.md` 与 `founder-report.html` 现在明确标为未实测模板，不能当 founder ship 证据。
- 组合器 RED→GREEN，独立复核无发现；组合器/verdict/CLI 三 suite **35/35 PASS exit 0**，`/private/tmp/fly2456-report-pair-batch.log`。CI 显式登记新 suite，enumeration 通过。引用证据文件必须保持可读且冻结；目前组合器遵循 verdict 的前五个 source 文件顺序，已用重算与 hash 校验约束。
- `host-runbook.md` 已开始编写，仍明确标“编写中”；已有 context、managed snapshot、slot runner 环境、房证据 capture、start/deploy/menu 收养函数与 SHA 前置，尚未完成全演练链，不能执行整轮。

## 路书词法守卫与隔离环境批次

- dry-run 使用每节 `fly2456-step` JSON 元数据，核显式绝对路径/已绑定变量、intent → adopt → execute guard 顺序；复用函数必须先定义并验证再作为 effect call 引用。其保证明确限于词法协议与真实 scan_block 回执，不是完整 shell parser，也不是实际执行安全证明。
- 独立复核发现 forward-defined effect wrapper 漏检、合法 call 旁夹带未注册 effect function 两处，均 RED→GREEN；以 fixed-point 传播函数副作用、拒绝额外调用修复，复核关闭。Node 内联 `-e` 与 `--input-type=module -` 的明确形式已支持，未知脚本参数仍 fail。
- 路书现有 11 节：context、managed snapshots、slot runner、房 capture、start、deploy/menu、SHA 前置、生产采样、decoy、teardown、room-info restore。**仍编写中，不能执行整轮**。实际 Python scanner 对这 11 节零命中，Node dry-run pass；receipt `/private/tmp/fly2456-partial-runbook-guard-2.json`，inputsDigest `d673c286cd36c17db49b4b5336b346152a255183930054118f0018948e044404`，scannerSha256 `03f50e1c6bd9a19b2de1b9026b8a39ea2115eaeba96c6b98a13d5c4dbddff982`。这是该草稿的回执，后续修改必须重跑，不能称最终路书 gate。
- 路书独立复核发现 slot_runner 继承 owner API token；真实函数提取测试先以 wrong-api-scope RED，改为 env -i + slot API token/ingest 明确重建后 GREEN。fixture 还种入旧 workflow output/submission/founder 与 unrelated secret，证明不传给代 runner CLI。slot 配置文件通过明确 SLOT_CONFIG 读取。复核关闭，11 个 Bash block 语法检查通过；无宿主操作。
- 本批 dry-run/CLI/路书三 suite **33/33 PASS exit 0**，`/private/tmp/fly2456-runbook-batch.log`；CI enumeration **44 Node suites / 302 shell suites**，含删除变异。脚本 lint 无错误；模板风格 info 不计测试。未运行最终全仓 gate，未 push。
- 精确续作入口：路书已保存可复用 helper，但尚无实际顺序段落。下一批补隔离 doctor、前置 PRE start/session terminate/两维护 tick/teardown 与归档 ledger；sandbox marker/PR/park、QA identity+fail/operator fallback、B1/B2 gate；cycle pre-state（listener 链/old lstart/log offset/三 run bounds/spec hash）、liveness+shape、cycle1零事件/cycle2第一episode；四次采样的实际调用与三组比较、fixture/zero-impact 文件构建及 pair 输出；紧急恢复实际调用；playbook §7 三项追加；最终 guard CI 命令。保持 plan 不动，cursor 4/7。

## 完整路书集成与取证精度（2026-09-10）

- Lead 问题 `c7791d8e-0d58-44d2-af0f-28b371382737` 确认现有维护循环无无条件 tick 可观测量。本轮允许保留真实 start/end、精确 waitedMs >= 600000，maintenanceTicks=null 且报告 UNAVAILABLE；必须绑定 `no_unconditional_tick_observable` 和该 ruling。数值 tick 分支如提供时钟，也须自洽。后续可独立增加每 tick 0600 heartbeat receipt，本任务不改产品。
- Lead 问题 `cb217d8d-9968-4f59-b725-3b53bf125b17` 允许只排除本次 ps 采集命令自身 PID。proc-prepare 保留原始字节，派生头记录精确 PID/lstart/原行/命令、源及派生哈希；读取时重新推导并拒绝篡改。未扩大到其他进程或父 shell，其他 NONSLOT 仍严格比较。
- marker 收养记录 expectedBaseBlobSha；仅远端 blob 仍为该基线时允许追加，否则 conflict。独立审阅关闭；15 项 file-adopt 回归通过。
- PRE 等待与 room-info 隐藏区间的嵌入 Python 直接从最终路书抽取测试；有效时间线与错误顺序、identity 漂移、时钟不自洽、错误 ruling 等 5 组 unittest 通过。路书 Bash 语法与真实 slot_runner 环境隔离 2 项通过。
- 最新定向八 suite 79/79 PASS，exit 0，日志 `/private/tmp/fly2456-integrated-focused.log`。完整 62 段真实 scanner/dry-run PASS，receipt `/private/tmp/fly2456-full-runbook-guard.json`，inputsDigest `bba506e5e43430fe34f54ba4e35b653f0c9c280f69b6fa660ed9ba4a0d9bd3f1`，scannerSha256 `03f50e1c6bd9a19b2de1b9026b8a39ea2115eaeba96c6b98a13d5c4dbddff982`。后续路书修改须重新出具 receipt。
- 全 lint 修复仅本任务测试 imports、赋值表达式和 HTML escape helper 名称；第二次 `pnpm lint` exit 0。`pnpm -r build` 完成 exit 0 后才启动 packages 全测试。没有新增 `.test.sh` 文件；枚举测试通过。
- 当前仍无真实房间、生产操作、push、PR 或外部评审结果。宿主 liveness 历史独立回执和本地受限环境结果分别报告，不能互相替代。

- 独立完整顺序审阅发现 cycle 1 立即采样，缺 pinned plan 的 60 秒观察期。新增失败回归后补持久化 receipt+60s deadline，再采样；实际嵌入代码的模拟时钟证明等待满 60 秒、恢复沿用原期限、receipt 变化 conflict。Python 6/6、路书 3/3 PASS，复查进行中。最终 scanner receipt 更新为 `/private/tmp/fly2456-full-runbook-guard-2.json`，62 段 PASS，inputsDigest `58227ae0154b34b616d8b177f7cebd3b632d3d7ccc38013b71b79c46d4abe3c5`。
- 全新增 Node 脚本套件本地 **466/467 PASS，exit 1**，`/private/tmp/fly2456-all-script-tests.log`；唯一失败为实际 liveness fixture，holderError=EPERM、verdict=unknown，不修改测试预期。Lead 宿主同源测试在 2026-09-10T06:50Z 的独立回执为 1/1 PASS exit 0（原始回执见此前宿主 liveness 记录）；本地全套仍失败，不能借宿主单项改写。无新增 shell suite；CI 枚举 45 Node / 302 shell 通过。

- 完整路书独立复查已关闭唯一 blocker，3/3 路书、6/6 Python 通过。全 packages 仍在运行，已发现 kill-path inventory 少两条本次 qa-only 项；isolated test 4/5 PASS，diff 仅 liveness fixture 的 owned child SIGTERM 与生成探测的 signal-0。因 fixture 位于禁止修改的 packages 下，已向 Lead 请求两项登记的精确例外，问题 `ef9c0fc6-429d-433d-8750-cccd737befe0`；尚未改 fixture，也不绕过 scanner。

- Lead 已批准 `ef9c0fc6-429d-433d-8750-cccd737befe0` 的窄口例外：只更新 `packages/claude-runner/test/fixtures/kill-path-inventory.json`，两条 qa-only 由 `scanKillPathInventory()` 产出，637→639；Biome 保留原格式，diff 仅 12 行。focused RED 4/5→GREEN 5/5，`/private/tmp/fly2456-inventory-green.log`。PR 须保留此例外及原始 diff 摘要。
- 第一轮 `pnpm test:packages:run` exit 1，claude-runner 1223 pass / 1 fail / 2 skip，唯一 failure 为上述 inventory；它的失败使递归后续包未完成。已修复登记并启动第二轮完整命令，不能用 focused green 代替全仓结果。

- 第二轮完整 `pnpm test:packages:run` exit 1：inventory 已通过，已有 `async-exec-file` 的 stdin 测试在全套并发中触发 500ms timeout；claude-runner 1223 pass / 1 fail / 2 skip。该文件 isolated 7/7 PASS（`/private/tmp/fly2456-stdin-focused.log`），不更改该测试或超时，不把第二轮全套标绿。
- 递归中断未启动的 edge-worker、teamlead、voice-bridge、voice-codex 已用四个明确 filter 加 `--no-bail run test:run` 补跑，日志 `/private/tmp/fly2456-remaining-packages.log`，结果待收集。其余 13 个有 test:run 的包均在完整命令中实际启动。

- Lead 对报告 `e3d584eb-a408-4bb5-bade-ab3f65caedfe` 作出 FLY-2492 协议裁定：既有 500ms stdin 并发 flake 不追本地全绿；隔离文件与四包补跑完成即止，两次 full exit 1 保留并在 PR 披露。milestone literal last 后一次普通 push，以 exact-head 机审和 CI 14/14 为完整门；评审期间不推。宿主由 Lead 跑。

## 本地验证收口（正式评审之前）

四个下游包 no-bail 补跑 exit 1：edge-worker 1318 pass / 14 skip，voice-bridge 649 pass，voice-codex 122 pass；teamlead 12451 pass / 1 fail / 7 skip（925 files pass / 1 fail）。失败为既有 StructuredInboxRouter 的模拟 pre-ready chokidar error 和 afterEach 10s hook timeout。原始日志 `/private/tmp/fly2456-remaining-packages.log`；已通过报告 `c02fc9c2-347c-4893-b177-9d8635a539c6` 告知 Lead。按 FLY-2492 裁定不追加本地全套重跑，不改无关产品代码。

本地 lint/build 通过；全包两次 exit 1 和下游补跑 exit 1 均保留。新工具 466/467 本地回执的单项 liveness EPERM 也保留，不能用宿主 1/1、stdin 7/7 或 inventory 5/5 改写全套状态。最终合入前门槛为冻结 HEAD 的 request-driven review 和 CI；当前未通过，尚不能 needs_review。

最终路书只更新交付状态说明后，重新运行真实 scanner：`/private/tmp/fly2456-release-runbook-guard.json`，62 段 PASS，inputsDigest `bdfb7c58a264f5978be46b02d09b8a54883dfe63c04cdd0bec8d0fce2a06cc34`，scannerSha256 `03f50e1c6bd9a19b2de1b9026b8a39ea2115eaeba96c6b98a13d5c4dbddff982`。

## 正式 R1 审查后有界修复（2026-09-10）

原始 request `38e868bd-9bb2-41c0-9079-327416c37426` / gate `c41248f1-aa23-428b-8713-2bc689755d7e` 在冻结头 `1c2aa9f83` 返回 CHANGES_REQUESTED。唯一 HIGH `managed-snapshot-budget-blocks-drill` 已核实：单一 owner 的 2GB 目录会累积生产双库和轮询副本。Lead `953b3f3a-d699-49b4-936d-c3806b4800d1` 批准串行受管采样、派生后续判据、关闭句柄与 release；`64b14d8c-ea5d-4cf3-97ce-ff2939643932` 确认显式有效 owner 与 canonical 目录校验。计划原文不改。

生产 StateStore 与 CommDB 不再同时占用 managed 目录。每份受管副本导出后续判据需要的列、类型和值，保留源 SHA/observedAt 与独立派生 SHA；关闭源句柄后 release。比较器在原文件已删除时读取私有派生文件，沿用原 SQL 谓词。CommDB 保留所有物理表 TEXT/JSON 判据列，才能用最终才获知的 executionId 反查 before；不执行 poison view。slot 双库每批最后 reader 后释放；每次 observe 轮询释放，终局先派生五表观察证据，后续换体因果链按同一来源重验。release 只有 deleted/already_absent 且目录已消失才通过；ok:true 的 owner_missing/owner_mismatch/not_authorized/owner_changed 仍停手。导出失败与会话退出均有释放路径，未分造 owner、未外移 DB、未改 2GB 护栏。

CI run `34458508601` 的两处失败均本地复现后修复：ci-structure 固定顺序增加一条已有 hermetic job 名；fly1674-residue 按 Lead `e1398292-10ad-4aea-bc10-6e6c8cc6406d` 添加精确 path|token 对。`no-three-stage` 是产品唯一合法 routing override，不是任意测试文案；Lead 明确接受保留真实负例并精确豁免。没有通配或新豁免机制。

红→绿回执：派生读取测试先因模块缺失红，随后修复内部表枚举并通过；实际 production_databases 提取测试以 1,149,616,128 + 998,420,480 字节模拟同 owner 2GB admission，未有串行函数时红，现成功且导出失败后释放；真实 observe_campaign 函数三轮验证 read→release，终局 derive→release；release 非删除回执与 /tmp canonical 目录、owner preflight 均有先红后绿。全部相关及 manifest 测试最终 **151/151 PASS**，路书 **8/8 PASS**，日志 `/tmp/fly2456-r2-focused-final.log`、`/tmp/fly2456-host-final.log`。

本轮 `pnpm lint` exit 0（15 warnings，无 error）、`pnpm -r build` exit 0；日志 `/tmp/fly2456-r2-lint-final.log`、`/tmp/fly2456-r2-build.log`。初次 lint 的新测试排版错误已修复后重跑。全新增工具批次 **476/477，exit 1**（`/tmp/fly2456-r2-all-tools.log`），仍仅实际 liveness wrapper 的 lsof EPERM；其后新增 owner/release/path 测试计入上述独立聚焦回执，不冒充整套重跑。本地全包历史失败继续按 FLY-2492 保留，未重复追绿。

CI structure PASS；fly1674-residue **76/76**；enumeration **45 Node / 302 shell** PASS，无新增测试文件需要额外 CI 枚举。最终真实 scanner + dry-run **62 段 PASS**，`/tmp/fly2456-r2-final-runbook-guard.json`，inputsDigest `0707b9b19524d0c79c7c618c86b694916301822fc255b215cd2bb76af5f61a5e`，scannerSha256 `03f50e1c6bd9a19b2de1b9026b8a39ea2115eaeba96c6b98a13d5c4dbddff982`。

R1 原始审查共有 **4 MEDIUM、3 LOW**（以结构化回执计数为准），按 Lead 裁定本轮只披露不改：整库缓冲的内存开销、生产 StateStore 只按声明 executionId 扫描、dry-run 不分析 heredoc 内部变更、空房检查未验证生产 tmux 残留；alert 文件消失不影响判决、PRE tick 校验固定 UNAVAILABLE、park marker 要求既存 baseline blob。这些不是已修复项。

下一步：修复提交→最后的 milestone→一次普通 push→新头 request-driven review + CI 14/14。新审若再有同源或新 HIGH，按 Lead 指示停手询问，最多再两轮。没有执行任何宿主起房、起体、cycle 或生产操作。

## 正式 R2 审查后的发布字段修复（2026-09-10）

request `56159ae2-ab06-4e51-8aec-88cffe213c20` / gate `e40e0b06-1480-4d29-ae8c-81aceeeac37b` 在 `2fe2c3e00` 返回 CHANGES_REQUESTED，唯一 HIGH `report-pair-leaks-raw-process-command-lines`。Lead `c6d23454-ea6b-4de5-b7ad-cf9236dd949f` 批准只修发布投影，计为剩余两轮中的第一轮；再有 HIGH 必须停手询问。

真实 verdict→pair fixture 注入合成 token 到 proc argv/env、事件 raw/parsed payload、未知嵌套字段、replacement 和终态归因。先确认 Markdown 泄漏红，再改为显式字段投影：单轮/双轮发布稿保留状态、计数、合法身份、PID、事件时间/类型/id/attempt、归因摘要与证据 path+SHA；丢弃 command、env、原始 payload 及未知嵌套对象。原始 proof 与判决语义不改，完整私有文件仍保存合成 token，证明未以删除取证换取发布安全。测试同时验证两种发布格式无 token/凭据变量名、50%/100% 成功率仍在、事件 id 顺序不变、PID/换体/终态归因仍在。报告/判决/CLI **39/39 PASS**（`/tmp/fly2456-r3-report-tests.log`），红测 `/tmp/fly2456-report-secret-red.log`。

Lead `27fb8a73-b160-4eb9-b210-b80fdf220ae5` 批准在 relayStateAllowedFiles 只追加 `scripts/lib/qa-fly-2456-db.mjs`。FLY-1645 原始失败为 question-only openGates 的两处 relay_state；读表逻辑与 scanner 不改。main-only 扫描现通过（1893 main files），守卫自身 **4/4 PASS**，CI 枚举 **45 Node / 302 shell** 通过。

CI run `34461715247` 在旧头最终为 **11 success / 3 failure**（含汇总 CI OK）。除上述登记缺失，teamlead shard1 为 4225 pass / 1 fail / 3 skip，唯一失败是既有 merge-ship-gate.integration.test.ts:518 的 5000ms timeout。本 PR 未改 packages/teamlead；isolated **12/12 PASS，2.66s**（`/tmp/fly2456-r2-merge-gate-focused.log`）。Lead `41cafb07-dc9a-4aaa-b476-4b4baca55456` 将其裁为并发 flake，以新头 CI 为准；若新 run 同一测试再红，只允许一次 `gh run rerun --failed`，仍红则 ask Lead。不把 isolated 改写 CI，不改 timeout。

本轮 `pnpm lint`、`pnpm -r build` 均 exit 0（`/tmp/fly2456-r3-lint.log`、`/tmp/fly2456-r3-build.log`）。全工具 **479/480，exit 1**（`/tmp/fly2456-r3-all-tools.log`），唯一失败仍为 lsof EPERM 的真实 liveness fixture。此前全包失败仍按 FLY-2492 保留。最终路书实际 scanner/dry-run **62 段 PASS**（`/tmp/fly2456-r3-runbook-guard.json`），inputsDigest `bc91e253547fb3935f68de809685421ff93464cf36f7b39461671dca59857da0`，scannerSha256 不变。

本次 R2 的 3 MEDIUM / 2 LOW 按 Lead 指示仅披露：alert 删除未影响判决、campaign shape 缺来源绑定、verdict phase 证据缺时间绑定；manifest 残锁未有恢复接口、proc 派生比较依赖原 ps 文件位置。上轮披露的非阻断项也不声称已修复。批准计划、产品和宿主运行状态均未改变；没有真机演练结果。修复后再次 milestone literal last、普通 push、新头机审与 CI，未完成 needs_review。

## 正式 R3 通过后的 retention 登记（2026-09-10）

request `96ad07ad-b5e3-4dbd-96fa-a0b8fc1b6fb0` 在 `3b0104e1e1367384b091eac1b803a9c203cdf3bb` APPROVED，发布泄漏 HIGH 已消除。4 MEDIUM / 4 LOW 仅披露：publicProof 字符串数组投影为空但计数非零、alert 删除未影响判决、campaign shape 缺来源绑定、phase 证据缺时间绑定；publicProof 不展示失败原因、单轮 precondition tick 分支未投影、manifest 残锁、proc 比较依赖原 ps 位置。未将建议改写为阻断或扩展本轮范围。

CI `34463716638` Quick Gate 在 FLY-1645 通过后因七条 retention read 未登记失败。本地扫描同样复现七条 unclassified。按 Lead instruction `035e84bb-a7de-4ce6-8044-fbaceb422e1e` 与裁定 `964fd665-b0df-41ea-908d-4c115c0aaf83`，仅在 retention config 追加七个精确 file/relation/baseTable/read 条目，disposition=candidate_guarded。分类理由：FLY-2456 read-only evidence over managed snapshot copies。不豁免扫描、不改读表逻辑或产品。

登记后守卫测试5/5，扫描ok:true、errors为空。按 CI YAML 顺序执行全部17个 Quick Gate run 步骤（不重复依赖安装），含 build、typecheck、lint、workflow-seeds 和所有前后守卫，全部exit0；逐项回执 `/tmp/fly2456-r4-quick-receipts.json`，独立扫描 `/tmp/fly2456-r4-retention-scan.json`。没有新增行为或测试文件；历史本地全包和lsof失败仍保留，未重跑追绿。

此次是批准的最后限定轮。修复提交→progress→milestone literal last→一次普通push→新头正式审查与CI14/14。再有HIGH必须停手ask Lead。当前尚未完成needs_review，真机证据仍由Lead提供。


## Implement attempt 3 — WAL snapshot 与 owner 前置修复

Lead 对问题 `6a9ff087-2f74-4cc2-bfc3-0b021c7651d1` 的回复限定三项：内存 WAL header 兼容、路书 workflow owner、PR 披露更新。批准计划、其它守卫与演练步骤不变；一次普通 push 后冻结 HEAD，新审查与 CI 14/14 后 needs_review。同源 HIGH 再出须先 ask Lead。

真实临时 WAL 数据库经 `wal_checkpoint(TRUNCATE)` 并关闭，文件 header 保持 `02 02`。新增回归在旧实现上 `SQLITE_CANTOPEN`，路书真实 Bash owner 检查对 workflow fixture 返回 1（期望 0）：`/tmp/fly2456-a3-red.log`，2 FAIL。SHA 校验后仅将 readFileSync 的内存 Buffer header[18]/[19] 改 `01 01`，再 readonly 反序列化。磁盘原始字节与 metadata SHA 不变；归一化副本 SHA 作为 metadata 会被拒绝；读取 responded 行成功且 DELETE 被拒绝。未读取生产数据库或制作生产副本。

路书 §01 两处 runner 改 workflow；实际 helper 回归接受当前 execution 的 workflow，拒绝不同 execution、runner/session/operator 与 inactive。相关两套件 `/tmp/fly2456-a3-focused.log` **81/81 PASS**。后续本地验证及精确头门另记，不以聚焦通过代替完整门。


本轮最终 `pnpm lint` exit 0（15 warnings；首次新测试格式错误已修复）、`pnpm -r build` exit 0；CI enumeration exit 0；retention/receipt 测试 **9/9**、两项实际 scanner 通过。全工具 **489/490，exit 1**，唯一失败仍是 liveness 实际 wrapper 的 lsof EPERM / holderPids=[] / verdict=unknown，`/tmp/fly2456-a3-tools.log`；不改写历史本地全包失败，不违反 FLY-2492 重追本地全绿。实际 runbook scanner/dry-run **62 段 PASS**，inputsDigest `008480c64b44d515b99f212a4a241ca71dfbe9219abfc28e6046aaf7244d65b5`。

PR body 修订补披露 MEDIUM `fleet-window-removal-without-exec-marker-unattributable`，以及 QA 发现的 76 个 `runner-fly1674-*` 陈旧窗口（Lead 回执已清，归因 follow-up FLY-2500）。改动面含 `scripts/lib/qa-fly-2456-file-adopt.mjs`；删除旧头 pending 句。旧头 f51aa8710 的 CI run 34468907713 实时核对 14/14 success，仅是旧头证据。真机 PRE/R1/R2 尚未由本节点执行。
# Implement attempt 4 — bounded CommDB evidence and NUL-safe matching

Lead request `6c54c527-5c9d-4d4f-a98a-5725f3a91885` reports host R1's 1,002,496,000-byte comm snapshot failing whole-text JSON serialization. The follow-up ruling `557ddeae-52c0-4b96-b28c-675095179e44` confirms production has legal NUL-delimited state keys: CommDB matching must use shared `instr(column, marker)>0`, accept NUL TEXT, and reject non-TEXT storage. StateStore and observation projections and their guards remain unchanged.

Comm derivation now selects only rows matching the same literal marker set and predicate as commScan. It traverses each physical table in rowid order with `iterate()`, hashing canonical JSON arrays of the selected TEXT/JSON values separated by newlines. Each table retains its full rowCount, sha256, schema columns and selected rows; all table/view identities remain available to schema checks. Unmarked text is hashed one row at a time and is not written into the projection. Non-TEXT values in scanned columns fail derivation before an artifact is written. Source snapshot SHA verification remains unchanged.

The runbook forwards slot/lead and all currently receipted start/QA executions plus already observed replacements, preserving PRE when present. Empty initial manifests pass only slot/lead. The actual derive wrapper parses repeatable `--exec` arguments. OWNER_EXEC explicitly requires a live unfinished DAG execution with workflow ownership, excluding Lead sessions and completed executions.

RED receipts: the 20,000 × 2KB unmarked fixture produced 41,064,241 bytes on the old implementation; fingerprint metadata was absent; direct/projection hit ordering differed; NUL TEXT was rejected by the old scanner and the old LIKE projection dropped markers after NUL; the production helper omitted slot/lead arguments. GREEN: focused scan/host-runbook/drill suites 61/61, including actual wrapper execution; all-tools 494/495 with the existing local liveness unknown-versus-alive failure retained (`/tmp/fly2456-a4-tools.log`). No live snapshot, slot body or Bridge restart was performed by this node.

Local lint and recursive build exit 0; CI suite enumeration passes. The actual restart scanner and protocol dry-run pass all 62 blocks, inputsDigest `e227797154bb4ac54cc68fd8309e821cc2ccf59ee6ae0e146e507ee2c6558805`, receipt `/tmp/fly2456-a4-runbook-guard-final.json`. Full-package validation and fresh exact-head formal review/CI are tracked separately; earlier-head approvals do not approve this repair.


## Accepted R7 HIGH repairs — production input classes and baseline deltas

Formal gate c0fc469e on 1c5932b33 returned CHANGES_REQUESTED: alerts-read-rejects-production-records and zero-impact-gates-are-absolute-not-delta. Lead accepted both findings and updated QA attempt 4 criteria (15753bb8-a8f7-4583-a763-3e322eec0a63); this is repair authorization, not an overrule. Seam confirmation 12ffba78-a387-49d6-9164-1f59c915c466 permits comm-only rowid preservation and numeric report fields. Old-head CI run34481068035 attempt2 finished14/14 after the single authorized retry; it does not approve the new repair.

Alerts now retain valid foreign lead identities/counts and classify non-JSON or atomic temp files as unparsed, without exporting content. Existing slot alert filenames form the baseline; only newly slot-attributed filenames are pollution. Unreadable/invalid inventories, path traversal, duplicate paths and digest mismatches still fail closed. Newly unparsed content remains needs-attribution; unchanged historical unparsed records are disclosed without blocking.

Comm scans emit physical (table,rowid,column) identities; the filtered comm projection carries original rowids and reconstructs them in memory. Production scans use existing sessions.execution_id and session_events.id stable keys. StateStore and observation projection contents remain unchanged. scanDelta checks complete unique identities and consistent aggregate counts, subtracts baseline identities, and cannot hide an addition behind deletion of an old hit. Verdict applies this before→liveAfter/postTeardown and exposes baselineHitCount/newHitCount; baseline alone does not fail. The pair report replays the delta verdict and publishes only these numeric additions to the established allowlist. No hit content, arbitrary identities or argv are added to publication.

All new acceptance cases were observed RED then GREEN: production-shaped foreign/non-JSON/tmp inputs; pre-existing slot alerts and database markers; equal hit counts with a different new identity; comm rowid survival through filtering; missing/duplicate identity proofs; and baseline counts in safe reports. Final focused CLI/alerts/scan/verdict/report/host tests103/103 pass (/tmp/fly2456-r7-final-focused.log). The initial whole-tool pass501/503 exposed an outdated CLI fixture (corrected to contain hitRows and baseline/new counts) plus the existing local liveness restriction. Final whole-tool receipt is reported separately. Lint, recursive build, CI enumeration, retention/receipt scans and9/9 guard tests pass. The unchanged62 command blocks pass actual scanner/dry-run with inputsDigest9114c7cf6ec53bd28cd3cf4e3e7454a533d43344b504b70b94b2a2ac35537be3.

Prior local packages exit1 remains disclosed: teamlead12444pass/8fail/7skip across actions-retry-route, chat-thread-routes and lead-inbox-runtime, plus onTaskUpdate timeout. No second full-package pursuit. New formal review and exact-head CI remain required after milestone-last ordinary push. No host drill was performed by this node.


R8 Bash 宿主兼容：review 2ab8697b / finding runbook-empty-array-breaks-on-macos-bash-3 由 Lead 4962f881 授权修复；追加 7e2dd870 授权 production_databases 子 shell out 去 local，保留 EXIT release。project_args/exec_args 采用 Bash3 安全空数组展开，测试默认显式 /bin/bash，可用 FLY2456_TEST_BASH 验 Bash5。旧路书 Bash3 红（2失败），数组修后剩 EXIT trap 局部变量失效，最终两种 shell 各9/9；失败路径仍断言 usage 归零。dry-run测试15/15、实际62段scanner/dry-run通过，digest63342b09c9645698be10b91478410464b590373163e2d32352565fafb3cd7538，lint通过。未改演练语义及其它工具；既往全包失败与本地liveness限制保留，新头CI待验。新增advisories仅披露：alerts-baseline-exclusion-ignores-content-change、comm-delta-depends-on-rowid-stability。
