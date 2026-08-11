# FLY-1697 全舰 lease 无出口 — 探索

Issue: FLY-1697 (https://linear.app/geoforge3d/issue/FLY-1697/全舰无出口-lease-只在建窗分支绑定launchd-native-走adopt分支-16-个-lead-全部无法-ack-任何收据已持续)
日期: 2026-08-11
基于: 无（起点为 Aunt Cass 的 issue 内诊断 + 本节点独立代码审计与生产实测）

## 1. 症状（照抄事实，全部已在本节点复核）

- 全舰 16 个 Lead 的 `handle-receipt` 硬报错：`receipt handling requires a validated Lead lease generation`。
- `lead-lease readiness --json` → `ok=false`；14 个 claude-code Lead 全部 `ready=false / bound=false / holderAlive=false`（本节点 2026-08-11 实测复现，非转述）。
- lease 行的 holder pid 全部已死，lstart 集中在 **Aug 10 08:35:59–08:38:37**；generation 停在 78–86 一带。
- Aug 10 23:37 全舰完整重启后 lease 行**一个都没变**——重启不自愈，已被 Aunt Cass 实证。

## 2. 独立审计结论：机制比 issue 里的诊断还深一层

Aunt Cass 的诊断（bind 只在「建窗」分支、adopt 分支不绑）**对代码的字面阅读是准确的**，但那两个分支都属于 **v1 supervisor loop**——而 v1 supervisor loop 在 launchd-native（FLY-1663/FLY-1676 cutover）之后是**不可达代码**。真实机制是三层叠加：

### 层 1：v2 one-shot body 完全不碰 lease

`packages/teamlead/scripts/lead-body.sh` 设 `FLYWHEEL_LEAD_BODY_V2=1` 后 source `claude-lead.sh`。`claude-lead.sh` 的 v2 one-shot block（`claude-lead.sh:4368-4438`）完成 resume/fresh 决策 → `_rules_bundle_commit_once` → `_launch_claude` → 写 exit receipt → `tmux kill-server` → **`exit`**。

而 lease 的全部机制——`lead_identity_prepare_lease`（resolve + acquire，`claude-lead.sh:4537`）和 `lead_identity_bind_lease`（`claude-lead.sh:2621`，建窗成功后）——都在 v2 block **之后**的 v1 supervisor loop（`while true`，约 4503 行起）里。v2 路径在 4438 行就退出了，**acquire 和 bind 一次都不会执行**。

> Aunt Cass 记录的「我走错的一步」（`claude-lead.sh` 被 source 所以 ps 里看不到）是对的；但下一步推理「代码在路径上，只是那个分支到不了」还差半格——对 v2 而言，**整个 supervisor loop（含 create 分支和 adopt 分支）都在路径之外**。

### 层 2：pane env 里没有 lease claim

v1 时代 `_launch_claude` 只在 `LEAD_LEASE_KEY`/`LEAD_LEASE_GENERATION` 非空时注入 `FLYWHEEL_LEAD_LEASE_KEY` / `FLYWHEEL_LEAD_GENERATION`（`claude-lead.sh:2984-2987`）。v2 从未 acquire，这两个变量恒空 → Claude child（以及它 spawn 的每个 `flywheel-comm` CLI 进程）**没有任何 lease claim env**。

### 层 3：`authorizeLeadWrite` 的 carrier_passthrough 不携带 generation，而 handle-receipt 硬性要求它

`packages/flywheel-comm/src/lead-lease.ts:2603-2612`（FLY-1663 引入）：backend=claude-code + projects.json `carrier:"v2"` + env `FLYWHEEL_LEAD_CARRIER=v2` → 直接返回 `disposition:"carrier_passthrough"`，provenance 只有 writerPid/writerStart，**永远没有 senderLeaseKey/senderGeneration**。

`packages/flywheel-comm/src/commands/handle-receipt.ts:39-46`（FLY-1392，2026-07-21 起就存在）硬性要求 `provenance.senderLeaseKey && provenance.senderGeneration`，否则抛出正是全舰看到的那句错。

**两条船在 Aug 9–10 交汇**：FLY-1392/1573 建立了「收据结算必须由可证明的 Lead 世代签名」的合同；FLY-1663 cutover 把 Lead 换到一条既不建世代、也不带 claim 的启动路径上，并用 passthrough 覆盖了大多数写入——唯独收据结算不在覆盖面内。普通 send/reply 等写入走 passthrough 一切正常（所以断的只有收据），收据从 cutover 那刻起全舰断路。

### 为什么 pre-cutover 一直是好的

v1 supervisor：acquire（新 generation）→ 建窗 → bind（holder=pane tuple）→ pane env 带 claim → `authorizeLeadWrite` 走完整校验 → `lease_validated` provenance 带 senderGeneration → handle-receipt 通过。整条链在 v1 是完整的。

### 为什么 lease 行是 bound=false（而不是「bound 但 holder 已死」）

生产 readiness 实测显示 16 行全部 `bound=false`，holder tuple = **supervisor** tuple（acquire 时初值）且 pid 全死、lstart 全在 Aug 10 08:35–38。这说明最后一批 v1 supervisor 在 08:35–38 完成了 **acquire**（写入新 generation、`bound_at=NULL`）之后、还没走到建窗+bind 就被 cutover 停掉了。此后 v2 路径永不 acquire，行就冻结在这个「acquired-but-never-bound」形状。

顺带解释了「lease.db mtime 还在更新但没绑定」：store 打开/WAL、audit 写入等都会碰文件，与是否 acquire 无关。

## 3. 对 issue 三个候选修法的判定（Aunt Cass 留给实现者的问题）

| 选项 | 判定 | 理由 |
| --- | --- | --- |
| **A：adopt 分支也调 bind** | **否，而且方向本身不成立** | v1 adopt 语义是「接管一个仍然活着、且 lease 仍绑在它身上的旧 body」：store 行 `bound_at` 已置、holder=活 pane、generation 未变。此时**不 bind 是故意且正确的**——`bind` 的 CAS 条件要求 `bound_at IS NULL`（lead-lease.ts:705-736），对已 bound 行必然返回 `stale_generation`；就算强行改写，也会把仍在跑的旧 Claude child 手里的 env claim 变成孤儿。更关键的是：**生产路径根本不经过 adopt 分支**（层 1）。 |
| **B：把 bind 抽成启动路径上无条件的一步** | **方向正确，落点要改** | bind 本来就不该是「建窗副作用」。但要落在 **v2 one-shot body** 里（生产唯一路径），不是改 v1 loop：v2 body 自己就是 supervisor + pane（同一进程），在 launch Claude 之前 acquire+bind 即可。v1 loop 保持字节不动（rollback/混合舰队兼容）。 |
| **C：launchd 建 tmux 时就绑** | 否 | launchd job 是 tmux server 进程本身；绑定需要 pane（body）的 pid+lstart，launcher 在 exec tmux 之前拿不到 pane 身份。body 是身份的天然拥有者。 |
| **D（本节点补充）：放宽 handle-receipt，接受 carrier_passthrough** | 否 | passthrough 的判据只是 env 自我声明（`FLYWHEEL_LEAD_CARRIER=v2`），不含任何进程存活/世代证明。放宽等于把 FLY-1392/1573 特意建立的「收据由可证明世代签名」合同拆掉，audit 链条失去归属。修恢复路径，不拆合同。 |

**结论：B（落在 v2 body）+ 必配套的 authorizeLeadWrite 修改。** 只做 B 不够——层 3 决定了即使 bind 恢复，只要 passthrough 分支还在 claim 之前短路，handle-receipt 依然拿不到 senderGeneration。两半缺一不可。

## 4. 修复形状（进入 research/plan 细化）

1. **v2 body 身份步**（shell）：v2 block 起点处（会话决策/bootstrap 之前）`lead_identity_prepare_lease` → 成功即 `lead_identity_bind_lease`（supervisor tuple = pane tuple = `$$` + lstart）→ 设 `LEAD_LEASE_KEY/LEAD_LEASE_GENERATION`，`_launch_claude` 既有注入逻辑（2984 行）自动把 claim 带进 pane env。冲突/传感器降级 → 告警 + 有界退避重试（不 exit——exit 会杀私有 tmux server 造成 cmux 窗口翻动，正是 FLY-1672/1596 治过的抖动）；store 故障 → 沿用 v1 的 degraded 放行（launch 无 claim + 降级标记，收据保持 fail-closed）。
2. **authorizeLeadWrite claim 优先**（TS）：carrier v2 分支仅在 **env 无任何 lease claim** 时才 passthrough；claim 存在则落入既有完整校验路径（与 v1 同轨）→ `lease_validated` provenance 带 senderGeneration。claim-absent 行为字节不变（旧 body 混跑期间的 forward-compat）。
3. **不需要 DB 手术**：现存 16 行是「unbound + supervisor 已死」，`acquire` 对这种形状直接 INSERT gen+1（lead-lease.ts:572→659）。修复 merge 后按标准流程重启舰队即全部自愈。**活着的旧 Lead 无法原地修**（env 无法注入活进程），重启是必要条件——这与「重启不自愈」不矛盾：不自愈的是旧代码，新代码重启即愈。
4. **不加任何新 flag**（Annie 铁律，FLY-1466）：行为以「claim 是否存在」为键，这是内在状态不是开关。

## 5. 与邻近 issue 的边界（维持 Aunt Cass 的分单，不并单）

- **FLY-1645**（settlement 写一半）：结算写入的原子性问题，机制、起点（08-05）都不同。本单只修「结算入口全断」，不碰 settlement 写入序。
- **FLY-1632**（Codex backend Lead 没有 lease 行）：mufasa / codex-infra-bot 走 `validateLeadCarrierAuthorization` carrier-evidence 路径，本单对该路径零改动。
- 本单修完后，claude-code 14 个 Lead 恢复收据结算；Codex 2 个 Lead 仍归 FLY-1632。

## 6. 诚实边界

- 本设计恢复的是 **claude-code v2 Lead** 的收据结算链，不给 Codex Lead 建 lease（FLY-1632）。
- 不改 handle-receipt 的合同（依旧要求 validated generation）；degraded store 场景下收据依旧 fail-closed——这是 FLY-1309 的既定取舍，不是本单的回归。
- passthrough 分支保留（claim-absent fallback），其最终移除留给后续单独收敛（需全舰确认新 body 已上线一个完整世代之后）。
