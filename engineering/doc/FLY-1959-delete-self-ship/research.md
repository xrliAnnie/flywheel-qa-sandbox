# FLY-1959 删除老 self-ship 路 — 调研
Issue: FLY-1959 (https://linear.app/geoforge3d/issue/FLY-1959/self-ship净删除-删掉老自-ship-重启路只留定时班车-founder-紧急一张票)
日期: 2026-08-21
基于: exploration.md

## 1. 代码与 live state 证据

### 1.1 仓库现状

以 `main@f4d789396` 为基线：

- `scripts/self-ship-restart.sh` 是普通 merge 的 marker producer；
- `scripts/lib/self-ship-queue.sh` 共 353 行，混合了 enqueue、marker schema、attempt/backoff、blocked/quarantine、ack、due scheduling 与 singleton lock；
- `scripts/update-flywheel.sh` 共 299 行，marker-driven 分支占主要篇幅；
- `.claude/commands/spin.md`、`.claude/commands/orchestrator.md`、`.flywheel/agents/*`、`.lead/flywheel-eng-lead/identity.md` 与 `.flywheel/config.yaml` 都把 post-merge handoff 写成标准路；
- `scripts/restart-services.sh::_self_ship_active` 读取 pending marker，给旧 self-ship 加第二个 idle sample；
- R4 validator、Linux provision spec、package allowlist 与 CI manual-only 清单都硬编码旧目录/旧脚本。

这说明净删除不能只改 plist；producer、consumer、operator prose、packaging 与 tests 必须同一 PR 收敛。

### 1.2 生产只读快照

2026-08-21 只读检查 `launchctl print gui/501/com.flywheel.updater`：live job 已加载、当前不运行、`runs = 0`，但 event trigger 仍精确监视 `/Users/xiaorongli/.flywheel/self-ship-pending.d`；installed plist 同样指向旧目录。`~/.flywheel/self-ship-pending.d` 存在且为空，urgent dir 尚不存在。

这些值会过期，只用于证明 repo 改动必须包含 installed plist 切换说明，不能用作合并后的验收结论。

## 2. launchd 的权威语义

本机 `launchd.plist(5)` 明确：

- `QueueDirectories` 在目录非空期间 keep job alive；它不是一次性的“文件新增事件”；
- `StartCalendarInterval` 可以是多个 dictionary，睡眠期间错过的多个触发会在唤醒时合并为一次；
- `ThrottleInterval` 是 launchd 的 spawn 节流秒数，默认 10 秒；设为 60 即把反复拉起的上限交给 OS。

因此最小正确结构不能是“失败 token 永久留在 watched dir”：确定性失败会每 60 秒重跑全舰 restart，并让分钟粒度 alert signature 绕过去重。Founder 又明确不要 retry receipt/quarantine，所以采用 claim-once：token 在 updater 取得 singleton lock 前保持耐久；取得锁后先校验、再从 watched dir 删除本轮 token，之后只尝试一次 restart。crash 若发生在 claim 前，QueueDirectories 仍会重拉；claim 后的失败不自动重试。唯一的短重试是 claim 前对 `origin/main` 做 `GIT_TERMINAL_PROMPT=0`、单次 20 秒上限的三次 fetch probe（中间各 1 秒）；它没有跨 invocation state，也不重复 deploy。无需 attempts、receipt、blocked/quarantine 或长寿命 sleep loop。

## 3. PR #906 可取与不可取

取消的 FLY-1934 分支提供三块可直接校准的素材：

- plist 将 QueueDirectories 改到 `self-ship-urgent.d`，保留 `00:00/12:00`，增加 `ThrottleInterval=60`；
- `request-restart.sh` 的顺序应是 durable token 在前、不带 `-k` 的 kickstart 在后；
- updater 每 invocation 最多做一次 deploy，当前轮运行中到来的 token 必须留给下一实例。

不能搬的部分不止后期 retry receipt/quarantine：#906 从根上仍保留 ordinary pending marker、per-marker ack/report/backoff/blocked 状态机，所以它不是本单目标的实现基线。FLY-1959 只借触发配置与竞态测试思路，不 cherry-pick 该分支。

## 4. 目标数据流

### 4.1 定时班车

```text
launchd 00:00/12:00
  → update-flywheel.sh
  → fetch origin/main
  → deployed-sha == origin/main ? 结束 : default_deploy 一次
  → restart-services.sh --reason updater
  → 既有单次 founder 播报 + deployed-sha 推进
```

不需要 per-merge 队列。两班之间的所有 merge 自然由 `origin/main` 最新 SHA 聚合成一波。

### 4.2 Founder 紧急票

```text
request-restart.sh
  → 校验 remote origin/main SHA
  → 在 watched dir 外写完整 token，同文件系统原子 publish 到 self-ship-urgent.d
  → launchctl kickstart gui/$UID/com.flywheel.updater（无 -k）

updater
  → 获取 singleton lock
  → snapshot 开场 token 路径
  → 校验 basename + schemaVersion + 40-hex targetSha + targetSha∈origin/main
  → provably-invalid token 从 watched dir 移出且绝不 restart；git 探测 indeterminate 也 claim-once、告警并结束，不留 watched condition
  → 合法 token在 restart前原子 claim到同盘临时目录
  → 本轮有合法 claim 时无条件 default_deploy 一次，成功或失败都不自动重试
```

late token 使用唯一文件名，不在开场 snapshot 中，因此不会被当前 claim。当前 updater 退出后 urgent dir 仍非空，launchd 再启动一轮。若第二实例撞到 singleton lock，它不消费 token并退出，token 继续保持触发条件。

这里不做跨 invocation 的 same-SHA 去重。`request-restart.sh` 是 founder-only 的强制重启入口；当 `deployed-sha` 已等于 `origin/main` 时仍必须生效，因此 `targetSha` 不是幂等键。并发或同一开场 snapshot 内的多张 token 会合并成一次 restart；第一批已经 claim 后才发布的 token 是新的显式人工意图，下一实例可以再 restart，launchd `ThrottleInterval=60` 给出硬节流。这个边界刻意不引入 receipt/ledger。

## 5. 最小实现边界

### 5.1 request-restart.sh

保留现有 bounded remote lookup 与 local `origin/main` fallback。移除对 `self-ship-restart.sh` 的委托，直接提供三个 sourceable helper：

- `rr_updater_loaded` / `rr_updater_enabled`：入票前 fail-close；
- `rr_publish_urgent_token <sha>`：创建 mode 0700 urgent dir；临时文件位于 watched dir 之外、但与它同一个 parent/filesystem，写完最小 JSON（`schemaVersion=1`、`kind=founder-urgent-restart`、`targetSha`、`createdAt`）并 chmod 600 后，以唯一 `.urgent.json` basename 原子 `mv` 进入 watched dir；
- `rr_kickstart_updater`：不带 `-k`。

dry-run 不创建目录/token、不 kickstart。

被删 library 的默认值必须显式移交给 survivors，而不能依赖调用环境：producer 与 consumer 都解析 `${HOME}/.flywheel` 和由它派生的 `self-ship-urgent.d`；producer 另定义 `SELF_SHIP_LAUNCHCTL="${SELF_SHIP_LAUNCHCTL:-launchctl}"`、`SELF_SHIP_UPDATER_LABEL="${SELF_SHIP_UPDATER_LABEL:-com.flywheel.updater}"`；consumer 另派生 `self-ship-updater.lock.d`。production canonical root 是 updater 启动时捕获的 `${HOME}/.flywheel`：macOS plist 的绝对 watched path、producer、consumer 与 rollout 必须解析到同一路径，即使 `.env` 带有同名变量也不能改写；Linux provision 以其 canonical `$st` 渲染同名 `self-ship-urgent.d`。`FLYWHEEL_HOME` / `SELF_SHIP_*_DIR` override 只作为 source harness seam。

### 5.2 update-flywheel.sh

删除 queue library source、marker report/ack/backoff/loop。把必要的 singleton lock缩成 updater 私有实现，但保留旧 lock 的两条安全不变量：活 PID 只有在 `ps -o command=` 可读且身份明确不匹配时才可按 PID reuse 回收；活但不可探测时绝不回收。死 PID 的 stale lock可回收；只有 owner 删除自己的 lock。

每次 invocation 仍先做 FLY-954 bin convergence 与 FLY-1814 launchd convergence/census。随后 snapshot urgent files：

- snapshot 非空：先严格校验。schema/basename/kind 错，或成功 fetch 后能确证 target 不在 `origin/main`，属于 provably-invalid，逐 token 以唯一 basename signature 告警并移出 watched dir，不触发 restart；fetch先走三次无状态有界 probe，全部失败或后续 git probe失败才属于 indeterminate，也把该票 claim 到本轮临时目录、逐票告警、不 deploy并返回非零，从而保持 at-most-once 且不让 `QueueDirectories` 每分钟重拉；bounded runner缺失以独立 rc/signature fail-fast，不伪装成网络错误；合法 token随后在 restart 前原子 claim（移动到 watched dir 外的本轮临时目录），并强制 deploy一次；deploy再次 bounded fetch后冻结 `origin/main` SHA，再做纯本地、不受网络 timeout强杀的 `merge --ff-only`。claim 目录不是 receipt/quarantine，随本轮 trap 删除；
- snapshot 为空：fetch 后只比较 `deployed-sha` 与 `origin/main`；落后才 deploy 一次；
- deploy 非零：urgent route 对每个已 claim token 用 `urgent-deploy-failed-<token-basename>`，使同票重复调用永久去重、不同票仍可见；scheduled route 用 `scheduled-deploy-failed-<UTC-YYYYMMDD>`，使持续故障每天重报一次。随后返回非零；合法 token 已 claim，不自动 retry。

claim 目录必须用字面模板 `mktemp -d "${FLYWHEEL_HOME}/.urgent-claim.XXXXXX"`，保证和 `${FLYWHEEL_HOME}/self-ship-urgent.d` 同设备；harness 直接比较两者 device id。cleanup trap 记录本轮是否完成：已 claim 但未走到 deploy complete、且尚未发过失败告警时，对每张票补发同一 basename signature 的告警，覆盖正常异常退出与 SIGTERM/INT。SIGKILL、宿主 panic、断电不能运行 trap，这个 at-most-once 缺口不做 ledger 修补，由 rollout 明示需要 founder 重新投票。

同盘还不够：claim目录不得落在 `$FLYWHEEL_DIR` checkout 内，否则 `default_deploy` 的 clean-worktree preflight 会确定性拒绝每张急票。harness 必须在真实 git fixture上断言 claim前后 `git -C "$FLYWHEEL_DIR" status --porcelain` 都为空。

consumer只接受固定 `.urgent.json` basename、最小 JSON schema和已在 `origin/main` 的 40-hex target。其他文件绝不等于 founder intent，原子移出 watched dir并按 basename告警；探测不确定时同样 claim-once、告警并丢弃，不创建 retry ledger 或隔离仓。真正的 founder authorization 仍由 `founder-only-authority.md` 与入口纪律约束，token validation 负责阻止 junk/foreign target 变成全舰 restart。

## 6. 活文档与护栏同步

- ship / orchestrator：删除 post-merge restart handoff；明确 merge 终态与 deployment 解耦；
- engineer/general runner contract、Lead identity/config：删除 Method B 与 blast-radius “merge 自动重启”说法；
- founder-only-authority R4：只承认 schedule 与 founder `request-restart.sh` 两个来源，删 post-ship exemption；
- FLY-913 hook deny reason：把 `request-restart.sh` 标为 founder 紧急票，不再提示 “self-ship 走既有 ship flow”；
- restart-guard runbook：统一写成“merge 永不即时重启”；
- R4/provision/plist：watched dir 只允许 urgent；
- `engineering/doc/FLY-1959-delete-self-ship/rollout.md`：明确 cutover 为先创建 mode 0700 urgent dir，再 `bootout → staged atomic plist install → bootstrap`，最后用 live `launchctl print` 验证；
- `CLAUDE.md`：增加 FLY-1959 里程碑并修正 FLY-1671 旧描述。

## 7. 风险与控制

| 风险 | 控制 |
| --- | --- |
| request 在 updater 已运行时到达 | token 先于 kickstart落盘；snapshot只删开场 token，晚到 token留给下一实例 |
| 同 SHA 连续紧急请求造成不清楚的去重 | 同一 snapshot 合并一次；claim 后的新请求明确定义为新的 founder intent，允许下一轮再重启；不用 targetSha 去重而破坏“已是最新代码也要重启”的紧急语义 |
| updater crash 后锁残留 | lock记录 PID，owner 已死才回收 |
| urgent deploy 失败导致热拉 | token 在 restart 前 claim，失败不留 watched condition、不自动 retry；token-basename signature 防同票重复告警 |
| 同一稳定 signature 永久吞掉后续事故 | urgent signature按唯一票 basename；scheduled signature按 UTC 日；同一事件去重，新的票/新的一天仍告警 |
| git 探测暂时失败被误判 foreign | 三态校验；indeterminate token不当作 foreign、也不 deploy，但 claim-once并明确告警，避免 watched condition 永久热拉；founder按告警决定是否重投 |
| 单次网络抖动烧掉 founder 紧急票 | claim 前的 fetch 使用 `bounded-run`，每次20秒上限、最多3次、两次1秒间隔且禁交互；全部失败才消费并告警，不引入跨轮重试状态 |
| bounded runner缺失或 deploy远端调用挂死 | runner不存在时 rc127 fail-fast并用独立 signature点名路径；validation/deploy fetch走同一 noninteractive 20秒边界，随后仅对冻结SHA做本地 fast-forward merge，既不无限等网络也不让 timeout SIGKILL worktree mutation |
| handled updater rc被 census误判 `live_failure` | `units.manifest` 明确允许 `0,1,2,3,127,130`；这些路径已有逐票/每日 severe告警，census不再重复制造持久 daemon anomaly |
| filesystem 导致 token 无法 claim | fail-close且不执行同批合法票；该 entry 是唯一可能继续 re-arm `QueueDirectories` 的残余，runbook要求看到 `claim-failed` 后先修正/移除该精确 entry，不盲目重投 |
| claim 后 updater 异常退出 | trap 对可捕获异常补票据唯一告警；SIGKILL/panic/断电可能静默丢票，rollout要求未观察到完成时 founder重新投票 |
| watched dir 在 bootstrap 时不存在 | request/updater 都会 `mkdir -p` + chmod 700；rollout/R4 在 bootstrap 前硬断言目录存在、owner/mode正确 |
| scheduled fetch 失败 | 不执行 restart，不推进 deployed-sha，返回非零并发一次告警；下班重试 |
| installed plist 仍看旧 inode | rollout/QA 明确 bootout → 原子安装 → bootstrap，并以 live `launchctl print` 验 trigger |
| 删除 marker-side `report_deployment` 影响 digest | `restart-services.sh::record_deployed_range` 已按 `OLD..NEW` 逐 commit 发送 `fallback-git-log` 事件并以相同 merge SHA 去重；保留 `restart-deployed-range.test.sh` 正向证据，无事件覆盖缺口。因 authoritative producer 一并删除，未来 daily digest 会把这些事件标为 `inferred`；该 job 当前为 `hold`，若 founder 将来 opt-in，需另行决定是否需要新的 authoritative source |

## 8. 会过期的结论

| 结论 | as-of | 重核命令 |
| --- | --- | --- |
| live updater 当前 `runs=0` 且监视 pending | 2026-08-21 08:xxZ | `launchctl print gui/$(id -u)/com.flywheel.updater` |
| installed plist 仍指向 pending | 2026-08-21 | `plutil -p "$HOME/Library/LaunchAgents/com.flywheel.updater.plist"` |
| pending dir 存在且空，urgent dir不存在 | 2026-08-21 | `find "$HOME/.flywheel/self-ship-pending.d" -mindepth 1 -maxdepth 1 -print; ls -ld "$HOME/.flywheel/self-ship-urgent.d"` |
| main 基线仍有旧 producer/consumer | `f4d789396` | `git grep -n 'self-ship-pending\|self-ship-restart' f4d789396 -- ':!engineering/doc/**' ':!doc/**/archive/**'` |
| PR #906 仍保留普通 marker | `1cee797ab` | `git show 1cee797ab:scripts/self-ship-restart.sh; git show 1cee797ab:scripts/update-flywheel.sh` |
