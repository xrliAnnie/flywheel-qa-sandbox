# FLY-2643 默认可见终端 — 实施计划
Issue: FLY-2643 (https://linear.app/geoforge3d/issue/FLY-2643/载体可见性默认-所有-lead及-runner默认必须跑在-cmux-可见的-tui-窗口里无终端后台跑不再是合法状态写成硬规则)
日期: 2026-09-17
基于: 无

## 1. 结果与授权边界

所有生产 Lead 和仍在执行的 Runner 必须能在 cmux 看见并接入自己的真实终端；后台进程活着、空白窗口、同名旧窗口均不能算上线。TUI 指可直接观察和操作的文字终端界面；tmux 保存实际终端，cmux 展示并连接这些终端。

本文件合并探索、仓库调研和实施步骤，遵循 plan_only。此提交只有设计；实现、测试、生产验收由后续节点执行。本轮不安装、不迁移、不重启、不请求 ship、不派后继。

Lead 回答 `d5aa3279-4c45-4e0a-8095-5a7c5b1f1ca8`：founder 2026-09-17 19:06Z 已解除“先收尾不开新活”；正式范围包括硬门代码，认可公共 launcher + verifier + cmux census 复用。实际存量切换不在设计节点进行；Raya 割接仍归 FLY-2496。必须验“后台无终端 Lead/Runner”被拒绝且可见报告的反例。

### 方案选择

| 方案 | 判断 |
| --- | --- |
| 只加规则和窗口名检查 | 拒绝：已有 Codex 生产可见规则，仍漏空壳、错 socket、后台进程；不能落实硬门。 |
| 一个只读验收入口，安装/班车/巡检复用，保留现有修复者 | 采用：统一判据，不再为不同入口各写一个“健康”。 |
| 每个观察失败都杀进程重建、重写载体/加新守护进程 | 拒绝：会丢进行中的工作并引起反复重启；超出本单。 |

“不可见=缺陷”不等于巡检有权杀进程。恢复中的业务可能继续运行，但必须显示 degraded/unverified，不能记为上线成功或静默容忍。后台 app-server 作为有可见 TUI 的后端仍合法；Bridge、watcher、updater 等非 agent 服务不要求模型终端。测试夹具隔离于生产名册，不能成为生产豁免开关。

## 2. 当前证据与真实缺口

基线 HEAD `06cbb36157890f91a44acb850f5243bb13a171e7`；源码路径/符号为实施定位，不以旧行号作身份。

| 入口/消费者 | 已有行为 | 本单改变 |
| --- | --- | --- |
| `CLAUDE.md` Codex Lead Deployment | FLY-398 已要求生产 windowed | 全 vendor、Lead/Runner 统一规则，通过真实加载器投递 |
| `scripts/flywheel-lead.sh:install_lead` | preflight、supervisor_install、plist 匹配就成功 | 等待可见验收，失败非零并报告；安装副作用与上线成功分开 |
| 同文件 `verify_lead` | registered 无进程；installed 到 Bridge nudge；live 到 PID/inbox/消息证据，无窗口硬门 | registered 不变；installed/live 追加相同可见检查；原收信/回信检查保留 |
| `scripts/restart-services.sh:launchd_lead_outcome_ready` | 仅新 supervisor PID/start 即成功；Claude/Codex 两分支都依赖 | 保留载体判定；班车最终成功再与可见验收相交 |
| 同文件 `trigger_cmux_refresh` | 在 `do_restart_all_leads` 之后才刷新 | 验收屏障放刷新之后，不能在每个 restart 内等未触发的刷新 |
| `packages/teamlead/scripts/verify-windowed-lead.sh` | 仅 Codex、固定 `flywheel` session；pane command 含 codex、socket 存在不足以证明当前线程 | 保留兼容诊断；公共验收补精确身份，不能拿它直接验证 Claude private socket |
| `scripts/flywheel-cmux-sync.sh:run_verify_sidebar` | 已有 target、pass/fail/inconclusive、两次稳定采样、pane/view/client/receipt/render 验证 | 复用真实 attach 证据，不运行 mutator；修正用于在线 agent 时的 absent 语义，见 §3 |
| `scripts/lead-patrol-snapshot.sh` STEP 1 | CommDB owner 索引与 Runner pane 取交集，缺 pane FINDING-CANDIDATE | 加期望 Lead 名册元数据核对；Runner pending/无 target 不能因 SQL 过滤消失 |
| `packages/teamlead/lead-rules-base/runbooks/patrol-v1.md` | STEP1 所属 Runner；STEP2 严格禁止跨 Lead 读取 scrollback | 保留权限边界；Lead 元数据核对不抓其他 Lead 屏幕 |
| `packages/claude-runner/src/CodexTmuxAdapter.ts:attemptOpen` | 有界创建/retry 和 tui lost/restored 通知，失败不杀工作 | 保留恢复机制，失窗纳入统一验收和可见 finding；不重做调度器 |
| `packages/teamlead/src/lead-backends/codex/codex-lead-tui-runtime.ts:ensureTuiHealthy` | 以 thread/socket ownership 重建；失败有 alert guard | 复用恢复；状态不能把窗口失败显示为上线成功 |

### 2026-09-17T19:14:54Z 只读基线

读取 17 个 canonical `~/.flywheel/manifests/*.json`，逐个 `launchctl print`，按 manifest private socket 或共享 tmux 查询 pane 元数据。17 个 canonical job 均 loaded（这不等于 running/online）。14 个 private Lead 的 `main/%0` 存在、pane_dead=0、当前命令 bash；未核验子进程，不能据此判空壳或通过。三个 shared exact window 均未找到：

| identity | 检测结果 | 后续处置 |
| --- | --- | --- |
| `raya/raya` | `flywheel:raya-raya` 缺失 | 交 FLY-2496 标准载体割接/验收，重验当前迁移账本，禁止本单另造 migration |
| `growth/mufasa-lead` | `flywheel:growth-mufasa-lead` 缺失 | Lead 在独立获权维护窗口按公共流程修复，并附复验 |
| `flywheel/codex-infra-bot-lead` | `flywheel:flywheel-codex-infra-bot-lead` 缺失 | 同上，不能因 infra 名字自动豁免 |

当时共享 tmux 有 7 个 canonical Runner window；同 pane 的 `cmux-*` 镜像不重复计数。未做全进程反向归属，不能声称“只有这三个异常”。`--verify-sidebar --target raya-raya --json` 返回 exit 2 / `sidebar-snapshot-unavailable`，是证据不足，不能盖过直接观测的缺窗，也不能宣称已完成 cmux QA。已通过 report `029c688d-6fa4-464c-b10b-5f01fc44336b` 交 Lead。

### Lead 追加只读调查（19:20–19:22Z）

请求来自 report 回复 `029c688d-6fa4-464c-b10b-5f01fc44336b`，要求解释 runtime 近期启动及“只有 Raya 窗口出现”。没有执行生产变更。

- **已证实**：19:20Z 三个 canonical job 均 running/runs=1；Raya PID17271 走公共 flywheel-lead.sh+manifest，Mufasa PID79715 和 Infra PID2921 仍走专用 wrapper。三个 job 都 KeepAlive/RunAtLoad；`launchctl blame` 仅 speculative，不给触发者。
- **日志证据**：Raya `~/.flywheel/logs/lead-raya-raya.log:7523–7543`，Mufasa `/tmp/flywheel-lead-growth-mufasa-lead.log:319–341`，Infra `/tmp/flywheel-lead-flywheel-codex-infra-bot-lead.log:314–335` 均有 SIGTERM→killed→Starting→runtime started。最新 Starting 本地时间分别12:04:59、12:03:54、12:01:50；日志没有日期，若属于当日 PDT 则对应19:04:59Z、19:03:54Z、19:01:50Z。这只是日期归属推断，不能作为精确进程出生证明。
- **实际瞬态采样**：19:21:08Z 默认 socket `/private/tmp/tmux-501/default` 的 flywheel session 仅 `@0 zsh`。随后25秒、约每秒一次只读采样：Infra 在19:22:15.506Z `%1080` PID58314 / codex / alive，19:22:16.671Z消失；Mufasa 在19:22:18.916Z `%1081` PID58669 / codex / alive，19:22:20.017Z消失；Raya 在19:22:23.296Z `%1082` PID60570 / codex / alive，19:22:24.451Z消失。
- **已否定**：“只有 Raya 窗口恢复”和“real TUI up 证明持续可见”。`tui-window.ts:ensureTuiWindow` 在 new-window 返回成功时立即打印这行；`codex-lead-tui-runtime.ts:ensureTuiHealthy` 的20秒 liveness loop 会独立重建窗口。窗口出现不证明 runtime 重启，三者都出现过但未持续。
- **未决**：SIGTERM 发送者、谁触发 launchd、精确进程start/parent，以及 pane 迅速退出的原因/退出码。`ps` 被 operation not permitted 拒绝，`log show` 被 Cannot run while sandboxed 拒绝；未绕过。不能归因给某个人、连接权限或 updater。后续授权 host QA 补这些证据，不影响先设计可见硬门。
- **设计响应**：carrier 成功需至少间隔5秒同一 identity 的两次观测；增加短暂窗口负例。14个 private bash pane 仍要沿进程树证明模型 body，并在 QA 受控接入验证能交互；仅 bash/current-command、空壳或打印过启动日志不通过。

### 第二次 Lead 补证与范围明确

Lead 回复 `d928d404-65bf-44e6-a146-68c24b4be596`：宿主观察 Raya 日志约7067条 real TUI up，约20秒一条，并提出该循环早于当日15:55Z重启。我们后续只读计数为7073；**累计计数×20秒≈39小时只能作持续时间估计，不独立证明日期或连续性**，若要证明重启前已发生需再取带日期日志/boot边界。保留Lead观察，不把算术推断写成已证实时间线。

当前日志 `lead-raya-raya.log:7535–7537` 明确有 `stopped any running daemon` → `Error: Remote control is enabled on MacBook-Pro.local but the connection is errored.` → `daemon OK`。这条错误位于 home 初始化输出，不是已绑定到某个死亡pane的stderr；它是候选根因，不能仅因相邻出现就认定导致1秒退出。runtime started及 socket/Discord owner 的宿主证据说明后台仍活跃；本轮没有做新的业务消息端到端探针，因此只声称可见窗口失效，不声称全部业务健康。

**选择：假绿及“1秒即死”的已复现根因修复纳入本单实现范围，不另拆待办PR。** 具体步骤见E0：先在隔离环境获取精确pane退出码和错误，再修证实路径；禁止凭候选错误修改生产credential、daemon或连接配置。根因未被复现/修复则本单实现不能宣称这一项完成，应将准确缺证报Lead继续处理。

## 3. 一个判定模型，分层证据

新增 `scripts/verify-agent-visibility.sh`，shell CLI 是唯一公共验收入口；只读，不 acquire mutator lease，不调用 repair/rebuild/refresh/attach/send-keys，不更改当前窗口。新共享实现 `scripts/lib/agent-visibility.sh` 使用现有 lifecycle/address/bounded-run helper。它验证 expected identity，不从“当前还活着的窗口集合”反推名单。

### 接口（新）

```sh
bash scripts/verify-agent-visibility.sh --project P --lead L --level carrier --json
bash scripts/verify-agent-visibility.sh --project P --lead L --level visible --json
bash scripts/verify-agent-visibility.sh --project P --exec-id E --level carrier --json
bash scripts/verify-agent-visibility.sh --project P --exec-id E --level visible --json
```

`--lead` 与 `--exec-id` 恰一个。project/Lead 使用既有安全 key 校验，exec-id 是 UUID；不接受任意 socket、PID、shell command、home 或 manifest 路径。production 路径从现有 state-root/registry resolution 派生。fixture 注入只用隔离 state root，不增加生产 disable/allow-headless flag。对外 exit 0=pass、1=fail、2=inconclusive；usage 64。候选上限：内部命令每次最多 5s，整个单次 subject 检查最多 30s（包含两次样本之间的5秒），timeout→inconclusive，不输出凭据或整段进程环境。

```ts
// JSON schema v1；kind/level/status 是本验收专用，不改 backend 枚举。
type VisibilityEvidence = {
  schemaVersion: 1;
  subject: { kind: 'lead' | 'runner'; project: string; leadId?: string; executionId?: string };
  level: 'carrier' | 'visible';
  status: 'pass' | 'fail' | 'inconclusive';
  reasons: string[];
  observedAt: string;
  identity: { carrierPid: number | null; carrierStart: string | null;
    socket: string | null; session: string | null; windowId: string | null;
    paneId: string | null; panePid: number | null; threadId: string | null };
  checks: { authority: string; pane: string; body: string; cmux: string };
};
```

不新建数据库表/镜像 registry/长期健康缓存。输出是当时观测，不是授权，不跨激活/重启复用；调用者可留在既有本次验收日志。显示名只展示，不能做身份匹配。需要 DB 的 Runner 读取必须用当前只读接口/参数化 SQL，拒绝 SQL 拼接；无 DB 副本需求，若需要快照只走受控 snapshot CLI。

### carrier 必须全部成立

1. 从 registry 得到唯一 `(project,lead)`，manifest/plist/loaded job 必须精确交叉匹配；不因 plist 未加载就省略应运行 Lead。停用只能根据明确现有生命周期记录，并展示 excluded 理由。manifest/plist 不是 online 权威。
2. Claude private：`derive_lead_socket(project/lead)` 与 manifest 一致，server/loaded job PID+start 对应，`main` 的真实 pane `%0` 活着；沿 pane PID 的有界子进程树找到本次 Lead 的实际 Claude body，允许合法 bash wrapper，拒绝只有空 shell。只比较运行时的 canonical launcher/body argv 及精确身份；不以 command 名中“claude”子串作 proof，不读取 secrets。
3. Codex shared：精确 `=flywheel:=project-lead`，唯一 live pane；验证当前 runtime 的 home/workspace/thread 和 TUI `resume --remote` 绑定，使用下述双文法的通用只读 helper，Raya 原 consumer 也调用该 helper，保留其更窄的迁移约束。只解析白名单启动语法，绝不 eval pane_start_command。pane PID/start 在采样前后不变；重启验收要求属于本次 carrier/当前 thread，不接受旧线程。backend 名 `codex-app-server` 本身不等于不可见。
4. Runner：从 CommDB exact execution active/phase-held 生命周期及 `tmux_window` 解析 canonical base session+window id，再对 pane/execution 当前绑定；不能只按标题匹配。`pending`、空 target、同 target 多个 exec、错 exec、pane_dead 都不通过。phase-held 仍是活 Runner，应保留可见窗口；已 terminal 且按既有 closeout 退役才 excluded。窗口存在不代表任意其他进程就是该 Runner。
5. 成功必须观察期望 subject 存在；缺失窗口=fail `missing_window`，死 pane=`dead_pane`，错身份=`identity_mismatch`，空壳=`body_missing`。tmux 服务确定不存在且 subject 应运行→fail；权限/读失败/超时→inconclusive `probe_unavailable`，不能“零异常”。两次身份采样不同→inconclusive `identity_drift`。成功样本必须至少相隔 5 秒且同一 carrier/pane PID+start/thread，不接受同一瞬间两次读取；这只是当前稳定性门，持续巡检仍不可省略。

### Codex 两种生产启动文法（均须支持，禁止照搬旧单文法）

`buildTuiCommand` 已有两分支，按 trusted canonical capability 配置选取允许分支：

- legacy：`CODEX_HOME="<home>" <bin> resume --remote "unix://<home>/app-server-control/app-server-control.sock" -C "<cwd>" -s <read-only|workspace-write> -c 'approval_policy="never"' <thread>`。
- capability-v2：`/usr/bin/env -i 'KEY=value' ... '<bin>' resume --remote 'unix://<trustedCapabilitySocket>' -C '<cwd>' -c 'approval_policy="never"' -c 'default_permissions=<profile JSON>' '<thread>'`。环境来自 `buildLeadModelEnv` 的白名单及 parent pins，必须核 project/lead/home/carrier generation；socket 是当前 parent authority 指定值，不能强行用 legacy home路径。

解析 helper 在不会执行的 tokenizer 中接受 tmux 外层单个quoted command或直接argv两种编码，最多解一层包装；随后校验固定语法、重复/未知参数、shell操作符/重定向/替换均拒绝。从 trusted spec 用当前 `buildTuiCommand`/`buildLeadModelEnv` 生成期望语义字段，与观测字段比较（不靠引号种类或 `startsWith CODEX_HOME`）。不输出整份env/pane command；只回传脱敏identity verdict。不能通过声明capability-v2让legacy subject越权，或反过来。两文法分别测试正常、错thread、错cwd、错home、错socket、错carrier、重复参数、shell注入；真实tmux测试覆盖其实际pane_start_command外层编码。

### visible 在 carrier 上继续验证

复用现有 sidebar 的单subject观测逻辑，新增只读 `flywheel-cmux-sync.sh --verify-agent-visible --target <canonical-title> --json`；保留旧 `--verify-sidebar` 的完整诊断接口和退出语义。新入口要求 live/live-v2、目标唯一、实际client接入正确pane、非空模型终端画面，但**不得复用旧入口的全局字节相等判据**。

新入口先解析整个输入以查该subject的冲突，再只把该subject的权威行、source/view pane tuple、匹配到的workspace/surface/client/birth/receipt/restored行投影到稳定fingerprint；排序后比较。保留cmux socket和相关tmux server generation，拒绝重启期间跨代拼证据。不把其他Runner的window列表、完整canonical_json、整份ledger、其他subject的restored行纳入fingerprint。全量解析错误不能假装完整；该subject重复映射、ownership不明仍inconclusive。两次观测间隔>=5秒，对本subject变化才报 `subject_drift`；无关Runner创建/关闭、其他view ledger更新不得影响本subject。

新入口的 `status/report/reasons/caveats` 全部检查：非空authority/ownership caveat→inconclusive，未知caveat默认inconclusive；仅明确不影响本subject且有测试的诊断可忽略。`receipt-uuid-unattributable` 仍不能通过。复用现有owner/receipt/socket generation，不拿sidebar名字或旧receipt当连接证据。

重要兼容边界：现有 sidebar 对已经退役的 Runner 可能返回 `PASS absent`；公共入口必须先从 active execution 证明应在线且 carrier pass，并拒绝 `PASS absent`，不能让 no window 通过。现有 `receipt-uuid-unattributable` WARN 对本硬门为 inconclusive；它不足以证明当前 cmux surface 与 client 对应。不要改变清理命令处理已退役对象的语义。screen 只用来辅助排除空画面，不以最后字符 `$` 等启发式证明模型存在；模型存在由 carrier/body 证据证明。

cmux 不可达/未启动=visible inconclusive；确定缺少对应 surface/client=fail。即使 tmux 可 attach，cmux 不可见也不能宣称本单验收通过。检查不主动 attach、切换焦点或向模型发消息。

## 4. 接入与失败传播

### 安装 / 激活

`install_lead` 完成现有安全 preflight、canonical supervisor_install 和 plist 检查后，最多等待候选总预算180s；每次visible探针完成后再退避2s，串行重试（每次受总剩余deadline限制，绝非每2s重叠启动一个>=5s探针）。让既有 watcher 负责建 view；本脚本不新增修复者。通过才打印 online/返回 0；逾期返回 78，打印 `installed_but_visibility_unverified`、identity、原因，并经现有 Lead alert 工具发可见告警。告警失败也必须 stderr+非零，不能改成成功。

已安装 job 留给当前 supervisor 恢复，不 rollback/kill，不在重试 install 中重复 bootstrap 一个 loaded exact job。现有 supervisor_install 幂等语义需用 fixture 锁定；重复 install 只重验匹配 job，拒绝已有不同 owner。`verify --stage registered` 不要求进程/窗口（FLY-2496 前激活依赖它）；`installed/live` 在返回成功前追加 visible，保留原 preflight、Bridge nudge、mailbox/Discord 证据顺序。新只读 verifier 不调用现有会 nudge 的 verify。

### restart-lead-wave

保留 `launchd_lead_outcome_ready` 的 carrier 语义，避免破坏旧 identity/authority/恢复守卫。`do_restart_all_leads` 输出先作为“载体已重启”的中间结果；**两处班车调用方**都必须在调度 `trigger_cmux_refresh` 后进入同一个最终可见收敛屏障，然后才计算 `leads_failed`、写 `LEADS_RESTART_STATUS_FILE`、清 pending marker、发成功报告。

`trigger_cmux_refresh` 返回只表示已调度5s/10s后台任务，**不表示完成**；`--refresh` 因watcher lease busy而exit0也不表示完成。屏障不信任这些返回值，不在原全局snapshot周围强抢mutator lease。它等待“刷新应产生的真实结果”：本次新carrier/body所对应的subject当前映射+attach稳定通过>=5秒；这是刷新/现有watcher已使该subject真正收敛的完成证据。若已符合目标，无须要求某个具体刷新命令执行过；若未符合则持续等待既有watcher，不以helper exit0放行。

watcher可继续处理无关subjects；新target投影使这些变化不产生snapshot-drift。若watcher正在改当前subject→`subject_drift`，仅重试该subject；若同一epoch两次确认expected subject缺窗/缺client→`confirmed_missing`；读失败/跨代/持续漂移→`unverified`，不得说成“窗口不存在”。最终健康只来自实际postcondition，不来自排队ACK。测试必须模拟异步refresh尚未执行、lease busy skipped、watcher同subject迁移、无关Runner持续开关四种场景。

对本次完整 expected candidate 集（包含 migration_activated_key 快捷分支，不包含既有 skip-test/明确暂停）重新核验；不要只采样成功名称列表。所有 subjects 共用候选总预算300s，最多四个有界只读 child 并发（退出时回收自己启动的探针），轮询失败集合，已成功也在最终提交摘要前重新核对身份，漂移退出成功集。逐 subject 最多30s，不得17×180s串行。deadline 到期未验项也计 unverified/failure，不能沉默跳过。每个 key 最多计失败一次：拒绝上线集合 `rejected = union(carrierFailed, visibilityFailed, visibilityUnproven)`；旧failed计数承接rejected以保留协议，但明细必须分confirmed-failure与unverified，不把drift伪称缺窗；保留原 skipped/total stdout 格式，明细只走现有 sidecar/日志。未知 candidate inventory→总体 degraded，禁止写 healthy。

代码已部署 SHA 与 Lead online 分开：即使新代码已部署，可见门失败仍写 Lead degraded、保留重试标记，不能为了修视图回滚代码。plugin-only/全量两分支同步接入；迁移 activation 快捷路径也不能绕过最后的门。

### patrol STEP 1 和 Runner

Department STEP1 只增加**当前Lead自身**的carrier/visible自检，保留仅自己名下Runner和当前项目外部真相的范围；不让每个Lead巡遍全registry。全Lead名册核对唯一归属现有 cmux fleet watcher 的 `reconcile_v2_lead_workspaces` 路径（`scripts/flywheel-cmux-sync.sh`），把其中现有private-only fleet census提取为独立只读collect/classify步骤，增加expected registry与窗口的左连接，覆盖private与Codex-shared；原private修复循环仍只作用于claude-private，覆盖无人能自检的离线Lead。该步骤复用公共验收的纯判定逻辑及一次批量metadata snapshot；不在持有mutator lease时串行跑N个30s CLI。稳定性使用相隔>=5秒的正常watch tick及内存中前次subject tuple，首次观测只判starting/unverified，重启后不沿用健康缓存。fleet watcher把这份带时间/coverage的事实摘要交现有告警入口；STEP1展示当前Lead对应行，不给各部门复制全舰队的finding责任。

复用 `lead-attach-missing` 的现有episode/持久告警去重，不虚构跨Lead新dedup层；runtime窗口故障与fleet缺窗是不同事实来源，但fleet只由一个watcher报告。保持runbook“只巡检自己名下/不扩大检测面”原句和FLY-2567断言，明确新增的是自身载体前置自检，fleet核对由独立既有fleet owner负责。Fleet expected名册包括缺manifest、loaded但缺pane、应在线但未加载者，不能先与现存pane inner join消掉它们。

STEP1 追加 `LEAD_VISIBILITY project=... lead=... status=... reasons=...`，缺窗/空壳为 `FINDING-CANDIDATE`，明确要求 Lead 判为 FINDING 并走现有巡检 finding/报告，不能写“正常”。无法探测为 `UNAVAILABLE(...)`，也必须报覆盖缺口。一个确定 finding 不被另一个 unavailable 覆盖：保留逐 subject 行及总 coverage，聚合 status 不足以替代明细。

Runner 仍只核 owner 范围，保留 CommDB cardinality 预检、pending/空 target 的 active 行，把它们列为 unproven/finding，不能被当前 `tmux_window<>''`/`NOT LIKE '%:pending'` SQL 静默过滤。启动宽限沿用现有 TUI-open deadline；deadline 前明确 starting-unverified，超时/永久缺 tmux 必须有可见 finding；不会把启动中的对象算 healthy。既有 tui lost/restored 是恢复通知，恢复后还需当前窗口复验才收敛 finding。

不增加每个巡检 tick 的重复频道消息，复用现有 finding/dedup/recovery 路径，以 subject+reason/当前 episode 去重。首次缺窗必须可见；仅写一条 debug log 不满足要求。保留后台业务/phase hold，不因观测失败自动终止 Runner。

## 5. 实施分块（每块先负例后实现，独立提交）

### A. 规则与真实消费者

- 新增 `packages/teamlead/lead-rules-base/visible-tui-default.md` 放唯一统一硬规则及“未验收=未上线”；`default-enable-policy.md` 只引用该规则，不把规则藏在仅部门会加载的文件；修改 `runbooks/patrol-v1.md` STEP1、`runner-patrol-rules.md` 和 `engineering/doc/FLY-2444-flywheel-lead-launcher/lead-in-any-repo.md` 安装/验收段。
- 核 `packages/teamlead/scripts/claude-lead.sh` 与 `packages/teamlead/scripts/lead-rules-bundle.sh` 的实际规则装配（`assemble_full_access_governance`）；两 vendor 的 CoS/department/infra 均应包含规则。装配角色清单固定为内部cos/dept及其infra席位；Claude legacy装配守卫要求非external且非companion，Codex compute_lead_rule_bundle仅在cos/dept分支加。companion保留其最小persona规则，external/Anna保持仅external-agent-contract.md的单文件硬边界，**不向两者注入内部载体操作规则**。它们若作为生产Lead运行，宿主安装/班车/fleet验收仍无角色豁免，规则注入范围不等于宿主验收范围。现有default-enable-policy条件加载不能充当全舰队规则入口。新常驻文件不超过280 Unicode字符，具体操作留runbook。
- 更新 `packages/claude-runner/agents/codex-runner-contract.md` 的窗口要求；Claude Runner 沿用真实 tmux 载体，由统一验收和 Lead runbook 约束。只改源，不改本机 materialized AGENTS。
- 测试新建 `scripts/__tests__/agent-visibility-rules.test.sh`，fixture 运行实际装配器，断言两vendor内部cos/dept/infra实际bundle含规则，companion不增加内部治理文件，external/Anna仍恰好external-agent-contract.md；不只grep源文件。
- 预算：保留FLY-2567的历史rules-inventory.json原始基线（不回写历史观测数字），修改fly2567-rule-budget.test.ts对实际装配的source basename集合与基线求并集，新增文件按baseline 0计全部增量，并验证无未计数新source；现有25%降幅不放宽。新增文件<=280字符，测试命令纳入下列清单。

### B. 只读公共验收

- 新增 `scripts/verify-agent-visibility.sh`、`scripts/lib/agent-visibility.sh`、`scripts/__tests__/agent-visibility.test.sh`；把 §3 接口/状态/输入约束实现为固定 JSON。
- 通用 Codex thread 解析 helper 新建同目录 `agent-tui-binding.ts`，按§3两个生产分支设计，不机械提取旧Raya的单文法。Raya consumer和公共验收读者共用它，Raya仍保留原home/workspace/legacy限制；不改migration授权/账本语义。
- runner lookup 使用参数化只读查询和既有 active status 集；shell wrapper 不把 stdout 再当 shell 执行。若需 TS CLI，新增 `packages/teamlead/src/bin/verify-agent-tui-binding.ts` 输出仅身份 verdict，由 wrapper 调用。
- 把新 shell/helper 加入 `scripts/converge-flywheel-bin.sh` 安装清单和 `scripts/__tests__/flywheel-lead-packaging.test.sh`；确认 `scripts/lib/bounded-run.sh` 在 repo/bin 两种运行位置可解析，缺依赖 fail closed。
- 先于硬门发布测耗时：隔离真实tmux+cmux中测1/17/50 subjects、watcher并发、私有与共享carrier混合的10轮总时长/p95/p99。候选5s子命令/30s单subject/180s install/300s wave仅为测试起点，不作为已测SLA；确认同subject5秒稳定间隔不被deadline压掉、17主体在总预算内能获得至少一次完整探测。若不满足，优先复用批量snapshot和target投影削减工作；根据实测调整有界常量并记录到实施证据，再开启硬门，不能把探测本身太慢当目标缺窗。语义始终失败关闭，不放宽identity/稳定条件。
- 用下列 fixture oracle 起步，先看到失败，再接实现：

```text
loaded job + no pane                => fail missing_window
correct title + wrong exec/thread   => fail identity_mismatch
live private bash + real body child => carrier pass
live private bash + no body child   => fail body_missing
carrier pass + sidebar PASS absent  => visible fail
carrier pass + sidebar inconclusive => visible inconclusive
carrier pass + current attached view=> visible pass
identity changes between samples   => inconclusive identity_drift
window appears for <2s then vanishes => fail/inconclusive, never pass
invalid key / injected shell text  => exit64, zero exec side effect
```

### C. 安装与班车门

- 修改 `scripts/flywheel-lead.sh`，依 §4 接入 install、installed/live；`registered` 不变。修改 `scripts/restart-services.sh` 的两处最终聚合路径，不扩大 kill/bootout 权限。
- 扩展 `scripts/__tests__/flywheel-lead.test.sh`、`scripts/test-restart-services.sh`、`scripts/__tests__/lead-restart-controlled-wave.test.sh`：背景进程但缺窗→install 非零/wave failed；启动延迟后可见→成功；只有 supervisor 换 PID 不能通过；cmux refresh 在验收前；同一失败不重复计；未知不清 retry marker；migration 快捷分支必须验；plugin-only 与 full 路径均覆盖。
- install fixture 记录调用序列，重试失败 install 不创建第二 job；最终验收前身份变化不能通过。保留旧 `registered` 和 FLY-2496 pre-activation 回归。

### D. 巡检统一事实

- 修改 `scripts/lead-patrol-snapshot.sh`、上述 runbook、`scripts/flywheel-cmux-sync.sh:reconcile_v2_lead_workspaces` 的单一fleet核对；扩展 `scripts/__tests__/lead-patrol-snapshot.test.sh` 和 `packages/teamlead/src/bridge/__tests__/lead-patrol-snapshot.test.ts`（仅若 JSON/渲染接口变化），STEP 1–6 schema 不更名。
- fixture fleet名册含healthy/missing/unknown Lead，覆盖每个expected Lead；Department STEP1只含self与owned/unowned/pending Runner范围判定。缺窗口必须仍有行；不capture unowned pane、不扩大STEP2权限。证明N个department tick不会产生N份fleet告警，持续缺窗复用同一lead-attach episode，恢复后下一次缺窗开启新episode。
- 检查 `packages/teamlead/src/lead-capabilities/patrol-schema2.ts`、`patrol-completion-gates.ts` 及 `patrol-artifacts.ts` 对 FINDING/UNAVAILABLE 的消费；报告必须包含缺窗项，未处置 finding 不能被结构化 completion 门误当全部 PASS。沿用现有 pipeline，不增平行告警服务。

### E0. 消灭创建假绿，并修复已复现的瞬死根因（本单范围）

修改 `packages/teamlead/src/lead-backends/codex/tui-window.ts`、`codex-lead-tui-runtime.ts`；新增/扩展 `__tests__/tui-window.test.ts`、`__tests__/codex-lead-tui-runtime.test.ts`、`__tests__/codex-lead-tui-runtime.rotation.test.ts`、`__tests__/capability-tui-runtime.test.ts`（均在同一 codex 目录下）。根据退出证据，只在必要时改 `packages/teamlead/scripts/codex-lead-tui-home.sh` 的已证实连接/daemon readiness 路径，并运行其 `packages/teamlead/scripts/__tests__/codex-lead-tui-home-zombie-reap.test.sh`。

1. 保持同步 `ensureTuiWindow` 的 boolean 为“创建成功”兼容契约，删除它的 `real TUI up` 成功日志，改为 `window_created_unverified`；它不能独自设置可见healthy。`onWindowOwned` 目前用于 `capability-tui-runtime.ts` stop cleanup，必须在创建成功时保留，**不能延迟该 ownership callback 从而泄漏未通过健康检查的窗口**。
2. 在 runtime 新增 per-generation 内存 `pendingVisibility`，绑定当前 thread/socket/carrier generation 和首样本paneId/PID/start；五秒后用异步 timer 复查相同tuple及活模型。不能用 sleep/spawnSync阻塞事件循环。通过才打印 real TUI up、向 alert guard record(true)、向 rotation settleReadiness 传 true；检查未完成/失败均不是healthy。只读公共verifier同样现场采样，不信任这条日志或内存状态。同步改 `startGateway` 中直接以 ownedTuiThreadId+isTuiWindowAlive 调用 settleReadiness 的旁路，以及 rotationFenceHeld 快捷分支；它们必须消费当前generation稳定proof。`residencyLifecycle.online()` 只表示后台收信服务在线，不得据此推导TUI验收成功，两者在报告中分列。
3. pending 时不重复kill/recreate同窗口；失败记录false，由现有20秒恢复节奏处理。stop、thread变更、capability socket变更、rotation fence失效须取消待验timer并使旧回调失效；旧timer不能把新generation判绿或杀它。已拥有且稳定健康的窗口仍按原规则复用。首采样就缺窗和5秒内退出都不能产生healthy回执。
4. 隔离QA session 设置该**测试窗口** `remain-on-exit on`（保留死亡pane）并记录 `pane_dead_status`、开始/结束时间、exact spec与脱敏stderr，复现与真实启动一致的 codex binary/home/workspace/thread/socket 组合，但使用QA凭据/身份和临时目录，绝不把生产凭据复制过去。观察 wrapper shell是否吞掉退出码，确保拿到的是TUI子进程退出状态。只保留本次 bounded test 输出，测试结束按拥有权清理。
5. 用所得错误建立稳定的失败回归：若确认 remote/socket错误，定位 `buildTuiCommand`、home初始化或daemon握手哪个环节实际违反当前运行时契约，然后作最小修复。若是其他错误，以实际证据为准。禁止用“socket文件存在”、清空用户home、自动换账号或headless fallback使测试变绿。这一步是有明确输入/输出的根因诊断任务，不预写未经证实的修复代码。
6. 验收：相同复现夹具修复前TUI 1秒退出，修复后真实同identity存活超过5秒且受控接入可操作；daemon/owner/credential边界不改变。再模拟1秒退出，确认创建日志仍非healthy且可见报告存在。回归callback cleanup、rotation fence、停止过程中timer回调和旧thread窗口。生产三者的最终修复按独立updater窗口执行，不由设计节点操作。

### E. 存量 inventory 和真实负例验收

实现/QA 在授权环境生成一次有时间戳 inventory：registry expected agents ∪ loaded canonical/legacy agent jobs ∪ 可归属长期 agent 进程，反向 join 到唯一 Lead/Runner。只收身份元数据，不保存密钥/消息内容。未知长期模型进程必须列为 unowned/unresolved，而非从总数删除；普通 infra daemon 列明 non-agent。每行含 source、identity、expected/lifecycle、socket/pane、visible verdict、owner、处置 issue、复验回执。

前三个已知异常按 §2 逐项交 Lead；其余经新 inventory 补齐。**本单源码验收与生产迁移验收分开**：源码完成不代表全舰队已切换；实际切换必须走公共安装和既有独立 updater 窗口，Raya 走 FLY-2496，不复制凭据、换身份或手改 registry。迁移后重启一次仍可见、能 attach 的证据由执行迁移的人补齐。未获生产权限则保留明确未验项交 Lead，不能伪报通过。

真实负例在隔离 HOME/state root/tmux socket 的 QA fixture 中起一个后台 Lead 和一个后台 Runner（无 terminal，dummy job/execution 也明确 expected active）。公共 verifier 必须 fail，实际 install/wave fixture 非零或计 failed，真实 snapshot STEP1 保留两行 finding；捕获实际报告/告警 sink 的 receipt，证明不是静默。再建立正确 pane + cmux 测试 view，验证恢复；受控测试 view 由 QA 明确拥有，不触碰生产窗口。截图或现场 attach 记录必须引用 exact execution/Lead、pane、时间，不能只拍一个同名窗口。

### 验证命令与预期

```sh
bash scripts/__tests__/agent-visibility.test.sh
bash scripts/__tests__/agent-visibility-rules.test.sh
bash scripts/__tests__/flywheel-lead.test.sh
bash scripts/__tests__/flywheel-lead-packaging.test.sh
bash scripts/test-restart-services.sh
bash scripts/__tests__/lead-restart-controlled-wave.test.sh
bash scripts/__tests__/lead-patrol-snapshot.test.sh
bash scripts/__tests__/fly2266-cmux-lead-attach-health.test.sh
bash packages/teamlead/scripts/test-verify-windowed-lead.sh
pnpm --filter flywheel-teamlead exec vitest run src/bin/raya-migration-proof.test.ts src/bin/raya-migration-proof-evidence.test.ts src/lead-backends/codex/__tests__/tui-window.test.ts src/lead-backends/codex/__tests__/codex-lead-tui-runtime.test.ts src/lead-backends/codex/__tests__/codex-lead-tui-runtime.rotation.test.ts src/lead-backends/codex/__tests__/capability-tui-runtime.test.ts
bash packages/teamlead/scripts/__tests__/codex-lead-tui-home-zombie-reap.test.sh
pnpm --filter flywheel-teamlead exec vitest run src/__tests__/fly2567-rule-budget.test.ts
pnpm lint
pnpm -r build
```

`flywheel-teamlead` 是当前 package.json 的真实包名；新增单元测试命令须纳入交接。成功要求正例全部通过且上述后台负例实测失败并有报告回执；mock green 不替代 cmux 真实 attach QA。设计阶段未执行这些实现测试。

## 6. 风险、回滚和不做的事

- 可见性门可能使原本“PID 正常”的多名 Lead 变 degraded：这是揭示缺陷，不能改阈值让它绿。先隔离测试/canary，再经 updater 发布；没有默认关闭开关。
- cmux 重启中可能暂时 unavailable：安装/班车有总 deadline，巡检明示；不因读失败无限重启 agent。恢复需当前证据，不能用旧 receipt 自动清缺陷。
- rules 生效按各 vendor 实际装配/下次标准启动，不声称编辑 Markdown 已改变运行中上下文。
- 回滚为正常 reviewed source revert + updater 发布，保留新旧 receipt、标记窗口验收未完成；不能退回 headless 并称合格。数据不迁 schema，无清库回滚。
- 不改模型、账号、exec/thread/activation identity、credential、不重写 cmux topology、不增加新 scheduler、不要求普通守护进程有模型 TUI。

## 7. 要求到证据的完成清单

| 原要求 | 实现完成证据 | 生产完成证据 |
| --- | --- | --- |
| 全 Lead/Runner 默认可见硬规则 | A 的实际 bundle + B 的公共判据 | 每个生产 agent carrier+visible 当前 pass |
| install/restart 不通过=未上线 | C 正负测试 + status/count/report 回执 | 一次授权安装/班车各自 exact identity 的新证据 |
| patrol 每个 Lead 无窗=FINDING | D expected 名册完整性、缺窗行、报告消费 | 当前巡检缺窗被发现并可见报告 |
| 存量逐个标准化，Raya 归2496 | E inventory + 每项 owner/route | 各项独立迁移/复验；本设计不执行 |
| Runner 同口径 | B/D exact exec/pending/dead/phase-held fixtures | active Runner window+view 当前证据 |
| TUI瞬死与创建假绿 | E0退出原因+先红后绿+timer/cleanup回归 | 授权窗口部署后持续可见及接入实证 |
| 后台无终端反例 | E 隔离真实进程 + 拒绝 + alert/report receipt | 不拿生产制造故障；QA受控反例足够证明门 |

设计节点交付：本 plan 有效 reviewVerdict=APPROVED；图示 HTML 含逐节评论、底部复制汇总，提交并 push；静默 publish、托管 HTTP/CSP 检查和 DESIGN-HTML report 后才 `complete --route phase_design_complete`，随后 park。上线/真实迁移完成状态不得在此节点宣称。

## 8. 评审修订记录

R2 `a129ca93-c0f1-485b-ab40-7c695a35563e` 有效CHANGES_REQUESTED：三个HIGH全部核源码后修订。`visibility-barrier-races-async-cmux-refresh` 改为等待subject实际收敛、目标投影隔离无关变化、drift只重试不伪称缺窗；`external-agent-rule-surface-leak` 明确external/companion不注入、宿主验收无豁免；`codex-tui-argv-whitelist-single-grammar` 指定legacy与capability-v2双文法/真实tmux夹具。五项非阻断建议一并明确：单一fleet owner及既有dedup、实际source集合预算、先测时再硬门、caveats失败关闭、唯一角色清单。新一轮有效APPROVED仍是交接前提。

### 实现交接处置（Lead instruction `f49a00be-19a0-49a9-842d-439a4e3c311b`）

| R3 advisory / 补证 | 实现处置 |
| --- | --- |
| `fleet-census-duplicates-existing-roster-check` | 不新增第二套共享 census；expected registry left join 复用 `derive_lead_roster` / `reconcile_lead_roster`，并分别保留 shared `lead-window-missing` 与 private attach 事实/episode，避免重复告警。 |
| `wave-failed-count-conflates-carrier-and-visibility` | 班车结果分列 carrier 与 visibility；回滚/Founder 文案把 `visibility-unproven` 写成可见性未验，不归因为 token/config。 |
| `lead-attach-missing-message-is-private-specific` | `lead-attach-missing` 只描述 private attach；shared carrier 缺窗使用中性 `lead-window-missing` 文案，不声称 private tmux server。 |
| SIGTERM 来源 | `/tmp/flywheel-updater.log` 2026-09-17 12:04:56–12:04:58 PT 已证实为 12:00 PT 定时班车正常 `bootout`/restart，整轮 `scheduled_deployed`；不再列作故障根因。1 秒窗口退出与此无关，E0 仍须隔离复现取退出码。 |

### QA1 返工：tmux TAB 消费者审计（2026-09-18）

QA 在 tmux 3.7c 真机证明：client 同时没有 `TMUX` 和 UTF-8 locale 时，tmux format 中的 TAB 会变成下划线；同一 pane 的可打印 `|` 不变。本次已把 `tui-window.ts` 的 live identity 与 retained-exit 两个生产 reader 一并改为 `|`，并用真实隔离 tmux 在 `env -u TMUX -u LANG -u LC_ALL -u LC_CTYPE` 形状下固定“旧 TAB 失败、新协议通过”的差分。

全仓排除普通 TSV/git 输出后，剩余 tmux-format TAB 消费者如下：

| 消费者 | 分类与本单处置 |
| --- | --- |
| `packages/teamlead/src/LeadWindowLocator.ts` | Claude private socket 的 capture/send 前置探测；不被 Codex Lead runtime 或本单公共可见性 verifier 调用，后者已使用 `|`。未扩展该独立交互路径。 |
| `packages/teamlead/scripts/check-rules-truth.mjs`、`scripts/flywheel-daemon.sh` | 旧 Claude 规则/daemon 诊断；不进入此次失败的 Codex TUI stability/exit reader，也不是新增公共 verifier 的证据源。保留现状，避免把 QA1 修复扩成旧载体协议迁移。 |
| `packages/teamlead/src/bridge/fleet-data.ts` | Bridge fleet 展示快照，不参与 install/restart/patrol 的公共 pass/fail 判据；本单硬门从 `agent-visibility.sh` 的可打印协议取证。 |
| `packages/teamlead/src/account-heal/quota-revive-scan.ts`、`packages/teamlead/src/bridge/patrol-orphan-sweeper.ts`、`packages/teamlead/src/bridge/runner-teardown.ts` | Runner quota/orphan/teardown 路径；Lead 明令本轮不碰 Runner 实现路径，且它们不读取 Codex Lead TUI stability/exit 证据。 |
| `scripts/flywheel-cmux-sync.sh` 的 `read_runner_tmux_*_inventory`、`scripts/lead-patrol-snapshot.sh` | Runner 名册路径；同样按范围锁不改。QA 已证明 active pending Runner 会变红；本轮只把 reason 校准为 `missing_window`。 |
| `scripts/qa-fly-2301-codex-lead-drill.sh` | 历史 QA-only drill，不装入生产载体或验收入口。 |

因此本轮没有把“TAB 在任意未来环境都安全”当作结论；只修复已证实的两处生产 reader，并列出其余独立消费者及未扩面原因。若后续要统一迁移这些旧协议，应另开有各自字段碰撞与真实 socket 回归的变更，不能顺手触碰本轮冻结的 Runner 路径。
