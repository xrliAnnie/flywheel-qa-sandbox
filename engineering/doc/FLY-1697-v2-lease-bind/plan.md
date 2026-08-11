# FLY-1697 全舰 lease 无出口 — 实施计划

Issue: FLY-1697 (https://linear.app/geoforge3d/issue/FLY-1697/全舰无出口-lease-只在建窗分支绑定launchd-native-走adopt分支-16-个-lead-全部无法-ack-任何收据已持续)
日期: 2026-08-11
基于: research.md
Codex design review: R1 5 项、R2 4 项、R3 3 项全采纳（本版为 R4 稿）

## 0. 一句话

launchd-native（v2）Lead body 从不 acquire/bind lease、pane env 无 claim、且 `authorizeLeadWrite` 的 carrier_passthrough 在 claim 校验之前短路 —— 三层叠加把收据结算唯一出口（`handle-receipt`）全舰关死；修法 = **v2 body 启动时显式 acquire+bind（issue 选项 B，落点在 v2 block 而非 v1 loop）+ authorizeLeadWrite claim 优先于 passthrough**，不加 flag、不动 DB、不改收据数据层合同。

## 1. Lead 裁决要求的落实（简报 7ff19ea2 / 增补 766d0ff2 / 定性升级 2f1b52aa）

### 1.1 可证伪因果验证（增补①）— 已跑，结果：细节证伪、机制强化

- 被检验命题：「08:36–08:38 窗进程的 lease 应有效（最后一次成功绑定）」。
- 实测（2026-08-11 `lead-lease readiness --json`，14/14 claude-code Lead）：**全部 `bound=false`**，holder tuple = acquire 初值（supervisor pid+lstart，全死，lstart 集中 08:35:59–08:38:37），generation 65–132。
- ⇒ 08:36 窗的行**从来不是有效绑定**，是 acquire-then-killed（v1 最后一波 supervisor acquire 后、建窗+bind 前被 cutover 停掉）。「最后一次成功 bind = 08:35–38」被证伪。
- ⇒ 但机制结论**强化而非推翻**：Aug 10 23:37 全舰 v2 重启后 generation 数字零变化 —— v2 波对 lease store **零写入**，直接实证「v2 路径根本不 acquire」。因果闭环：inbox 结清停在 carrier 切换点（最后 processed=06:52:37Z）↔ v2 child 无 claim env + passthrough 无 provenance ↔ 双层合同（handle-receipt.ts:39 + db.ts:2696）拒绝。
- 附带更正一个转述：`flywheel-eng-lead` 并非没有 lease 行（gen=132 存在），`lease status` 显示 null 是「无当代有效世代」的投影，不影响任何结论。

### 1.2 adopt 并发判定（简报③ / 增补②，按三条标准）

- **CAS 语义**：`bind`（lead-lease.ts:705-760）CAS 要求 `bound_at IS NULL` 且 holder=supervisor tuple —— 对 adopt 场景（行已 bound）必然 `stale_generation`。⇒ 按 Lead 给的判定标准走「**CAS 拒绝 → 守卫后进 adopt**」一侧：adopt 分支不 bind 是**故意且正确**，选项 A 关死。
- **谁可能同时 adopt**：v1 语义里 adopt = 新 supervisor 接管「lease 仍绑着、进程仍活着」的旧 body；acquire 的 `holder_orphaned`/`denied_holder_alive` 分类（:612-655）+ bind CAS 共同防两进程抢同一 key。v2 下 supervisor≡holder（同进程），`holder_orphaned` 形状只能来自 v1 遗留行 —— v2 不引入新的并发 adopt 情形。
- **旧世代 16 行的接管语义**：当前形状 = unbound + supervisor 死 → `acquire` 走 :572→:659 `INSERT gen+1`。**显式语义：直接翻代，不 adopt、不手术。**
- 结论与 Lead 初步倾向一致：**选项 B（bind 抽成启动路径显式一步）**，落点修正为 v2 one-shot block（生产唯一路径；v1 loop 字节不动）。

### 1.3 定性升级的边界纪律（2f1b52aa）

- `chat-receipt.ts` 对 `carrier===inbox` 的 `ignored_inbox` 是既有意图，**本单零接触**；修复对象只有 lease bind + authorize 顺序。
- `flywheel_inbox_ack_batch` 批次机制**零接触**。
- 验收唯一有效形态 = 正对照（见 §5）；readiness 绿、单测绿都只是必要条件。

## 2. 改动 1（shell）：v2 body 身份步

### 2.1 新 lib 函数 — `packages/teamlead/scripts/lib/lead-identity-preflight.sh`

新增 `lead_identity_v2_acquire_bind()`（Bash 3.2、无 trap、无 shell-opt 改动，延续该文件契约）：

```bash
# FLY-1697: launchd-native (v2) body identity step. The v2 body process is its
# own supervisor AND holder (one pid+lstart tuple), so acquire and bind happen
# back-to-back before any receipt/session side effect.
# rc 0: bound; LEAD_LEASE_KEY/LEAD_LEASE_GENERATION carry the claim.
# rc 1: degraded store (LEAD_LEASE_DEGRADED set); launch proceeds without claim.
# rc 2: held (LEAD_LEASE_HOLD_REASON set); caller alerts and retries.
lead_identity_v2_acquire_bind() {
  local lead_id="$1" project="$2" body_pid="$3" body_start="$4"
  local prepare_rc=0 bind_rc=0 verify_rc=0
  if [ -z "$body_start" ]; then
    LEAD_LEASE_KEY=""
    LEAD_LEASE_GENERATION=""
    LEAD_LEASE_DEGRADED="store_error"
    LEAD_LEASE_HOLD_REASON=""
    return 1
  fi
  lead_identity_prepare_lease "$lead_id" "$project" "$body_pid" "$body_start" \
    || prepare_rc=$?
  case "$prepare_rc" in
    0)
      if [ -n "$LEAD_LEASE_KEY" ] && [ -n "$LEAD_LEASE_GENERATION" ]; then
        lead_identity_bind_lease \
          "$LEAD_LEASE_KEY" "$LEAD_LEASE_GENERATION" \
          "$body_pid" "$body_start" "$body_pid" "$body_start" || bind_rc=$?
        [ "$bind_rc" -ne 0 ] || return 0
        if [ "$bind_rc" -eq 2 ]; then
          # The bind CLI itself reported a store fault — not a race.
          LEAD_LEASE_HOLD_REASON="v2_bind_store_error"
          return 2
        fi
        # Ambiguous bind: the store transaction may have committed even though
        # the CLI reported failure (killed after commit / lost response). Read
        # back with the exact tuple before classifying (Codex R1 HIGH-1).
        lead_identity_v2_verify_bound \
          "$LEAD_LEASE_KEY" "$body_pid" "$body_start" || verify_rc=$?
        case "$verify_rc" in
          0) return 0 ;;
          2) LEAD_LEASE_HOLD_REASON="v2_bind_verify_store_error" ;;
          *) LEAD_LEASE_HOLD_REASON="v2_bind_unverified" ;;
        esac
        return 2
      fi
      return 1   # store_error degraded launch (fail-open at launch only)
      ;;
    4)
      # Legacy bound row with a live foreign holder. One-shot bodies never
      # adopt someone else's pane; hold until the holder exits.
      LEAD_LEASE_HOLD_REASON="denied_holder_alive"
      return 2
      ;;
    5)
      # idempotent_adopted: WE are the recorded supervisor and the holder is
      # alive. When the holder tuple is exactly this body, this is the legal
      # recovery state after an ambiguous bind (commit landed, response lost):
      # prepare already exported LEAD_LEASE_KEY/LEAD_LEASE_GENERATION.
      if [ "$LEAD_LEASE_ORPHAN_HOLDER_PID" = "$body_pid" ] \
        && [ "$LEAD_LEASE_ORPHAN_HOLDER_START" = "$body_start" ]; then
        return 0
      fi
      LEAD_LEASE_HOLD_REASON="denied_holder_alive"
      return 2
      ;;
    *)
      # rc 3: hold (denied_holder_alive / denied_sensor_degraded / identity_*).
      [ -n "${LEAD_LEASE_HOLD_REASON:-}" ] \
        || LEAD_LEASE_HOLD_REASON="v2_unexpected_prepare_rc_${prepare_rc}"
      return 2
      ;;
  esac
}

# Read-after-write disambiguation for a bind whose CLI response was lost.
# rc 0 only when the store's current row is bound to exactly this tuple;
# rc 2 store/CLI error; rc 1 definite non-match (unbound / mismatch reasons).
lead_identity_v2_verify_bound() {
  local lead_key="$1" body_pid="$2" body_start="$3" output="" rc=0 status=""
  output="$(lead_identity_cli verify-bound \
    --lead-key "$lead_key" \
    --supervisor-pid "$body_pid" \
    --supervisor-start "$body_start" \
    --holder-pid "$body_pid" \
    --holder-start "$body_start" \
    --json)" || rc=$?
  [ "$rc" -ne 2 ] || return 2
  status="$(printf '%s' "$output" | lead_identity_json_field status 2>/dev/null || true)"
  [ "$status" = "verified" ]
}

# Pure (reason, consecutive-count) -> alert classification (unit-testable;
# sourced by the v2 block). Prints the alert kind, or nothing when this pass
# must stay silent. `count` = consecutive passes with this same reason.
lead_identity_v2_hold_alert_kind() {
  local reason="$1" count="${2:-1}"
  case "$reason" in
    denied_holder_alive) printf 'lead_dual_active\n' ;;
    denied_sensor_degraded) printf 'lead_dual_active_sensor_degraded\n' ;;
    v2_bind_store_error|v2_bind_verify_store_error) printf 'lead_lease_store_broken\n' ;;
    v2_bind_unverified)
      # First definite mismatch stays silent (an in-flight race resolves via
      # the next prepare round). A REPEAT of the same reason means the row is
      # persistently self-unbound (acquire keeps answering `idempotent`, so
      # prepare will never reclassify) — escalate on a non-dual kind instead
      # of holding silently forever (Codex R3 HIGH-1).
      [ "$count" -lt 2 ] || printf 'lead_identity_source_broken\n'
      ;;
    *) printf 'lead_identity_source_broken\n' ;;
  esac
}
```

要点：
- **rc 5 自身 tuple 收敛为成功**（Codex R1 HIGH-1）：`bind` 在单事务里先提交行+history 再由 CLI 返回（lead-lease.ts:709-754）；提交后 CLI 被杀/响应丢失 → 下一轮 `acquire` 对「requester=supervisor 且 holder 活」返回 `idempotent_adopted`（:589-605），holder tuple 正是本 body —— 这是模糊完成的合法恢复态，不是 HOLD。非本体 tuple 的 rc 5（理论上仅 pid+lstart 双复用才可能）保持 HOLD，分类 `denied_holder_alive`。
- **bind 非成功先分来源、再 `verify-bound` 读后判定**（R1 HIGH-1 + R3 HIGH-1）：bind CLI 自身 rc 2（store 错）→ `v2_bind_store_error`，不做 verify；其余非成功走 `verify-bound`（commands/lead-lease.ts:358）exact-tuple 核验：verified → 成功；CLI rc 2 → `v2_bind_verify_store_error`；definite mismatch（unbound / holder_mismatch / supervisor_mismatch / missing_history）→ `v2_bind_unverified`。
- **`v2_bind_unverified` 首轮静默、重复升级**（Codex R2 #2 + R3 HIGH-1）：单次 mismatch 不是「live holder」证据——真竞态会在下一轮 `prepare` 拿到权威分类（活 holder → `denied_holder_alive` → `lead_dual_active`）。但 **self-unbound 行的持续 bind 失败不会被 prepare 重分类**：unbound + 本体 tuple 的行会让 `acquire` 在任何 liveness 判定之前直接返回 `idempotent`（lead-lease.ts:514-553），每轮都回到同一 mismatch —— 故同一 reason 连续第 2 次起升级为 `lead_identity_source_broken`（非 dual 族，不占 `lead_dual_active` 当日 claims.db 名额），成功或 reason 变化即重置计数。无任何静默无限 HOLD 路径。
- **分类是纯函数** `lead_identity_v2_hold_alert_kind(reason, count)`（可 source、可单测）：holder-alive 族（prepare 证明过的 `denied_holder_alive`，含 rc 4 / 非本体 rc 5）→ `lead_dual_active`；传感器族 → `lead_dual_active_sensor_degraded`；bind/verify store 错 → `lead_lease_store_broken`；`v2_bind_unverified` count 1 → 静默、count ≥2 → `lead_identity_source_broken`；其余（identity_* / 未知）→ `lead_identity_source_broken`。
- rc 4（`holder_orphaned`：行已 bound、supervisor 死、holder 活）在 v2 下**不 adopt**——one-shot body 没有「接管别人 pane」的语义；held（`denied_holder_alive` 分类），旧 holder 死后 acquire 自然翻成 rc 0（§1.2）。
- 绝不强抢：所有 held 态都交给下一轮 `prepare` 重新裁决，无任何覆写路径。

### 2.2 claude-lead.sh v2 block 集成

位置：v2 one-shot block 起点（`claude-lead.sh:4368` 的 `if [ "${FLYWHEEL_LEAD_BODY_V2:-0}" = "1" ]` 内、session resume/fresh 决策**之前**）——身份未定不消费任何会话决策、不发 bootstrap。dry-run 分流在 :4281-4285 已经 `exit 0`，**先于本步**：dry-run 的 zero-side-effect 合同不变（Codex R1 HIGH-2），身份步只在真启动路径运行。

```bash
  # FLY-1697: identity before any side effect. Held states retry inside the
  # body (exiting would kill the private tmux server and churn cmux windows).
  _v2_identity_backoff=3
  _v2_identity_rc=0
  _v2_hold_streak=0
  _v2_prev_hold_reason=""
  while :; do
    _v2_identity_rc=0
    lead_identity_v2_acquire_bind \
      "$LEAD_ID" "$PROJECT_NAME" "$$" "$LEAD_LEASE_SUPERVISOR_START" \
      || _v2_identity_rc=$?
    [ "$_v2_identity_rc" -eq 2 ] || break
    if [ "$LEAD_LEASE_HOLD_REASON" = "$_v2_prev_hold_reason" ]; then
      _v2_hold_streak=$((_v2_hold_streak + 1))
    else
      _v2_hold_streak=1
      _v2_prev_hold_reason="$LEAD_LEASE_HOLD_REASON"
    fi
    _v2_alert_kind="$(lead_identity_v2_hold_alert_kind \
      "$LEAD_LEASE_HOLD_REASON" "$_v2_hold_streak")"
    if [ -n "$_v2_alert_kind" ]; then
      _lead_identity_alert "$_v2_alert_kind" \
        "Lead identity held before launch" \
        "${PROJECT_NAME}/${LEAD_ID} is held before launch: ${LEAD_LEASE_HOLD_REASON}."
    fi
    log "Lead identity HOLD (${LEAD_LEASE_HOLD_REASON}); retrying in ${_v2_identity_backoff}s"
    interruptible_sleep "$_v2_identity_backoff"
    if [ "$SHOULD_EXIT" -ne 0 ]; then
      log "Shutdown requested during identity hold — exiting body."
      exit 0
    fi
    [ "$_v2_identity_backoff" -ge 30 ] || _v2_identity_backoff=$((_v2_identity_backoff * 2))
    [ "$_v2_identity_backoff" -le 30 ] || _v2_identity_backoff=30
  done
  if [ "$_v2_identity_rc" -eq 1 ]; then
    log "WARNING: Lead lease store unavailable; launching degraded without a generation claim"
    _lead_identity_alert lead_lease_store_broken \
      "Lead lease store unavailable" \
      "${PROJECT_NAME}/${LEAD_ID} could not acquire its identity lease; launch is degraded and receipt settlement remains fail-closed."
  fi
```

告警分类裁决（Codex R1 LOW-5 + R2 #2 + R3 HIGH-1）：`lead-alert.sh` 的 claims.db 按 `(project, lead, kind, 当日)` 去重，混类会互吞 —— 分类收敛为纯函数 `lead_identity_v2_hold_alert_kind(reason, count)`（§2.1），v2 block 维护同 reason 连续计数并只消费其输出；`v2_bind_unverified` 首轮静默、连续第 2 轮起升级 `lead_identity_source_broken`（self-unbound 行 prepare 无法重分类，不许静默无限 HOLD）。分类函数全表进单测（§4.1 case 8）。

配套小改：
- `_lead_identity_alert()` + `LEAD_ALERT_SH`（现 `claude-lead.sh:4485-4497`）定义**上移**到 v2 block 之前（纯移动；v1 语义字节不变）。
- env claim 注入**零改动**：`_launch_claude` 既有逻辑（:2984-2991）在 `LEAD_LEASE_KEY/LEAD_LEASE_GENERATION` 就位后自动把 `FLYWHEEL_LEAD_LEASE_KEY`/`FLYWHEEL_LEAD_GENERATION` 带进 pane env；degraded 时自动注入 `FLYWHEEL_LEAD_LEASE_DEGRADED`。
- v1 supervisor loop、create/adopt 分支、`ensure_tmux_session`、dry-run 分流：**字节不动**。

### 2.3 明确不做

- 不在 launchd wrapper / launcher 绑（issue 选项 C）：launcher 在 exec tmux 前拿不到 pane 身份。
- 不给 v1 adopt 分支加 bind（选项 A）：§1.2 已关死。
- 不放宽 handle-receipt 双层数据合同（探索里的选项 D）。
- 不做 lease.db 手术：现存 16 行形状（unbound+supervisor 死）由 `acquire` 的 :572→:659 路径自然翻代。
- 不让 dry-run 产生任何 store 副作用（HIGH-2 裁决：保留既有合同）。

## 3. 改动 2（TypeScript）：authorizeLeadWrite claim 优先于 passthrough

`packages/flywheel-comm/src/lead-lease.ts:2603-2612`：

```ts
if (
  backend === "claude-code" &&
  resolution.lead.carrier === "v2" &&
  env.FLYWHEEL_LEAD_CARRIER === "v2" &&
  !env.FLYWHEEL_LEAD_LEASE_KEY &&
  !env.FLYWHEEL_LEAD_GENERATION &&
  !env.FLYWHEEL_LEAD_LEASE_DEGRADED
) {
  return {
    disposition: "carrier_passthrough",
    provenance: writerProvenance,
  };
}
```

- claim（任一 env 字段）存在 → 不 passthrough，自然落到既有完整校验（:2632-2658），与 v1 Lead 同轨 → `lease_validated` + senderLeaseKey/senderGeneration provenance → 双层收据合同满足。
- **degraded marker 存在也不 passthrough**（Codex R2 HIGH-1）：新 v2 body 在 store 故障时注入 `FLYWHEEL_LEAD_LEASE_DEGRADED`（无 key/gen，:2984-2991）——若仍 passthrough，enforce 模式下普通写入被放行，违反 lib 既有合同「fail-open at launch only; enforce-mode writes remain fail closed」（lead-identity-preflight.sh:109-115 注释）。加上 `!env.FLYWHEEL_LEAD_LEASE_DEGRADED` 后：degraded body 落入完整路径 → 无 claim → `denyOrAudit("missing_or_mismatched_claim")` → audit_only 观察放行、enforce 真拒。旧 body 从不设该 marker，混跑字节兼容不受影响。
- claim 与 degraded marker 全缺席 → **字节不变的 passthrough**（旧 body 混跑窗口 forward-compat；行为矩阵全表见 research §4，加 degraded 行）。
- 半残 claim → 落入校验 → `denyOrAudit("missing_or_mismatched_claim")`：audit_only（生产现状）放行普通写入 + 审计，收据按 §3.1 裁决；配置残缺显性化而非静默。
- 不加任何 flag（FLY-1466 铁律）；不动 mode（保持 audit_only default）；Codex 分支（:2613）与 FLY-1632 零接触。
- 部署次序建议（非硬约束）：TS 侧（CLI dist）先于 body 重启生效，缩短 enforce 语义缺口；两个方向的混跑都不恶化现状（§6）。

### 3.1 audit_only 下 stale claim 的收据语义 — 显式裁决（Codex R1 MEDIUM-4）

事实：claim-first 后，stale-but-has-history 的 claim 在 audit_only 下经 `attachClaimedHolder`（:2470-2488）拿到含 sender 字段的 `audit_allowed` provenance，而 handleReceipt 双层只查 sender 字段不查 disposition —— 即 **stale 世代在 audit_only 下能结算收据**，这相对「passthrough 时代收据全死」是新增可达行为。

**裁决：接受，这是 v1 语义的等价恢复，不是新洞。** 理由：
1. cutover 之前 v1 Lead 的 stale claim 在 audit_only 下走的就是同一条 attachClaimedHolder → audit_allowed → 收据可结算的路径；本单恢复的是 pre-cutover 现状，不放宽任何层。
2. audit_only 的设计语义就是「观察不拦截」：正常路径下每次 stale 结算写 `would_block` fault audit（:2559）。**审计是 best-effort，不是合同**（Codex R2 #4）：`persistFault` 在 audit 写失败时仅发 `lead_lease_store_broken` 告警后返回（:2493-2504），settlement 不 fail-close —— 本单不改这个既有合同，风险表如实表述，并加 audit-write-failure 用例（§4.3 case 3b）。
3. enforce 模式下同一形状被真拒（`LeadLeaseDeniedError`）—— split-brain 硬防护归 enforce，这正是 FLY-1309 的模式分层。

因此本计划**不再声称「收据行为零变化」**，准确表述为：**数据层合同（双层 sender 字段要求）零变化；authorize 层恢复 v1 同轨行为，audit_only 下 stale 结算可达、正常路径被审计（审计写失败时 best-effort 告警、放行不回滚）**。测试双向钉死（§4.3 case 3）。

## 4. TDD（RED → GREEN，全部先写）

### 4.1 shell 单测 — 扩展 `packages/teamlead/scripts/__tests__/test-lead-identity-preflight.sh`

沿用「source lib + 覆写 `lead_identity_cli`」既有模式（stub 仅限本层；lib :24-27 明示 test seam），覆盖 `lead_identity_v2_acquire_bind` / `lead_identity_v2_verify_bound` / `lead_identity_v2_hold_alert_kind`。**恢复链用例必须是 store 语义上真实的状态序列**（Codex R3 #2 —— mismatch→rc 5 是互斥态，不许出现在同一序列里）：
1. acquire ok（fresh）→ bind bound → rc 0，KEY/GENERATION 就位。
2. **恢复链三条真实状态机**（R1 HIGH-1 + R3 #2）：
   - ① bind 报失败 + verify definite mismatch（`v2_bind_unverified`）→ 下一轮 acquire 返回 **`idempotent`**（self-unbound 行）+ bind 成功 → rc 0，**同 generation**；
   - ② 同一 mismatch 连续两轮 → `lead_identity_v2_hold_alert_kind(reason, 2)` 输出 `lead_identity_source_broken`（有界升级，无静默死锁）；
   - ③ bind 报失败 + verify rc 2（不可判定）→ 下一轮 prepare 返回 **rc 5 + 本体 tuple**（bind 实际已提交的形状）→ rc 0，**同 generation**。
3. bind CLI rc 2 → rc 2，`v2_bind_store_error`（不做 verify）；verify CLI rc 2 → rc 2，`v2_bind_verify_store_error`。
4. rc 5 + 非本体 holder tuple → rc 2，`denied_holder_alive`。
5. rc 4（holder_orphaned）→ rc 2，`denied_holder_alive`（v2 不 adopt）。
6. store error（CLI exit 2 / status error）→ rc 1，`LEAD_LEASE_DEGRADED=store_error`。
7. `body_start` 空 → rc 1 degraded，不碰 CLI。
8. `lead_identity_v2_hold_alert_kind` 全表（含 count 维度）：`denied_holder_alive`→`lead_dual_active`；`denied_sensor_degraded`→`lead_dual_active_sensor_degraded`；`v2_bind_store_error`/`v2_bind_verify_store_error`→`lead_lease_store_broken`；`v2_bind_unverified` count 1→**空（静默）**、count 2→`lead_identity_source_broken`；`identity_source_error`/未知→`lead_identity_source_broken`。
9. 卫生断言：helper 内部临时变量全 `local`（source-only lib 不得向调用 shell 泄漏全局，R3 #2）。

### 4.2 hermetic v2 harness e2e — 新 `fly1697-v2-lease-body.test.sh`（Codex R1 HIGH-2/MEDIUM-3 + R2 #3 重设计）

**不走 dry-run**（其在 :4281 先于 v2 block 退出，且必须保持零副作用）。**入口用真实 `lead-body.sh` + manifest**（Codex R2 #3：`FLYWHEEL_LEAD_CARRIER=v2` 等生产投影只在 `lead-body.sh:47-58`，直接设 `FLYWHEEL_LEAD_BODY_V2=1` 跑 claude-lead.sh 会漏掉），复用/扩展既有 `scripts/__tests__/fly1663-lead-v2-runtime.test.sh` 的驱动模式：
- 隔离 `HOME`（temp）；**同一份** carrier v2 最小 projects fixture 写到两处消费点：`${HOME}/.flywheel/projects.json`（`ProjectConfig.loadProjects()` 读取，ProjectConfig.ts:290-317）+ `FLYWHEEL_PROJECTS_FILE` 指向同一文件（lease CLI 读取）——两个消费者不同源是 R2 #3 点名的坑。
- `FLYWHEEL_LEAD_LEASE_DB`（temp store）；`FLYWHEEL_COMM_CLI` 指向**真实构建的 `packages/flywheel-comm/dist/index.js`**（不是协议 stub —— 断言必须穿过真 `LeadLeaseStore.acquire/bind`）。
- PATH shim：fake `claude` child（dump 自身 env 到文件后退出 0）+ **确定性 `agent-team-transport` shim**（非 dry-run 路径在 claude-lead.sh:4243-4268 硬依赖，缺了会 FATAL 在身份步之前；参照 `fly231-companion-launch-plan.test.sh` 的做法）。
- 预置 `SESSION_ID_FILE` 走 resume 路径（跳过 `send_bootstrap` 的 Bridge 依赖）。tmux 非必需（v2 `_launch_claude` 直接 spawn child，结尾 `tmux kill-server` 有 `|| true` 兜底）。

断言：
1. 正常路径：隔离 store 里该 key 行 `bound_at` 非空、holder=body tuple、有 history 行；fake child dump 出的 env 含 `FLYWHEEL_LEAD_LEASE_KEY` + `FLYWHEEL_LEAD_GENERATION`。
2. 陈旧行预置（unbound + 死 supervisor tuple —— 生产形状复刻）→ 启动后 generation+1 且 bound（§1.1 翻代语义钉进测试）。
3. degraded：store 路径不可开 → child env 含 `FLYWHEEL_LEAD_LEASE_DEGRADED`、无 claim 条目；body 仍完成启动。
4. **变异对照**（防 vacuous green，记忆规则；对 **scratch copy** 做，不碰工作区源文件）：scratch 副本删去 v2 身份步调用重跑 → 断言 1 必红。
5. 反向对照（reverse-compat）：v1 形状（不经 lead-body.sh）+ `FLYWHEEL_LEAD_DRY_RUN=1` 的 LAUNCH_PLAN 与改动前字节一致；且 dry-run 全程对隔离 lease store 零写入（HIGH-2 合同 sentinel）。

### 4.3 TS 单测 — `packages/flywheel-comm/src/__tests__/lead-lease-enforce.test.ts` + handle-receipt 用例

沿用既有 env fixture / `setMode` / `writeProjects`：
1. carrier v2 + 无 claim 无 degraded → `carrier_passthrough`（字节回归 sentinel）。
2. carrier v2 + 有效 claim（acquire+bind 后）→ `lease_validated`，provenance 含 sender 字段；`handleReceipt --action ack` 全链走通（真 CommDB，收据行落 settlement）。
3. **§3.1 裁决双向钉死**：carrier v2 + stale-history claim：audit_only → `audit_allowed` 且 `handleReceipt` 结算成功 + `would_block` fault audit 落账（正例）；enforce → `LeadLeaseDeniedError`（反例）。**3b（R2 #4 + R3 #3）**：确定性 seam —— 在**已绑定且可读**的测试 DB 上建 `BEFORE INSERT` fail trigger 只让 audit 表 INSERT 失败（history 仍可读，`attachClaimedHolder` 先拿到 provenance）→ 断言 settlement 成功 + `lead_lease_store_broken` 告警路径触发（best-effort 合同如实钉死；不许用「整库只读/坏」——那会让 provenance 在 sender 检查前就断，测不到目标行为）。
4. **carrier v2 + degraded marker（无 claim）三向**（R2 HIGH-1）：audit_only → `audit_allowed`（missing_or_mismatched_claim 审计）；enforce → `LeadLeaseDeniedError`（写边界 fail-closed 恢复）；receipt → 仍抛既有错误（fail-closed）。
5. carrier v2 + 半残 claim → `missing_or_mismatched_claim` 路径。
6. carrier v2 + 无 claim 时 `handleReceipt` 仍抛既有错误（数据合同不放宽的 sentinel）。

### 4.4 全仓门

`pnpm lint` + `pnpm -r build` + `pnpm test:packages:run` + `scripts/__tests__` 新旧 shell 套件（FLY-224/248 教训：full repo，不只 changed files）。

## 5. 验收（正对照形态，per Lead 增补③/定性升级②；实施+QA 节点执行）

在真机重启任一 claude-code Lead 后：
1. `lead-lease readiness --json`：该 Lead `bound=true`、`holderAlive=true`、`pid` 为真实存活 body 进程、generation 相对陈旧行 +1 —— **必要条件，不构成 PASS**。
2. **正对照（唯一有效形态）**：在该 Lead 真会话内对一条 inbox 载体收据跑 `handle-receipt --action ack`（**不带 reply_to**）→ 结算成功，且该收据**真不再重投**（观察后续投递周期，重投停止为准；「不报错」不算）。
3. 负对照保持：另一个未重启的旧 Lead 同操作仍报 `requires a validated Lead lease generation`（证明修复归因于新 body 而非环境漂移）。
4. 全舰验收（ship 后）：16 Lead 中 14 个 claude-code 全部拿到当代 lease；再重启一次任意 Lead，generation 跟进 +1 且 bound（「重启后世代跟进」）。
5. Codex 2 Lead 仍走 FLY-1632，不在本单验收面。

## 6. 上线与兼容

- **生效条件**：merge + 舰队重启（标准 self-ship restart，founder-gated）。活体旧 Lead 无法原地修（claim 是 env，无法注入活进程）。
- **混跑窗口**：新 CLI + 旧 body（无 claim）→ passthrough 字节不变，普通写入零回归，收据维持现状（本来就断）；新 body + 旧 CLI dist → pane 里的 claim env 无人消费，行为同现状。两个方向都不恶化 —— 无部署顺序约束。
- **回滚**：revert 即回到现状（收据断，但无新增伤害面）；lease store 里多出的已 bound 世代对旧代码无害（v1 acquire 对 bound+死 holder 走翻代路径）。
- 版本：ship 时取空号（当前 doc/VERSION v1.55.0，多单 pending）。

## 7. 风险清单

| 风险 | 判定 |
| --- | --- |
| v2 每次 body 重启 generation +1（v1 是 supervisor 存活期复用） | 已检索 senderGeneration 消费方（sender-ref/db/audit），无稳定性假设；审计粒度变细是增益 |
| identity hold 重试循环滞留（如 v1 遗留活 holder 一直不死） | 与 v1 supervisor HOLD 语义一致：告警（claims.db 去重，三族分类不互吞）+ 退避重试，founder 可见；不 exit 避免 tmux/cmux churn |
| self-unbound 行持续 bind 失败（prepare 永远答 `idempotent`，无法重分类） | streak 有界升级（R3 HIGH-1）：同 reason 第 2 轮起 `lead_identity_source_broken` 告警，无静默无限 HOLD；成功/换 reason 重置 |
| bind 模糊完成（提交后响应丢失） | verify-bound 读后判定 + rc 5 本体 tuple 收敛，同 generation 恢复，无重复 acquire、无 HOLD 死锁（§2.1，测试 §4.1-2）|
| audit_only 下 stale claim 可结算收据 | §3.1 显式裁决：v1 同轨恢复，正常路径 `would_block` 审计可见（**审计 best-effort：写失败告警放行，不 fail-close**），enforce 真拒；双向+audit-failure 测试钉死 |
| degraded body 绕过 enforce 写边界 | passthrough 条件加 `!FLYWHEEL_LEAD_LEASE_DEGRADED`（R2 HIGH-1）：degraded 落入完整路径，enforce fail-closed 恢复；旧 body 无 marker 字节兼容 |
| enforce 模式将来开启后 stale claim 被真拒 | FLY-1309 设计意图，非本单引入；本单不动 mode |
| bind CAS 竞态导致启动延迟 | 仅同 key 并发 body 的病理情形；verify → 退避重试 → prepare 重裁决，无死锁路径 |
