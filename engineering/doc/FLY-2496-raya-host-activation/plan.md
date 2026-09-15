# FLY-2496 Raya 宿主激活 — 实施计划
Issue: FLY-2496 (https://linear.app/geoforge3d/issue/FLY-2496/raya宿主激活-生产-raya-卡在旧壳-0f77e977班车判-host-capability-absent缺)
日期: 2026-09-13
基于: research.md

状态：v5（R1 10 条、R2 6 条、R3 3 条、R4 3 条 findings 全部处置，见 §11 与 review.md；R4 为 Lead 授权的确认轮，仍非 APPROVED，按 Lead 裁定走 leadAcceptance：两条阻断级已修入本版，一条经源码实核驳回，不开 R5）。本节点只设计；不实现、不部署、不申请 ship。Lead 裁定（问题 `02cdabc6-e34f-4614-af54-12171c574c71`）：A 人手只 register 不 install；B 账本缺席时班车每班一行 info、账本携带 founder 授权字段、proof 工具 source-only；C `import-cos-context` 移出关键路径。

## 1. Founder 视角

今天 Raya 还在 9 月 6 日那个"自带小脑"的旧壳里跑，班车每天两次看一眼、发现宿主上没有"标准 Lead 的身份证"（canonical manifest，一份描述"raya 这个 Lead 属于哪个项目、用什么后端"的 JSON）就跳过。本计划让你**授权一次**（一条固定格式的 Discord 消息），然后 Lead 在宿主做四件不改变"谁在回 #raya"的准备（注册身份、建工作区、接 Codex 账号、写一份迁移账本），再由班车按已经合入的 P0–P7 事务，在凌晨那班**先把代码构建好、把探针能力验证好、确认 #raya 已经安静了 15 分钟、把所有能提前做的都做完，才**停旧壳、起新 Lead，并自己发一条探针证明停机窗口没丢信；第二班核对证据后写下 v2 回执。旧 Raya 没有留下"哪条消息处理过"的账，所以我们不猜：频道不安静就等下一班；更早的历史由你的授权明确划为不补录范围。验收只认那份回执和 `flywheel-lead.sh verify`；"Raya 真的读了一张 summary PR"是回执之后的独立观察项。

```mermaid
sequenceDiagram
  autonumber
  participant F as founder
  participant L as Lead(宿主)
  participant B as Bridge/全舰
  participant S as 班车 updater
  participant R as 新 Raya Lead
  F->>L: 一条固定格式授权消息(含 baseline 令牌)
  L->>L: H1 工作区/Codex home
  L->>B: H2 register raya(projects.json+manifest)
  L->>S: H2 request-restart.sh(紧急票)
  S->>B: 全舰重启, Bridge 认得 raya, 17 席 digest
  L->>L: H3 账本工具 init(核授权令牌行、nudge 202、两份旧 plist、探针 bot 真能发)
  S->>S: 班车 N pre-stop: 目标 SHA→scratch build→探针能力→频道安静 15 分钟→ff→复验
  S->>S: 班车 N P2: 停旧壳(逐 job, ms 时间戳)→晋升候选产物
  S->>R: P3 探针(intent 先落账本)→停机窗口无人类消息→seed; P4b install; P5
  L->>R: H4 文字探针; 等一个 6h summary 轮; proof 工具 collect
  S->>S: 班车 N+1: (Flywheel 漂移则自动 rebind, activation 不变) P6 校验→P7 v2 receipt
  L->>F: 报告: receipt v2 + verify live; 之后观察 summary 读收据
```

## 2. Gate、顺序与发布单位

1. 本节点：exploration/research/plan + 设计评审 effective APPROVED + founder HTML 发布与报告 → `phase_design_complete`。不请求 ship。
2. 实现节点：一个 Flywheel PR（§5 六个批次，全部 source-only，随正常班车部署）。**PR 合入且 `~/.flywheel/deployed-sha` 到达含它的 SHA 之前，不得开始 §4 任何人手步骤**。
3. 生产激活（§4）由 Lead 在 founder 授权后执行，QA 节点只验证工具在隔离夹具里的行为和 dry-run。
4. 验收（§8）由独立 QA 读回执/CommDB/Discord 核，不由执行者自证。

## 3. 身份与唯一真相（继承 FLY-2445 plan §3，本单不改）

`raya / raya / raya-raya`；`codex-app-server` / `full-access` / 可见 TUI；工作区 `~/Dev/raya-lead-workspace`；Codex home `~/.codex-raya`；`projects.json` 是唯一身份源，`manifests/raya-raya.json` 只是投影；job `com.flywheel.lead.raya-raya`；bot 与 #raya 不变，token 只按 `RAYA_BOT_TOKEN` 名解析；mailbox `comm/raya/comm.db`。本单新增的文件都在 `~/.flywheel/raya/migrations/FLY-2445-standard-lead/`，0600，只存元信息与 id，不存 token。founder 身份只经公共 `resolveFounderId`（`packages/flywheel-comm/src/founder-attribution.ts:118`）解析，两个 identity env 冲突即 fail-closed。**activation** = 账本 P4b→P5 写下的激活事务（`activation_id = "<migration_id>:<activated_at>"`），不绑定进程 PID；标准 Lead 因 Flywheel 全舰重启换代是正常生命周期，不改变 activation。

## 4. 宿主激活包（人手步骤，按顺序，每步有停止线）

约定：命令由 Lead 在宿主执行；`FW_RAYA_BOT_ID`、`FW_RAYA_CHANNEL` 来自经核验的现有身份与频道；`FW_PROBE_BOT_ENV` 是一枚**非 Raya、非 founder** 的现有 bot token 环境变量名（建议 `FLYWHEEL_ALERT_DISPATCH_BOT_TOKEN`），其 bot 必须**同时**能读 #flywheel-engineer 和在 #raya 发言（H3 实测）；`FW_TARGET_RAYA_SHA` 固定为 `9d63a2b2e6736bcdd5e699945b3bf8655c06c5e9`（Raya main 又前移则先审阅新头再改此值并重跑 H3）。

### H0 授权与冻结（founder）

founder 在 #flywheel-engineer 发**一条**消息，正文必须含下面这一行（机器逐 token 匹配，其余文字随意）：

```
FLY-2496 AUTHORIZE register cutover=9d63a2b2 urgent-restart baseline=quiet15m
```

- `cutover=<sha8>` 必须等于 `FW_TARGET_RAYA_SHA` 前 8 位；三项 scope 固定且齐全；`baseline=quiet15m` 是 founder 对历史基线的明确声明：切换只在 #raya 已安静 15 分钟时进行，更早的历史不在本次补录范围（FLY-2445 §6.2 的"明确历史基线"路径，以 founder 授权替代"证明旧入口未运行"，因为旧壳没有任何可机读的处理记录，research §4）。缺任一 token、或作者不是 `resolveFounderId` 解出的 founder → H3 拒绝。
- 冻结窗从 H2 到 P7：不注册/注销任何 Lead，不跑 `summary-registry migrate`，不改 `manifests/raya-raya.json`。Flywheel 自身部署**不**冻结（班车 N+1 自动 rebind）。

### H1 工作区与 Codex home（不改变任何运行中的东西）

> **FLY-2559 修正**：保留原 H1/H2 记录，执行顺序修正为：先准备工作区和 standalone Codex home，再执行 H2 的 register；在 register 成功、canonical manifest 与 projects.json 一致后，才执行下面 H1 中的两条 `--lead raya/raya` link-truth 命令；之后再 verify registered / 后续安装。未注册的 Lead 不具备 pre-install authority。退役 Raya wrapper 不再授权，标准 carrier 为 `flywheel-lead.sh`。此修正不增加重启、安装或部署授权。


```bash
set -euo pipefail; umask 077
W="$HOME/Dev/raya-lead-workspace"; M="$HOME/.flywheel/raya/memory"
install -d -m 700 "$W" "$W/.lead/raya" "$W/state"
if [ -n "$(git -C "$M" status --porcelain)" ]; then
  git -C "$M" add -A && git -C "$M" commit -m "chore: checkpoint before FLY-2496 migration"
fi
[ -z "$(git -C "$M" status --porcelain)" ]
git clone --quiet "$M" "$W/memory"
[ "$(git -C "$M" rev-parse HEAD)" = "$(git -C "$W/memory" rev-parse HEAD)" ]
[ "$(git -C "$M" rev-parse 'HEAD^{tree}')" = "$(git -C "$W/memory" rev-parse 'HEAD^{tree}')" ]
git -C "$HOME/.flywheel/raya/code" fetch --quiet origin
git -C "$HOME/.flywheel/raya/code" show "$FW_TARGET_RAYA_SHA:.lead/raya/identity.md" > "$W/.lead/raya/identity.md"
install -d -m 700 "$HOME/.codex-raya"
CODEX_HOME="$HOME/.codex-raya" CODEX_INSTALL_DIR="$HOME/.codex-raya/.local/bin" sh -c 'curl -fsSL https://chatgpt.com/codex/install.sh | sh'
[ "$("$HOME/.codex-raya/packages/standalone/current/codex" --version)" = "$("$HOME/.codex-mufasa/packages/standalone/current/codex" --version)" ]
bash "$HOME/Dev/flywheel/scripts/codex-home-link-truth.sh" --lead raya/raya "$HOME/.codex-raya"
bash "$HOME/Dev/flywheel/scripts/codex-home-link-truth.sh" --inspect --lead raya/raya "$HOME/.codex-raya" | jq -e '.state=="already"'
```

- 停止线：任一断言失败、`link-truth` 不是 `already`、`$W` 与 `~/.flywheel`/Codex home 有重叠 → 停。

### H2 register + 紧急重启（同一个 5 分钟窗）

```bash
REG=( --project-name raya --project-root "$HOME/Dev/raya-lead-workspace"
  --project-repo xrliAnnie/raya --general-channel "$FW_RAYA_CHANNEL"
  --lead-id raya --chat-channel "$FW_RAYA_CHANNEL"
  --bot-token-env RAYA_BOT_TOKEN --bot-user-id "$FW_RAYA_BOT_ID"
  --harness codex --model gpt-6-astra --effort xhigh
  --model-context-window 1050000 --summary-role recipient
  --can-spawn-runners false
  --alert-channel "$FW_RAYA_CHANNEL" --alert-bot-token-env RAYA_BOT_TOKEN
  --alert-fallback-to-core false )
"$HOME/.flywheel/bin/flywheel-lead.sh" register "${REG[@]}" --dry-run
"$HOME/.flywheel/bin/flywheel-lead.sh" register "${REG[@]}"
"$HOME/.flywheel/bin/flywheel-lead.sh" verify --stage registered "$HOME/.flywheel/manifests/raya-raya.json"
bash "$HOME/Dev/flywheel/scripts/request-restart.sh"
"$HOME/.flywheel/bin/flywheel-lead.sh" verify --stage installed "$HOME/.flywheel/manifests/raya-raya.json"
```

- 期望：register 打印 `effectiveAt:"next-bridge-restart"`；紧急重启日志里 raya 被记为 `pending-install`（§5 D）、`failed:0`；`verify --stage installed` 返回 0（nudge 202）；16 席正常。
- 停止线：register 非零、重启 `failed>0`、nudge 非 202 → 停在此报 Lead/founder，**不写账本**。
- 时间：建议 23:00–23:20 PT，紧接 00:00 PT 班车。

### H3 迁移账本（授权落盘）

```bash
node "$HOME/Dev/flywheel/packages/teamlead/dist/bin/raya-migration-manifest.js" init \
  --target-raya-sha "$FW_TARGET_RAYA_SHA" \
  --authorization-message-id <H0 消息 id> --authorization-channel-id <H0 频道 id> \
  --probe-bot-token-env "$FW_PROBE_BOT_ENV" [--dry-run]
```

工具做的事（fail-closed，任一失败不写文件，只打印失败项**名称**）：

1. canonical manifest 有效；projects.json 恰一行 raya 且 `botUserId==FW_RAYA_BOT_ID`；`POST /api/lead-inbox/nudge` 202。
2. Bridge env 文件里的 `RAYA_BOT_TOKEN` 在进程内 `GET /users/@me`，id 等于 botUserId。
3. **授权消息核验**：用 `FW_PROBE_BOT_ENV` 读 `GET /channels/<auth channel>/messages/<id>`；作者 == `resolveFounderId`；正文含 §H0 那一行（五个 token 齐全、`cutover=` == `target_raya_sha[0:8]`、`baseline=quiet15m`）；记 `content_sha256`。
4. **两份旧 plist 全量核验**（brain、voice 各以 `raya_legacy_plist_matches` 同款规则），记录各自 `launchctl print` 的 loaded/pid/start 到 `legacy_owner[]`。
5. **探针 bot 真能发**：先 CAS 写 `precheck.intent`（nonce），再 POST `[FLY-2496 pre-check <nonce>] 激活前发信能力检查，可忽略。`；崩溃重跑先按 nonce 回找再决定是否重发；成功写 `window_probe.precheck_message_id`。
6. `stateDir` 由 `codex-lead.sh --print-state-dir raya raya` 解出，`inbound-cursor.json` 不存在；账本目录不存在（存在 → 拒绝，除非 `--resume-from-failed` 且 checkpoint P2 且 `legacy_owner[]` 无 `stopped_at_ms`）。
7. 写 §6.1 账本（0600，tmp+fsync+rename）。

### 班车 N（自动，00:00 PT）

按 §5 A/B：pre-stop 全过（含"#raya 最近 15 分钟无人类消息"）→ ff → 复验 → P2 停旧壳 → 晋升候选产物 → P3 探针与停机窗口检查 → P4b install → P5；回执 `refused / p5-awaiting-real-p6-evidence`。

- `prestop-failed`（含 `channel-active`：15 分钟内有人类消息）：旧壳与主 checkout 零变更；下一班自动重试。
- 停在 P3 `unresolved` 非空（停机窗口 [T0,T1] 内出现人类消息、探针投递不明）：新 Lead 未装；Lead 按 §7 对账后 `resolve`，下一班续。
- 其他 P2 之后的失败：**不要**重启旧壳（§7）；账本可续。

### H4 取证与 proof

1. 用 `FW_PROBE_BOT_ENV`（或 founder 在 #raya 正常说话）发一条文字，记 messageId；等 Raya 回复。
2. 等到下一个 6h 边界后（`summary_absorption_round` delivered 是 **P6 门**的一项，`raya_p6_evidence_valid:352-354`）。
3. `node …/dist/bin/raya-migration-proof.js collect --text-message-id <id> [--dry-run]`：先取 Raya deploy lock（与班车同一 `deploy.lock.d` 协议，`raya_lock_acquire` 同语义），按 research §1.5 逐字段取证写 `proof.json`（0600），释放锁；缺任一字段拒写并列出缺项；若账本 `flywheel_deployed_sha` ≠ 当前 `~/.flywheel/deployed-sha`，拒绝并提示"等下一班自动 rebind 后再 collect"。

### 班车 N+1（自动）

- **自动 rebind**（§5 A(4)）：若 Flywheel 在 N 之后发布过，班车在持锁下核 `~/.flywheel/leads-restart-status.json`（`schemaVersion==1`、`codeDeployedSha == 当前 deployed-sha`、`leadsRestartStatus=="healthy"`、`failed==0`、`skipped==0`、`total==17`、`recordedAt` 晚于账本 `activated_at` 与上次 rebind）、Bridge `/health.buildSha == 当前 deployed-sha`、`verify --stage live` 通过、Raya 当前 `process_started_at` 早于 `recordedAt` 且晚于上次绑定时刻。**写入顺序（crash-resumable）**：① 同锁内先把旧 `proof.json`（如有）原子 rename 为 `proof.stale-<ts>.json`；② 再**一次** CAS 同时写 `flywheel_deployed_sha`、追加 `flywheel_rebinds[]`、checkpoint 回到/保持 P5、清空 `lead/checks/cutover` 中 proof 派生字段。①后②前崩溃：账本仍漂移，下一班重新进入 rebind（quarantine 幂等）；②之后不存在可被误读的旧 proof。状态 `awaiting_rebind_proof`（refused 回执，非 severe）。**activation 不变**（§3），窗口证据仍属同一 activation；Lead 只需重跑 H4.3（proof 工具重新采集当前进程字段与最新 summary 轮）。
- 无漂移：P6→P7，回执 `outcome=deployed`、`schemaVersion 2`、`carrier standard-lead`、`deployed_sha=FW_TARGET_RAYA_SHA`、`flywheel_deployed_sha=<账本值>`；`deployed-sha` 前移。

### 激活后观察（P7 之后，独立于回执）

P7 后的第一个 6h 边界：若当轮有 open summary PR，至少一张被 `flywheel-comm summary merge` 合并，merge receipt（`summary-pr-merge.ts:48-59`）`roundId` 等于该轮 roundId 且 `ts` 晚于 `delivered_at`；若当轮没有候选 PR，记 `no-candidate`（可审计，不算失败，也不反向影响 P7）。当前 receipt 没有 actor 字段，**只能证明"Raya 轮次触发并留下 roundId 绑定的 merge 回执"，不能证明 GitHub actor 是 Raya bot**（follow-up 2）。

## 5. Flywheel 代码增量（一个 PR，六批，先写失败用例）

| 批 | 文件 | 行为 | RED → GREEN 判据 |
|---|---|---|---|
| A 账本缺席 / 授权围栏 / 逐 job quiesce / 自动 rebind | `scripts/lib/updater-raya-deploy.sh`；`scripts/__tests__/updater-raya-deploy.test.sh`、`update-flywheel-sources.test.sh` | (1) host_capable 真但 `raya_manifest_base_valid` 假 → 只设 `RAYA_DEPLOY_STATE=not_configured`、`DETAIL=migration-ledger-absent` 后 return；pass 内不打日志（外层 `update-flywheel.sh:727` 是唯一一行）、不拿锁、不写回执、不告警。(2) pass 入口无条件 `unset RAYA_MIGRATION_ALLOW_LEGACY_STOP`；只在 quiesce 子调用内、且账本 `.authorization` 完整（`legacy_stop==true`、`granted_by=="founder"`、`evidence_{message,channel,author}_id`、`content_sha256`、`canonical_line` 五 token 与 `cutover=` == `target_raya_sha[0:8]`）时置 1；生产路径不读任何其他 `*_ALLOW_LEGACY_STOP` 变量，测试用完整账本 fixture + stub `launchctl`。(3) quiesce 逐 job 记账 `legacy_owner[]`，先记 `stop_started_at_ms`（node `Date.now()`），bootout 后记 `stopped_at_ms`；"plist 匹配且 `launchctl print` 已失败"视为已完成不再 bootout；两者都有 `stopped_at_ms` 才写 `old_stopped_at`。(4) checkpoint ∈ {P5,P6} 且 `flywheel_deployed_sha` ≠ 当前 → 持锁按 §4 班车 N+1 的谓词自动 rebind（activation 不变；先 quarantine 旧 proof，再单次 CAS 写账本）；谓词不满足 → `awaiting_rebind`（非 severe，refused 回执）而非 `source-prepare-failed` | 现有 31 例不变；新增：账本缺 → 零 lock/receipt/alert 且 scheduled wake 完整输出里 `migration-ledger-absent` 恰一次；caller 预设 env=1 + 账本缺/字段缺/作者非 founder/`cutover=` 不符/scope 或 baseline token 缺 → 零 bootout；brain 停后 voice 失败 → 下一班不再 bootout brain；Flywheel 漂移 + 健康 restart-status → rebind、旧 proof 改名、activation 字段不变、无 severe；漂移但 status 非 healthy/`total≠17`/进程早于上次绑定 → `awaiting_rebind` 无 severe；deploy-before-proof / proof 已写后 deploy / P6 后 crash 再 rebind 三条路径各断言证据归属同一 activation；rebind 自身三处 crash-injection（quarantine 前、quarantine 后账本 CAS 前、账本 CAS 后）恢复结果均为 `awaiting_rebind_proof` 且零 severe、零 `proof-invalid`；P7 后漂移仍走既有 followup 事务 |
| B pre-stop 前置 + 候选晋升 + P3 探针/停机窗口/seed | `updater-raya-deploy.sh`：新增 `raya_prestop_prepare`、`raya_promote_candidate`、`raya_emit_window_probe`、`raya_compute_seed_boundary`；`raya_materialize_business` 改为从候选目录读 | **pre-stop**（任一失败 → `prestop-failed`，旧壳零变更；ff 之前主 checkout 也零变更）按序：账本 `target_raya_sha`；fetch → `origin/main == target`；`merge-base --is-ancestor HEAD target`；scratch worktree `$RAYA_HOME/build-check/<target>`（`git worktree add --detach`）`pnpm install --frozen-lockfile && pnpm build`（bounded），验证 `packages/cos/dist`、`.lead/raya/identity.md`，算 artifact/persona digest（== 工作区占位 digest）；两份 legacy plist 再核一次；**当场发信能力**：CAS 写 `prestop_probe.intent{nonce}` 后 POST `[FLY-2496 prestop-check <nonce>] 班车切换前检查，可忽略。`（重跑先按 nonce 回找）；**频道安静检查**：`GET …/messages?limit=100` 回看并分页直到最老一条早于 15 分钟前（≤5 页，否则 fail-closed `channel-active`），最近 15 分钟（按 snowflake 毫秒）内存在非 bot 消息 → `prestop-failed channel-active`；**最后一个可逆步骤**：主 checkout `git merge --ff-only <target>`（失败 → prestop-failed，旧壳仍活）；随后立即复验 `HEAD==target`、候选 digest、两份 legacy owner identity、频道仍安静 → 才进入 quiesce。**P2**：quiesce（A(3)）→ `raya_promote_candidate`：从 scratch 目录物化到 `<workspace>/.flywheel-managed/versions/<target>`，digest 必须等于 pre-stop 算好的值；quiesce 后**没有**任何 install/build/ff。**P3 探针幂等**：CAS 写 `cutover_probe.intent{nonce,at}` → POST `[FLY-2445 cutover window probe <nonce>] Raya，请回复一句确认收到。`；恢复时从 `snowflake(intent.at − 60s)` 用 `after=` 向前分页（≤10 页），找到同 nonce+探针 bot 即复用；页数耗尽/403/timeout → `unresolved[]{reason:"probe_delivery_ambiguous"}` 停，绝不重发。**停机窗口检查与 seed**（不做任何"已处理"推断）：T0=`min(legacy_owner[].stop_started_at_ms)`，T1=`max(stopped_at_ms)`；回看探针之前的消息（≤5 页，耗尽 → `unresolved{reason:"lookback_exhausted"}`）：时间 ∈ [T0, T1] 的非 bot 消息 → `unresolved[]{message_id, reason:"stop-window"}` 停，不写 seed；`[T0−15min, T0)` 内出现非 bot 消息 → 与 pre-stop 的 `channel-active` 矛盾，记 `unresolved{reason:"quiet-window-violated"}` 停；否则 seed 边界 **`B_final`** 按下式确定：`B0` = 时间 < T0 的最后一条消息（任意作者，通常是旧壳或 pre-check 的 bot 消息）；若无 stop-window 条目，`B_final = B0`；若有 stop-window 条目且全部已 `resolve`，按 snowflake 升序校验 resolutions 必须是"零个或多个 `confirmed_processed`/`side_effect_reconciled` 组成的前缀 + 零个或多个 `confirmed_unprocessed` 组成的后缀"（任何 processed 出现在 unprocessed 之后 → 拒绝，停在 P3）；存在 unprocessed 时 `B_final` = 最早 unprocessed 之前的最后一条频道消息；全部 processed 时 `B_final` = T1 之前的最后一条消息。账本记 `cutover_probe.boundary_message_id = B_final`。频道无消息 → `emptyChannels`。写 §6.2 seed（`lastConfirmedMessageId = B_final`），走既有 seed 工具。账本记 `baseline:{kind:"quiet15m", authorized_by_line:true, before_ms:T0}` | fake curl 夹具：`origin/main ≠ target`、scratch build 失败、prestop POST 403、15 分钟内有人类消息、ff 失败、ff 后 HEAD 漂移/checkout 变脏 → 全部 `prestop-failed` 且两旧 job 仍活；POST 成功后崩溃 → 重跑找到同 nonce 不重发；51+/500+ 条、分页 403 → 零第二次 POST 且 `probe_delivery_ambiguous`；[T0,T1] 内人类消息 → `stop-window` unresolved、无 seed、无 install；同毫秒边界；无关 bot 消息不算人类消息；产出 seed JSON 交给**真实** `seed-lead-inbound-cursor.js` 通过，三例：processed-only（`B_final` = T1 前最后一条）、processed→unprocessed（`B_final` = 最早 unprocessed 前一条）、unprocessed→processed（拒绝）；seed 文件 0600 且 `B_final` < probe id；真实 0f77e977→9d63a2b2 删除布局下 ff 后 `raya_legacy_plist_matches` 仍通过（它对 cli 路径只做字符串比较，`isfile` 检查的是 node 二进制），且 plist/PID/start 任一漂移零 bootout；quiesce 后零 `pnpm`/`git merge` 调用（argv 记录断言） |
| C 账本工具 | 新增 `packages/teamlead/src/bin/raya-migration-manifest.ts`（+ `.test.ts`）；打包清单确认 dist/bin 覆盖 | §4 H3 全部检查；`init` / `--dry-run` / `--resume-from-failed`；`resolve --message-id <id> --as confirmed_processed\|confirmed_unprocessed\|side_effect_reconciled --evidence <text>`（只针对 `stop-window` 条目；写不可变 `resolutions[]`；前缀/后缀规则与 `B_final` 计算见 §5 B：processed 必须构成前缀、unprocessed 必须构成后缀，交错即拒绝并要求先人工完成较早缺口）；`resolve --as lookback_confirmed --boundary-message-id <id> --evidence`、`--as probe_message-id <id>`、`--as probe_not_delivered --evidence`（intent 落盘后 POST 前崩溃且回找为空的显式终止/重发授权路径）；Discord/Bridge 调用经注入 fetch；输出无 token | 每个前置的负向用例各一（作者非 founder、`FLY-2496` 拒绝文本、`cutover=` 不符、scope/baseline token 缺、两个 founder env 冲突、voice plist 异构、pre-check 403、pre-check 崩溃重跑不重发）；成功账本让 `raya_manifest_base_valid`、`raya_bridge_token_ready`、`raya_standard_manifest_checkpoint` 通过；`resolve` 交错（较早 unprocessed、较晚 processed）被拒；`install` 前后 manifest sha256 不变 |
| D `pending-install` 分类 | `scripts/lib/lead-restart-lifecycle.sh:767-781`；`scripts/restart-services.sh` `do_restart_all_leads` case；`scripts/lib/converge-nonlead-daemons.sh`、`host-tmux-selection-gate.sh:108` 枚举同步；`lead-restart-lifecycle-generic-carrier.test.sh`、`restart-services-notify.test.sh` | manifest 在 + projects 可解析 + plist 不存在 + job unloaded → `pending-install`：`log WARNING`、`alert_warning "lead-restart-pending-install-<key>"`、`skipped+1`；其他路径不变 | RED：raya 夹具被计 failed；GREEN：skipped=1 failed=0，其余 16 席行为字节不变 |
| E proof 工具 + 告警 kind 双面契约 | 新增 `packages/teamlead/src/bin/raya-migration-proof.ts`（+ test）；`scripts/lead-alert.sh:207` 白名单、`:122` `INFORMATIONAL_KINDS`；`packages/teamlead/src/LeadAlertNotifier.ts` `ALERT_EVENT_TYPES` + informational set；`packages/teamlead/src/bridge/kind-contract.ts` `KIND_CONTRACTS`；`packages/teamlead/src/bridge/alert-kind-copy.ts` `titleFor/bodyFor/severityFor` 各加 `activation_probe` case（info）；`alert-kind-copy.test.ts`、`kind-contract.test.ts`、`lead-alert-strict-delivery.test.sh`、`lead-alert-external-kind.test.sh` | research §1.5 逐字段；`activation_id = "<migration_id>:<activated_at>"`；持 Raya deploy lock 期间采集与写入；只读 SQL 查 mailbox；子进程注入；`emptyChannels` → `cutover.channels=[{channel_id, seeded_after:"0"}]`；账本 SHA 漂移时拒绝；告警 argv 固定为 `lead-alert.sh --project raya --lead raya --kind activation_probe --severity info --title "Raya activation probe" --body "<migration_id>" --signature "raya-activation-probe-<migration_id>" --strict-delivery`，取唯一 stdout 行的 messageId | 用 2445 的 P6 夹具反向生成环境，`collect` 产出的 proof 过 `raya_validate_proof` + `raya_p6_evidence_valid`；负向：digest 漂移、旧壳仍在、探针无回复、SHA 漂移拒写、锁被班车持有时等待/拒绝；kind 契约 TS/shell parity、`noImplicitReturns` 编译、direct/queued 两路 strict delivery 同为 info 且唯一输出行 |
| F 文档与 R1 | `packages/teamlead/lead-rules-base/founder-only-authority.md` R1 Raya 段补"人手只 register，install 归班车；授权令牌行含 baseline"；`engineering/doc/FLY-2444-flywheel-lead-launcher/lead-in-any-repo.md` 加一行指向 link-truth | 文档链接可达；`ci-structure.test.sh` 过 |

建议命令（实现前先核 package 脚本）：

```bash
bash scripts/__tests__/updater-raya-deploy.test.sh
bash scripts/__tests__/update-flywheel-sources.test.sh
bash scripts/__tests__/raya-standard-migration.test.sh
bash scripts/__tests__/lead-restart-lifecycle-generic-carrier.test.sh
bash scripts/__tests__/restart-services-notify.test.sh
bash scripts/__tests__/lead-alert-strict-delivery.test.sh
bash scripts/__tests__/lead-alert-external-kind.test.sh
bash scripts/__tests__/package-onboard.test.sh
pnpm --filter flywheel-teamlead test -- src/bin/raya-migration-manifest src/bin/raya-migration-proof src/bridge/__tests__/kind-contract src/bridge/__tests__/alert-kind-copy
pnpm --filter flywheel-teamlead build && pnpm lint
```

判一次测试成功要核 `Test Files/Tests` 条数，不只看退出码。跑重型套件前排除 `**/tmux-viewer.macos.test.ts`。

## 6. 数据模型

### 6.1 迁移账本新增字段（其余见 research §1.3）

```ts
target_raya_sha: string;
authorization: { legacy_stop: true; granted_by: "founder"; granted_at: string;
                 evidence_message_id: string; evidence_channel_id: string;
                 evidence_author_id: string; content_sha256: string;
                 canonical_line: string;   // "FLY-2496 AUTHORIZE register cutover=<sha8> urgent-restart baseline=quiet15m"
                 issued_by: string };
window_probe:  { bot_token_env: string; bot_user_id: string; channel_id: string; precheck_message_id: string };
legacy_owner:  Array<{ label: string; plist_sha256: string; loaded: boolean; pid: number | null;
                 start: string | null; stop_started_at_ms?: number; stopped_at_ms?: number }>;
prestop_probe?: { intent?: { nonce: string; at: string }; message_id?: string };
cutover_probe?: { intent?: { nonce: string; at: string }; message_id?: string; sent_at?: string;
                  bot_user_id?: string; boundary_message_id?: string | null };
baseline?:     { kind: "quiet15m"; authorized_by_line: true; before_ms: number };
unresolved: Array<{ message_id?: string; reason: "stop-window" | "quiet-window-violated"
                    | "lookback_exhausted" | "probe_delivery_ambiguous" }>;
resolutions?: Array<{ at: string; by: string; target: string; as: string; evidence: string }>;
flywheel_rebinds?: Array<{ from: string; to: string; at: string; lead_pid: number; restart_recorded_at: string }>;
```
`unresolved` 元素由字符串改为对象：`raya_manifest_base_valid` 只查 `type=="array"`，`raya_standard_preinstall_ready`/seed 工具只查 `length==0`，兼容。`raya_manifest_transform` CAS 语义不变。

### 6.2 seed 输入（班车 P3 写，格式即真实 `CursorSeed`，`seed-lead-inbound-cursor.ts:22-31`）

```json
{ "schemaVersion": 1, "migrationId": "<账本 migration_id>", "expectedBeforeSha256": null,
  "writerStopped": true, "unresolved": [],
  "channels": [{ "channelId": "<#raya>", "lastConfirmedMessageId": "<边界 B 的 id>" }] }
```
`expectedBeforeSha256` 为 `null`（H3 已保证 cursor 文件不存在）；`--resume-from-failed` 且 cursor 已存在则填其真实 sha256。频道为空 → `channels: []`、`emptyChannels: ["<#raya>"]`。

### 6.3 proof.json

形状 = v2 回执的 `lead/business/checks/cutover` 四对象 + `migration_id/raya_sha/flywheel_deployed_sha`（`raya_validate_proof:314-325`）。字段来源见 research §1.5；`lead.activation_id = cutover.activation_id = "<migration_id>:<activated_at>"`；`lead.pid/process_started_at/thread_id/tui_visible` 为 proof 时刻的活进程；`cutover.channels` 至少一项。

## 7. 回滚界线

| 时点 | 能回什么 | 不能回什么 |
|---|---|---|
| H1 | 删工作区、删 `~/.codex-raya`（先 link-truth 解链）；零生产影响 | — |
| H2 register 后、账本前 | `lead-registry` 受锁注销 + 再一张紧急票全舰重启；这段里班车只打 info 行 | 已发出的紧急重启 |
| 账本后、班车 N 前 | 删账本目录 = 撤销授权 | H3 pre-check 消息 |
| 班车 N pre-stop 失败（ff 之前） | 什么都没变（旧壳、主 checkout 未动；scratch worktree 可删） | prestop-check 消息 |
| ff 成功后、quiesce 失败 | 旧壳进程仍活（代码在内存）；主 checkout 已到 target，下一班 ff 为 no-op 并重试 quiesce。**残余风险**：此状态下旧壳若被 launchd 重拉会因文件已删而起不来（pre-stop 与 H3 已两次核验 identity，quiesce 失败面很窄），记入账本并 severe 告警 | 主 checkout（禁止手工 reset） |
| 班车 N P2 停旧壳之后 | **没有自动旧脑回退**（2445 plan §6.5、issue"不做"）；失败态是"新通路 maintenance + 持久收件"，账本逐 job 可续 | 旧壳；要恢复它需单独授权 |
| P3 `unresolved` 非空 | 停在 P3，不 install。`stop-window` 条目由 Lead 人工对账后 `resolve --as …`（unprocessed 必须是后缀）；`probe_*`/`lookback_*` 用带证据的显式 resolve。下一班续 | — |
| P5 后 | 停新 Lead 精确进程身份（`flywheel-lead.sh stop`）；mailbox/journal/outbox 保留 | 已发消息、已 merge 的 summary |
| P7 后 | 标准 `rollback_target` 两仓配对（首次为 null） | — |

任何身份漂移、未知活 owner、并发工作区改动、digest 不等 → fail-closed 保留现场，不"清理"。

## 8. 验收矩阵（独立 QA 读）

| 要求 | 必须看到 | 不足以证明 |
|---|---|---|
| 班车不再判 host-capability-absent | 班车 N 日志 `raya shuttle:` 从 `not_configured` 变为 `awaiting_proof`，N+1 变为 `deployed standard-lead:9d63a2b2` | 只有 manifest 文件出现 |
| 中间态不误告警 | H2→H3 之间每个 scheduled wake 完整日志里 `migration-ledger-absent` 恰一行，无 `Raya deploy failed` | — |
| 全舰重启不把 raya 计失败 | 紧急重启日志 `pending-install` warning 一条、`failed:0`；16 席 verify 绿 | — |
| 不可逆边界前的失败零副作用 | 隔离夹具：`origin/main ≠ target` / scratch build 失败 / prestop POST 403 / 频道活跃 / ff 失败 → `prestop-failed`，两旧 job 未动 | — |
| 停机窗口不丢信 | 账本 `cutover_probe.message_id` 的 `chat:raya:<id>` 在 CommDB ACKED 且有 outbound 回复 id；`boundary_message_id < probe id`；`unresolved` 为空或全部有 `resolutions[]` 回执；`baseline` 已记录且授权行含 `baseline=quiet15m` | 只有启新后的文字探针 |
| v2 回执 | `schemaVersion 2 / carrier standard-lead / outcome deployed / deployed_sha == target_raya_sha / flywheel_deployed_sha == 当时 ~/.flywheel/deployed-sha`；`verify --stage live` 0 | v1 回执、PR MERGED、anchor 文件 |
| Flywheel 漂移不误告警 | 若 N→N+1 间有 Flywheel 发布：日志 `awaiting_rebind_proof`、`flywheel_rebinds[]` 一条、activation_id 不变、无 severe | — |
| 读钟响了（P7 后观察项） | 下一个 6h 边界：`summary_absorption_round` delivered 行 + roundId 绑定的 merge receipt，`ts` 晚于 `delivered_at`；或可审计的 `no-candidate` | founder 手点的 merge；不能据此声称 GitHub actor 是 Raya bot |
| 巡检收敛 | `raya_checkout_overdue` 告警在班车 N 后停止 | — |
| 权限不放宽 | 账本/proof/seed 均 0600；工具输出零 token；不引用旧 `~/.flywheel/raya/codex-home` | — |

## 9. 风险与 follow-ups

- **探针需要 Raya 回复**：P6 要 `window_outbound_message_id`。若 12h 内无回复，Lead 用 `FW_PROBE_BOT_ENV` 再发一条引用探针的追问（窗口消息 id 不变）。仍无 → 报 founder，不伪造。
- **register→P5 窗口丢一槽 summary**：见 exploration §6；用 23:00 PT 起步压到 1h 内。
- **`baseline=quiet15m` 是授权的历史基线声明，不是处理证明**：旧壳没有可机读的处理记录（research §4），无法做得更好；如 founder 不接受此基线，唯一替代是人工逐条对账整个旧壳生命周期的 #raya 消息。
- **ff 后 quiesce 失败的残余风险**：见 §7 第五行。
- **rebind 的进程/代码绑定是间接的**：依赖 `leads-restart-status.json` 的多个 pinned 字段 + Bridge buildSha + 进程出生时刻；没有 restart-services 写的逐 Lead SHA 回执（follow-up 4）。**诚实边界**：activation 绑定迁移事务，所以 rebind 后的 text/summary 证据属于同一 activation，但不保证来自当前 PID；"当前进程"证据只有 restart-status + `verify --stage live` + proof 时刻的 pid/start。若验收方要证明当前进程端到端，需在 rebind 后重做 H4.1 并等当前进程之后的新 summary 轮。
- follow-up 1：`import-cos-context` 14 行——待 `lead-directory` 有消费者后另开单。
- follow-up 2：读收据 merge 的 actor provenance：receipt `actor` 字段 + commit trailer `Flywheel-Reader: raya`。
- follow-up 3：`pending-install` 对误删 plist 的 Claude Lead 从 failed 降为 warning——patrol 规则加"pending-install 超过 1 个班车周期即 escalate"。
- follow-up 4：restart-services 逐 Lead `{codeDeployedSha, leadKey, pid, processStartedAt}` 回执，让 rebind 不再间接。
- 未决（不阻塞）：`FW_PROBE_BOT_ENV` 选哪枚 bot 由 Lead 在 H0 与 founder 一并定（需双频道权限）。

## 10. 设计节点交付审计

提交本文件、exploration.md、research.md、progress.md、Mermaid 源与本地渲染 SVG、单 `<script nonce="__CSP_NONCE__">` 的 founder-design.html（每 section 意见框、按 pathname 隔离 localStorage、实时汇总、`【页面意见汇总】FLY-2496` 首行、1800 字符分块、clipboard 拒绝 fallback、零外链）。评审：Codex 三轮后按项目规则上报 Lead 裁定 effective verdict；`stage set design_review --plan` → inbox 取 manifest → design-review.json → `await-codex-gate`。最后 publish-only、DESIGN-HTML report、`phase_design_complete`。设计完成不等于 Raya 已激活。

## 11. 评审记录

| 轮 | findingKey | 处置 |
|---|---|---|
| R1 | SEED-SCHEMA | 采纳：§6.2 `expectedBeforeSha256`；真实 seed 工具集成用例 |
| R1→R3 | CURSOR-BOUNDARY | R3 重开后改为：**不做任何"已处理"推断**（旧壳无可机读处理记录，文字回复无 `message_reference`）；切换前置"频道安静 15 分钟"，停机窗口内人类消息一律 `unresolved`；更早历史由 founder 授权行 `baseline=quiet15m` 明确划为不补录范围；`confirmed_unprocessed` 只允许为后缀，交错即拒 |
| R1→R2 | CUTOVER-RESUME | 恢复搜索从 `snowflake(intent.at−60s)` 用 `after=` 分页 ≤10 页；耗尽 → `probe_delivery_ambiguous` 停；R3 advisory 补 `probe_not_delivered` 显式路径 |
| R1→R2 | AUTH-FENCE | founder 消息固定令牌行机器匹配（R3 起含 `baseline=quiet15m`）；`resolveFounderId`；无第二个运行时开关 |
| R1→R3 | PRESTOP-PREFLIGHT | R3 重开后改为：主 checkout ff 作为最后一个可逆 pre-stop 步骤，ff 后复验再 quiesce；quiesce 后零 install/build/ff；残余风险写进 §7 |
| R1→R3 | SHA-FREEZE | R3 重开后改为：activation 绑定迁移事务（`<migration_id>:<activated_at>`）而非 PID，`cutover.activation_id == lead.activation_id` 在 Lead 换代后仍成立；proof 工具与班车共用 deploy lock；restart-status 谓词 pin `schemaVersion/failed/skipped/total==17/recordedAt`；不冻结 Flywheel 发布 |
| R1→R2 | ALERT-KIND-CONTRACT | 补 `alert-kind-copy.ts` 三 case、测试与完整 argv |
| R1 | LEDGER-INFO-COUNT / MEMORY-CHECKPOINT / SUMMARY-PROVENANCE | 采纳（未重开） |
| R2/R3 advisory | research/exploration 同步、summary delivery 是 P6 门、pre-check nonce、测试命令拆行、`no-candidate`、`probe_not_delivered`、restart-status pinned 字段 | 均已写入 |
| R4 | CURSOR-BOUNDARY | 阻断级，采纳：`B_final` 前缀/后缀定义与三例测试（§5 B/C） |
| R4 | PRESTOP-PREFLIGHT | **驳回**（事实错误）：matcher 对 cli 路径只做字符串比较，`isfile` 检查的是 node 二进制；保留 Codex 建议的删除布局测试（review.md） |
| R4 | SHA-FREEZE | 阻断级，采纳：先 quarantine 旧 proof 再单次 CAS 账本；三处 crash-injection 用例 |
| R4 advisory | research §4 措辞收窄、exploration 残留同步、quiet check 分页、activation 诚实边界 | 均已写入 |
