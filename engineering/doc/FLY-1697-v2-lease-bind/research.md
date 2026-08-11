# FLY-1697 全舰 lease 无出口 — 调研

Issue: FLY-1697 (https://linear.app/geoforge3d/issue/FLY-1697/全舰无出口-lease-只在建窗分支绑定launchd-native-走adopt分支-16-个-lead-全部无法-ack-任何收据已持续)
日期: 2026-08-11
基于: exploration.md

本文是代码级事实清单：每条都带 file:line，供 plan.md 直接引用。所有生产状态均为 2026-08-11 本机实测。

## 1. 断路链条的五个代码事实

### F1 — v2 one-shot block 在 supervisor loop 之前退出

`packages/teamlead/scripts/claude-lead.sh:4368-4438`：`FLYWHEEL_LEAD_BODY_V2=1` 时，body 完成 resume/fresh 决策 → `_rules_bundle_commit_once` → `_launch_claude` → 写 exit receipt → `tmux kill-server` → `exit`。

lease 机制全部在这个 block **之后**：
- `lead_identity_prepare_lease` 调用点：`claude-lead.sh:4537`（v1 supervisor loop 内）
- `lead_identity_bind_lease` 唯一调用点：`claude-lead.sh:2621`（`ensure_tmux_session` 建窗成功后，仅 v1 loop 调用）

⇒ v2 生产路径 acquire/bind **零执行**。`git log` 佐证：v2 carrier 由 `dfc8848b`（FLY-1663, PR #794, 2026-08-09）引入，同一 commit 加了 `carrier_passthrough`。

### F2 — pane env 无 lease claim

`claude-lead.sh:2984-2991`（`_launch_claude` 内，v1/v2 共用）：仅当 `LEAD_LEASE_KEY` + `LEAD_LEASE_GENERATION` 非空时注入 `FLYWHEEL_LEAD_LEASE_KEY` / `FLYWHEEL_LEAD_GENERATION`；否则若 `LEAD_LEASE_DEGRADED` 非空注入降级标记。v2 两者恒空 → child env 三者皆无。

v2 pane env 有 `FLYWHEEL_LEAD_ID`（:2931）和 `FLYWHEEL_LEAD_CARRIER=v2`（:3032-3033）。

### F3 — carrier_passthrough 短路在 claim 校验之前

`packages/flywheel-comm/src/lead-lease.ts:2603-2612`：

```ts
if (backend === "claude-code" && resolution.lead.carrier === "v2" && env.FLYWHEEL_LEAD_CARRIER === "v2") {
  return { disposition: "carrier_passthrough", provenance: writerProvenance };
}
```

`writerProvenance` 只有 `writerPid/writerStart`（:2429-2432）。完整 lease 校验（`store.validate` → `lease_validated` + senderLeaseKey/senderGeneration provenance）在 :2632-2658，v2 永远到不了。

### F4 — 收据结算是双层硬合同

- `packages/flywheel-comm/src/commands/handle-receipt.ts:39-46`：`!provenance?.senderLeaseKey || !provenance.senderGeneration` → 抛 `receipt handling requires a validated Lead lease generation`（全舰看到的原句）。
- `packages/flywheel-comm/src/db.ts:2696-2704`：`CommDB.handleReceipt` 再验一次 → `not_authorized: a valid Lead lease generation is required`。

两层都是 FLY-1392（`d817eff2`, 2026-07-21）建立的合同。**其它写入（send/reply 等）不要求 sender lease 字段**——这解释了「只有收据断，别的都正常」。

### F5 — v1 adopt 分支不 bind 是故意且正确的（回答 issue 的选项 A）

store 语义（`packages/flywheel-comm/src/lead-lease.ts`）：
- `acquire`（:487-703）：
  - 行存在、requester ≠ supervisor、行**已 bound**、supervisor 死、holder **活** → `holder_orphaned`，返回**旧** generation + 旧 holder tuple，**不写行**（:612-649）。
  - 行已 bound、requester 就是 supervisor、holder 活 → `idempotent_adopted`（:589-605）。
  - 行 **unbound**、supervisor 死 → 落到 :659 `INSERT` gen+1 → `acquired`。★ 这就是当前生产 16 行的形状，fresh acquire 直接成功。
  - supervisor/holder 活 → `denied_holder_alive`；传感器错 → `denied_sensor_degraded`。
- `bind`（:705-760）：CAS `WHERE ... AND holder_pid = supervisor_pid AND holder_start = supervisor_start AND bound_at IS NULL`。对 adopt 场景（`bound_at` 已置）必然 `stale_generation`。adopt 的正确行为就是**沿用旧 generation 的既有绑定**（validate :871-907 只查 generation 匹配 + bound_at + history，不查 holder 存活）——旧 Claude child 手里的 env claim 继续有效。
- shell 侧 adopt 分支：`claude-lead.sh:1876-1922`（`_lead_try_adopt_body`）+ rc 4/5 处理（:4556-4601）。

⇒ 「给 adopt 分支加 bind」既不可行（CAS 拒绝）也不对（会孤儿化活 child 的 claim），且该分支在 v2 生产路径上不可达。

## 2. 生产状态实测（2026-08-11）

`lead-lease readiness --json`（完整输出见当日实测；关键字段）：
- `mode: {"mode":"audit_only","source":"default"}` — **没有 mode 文件**，默认 audit_only。不是 off（off 时 `authorizeLeadWrite` 直接返回无 provenance 的 `{disposition:"off"}`，:2414）。
- 14 个 claude-code Lead 全部：`ready=false, bound=false, holderAlive=false`，generation 78-86，holder pid 死，lstart `Mon Aug 10 08:35:59 → 08:38:37`。
- **`bound=false` 的含义**：行处于 acquired-but-never-bound（`bound_at IS NULL`，holder tuple = acquire 时写入的 supervisor tuple）。即最后一批 v1 supervisor 在 08:35-38 acquire 后、bind 前被 cutover 停掉。与「最后一次成功 bind 在 08:35-38」的表述差半格，但对修复方案的影响相同且更有利（见 F5 ★）。
- `~/.flywheel/projects.json`：16 个 Lead 中 14 个 `carrier=v2`（claude-code），2 个 Codex backend（growth/mufasa-lead、flywheel/codex-infra-bot-lead）→ 归 FLY-1632，本单不动。

**audit_only 下为什么还是硬错**：audit_only 只影响 `denyOrAudit`（把 enforce 的拒绝降级为放行+审计，:2558-2564）。v2 的失败根本不经过 denyOrAudit——passthrough 正常返回、但 provenance 缺字段，handle-receipt 自己抛错。所以 audit_only 救不了收据。

**pre-cutover 为什么能工作**：v1 完整链 = acquire（:4537）→ 建窗 → bind（:2621）→ env claim 注入（:2984）→ `authorizeLeadWrite` 走 :2632 完整校验 → `lease_validated` + 完整 provenance → 双层合同通过。

## 3. 修复所需的现有基础设施（全部已就位）

| 设施 | 位置 | v2 block 内可用性 |
| --- | --- | --- |
| `lead_identity_prepare_lease` / `lead_identity_bind_lease` | `packages/teamlead/scripts/lib/lead-identity-preflight.sh:29,178` | ✅ lib 在 `claude-lead.sh:220` source，早于 v2 block |
| `FLYWHEEL_COMM_CLI` | `claude-lead.sh:484` export | ✅ |
| `LEAD_LEASE_SUPERVISOR_START`（v2 分支：`ps -p $$ -o lstart=`） | `claude-lead.sh:4095-4099` | ✅ 已在 v2 block 之前计算 |
| env claim 注入 | `claude-lead.sh:2984-2991`（`_launch_claude` 共用） | ✅ 只要 v2 block 设好 `LEAD_LEASE_KEY/LEAD_LEASE_GENERATION` 即生效，零改动 |
| `interruptible_sleep` | `claude-lead.sh:109` | ✅ |
| `_lead_identity_alert` + `LEAD_ALERT_SH` | `claude-lead.sh:4487-4497` | ❌ **定义在 v2 block 之后** — 需把定义上移（纯移动，v1 字节语义不变） |
| alert 去重 | `lead-alert.sh` claims.db（FLY-83/1082 体系） | ✅ 重试循环里重复调用不会刷屏 |

## 4. authorizeLeadWrite 改动点的行为矩阵（改动前 → 改动后）

前提：backend=claude-code、projects carrier=v2、env `FLYWHEEL_LEAD_CARRIER=v2`。

| env claim 状态 | 现行为 | 新行为 | 影响 |
| --- | --- | --- | --- |
| 无 `FLYWHEEL_LEAD_LEASE_KEY` 且无 `FLYWHEEL_LEAD_GENERATION` | passthrough | **passthrough（字节不变）** | 旧 body 混跑期 forward-compat；普通写入不回归 |
| claim 齐全且 `store.validate` 通过 | passthrough（无 sender 字段）| **`lease_validated` + 完整 provenance** | 收据合同满足；send/reply 的 provenance 也变强（多记 sender 字段，仅增益）|
| claim 齐全但 stale/unbound/missing | passthrough | `denyOrAudit(reason)`：audit_only → `audit_allowed`（`attachClaimedHolder` :2470-2488 会在 history 存在时附上 sender 字段）；enforce → 拒绝 | 与 v1 Lead 同轨；enforce 的拒绝正是 split-brain 防护本意 |
| claim 只有一半 | passthrough | `denyOrAudit("missing_or_mismatched_claim")` | 配置残缺显性化，audit_only 下不致断 |
| store 打不开 | passthrough | `denyOrAudit("lease_store_error")` | 与 v1 同轨；audit_only 放行普通写入，收据 fail-closed（FLY-1309 既定取舍）|

注意顺序：claim 判定必须放在 :2603 的 passthrough 条件里（claim 存在→不 passthrough→自然落到 :2632 完整校验），`FLYWHEEL_LEAD_ID` mismatch 检查（:2585）在其之前，Codex 分支（:2613）因 backend 不同不受影响。

## 5. v2 身份步的状态处理表（prepare 返回码 → v2 动作）

`lead_identity_prepare_lease` 返回码语义（lib :29-176）：

| rc | 含义 | v1 supervisor 行为 | v2 body 应对 |
| --- | --- | --- | --- |
| 0 + `LEAD_LEASE_FRESH=1` | acquired/idempotent，拿到新 generation（unbound） | 建窗后 bind | **立即 bind**（supervisor tuple = pane tuple = `$$` + lstart，同一进程）→ 设 env claim → launch |
| 0 + `LEAD_LEASE_DEGRADED=store_error` | store 打不开，fail-open at launch | 降级 launch，无 claim | 同 v1：降级 launch（带 `FLYWHEEL_LEAD_LEASE_DEGRADED` 标记）+ 告警；收据保持 fail-closed |
| 3 | resolve/acquire 被拒（含 `denied_holder_alive`/`denied_sensor_degraded`） | HOLD + 退避重试 + 告警 | **告警 + 有界退避重试（3s→30s），不 exit**。exit 会杀私有 tmux server → launchd 整体重建 → cmux 窗口翻动（FLY-1672/1596 治过的抖动），故重试留在 body 内 |
| 4 | `holder_orphaned`（行已 bound、supervisor 死、holder 活） | adopt 该 body | v2 下 supervisor≡holder（同进程），此形状只能来自 v1 遗留行或病理状态。**不 adopt**（one-shot body 没有「接管别人 pane」的语义）→ 按 rc 3 同路径告警+重试；旧 holder 死掉后 acquire 自然翻成 rc 0 |
| 5 | `idempotent_adopted`（requester 就是 supervisor、holder 活） | 继续监控 | v2 下同 tuple 重入不可能（one-shot 进程一次一世代）→ 按 rc 3 同路径处理（防御性归并，不单列分支）|

bind 返回 `stale_generation`（竞态：另一个 body 抢先 acquire 了 gen+1）→ 按 rc 3 同路径重试（下轮 prepare 会重新判定谁该持有）。

## 6. 现存 16 行陈旧数据的自愈路径（无需手术）

当前行形状 = unbound + supervisor tuple 已死。新代码 body 启动 → `acquire`：走 `lead-lease.ts:572`（`bound_at === null`）→ supervisor 死 → 落 :659 `INSERT` gen+1 → `acquired` → bind 成功。**每个 Lead 重启一次即自愈，lease.db 零手工改动。**

pid 复用不构成威胁：存活判定是 pid+lstart 双元组（`processAliveWithStart` :293-310）。

活着的旧 Lead **无法原地修复**：claim 是 env，无法注入活进程。修复生效 = merge + 舰队重启（标准 self-ship restart 流程，founder-gated）。

## 7. 测试缝（TDD 落点）

- **shell 单测**：`packages/teamlead/scripts/__tests__/test-lead-identity-preflight.sh` 已有「source lib + 覆写 `lead_identity_cli` 函数」的成熟模式（lib :24-27 明示这是 test seam）。新的 v2 身份步函数放进 `lead-identity-preflight.sh`（而非内联在 claude-lead.sh），即可用同一模式单测全部 rc 分支。
- **launch-plan e2e（dry-run）**：`FLYWHEEL_LEAD_DRY_RUN=1` 下 `_launch_claude` 在真启动前输出 `LAUNCH_PLAN`（:3080-3083，v2 路径同样经过）。参照 `fly231-companion-launch-plan.test.sh` / `fly879-external-launch-plan.test.sh` 的驱动方式，跑 `FLYWHEEL_LEAD_BODY_V2=1` + 隔离 `FLYWHEEL_LEAD_LEASE_DB` + stub `FLYWHEEL_COMM_CLI`（一个说 JSON 协议的 stub .js），断言 plan 含 `FLYWHEEL_LEAD_LEASE_KEY`/`FLYWHEEL_LEAD_GENERATION`。反向对照：v1 路径（不设 `FLYWHEEL_LEAD_BODY_V2`）plan 字节不变。
- **TS 单测**：`packages/flywheel-comm/src/__tests__/lead-lease-enforce.test.ts` 已有 env fixture + `setMode` + `writeProjects` 全套（:500-600 附近有 carrier 案例）。新增第 4 节矩阵的各行；`handle-receipt` 走通/走不通各一例。
- **reverse-compat sentinel**：claim-absent passthrough 字节不变（老 body + 新 CLI 混跑窗口）。

## 8. 风险与开放点（供 plan 定案）

1. **世代按 body 重启递增**：v2 每次 body 重启（launchd respawn）都会 acquire 新 generation；v1 是 supervisor 存活期内复用。generation 是审计粒度不是稳定 id，检索过 `senderGeneration` 消费方（sender-ref/db 记录、audit），无稳定性假设。风险低，plan 里记为已确认。
2. **dry-run 会真 acquire**：设计选择让身份步在 dry-run 下也运行（launch plan 要能证明 claim 注入），测试用隔离 DB；手工对生产 dry-run 会白 bump 一个 generation（unbound、下次真启动自愈）。可接受，文档注明。
3. **enforce 切换的将来**：本单不动 mode（保持 audit_only default）。矩阵第 3 行在 enforce 下会真拒绝 stale claim——那是 FLY-1309 设计意图，不是本单引入。
4. **passthrough 的最终移除**：留给后续收敛单（需全舰新 body 各自完成 ≥1 次 bind 之后），本单不做。
