# FLY-2653 Raya 割接生产恢复 — Runbook
Issue: FLY-2653 (https://linear.app/geoforge3d/issue/FLY-2653/raya割接工具缺口-旧壳-brain-在-p3-之前自己死了-标准-lead-已在线-班车-prestop-永远-validation)
日期: 2026-09-18
基于: exploration.md

> **2026-09-18 实现修订（取代本文旧操作节拍）：** 本文 §0–§6 记录的是本 PR
> 之前的生产快照与恢复方案，不得再当作合入后的操作指令。合入后，一次性 prestop
> 只要求 founder 授权 target 是当前 `origin/main` 的祖先，仍只构建/提升该授权 target；
> 日常 standard-update 则 fast-forward 到刚 fetch 的 `origin/main`，并把实际部署 SHA
> 同时写回 `target_raya_sha` 与 `raya_sha`。成功的 urgent Flywheel deploy 会在 Flywheel
> 步骤完成后进入 Raya pass；但 updater 在进程启动时已经 source 旧函数，所以**部署本
> PR 的那一轮仍会按旧逻辑跳过 Raya，必须等部署完成后的下一次 updater 调用**才会运行
> 新逻辑。本 implement runner 不触发 restart/kickstart，也不执行任何生产写入。

> 执行人：flywheel-eng-lead（Tadashi）。design runner 只做了只读核对，**没有执行任何写操作**。
> §1 的读数是 2026-09-18 13:20–13:40 PT 的**执行前快照**（pre-init / pre-projection）；#2 与 #12 两行描述的是当时的状态，之后已被 Lead 的操作改变，现态见 §0。

## 0. 一句话

代码正门已经在生产 checkout 里（FLY-2657 / `9e6282830` ⊂ 已部署 `bd2fc7dfe`）。割接还需要三件**运维动作**：
(a) 用 founder 新授权行重放 `init --resume-from-failed`；(b) 把工作区 persona 占位重投影到新 target（本次新发现，不做的话 prestop 仍会 `prestop-validation-failed`）；(c) 等一趟 **scheduled** 班车（紧急重启不跑 raya 段）。

**现态（runner 只读读回，2026-09-18 ~13:50 PT）：(a)、(b) 已由 Lead 于 13:37 PT 前后执行完毕并读回通过——账本 `P2 / target 90e433e8… / cutover=90e433e8 行 / cursor.status="preexisting" / brain {loaded:false,pid:null} / voice {loaded:true,pid:null}`；`identity.md` = `ca1240f1…78f5`。§2、§3 现在是审计留档，禁止重跑。当前只剩 (c)：今晚 00:00 PT 班车，以及 §1 #10、#13、#14、#15 四条要一直守到班车的条件。**

## 1. 前置条件与当前生产读数

| # | 前置条件（代码依据） | 当前读数 | 结论 |
|---|---|---|---|
| 1 | 已部署 Flywheel 含 FLY-2657（`git merge-base --is-ancestor 9e6282830 HEAD`） | `~/.flywheel/deployed-sha` = `bd2fc7dfe5eb…`，含 `9e6282830` | ✅ |
| 2 | 旧账本可 resume：`checkpoint=="P2"`、无 `old_stopped_at`、两个 owner 都没有 `stop_started_at_ms`/`stopped_at_ms` 键（`raya-migration-init.ts:177-188`） | `checkpoint=P2`，`prestop_retry=true`，两个 owner 均无 stop 键，`has("old_stopped_at")=false` | ✅（执行前快照；init 后 `prestop_retry` 已随账本重建清掉） |
| 3 | 标准 Lead live（init 内部会自己再跑一次，30s 上限，`raya-migration-init.ts:321-331`） | `flywheel-lead.sh verify --stage live` 8 项全 PASS，launchd pid=64886，Bridge buildSha=`bd2fc7dfe` | ✅ |
| 4 | cursor 是 0600 普通文件且可解析（`readLeadInboundCursor`） | `…/raya__raya-726179611f72617961/inbound-cursor.json`，`-rw-------`，35 个 channel | ✅ |
| 5 | 旧壳 plist 仍在且 `ProgramArguments[0]` 是可执行普通文件（`inspectLegacyOwners:72-95`） | 两份 plist 0600 在位；node=`/opt/homebrew/Cellar/node/25.6.1/bin/node` 存在 `-rwxr-xr-x`；plist sha 与账本一致（`8d9f1f68…`/`f68997d7…`） | ✅ |
| 6 | 旧壳 launchd 形状是 init 认识的两种之一 | brain：`Could not find service` + `print-disabled` = disabled + pid 54811 `no such process`；voice：loaded、首个 `state = not running`、无 pid | ✅（init 会记 brain `pid:null,loaded:false`，voice `pid:null,loaded:true`） |
| 7 | 没有未记账的旧壳进程（FLY-2657 全进程 census） | `ps` 里无 `raya/code/apps/(brain\|voice)/dist/cli.js` | ✅ |
| 8 | `~/.flywheel/.env` 有 `RAYA_BOT_TOKEN`、探针 bot token、`FLYWHEEL_API_TOKEN\|TEAMLEAD_API_TOKEN` | 键名存在：`RAYA_BOT_TOKEN`、`TADASHI_BOT_TOKEN`、`TEAMLEAD_API_TOKEN`、`FLYWHEEL_BRIDGE_URL`（只核了键名，没读值） | ✅ |
| 9 | 身份三件套是普通文件：`manifests/raya-raya.json`、`projects.json`、`state/summary-registry/migration-receipt.json` | 三者均 `-rw-------` 普通文件 | ✅ |
| 10 | Raya 仓 `origin/main == target`（`raya_prestop_prepare:1046`，**严格相等**） | `git ls-remote origin main` = `90e433e87a68287ed59ba64f2584e3a6bc0da151` | ✅ **但易碎**：Raya 仓此刻有 10+ 个 open 的 summary PR（#186–#195 等，`gh pr list -R xrliAnnie/raya`），main 自 9-16 12:56 PT 起未动。**首趟班车 ff 之前任何一个被合入（含在线 Raya Lead 自己的吸收轮 merge），target 就漂走，必须重新要授权行**。班车前请确认没人/没 Lead 在合 Raya PR |
| 11 | 生产 checkout 在 main、干净、是 target 的祖先 | HEAD=`0f77e977…`，branch=main，clean，`0f77e977` 是 `90e433e8` 祖先 | ✅ |
| 12 | **工作区 persona 占位 == target 的 `.lead/raya/identity.md`**（`raya_prestop_prepare:1064-1066`；FLY-2496 plan.md:77 定义为激活包的人工步骤） | 工作区 `~/Dev/raya-lead-workspace/.lead/raya/identity.md` sha256=`4e982448…`（= Raya `9d63a2b` 9-09 版）；target `90e433e8` 的 = `ca1240f1…`（旧 target `5913bb47` 的 = `72553f4c…`，同样不等） | ❌（执行前快照）→ ✅ 已由 §3 修正并读回；不做的话 init 成功后班车仍 `prestop-validation-failed` |
| 13 | #raya 频道（`1542079099928059987`）prestop 前后 15 分钟无人类消息（quiet15m，`quiet-check` 跑两次） | 无法预读；执行时刻决定 | ⚠️ 提醒 founder 班车前后 ~20 分钟别在 #raya 说话 |
| 14 | 无遗留 Raya deploy lock；**班车取快照那一刻 `~/.flywheel/self-ship-urgent.d` 必须为空**（`update-flywheel.sh:752-776` 在任何 token 校验之前就按该目录是否为空定 `UPDATER_WAKE_KIND`；目录里有任意条目 ⇒ 这一轮算 `urgent` ⇒ `:1008-1019` 跳过 raya 段。`request-restart.sh:135-140` 存在「token 已落盘但 nudge 失败、token 留在目录里」的形状） | 执行前快照与 13:59 PT 复读：`~/.flywheel/raya/` 下无 lock 目录；`self-ship-urgent.d` 空 | ✅ 但这是**时点条件**：00:00 PT 前后若有人发了 founder 紧急重启票，这一班就不跑 raya 段，要再等 12 小时。班车前若发现目录非空：**不要盲删**，按 urgent token 的正常消费路径诊断（updater 日志里该 token 是否已被 claim/消费），确认消费完再指望下一趟 scheduled。班车后先看日志里的 `updater cycle: wake=` 是 `scheduled` 还是 `urgent`，别把「raya 段根本没跑」误判成割接内部失败 |
| 15 | **persona projector 处于休眠**（FLY-2696，已随 `bd2fc7dfe` 部署：`scripts/flywheel-lead.sh:243-254` 在 Raya 每次启动前跑 `flywheel-comm persona-project`；无 contract 且无 marker ⇒ `skipped/not_enrolled`、不碰文件；无 contract 但存在 `enrollment.json` 或 `activation.json` marker ⇒ 拒绝启动 rc 78（空 state root 目录本身无害，仍是 `skipped/not_enrolled`）；有 contract ⇒ 经 activation/contract fencing 后按授权 pin 校验，结果可能是 `changed:false`、原子投影覆盖 `identity.md`、授权 fallback 或拒绝，`packages/flywheel-comm/src/commands/persona-project.ts:105-169`、`persona-projector.ts:418-428,476-593`） | `projects.json` 的 raya/raya 行 `has("personaProjection")=false`；`manifests/raya-raya.json` 无该键；state root `~/.flywheel/state/lead-persona/raya/raya` **不存在**（无 `enrollment.json`/`activation.json`）；`lead-raya-raya.log` 最近一次启动记 `{"status":"skipped","reason":"not_enrolled"}` | ✅ 休眠。**P5 之前不要给 raya 行的 selector 加 `personaProjection`，也不要创建 `enrollment.json`/`activation.json` marker**；否则 P4b 受控重启可能被拒，或 persona 被投影/fallback 到别的 pin，candidate/persona 绑定随之失效。若届时已 opt-in，§3 的手工步骤作废，必须先证明 projector 的授权 commit/digest 正好是 `90e433e8…/ca1240f1…` |
| 16 | target 版本目录不存在，或其 tree digest 等于候选（`raya_verify_candidate_artifact:1017-1025` 会拒「已存在但摘要不同」） | `~/Dev/raya-lead-workspace/.flywheel-managed/versions/` 不存在 | ✅ |

## 2. init 命令（逐字）— 已执行，审计留档，禁止重跑

`content_sha256` **不用手算**：init 用探针 bot token 经 Discord REST 取回该消息，校验 `id / channel_id / author.id == founder / 非 bot / 某一行 trim 后逐字等于 canonical 行`，然后自己算 `sha256(message.content)` 写进账本（`raya-migration-manifest.ts:33-74`）。author id 也不是参数——它从 `.env` 的 founder 身份解析，取回的消息作者必须等于它（应为 `1138241636057481306`）。

canonical 行必须是（`cutover=` 取 target 前 8 位）：

```
FLY-2496 AUTHORIZE register cutover=90e433e8 urgent-restart baseline=quiet15m
```

先 dry-run（不取锁、不写账本、不发 precheck；preexisting 路径下**会**向 Bridge POST **两次** `/api/lead-inbox/nudge`——init 自己一次 `raya-migration-init.ts:244-261`，它调用的 `verify --stage live` 再一次 `scripts/flywheel-lead.sh:903-919`；只是催一下在线 Lead 的收件泵）：

```bash
cd ~/Dev/flywheel
node packages/teamlead/dist/bin/raya-migration-manifest.js init \
  --resume-from-failed --dry-run \
  --target-raya-sha 90e433e87a68287ed59ba64f2584e3a6bc0da151 \
  --authorization-message-id 1549915003895947318 \
  --authorization-channel-id 1547579673049829558 \
  --probe-bot-token-env TADASHI_BOT_TOKEN
# 期望 stdout: {"status":"dry-run","probe_send":"not-run"}
```

再真跑（去掉 `--dry-run`；持 Raya deploy lock，CAS 覆盖旧账本，`migration_id` 沿用旧值）：

```bash
node packages/teamlead/dist/bin/raya-migration-manifest.js init \
  --resume-from-failed \
  --target-raya-sha 90e433e87a68287ed59ba64f2584e3a6bc0da151 \
  --authorization-message-id 1549915003895947318 \
  --authorization-channel-id 1547579673049829558 \
  --probe-bot-token-env TADASHI_BOT_TOKEN
# 期望 stdout: {"status":"initialized","migration_id":"FLY-2445-standard-lead-436957b7-…","path":"…/manifest.json"}
```

读回核对：

```bash
jq '{checkpoint,target_raya_sha,line:.authorization.canonical_line,msg:.authorization.evidence_message_id,
     cursor:.cursor.status,owners:[.legacy_owner[]|{label,loaded,pid}]}' \
  ~/.flywheel/raya/migrations/FLY-2445-standard-lead/manifest.json
# 期望: P2 / 90e433e8… / cutover=90e433e8 行 / 1549915003895947318 / "preexisting" /
#       brain {loaded:false,pid:null} / voice {loaded:true,pid:null}
```

常见失败码 → 含义：`authorization-message-invalid`（消息里没有逐字 canonical 行、或探针 bot 看不到该频道）；`probe-bot-invalid`（探针 bot 与 Raya bot 或 founder 同号）；`bridge-nudge-failed`（Bridge 不是 202）；`migration-already-initialized`（账本已不满足第 1 节 #2）；live verify 失败会以 `migration-operation-failed` 类非零退出且账本字节不变。

说明：`--probe-bot-token-env TADASHI_BOT_TOKEN` 沿用旧账本 `window_probe.bot_token_env`；该 bot 必须能读授权频道 `1547579673049829558`。precheck 探针消息按 `precheck.intent` 里的 nonce 回找复用，不会重发。

## 3. persona 占位重投影 — 已执行，审计留档，禁止重跑

```bash
set -euo pipefail
W=~/Dev/raya-lead-workspace
T=90e433e87a68287ed59ba64f2584e3a6bc0da151
OLD=4e982448296ac31215dde62ac2a6343f642753eeb39ba96e16767ed921e63b1f
NEW=ca1240f12fbbe868ec3fa117f4882ecfcb78d20a51a0ffa7ad9f37babbcd78f5
ID="$W/.lead/raya/identity.md"; BAK="$ID.bak-$OLD"
sha() { shasum -a 256 "$1" | cut -d' ' -f1; }
[ "$(sha "$ID")" = "$OLD" ] || { echo "STOP: current persona is not the expected old digest"; exit 1; }
[ ! -e "$BAK" ] || { echo "STOP: backup already exists; verify its digest, never overwrite"; exit 1; }
cp -p "$ID" "$BAK"
git -C ~/.flywheel/raya/code show "$T:.lead/raya/identity.md" > "$ID.tmp"
chmod 600 "$ID.tmp"
[ "$(sha "$ID.tmp")" = "$NEW" ] || { rm -f "$ID.tmp"; echo "STOP: target persona digest mismatch"; exit 1; }
mv "$ID.tmp" "$ID"
[ "$(sha "$ID")" = "$NEW" ] && echo OK
```

命令形状源自 FLY-2496 `plan.md:77`（激活包原话），加了 fail-closed 断言：current 不是预期旧摘要 ⇒ 停；备份已存在 ⇒ 停（**绝不覆盖回退点**）；tmp 摘要不是 target ⇒ 停。`.bak-*` 留在 `.lead/raya/` 下不影响任何校验（校验只看 `identity.md` 本体）。

> **执行记录（runner 只读读回，2026-09-18 ~13:50 PT）**：Lead 已在 13:37 PT 按本节初版执行过一次。读回：`identity.md` = `ca1240f12fbbe868ec3fa117f4882ecfcb78d20a51a0ffa7ad9f37babbcd78f5`（= target）；`identity.md.bak-9d63a2b` = `4e982448…`（= 9-09 旧版，回退点真实）。**本节不要再跑第二遍**——初版命令重跑会用新 persona 覆盖备份；上面的新版会在「current 不是旧摘要」处直接停。init 也已执行，账本读回满足 plan §4 P-a。
风险：从此刻到 P4b 受控重启之间，若标准 Lead 意外重启，会先读到新 persona 而 `business/current` 还没物化。**尽量贴着班车做**（例如班车前 10 分钟内）。新 persona 引用的 `lead_actions.summary_presentation` 已随 `bd2fc7dfe`（#1254）在 Bridge 上线，所以即便提前生效也只是「工具在、cos 包未到」，不是崩溃级。

## 4. init 之后谁跑 P2→P7

**只有 scheduled 唤醒跑 raya 段；紧急重启明确跳过。** 依据：

- `scripts/update-flywheel.sh:772-776`：urgent 目录快照为空 ⇒ `UPDATER_WAKE_KIND=scheduled`，否则 `urgent`。
- `scripts/update-flywheel.sh:1008-1019`：`case $UPDATER_WAKE_KIND in scheduled) raya_host_capable && updater_raya_pass ;; urgent) log "raya shuttle: skipped wake=urgent" ;; *) … fail closed`。
- `scripts/request-restart.sh:76-91,135`：它只做一件事——往 `self-ship-urgent.d` 发 token 再 nudge updater ⇒ 必然 `wake=urgent` ⇒ **`request-restart.sh` 永远不跑 raya 段**（这正是 FLY-2433 记的那条）。
- 定时点：`com.flywheel.updater` plist `StartCalendarInterval` 00:00 / 12:00（本机时区 PT）。下一班 = **今晚 00:00 PT**。注意「定时器触发」≠「`UPDATER_WAKE_KIND=scheduled`」：只有取快照时 urgent 目录为空才算 scheduled（§1 #14）。

**今晚 00:00 之前没有正门。** 代码层面，updater 在 urgent 目录为空时被手动唤起会被判成 `scheduled` 并跑 raya 段；但手动唤起 updater 正是 FLY-913 部署护栏硬拦的动作（护栏原话：「普通 merge 永不即时重启：等待本地 00:00/12:00 班车，不要手动唤起」——我发这份报告时提到该命令都被护栏拦了一次）。所以本 runbook **不提供**提前跑的步骤：首趟 = 今晚 00:00 PT 班车。若 founder 明确要求更早，那是一张需要 founder 亲口授权的例外，不在本单范围，也不应由 Lead 或 runner 自行绕过护栏。

单趟班车能走多远（`updater_raya_pass:1350-1442`）：

| 趟 | 动作 | 结束状态 |
|---|---|---|
| N（首趟 scheduled） | prestop（scratch build 90e433e8 → persona 相等 → prestop-probe → quiet-check → ff 生产 checkout → 复验）→ quiesce 两个旧 owner（补三时间戳 + disable 读回 + warning alert）→ promote → P3（探针 + preexisting 只读 boundary）→ P4b（bridge token 闸 → live verify → **受控 install 重启标准 Lead 到新 artifact/persona** → ≤30×2s 等 live → 写 `activated_at` → 发 post-activation 探针）→ P5 | 回执 `refused / p5-awaiting-real-p6-evidence`（非 severe）。**此刻 #154 已在生产生效，founder 就能用上新 Raya** |
| 人工 H4 | #raya 发一条文字记 messageId、等 Raya 回复；等过下一个 6h summary 边界（`summary_absorption_round` delivered 是 P6 门）；`node packages/teamlead/dist/bin/raya-migration-proof.js collect --text-message-id <id>` | `proof.json` 0600 |
| N+1（下一趟 scheduled） | P5→P6→P7，写 v2 回执 | `deployed` |

所以：**「founder 今晚能不能用上 Raya（#154）」取决于首趟班车到 P5**——最早今晚 00:00 PT（或你拍板的手动 scheduled 唤醒）；**v2 回执最早要到再下一班**（还夹着一个 6h summary 轮），FLY-2619/2631 的收尾按这个节拍排。
注意 N 与 N+1 之间若 Flywheel 又发布过（`deployed-sha` 变了），N+1 会先自动 rebind 并回到 `awaiting_rebind_proof`，需要重跑一次 proof collect。

## 5. 成功判据与回退点

首趟成功（P5）：

```bash
jq '{checkpoint,raya_sha,activated_at,cursor:.cursor.status,
     owners:[.legacy_owner[]|{label,stop_started_at_ms,disabled_at_ms,stopped_at_ms}]}' \
  ~/.flywheel/raya/migrations/FLY-2445-standard-lead/manifest.json      # P5 / 90e433e8… / 三时间戳齐
git -C ~/.flywheel/raya/code rev-parse HEAD                              # 90e433e87a68…
bash ~/.flywheel/bin/flywheel-lead.sh verify --stage live ~/.flywheel/manifests/raya-raya.json   # 全 PASS，pid 已换
readlink ~/Dev/raya-lead-workspace/business/current                      # …/.flywheel-managed/versions/90e433e8…
launchctl print-disabled gui/501 | grep xrli.raya                        # brain、voice 均 disabled
```

最终成功（P7）：`~/.flywheel/raya/deploy-receipt.json` 为 `schemaVersion:2`、`carrier:"standard-lead"`、`outcome:"deployed"`、`deployed_sha=90e433e8…`、`flywheel_deployed_sha=<当时 Flywheel 已部署 SHA>`；`~/.flywheel/raya/deployed-sha` 前移到 `90e433e8…`（当前回执是 `schemaVersion:1 / rolled_back / 0f77e977`）。

回退点：

| 失败位置 | 现场 | 回退 |
|---|---|---|
| init 任一失败 | 账本字节不变（CAS + 失败在写之前） | 无需回退；修前置后重跑 |
| 班车 `prestop-failed`，且生产 checkout HEAD 仍是 `0f77e977…`（ff 之前） | 旧壳零变更、生产 checkout 零变更、账本只多 `prestop_retry=true`（可能还有 `prepared_candidate`） | 无需回退；查是第 1 节哪一条，修后等下一班。persona 想撤：先核 `identity.md.bak-9d63a2b` 摘要是 `4e982448…`，再 `mv` 回去 |
| 班车 `prestop-failed`，但生产 checkout HEAD 已是 `90e433e8…`（**ff 之后、quiesce 之前**：`:1097-1099` ff 成功后，`:1100-1102` 的 candidate 复验 / legacy owner 复验 / 第二次 quiet-check 失败） | detail 字符串与上一行**完全相同**，只能靠 `git -C ~/.flywheel/raya/code rev-parse HEAD` 区分。旧 owner 未被碰（brain 本就不在，voice 仍 loaded/not running），账本无 stop 键，checkout 已在 target | **禁止 `git reset`**（违反既有恢复合同，且下一班的祖先检查以当前 HEAD 为准）。修好失败条件（多半是频道不安静）后等下一班重跑完整 prestop；此时 `HEAD == target`，ff 是 no-op |
| quiesce 之后（账本出现 stop 三字段） | 不可逆点已过：旧壳已 disable。**不要**再跑 init（`migration-already-initialized` 会拒） | 只能向前：下一班按账本 checkpoint 续跑；P3 `unresolved` 走 `raya-migration-manifest resolve …`；P4b `awaiting_lead` 下一班自动续等、不重复 install |
| Raya `origin/main` 在班车前漂离 90e433e8 | prestop 在 `origin/main == target` 处失败：旧 owner 与生产 checkout 均不变；fetch 已更新本地 tracking ref `refs/remotes/origin/main`，账本会尝试记 `prestop_retry=true`（同「ff 之前」那一行） | 需要 founder 对新 main 头重发授权行，再重放第 2 节 |

## 6. 我没有做、也不建议 runner 做的事

没跑 init（含 dry-run，因为它会 nudge 在线 Lead）、没碰工作区 persona、没 kickstart updater、没读 `.env` 的值、没读 Discord 消息正文。授权消息里是否**逐字**含 canonical 行，由第 2 节 dry-run 一步核出。
