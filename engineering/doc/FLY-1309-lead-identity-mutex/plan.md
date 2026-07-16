# FLY-1309 Lead 身份唯一性 — 实施计划
Issue: FLY-1309 (https://linear.app/geoforge3d/issue/FLY-1309/fix-lead-身份唯一性-双进程互斥-同身份并存检测1229-改写今晚双-lead-事故根治)
日期: 2026-07-16
基于: research.md
Codex design review: **15 轮 APPROVED**(2026-07-16,xhigh;R1-R14 共 43 项 findings 全部采纳折入,R15 零遗留——「no remaining feasibility, correctness, completeness, rollout, or byte-compat blocker」;approval 不豁免实现与 QA 证据)

## Goal

把「以 leadId 行事的权力」绑定到一张可原子转移、**代次只增不减**的身份 lease 上:同一 leadId 任一时刻只有「当前代次且已 bound」的进程能发 runner 指令/答 gate;第二个进程可以存在但**结构性只读**;Bridge 对同身份双活**立刻告警并标记后起进程**;每条 Lead 指令**可审计到具体 Lead pane 进程**(含跨代历史);正常生命周期(KeepAlive 重启/resume/合法接替)零影响。

## 验收映射

| Issue 验收 | 本计划交付 |
|-----------|-----------|
| 1 结构性互斥(第二进程拒起或降级只读) | M1+M2 lease + fail-closed 校验(CLI 与 Bridge 两个真实写边界,均要求「当前代次 + bound」);M3 launch 前进程表 preflight(拒起) |
| 2 并存检测+告警+标记后起 | M4 `lead_dual_active` 告警(episode latch,标记后起+lease 持有者,判不出先后标 ambiguous) |
| 3 指令可溯源 | M2 CommDB 溯源列(指向 **Lead pane holder**,经不可变 generation 历史表跨代可回放)+ mailbox envelope metadata(gate 已定:可审计性,可见文本字节不动) |
| 4 回归零影响 | lease 接替=代次+1(复用 FLY-1285 死亡证明),same-supervisor 幂等 acquire 防 HOLD 循环增代;不引入新 kill 路径(唯一例外:回收**本代次自己刚建的** window,镜像 launch-claim-store 先例);`audit_only` 默认合入 |

## Architecture

三层纵深,互为独立兜底:

1. **Lease 层(互斥/降级)**: `~/.flywheel/lead-lease.db`(better-sqlite3,WAL+busy_timeout,BEGIN IMMEDIATE/CAS)。**两态协议** `acquired_unbound → bound`;bind 是**校验意义上的 commit 点**(enforce 只认 bound)。**mode 控制面独立于 lease DB**(`~/.flywheel/lead-lease-mode.json`,原子写)——删/重建 lease DB 不会静默降级 enforce。
2. **检测层(告警)**: LeadWatchdog tick piggyback 一次 `ps` 全表扫描,按 canonical leadId 精确分组——claude-backend 身份 claude-argv ≥2、**desired-Codex 身份 claude-argv ≥1**(R10 #3),均连续两 tick → `lead_dual_active`/`lead_backend_drift`(claims.db 去重 + episode latch)。只告警不杀。audit 上报走 **durable outbox**(确定性文件 + 现有 alert-queue drain),不用 claim-before-post。
3. **溯源层(审计)**: CommDB `messages` 幂等加 6 列,经不可变 `lease_generation_history` 跨代回放;mailbox envelope metadata 同带。`[lead-instruction <id>]` 字节不变。

```mermaid
sequenceDiagram
    participant S as claude-lead.sh (supervisor)
    participant L as lead-lease.db
    participant P as Lead pane (claude)
    participant C as flywheel-comm CLI
    participant B as Bridge (gate 写边界)
    participant W as Bridge LeadWatchdog

    S->>S: canonical resolve(共享 resolver,四态契约)
    S->>L: acquire(死亡证明;same-supervisor unbound 幂等)→ gen=N+1, unbound
    S->>S: FLY-1285 guard + 全表 preflight
    alt 存在同身份活进程
        S->>S: HOLD + lead-alert(不 launch;unbound row 保持)
    else 干净
        S->>P: launch, env: LEASE_KEY + GENERATION=N+1
        S->>L: bind(CAS: 当前代次+expected supervisor+未 bound)= commit + history 插入
        alt bind 失败
            S->>S: 回收本代次自建 window(window_id+pane_pid 双证)→ 重试
        end
    end
    P->>C: respond/send(--lead/--from)
    C->>L: configured-lead 分类(共享 resolver)+ 校验(当前代次 AND bound;mode 读独立控制面)
    alt stale/unbound/缺 env/无行(enforce, configured lead)
        C-->>P: 拒绝(fail-closed)+ 审计(store 坏则 alert-queue+本地日志)
    else 通过
        C->>C: 写 CommDB(holder+writer 溯源)+ mailbox(provenance)
    end
    C->>B: gated approve_to_ship(带 {leaseClaim, carrierClaim, provenance})
    B->>L: 写入前按 requestingLeadId 二次校验(先于 founder-consent attribution 改写)
    W->>W: 每 tick: ps 按 canonical 分组(连续两 tick + latch)
    W->>L: 收割 lease_audit → durable outbox → alert-queue drain(可见上报)
```

## Gate 定稿的设计决定(Tadashi 2026-07-16 批准原文要点)

1. **验收 3 = 可审计性,非可见文本**: envelope metadata + CommDB 溯源列;`[lead-instruction <id>]` 字节不动。
2. **钉子① enforce 翻转 = 显式 ship checklist 项**,Lead task 跟踪,不许「合了但永远 audit_only」;**audit_only 期间必须上报「本应拦下的写入」**(lease_audit → outbox → thread/log 可见,M4-T7c)。
3. **钉子② lease 库故障语义分层**(§故障语义)。
4. **钉子③ BYPASS 必须响亮**: 逐条 log + 告警,响亮通道**不依赖 lease DB**(alert-queue + 本地追加日志)。
5. 范围外 follow-up(terminal-mcp send-keys 旁路 → FLY-1306/后续;Codex lead backend;per-Lead Bridge credential)——ship 时逐条落 Linear。

## 身份与信任模型

- **canonical resolver(共享契约;Codex R2 #5)**: 单一纯函数(`packages/flywheel-comm/src/canonical-lead.ts`,subpath export;bash 经 `lead-lease resolve` 子命令走同一实现),输入 leadId(+可选 project hint),从 `~/.flywheel/projects.json` 解析,返回四态:
  - `ok{canonicalProject, leadKey}` — 唯一命中;
  - `valid_but_lead_absent` — 文件可读、该 leadId 未配置(新项目 bootstrap:supervisor 用派生值+WARN;写边界视为**非** configured lead 放行);
  - `ambiguous` — 一 leadId 映射多 project:acquire/scan/写边界一律显式拒绝,不猜;
  - `source_error` — ENOENT/解析失败/EACCES:**绝不退化为空集**。写边界:请求带 lead 标记(claimed id 曾见于 lease markers/`FLYWHEEL_LEAD_LEASE_KEY`/`FLYWHEEL_LEAD_ID` env)→ fail-closed 拒 + 独立告警;无标记调用者放行。supervisor:HOLD + 告警(配置层坏了,起了也是错身份;与 lease store fail-open 不同——那是锁层,这是身份层)。恢复测试:config 恢复后自动恢复。
- **lease key** = `<canonicalProject>-<leadId>`;supervisor 传入 PROJECT_NAME 与 canonical 不一致 → **fail-stop**(HOLD+告警,非 WARN)。
- **leaseProtected 谓词(Codex R3 #1 + R4 #3 + R5 #2/#3)**: backend 判定**复用现有 `effectiveLeadBackend()` 契约**(`packages/teamlead/src/lead-backends/lead-backend.ts:41-65`,precedence = projects.json leads[].backend > 项目 config/env legacy > claude-code 缺省;bash twin `flywheel-fleet.sh` 同源)——**下沉为共享纯函数到 flywheel-comm**(依赖方向: flywheel-comm 不能反向 import teamlead;teamlead 改为消费下沉后的实现 + conformance fixture 保证不是第二份拷贝)。
  - **退出保护 = per-request 判定,writer 必须绑定到 carrier instance**(Codex R5 #2 + R7 #1——identity 级豁免不够:健康 Codex carrier 活着时,同身份误起的 Claude pane 不得借它的证据免 lease 通行): passthrough 需同时满足 `desired effective backend=codex` **AND** `actual carrier=新鲜、身份绑定、pid+lstart 实时复证的 confirmed-codex 证据` **AND** **本次请求证明 writer 属于该 carrier instance**——实现(R8 #1 钉死全链): 新 env `FLYWHEEL_LEAD_CARRIER_INSTANCE_ID`(随机,每 carrier generation 一个;**原值只驻留 carrier/子进程 env,日志/diagnostics/evidence 一律只存摘要**)。注入链必须穿过 Codex runtime 的**正向 env allowlist**(`codex-lead-runtime.ts` `buildFullAccessEnv` 精确 allowlist + `buildTuiDaemonEnv`/app-server child env——只改 launcher 注入会在 launcher→runtime→daemon 边界被 allowlist 删掉,真正跑 flywheel-comm 的子进程拿不到);runtime 启动后发布 `{leadKey, pid, lstart, instanceDigest}`,由 FleetPoller **验证运行中进程**后写入 evidence(不从静态 plist 推断)。CLI 自动携带 claim;Bridge 经独立 server-side context(见 T5)对 raw claim 取摘要后与 live evidence **常量时间比较**,不落 raw 值(防混乱不防恶意,同现有信任模型)。无匹配 carrier claim 的同身份调用**留在保护集** → enforce 下因无 lease 被拒。任何 desired/actual 不一致、carrier unknown/stale、probe 错误同样留保护集: audit_only 记 `would_block(backend_drift)`;enforce fail-closed + durable episode 告警。CLI 与 Bridge 每次 validation 都执行;readiness 只是 rollout 汇总。必红测试: enforce 运行中 desired 改 codex 而 carrier 仍 claude → 当前/陈旧 holder 都不得 passthrough;**健康 Codex C + 同身份 Claude intruder 并存 → intruder 的 CLI send 与 Bridge gated response 均拒且零落库,C 的调用保持兼容**(该反例必须分别落进 **CLI suite、Bridge suite、ps-scan suite 三处**,不只留在设计段落);carrier claim 矩阵 = matching/missing/wrong/stale 四分支(T4);carrier 真确认切换后才解除。
  - **检测层不因 identity 是 codex 而跳过**(R7 #1 附带): ps scan 按 claude-argv 覆盖**所有** configured 身份;codex 身份本不该有 claude pane,任何 claude-argv 命中 codex 身份 → 至少发 `lead_backend_drift`/dual-active 级告警。
  - **carrier 证据 provider(Codex R5 #3 + R6 #2)**: 归一化证据 `{backend, source, freshness, 绑定的 project/lead, **observed carrier pid+lstart**}`,**必须覆盖生产现役全部 launcher 形态**——标准 manifest wrapper(`flywheel-lead-wrapper.sh` 按 manifest `leadBackend.backendId` dispatch)、**Mufasa windowed TUI launchd wrapper**、**codex-infra TUI wrapper**(两者绕过标准 manifest;Mufasa manifest 无 backend 字段、infra bot 无标准 manifest——按标准语义硬判会把要求字节兼容的两个生产 Codex Lead 误报 drift)、probe unknown/error。优先**复用/扩展 FLY-247 fleet evidence**(Bridge 已有 30s poller),poller 把 per-lead carrier 证据原子写入控制面文件(`~/.flywheel/lead-carrier-evidence.json`),CLI/Bridge 校验时读。
    - **freshness ≠ 仍然活着**(R6 #2): 30s 采样/90s TTL 的快照在窗口内进程可能已死/被替换/PID 复用——排除保护**不得弱于 lease holder 证明**。规则: passthrough 判定前,validation 必须用 `processAliveWithStart(evidence.pid, evidence.lstart)` **轻量实时复证** carrier 进程仍是同一 OS 进程;复证失败 → 保持保护。证据必须来自**运行中的** launchd/TUI 进程(fixture 断言不是只解析 plist ProgramArguments——「文件已切、旧进程未切」的部署窗不得假 confirmed)。backend transition 集成点: fleet apply/launchd stop/swap 前先原子 invalidate 证据文件,新 carrier 完成 pid+lstart 发布后才重新 confirmed(与实时复证并用)。
    - absent/stale/复证失败 → 按保护处理(fail-safe:证据缺失只会多保护,不会开旁路);**伪造/缺失 carrier 不得让实际 Claude 退出保护**。必红测试: t0 发布 fresh codex 证据 → TTL 内杀掉/替换 carrier 为 Claude 或 PID 复用+lstart 不匹配 → 下一次 CLI 与 Bridge validation 都保持 protected;仅新 codex pid+lstart 复证成功后才解除。production-shaped fixture: 现有两个 TUI plist/launcher 形态 + 运行中进程,证明 Mufasa 与 codex-infra 不产生 drift、也不产生误告警(scan 范围见下——它们仍是 scan target,只是健康 Codex carrier 不是 claude-argv 进程,故零命中)。
  - **scan target ≠ matched process**(R9 #2,钉死一致语义): ps scan 的 **target = 全部 configured identities**(含 desired-Codex);正常 Codex carrier 本身不计作 claude-argv 命中;传统 dual-active 阈值(同 identity claude-argv ≥2)只适用于 claude-backend 身份;**desired-Codex 身份上 claude-argv 命中 ≥1 即为 drift/intruder episode**(保留连续两 tick 去抖)。`scanDualActive` 显式接收 canonical desired backend + live carrier disposition 作为输入;**禁止复用会排除 confirmed-Codex 身份的 `filterPaneWatchedLeads()` 结果**。
  - 其余必红测试: projects backend 缺省 + legacy/manifest=codex → 不得进保护集;configured Claude Lead 无 lease → enforce 拒;configured Codex Lead(健康证据)无 lease → 全模式零变化(仅指授权面;检测面按上条语义仍覆盖)。
- **Lead 分类与 lease row 无关**(防删库旁路): claimed ∈ **leaseProtected** 集合 → 必须过 lease 校验;runner execId/bridge/founder 名/非保护 backend Lead → 原样放行。Bridge 侧 trusted-actor 豁免只给**服务器内部产生、无 Lead requester** 的调用,绝不由 HTTP body 自报(Codex R2 #4)。
- 防**混乱**不防**恶意规避**(bypassPermissions 进程理论上可伪造 env——与 founder-only-authority 同一信任模型)。

## Lease 状态机(Codex R2 #2 定稿)

**行状态**: `absent → acquired_unbound(holder=supervisor pid+start, bound_at NULL) → bound(holder=pane pid+start, bound_at 非空, history 行已插)`。generation 只在 acquire 成功时 +1,永不回退、永不删行。

**acquire 规则**(BEGIN IMMEDIATE 单事务):
- 行 bound 且 holder(pane)经 pid+lstart 证明**活** → `denied_holder_alive`(→ supervisor HOLD);
- 行 unbound 且 holder(supervisor)是**本 supervisor**(pid+start 相同)→ **幂等返回现有 generation**(HOLD/重试循环不增代;Codex R2 #2);
- 其余(holder 死、无行)→ generation+1,unbound,holder=本 supervisor。

**bind 规则**(BEGIN IMMEDIATE 单事务,CAS): `UPDATE lead_lease SET holder=pane,bound_at=now WHERE lead_key=? AND generation=? AND holder_pid=<expected supervisor pid> AND holder_start=<expected> AND bound_at IS NULL`,同事务插 history(insert-once,PRIMARY KEY(lead_key,generation))。changes()=0 → `stale_generation`,**不改 row 不污染 history**(late-bind race:gen1 bind 在 gen2 acquire 后迟到 → 必败且 gen2 row/history 不变——必红测试)。

**校验规则**(写边界,enforce): 通过 = `env.leaseKey 匹配 AND env.generation == row.generation AND row 已 bound AND history(key,gen) 存在`。unbound 当前代次(new-window→bind 窗口的裸 pane)→ enforce 拒、audit_only 记 `would_block`(Codex R2 #2:bind 才是 commit,窗口期不得有 VALIDATED writer)。

**supervisor 执行顺序**(与现有代码顺序一致可执行): canonical resolve → **acquire**(幂等)→ 现有 FLY-1285 guard(`_prepare_lead_launch`)+ 全表 preflight → `_launch_claude`(env 注入)→ **bind**(archive 写点)。语义:bound holder 活着 → acquire 先 deny(HOLD,现状语义);**unbound holder 死**(bind 前崩溃的 orphan 场景)→ acquire gen+1 先使裸 orphan 永久 stale,随后 preflight 见活 claude → HOLD+告警交人(orphan 无授权,系统安全;与今天 FLY-1285 orphan 处置一致,无新增死锁)。

**crash fault 矩阵**(T6c,每格给预期 row 状态):
| 崩溃点 | row 状态 | 下一 supervisor | 不变式 |
|---|---|---|---|
| acquire 后/launch 前 | genN unbound, holder=死 supervisor | acquire→genN+1 | 无 pane,无写者 |
| new-window 后/bind 前 | genN unbound + 裸 pane(env genN) | acquire→genN+1(orphan stale)→preflight HOLD | 裸 pane unbound,enforce 本就拒;永无二写者 |
| bind 写失败(supervisor 活) | genN unbound | 本 supervisor 回收自建 window→重试(幂等 acquire 同代) | 无 |
| bind 后/wait 前 | genN bound(pane 活) | acquire denied_holder_alive→HOLD | 合法单写者继续 |

## 故障语义(钉子②定稿)

| 场景 | 行为 | 理由 |
|------|------|------|
| **Lead 启动**时 lease store 层错误(损坏/锁死) | **fail-open**: 照常 launch,env 注入 `FLYWHEEL_LEAD_LEASE_DEGRADED=store_error`(无代次),经 **alert-queue** 发 `lead_lease_store_broken` | 哑舰队比短暂双活糟;检测层兜底 |
| **enforce 下 configured-lead 写入**时 store 损坏/无行/缺 env/unbound | **fail-closed**: 拒写;审计优先 lease_audit,store 不可写则 **alert-queue 条目 + `~/.flywheel/logs/lead-lease-audit.log` 追加** | store 失败即放行=删库成旁路;错发不可撤回,被拒可重试 |
| **lease DB 被删后重建为空**(可正常打开) | mode 在**独立控制面**(Codex R2 #1),enforce 不丢;configured lead 无行 → enforce 拒(分类不依赖行) | 「删库=解除互斥」物理不成立;必红测试: enforce→删 lease DB→自动重建空库→configured lead 写仍拒 |
| projects.json source_error | 写边界对带 lead 标记的调用 fail-closed+独立告警;supervisor HOLD+告警 | 读失败 ≠ 空配置(Codex R2 #5) |
| 救火受阻 | `FLYWHEEL_LEAD_LEASE_BYPASS=1`(逐条审计+告警)或 `set-mode off` | 出口响亮、人手动拉 |
| acquire denied_holder_alive | HOLD+告警(FLY-1285 语义),不强抢 | 互斥本意 |
| bind 失败(supervisor 活) | 回收本代次自建 window(双证)→重试 | 绝不留「活着未登记」写者(launch-claim-store:68-73 先例) |

## 环境旋钮与控制面

| 项 | 值域 | 默认 | 说明 |
|------|------|------|------|
| **mode 控制面** `~/.flywheel/lead-lease-mode.json`(原子写,`lead-lease set-mode` 唯一写者) | `off\|audit_only\|enforce` | 无文件=`audit_only` | **独立于 lease DB**(删库不降级);CLI/Bridge 每次校验 live-read;`status` 输出 effective mode + 来源 |
| `FLYWHEEL_LEAD_LEASE_MODE` | 同上 | 未设 | **仅测试 seam**;readiness proof 机器检查 Bridge 与全 Lead pane **均未设**(Codex R2 #1/#6) |
| `FLYWHEEL_LEAD_LEASE_BYPASS` | `1` | 未设 | enforce 单次放行,逐条审计+alert-queue 告警 |
| `FLYWHEEL_LEAD_LEASE_DB` | 路径 | `~/.flywheel/lead-lease.db` | 测试 seam |
| `FLYWHEEL_LEAD_LEASE_MODE_FILE` | 路径 | `~/.flywheel/lead-lease-mode.json` | 测试 seam(set-mode 测试不写真实 home;Codex R3 #5) |
| `FLYWHEEL_LEAD_LEASE_KEY` / `FLYWHEEL_LEAD_GENERATION` | 注入值 | — | launch 时注入 pane env |
| `FLYWHEEL_LEAD_CARRIER_INSTANCE_ID` | 注入值 | — | Codex launcher 每 carrier generation 注入;raw 只在 carrier env,其余处只存摘要(R8 #1) |
| `FLYWHEEL_LEAD_EPISODE_DB` | 路径 | `~/.flywheel/state/lease-episodes.db` | 测试 seam(R8 #3) |
| `FLYWHEEL_LEAD_RECEIPT_DIR` | 路径 | `~/.flywheel/state/carrier-receipts/` | 测试 seam(R12 #3;self-check receipt 落盘目录) |
| `FLYWHEEL_LEAD_LEASE_DEGRADED` | `store_error` | — | 启动 fail-open 时注入 |
| `FLYWHEEL_DUAL_ACTIVE_SCAN` | `0` | on | 检测层 kill switch |

mode 判定: env(测试)> 控制面文件 > 默认 audit_only。控制面文件损坏(非 ENOENT)→ 按 enforce 从严处理并告警(mode 层的 fail-closed:无从证明「不是 enforce」)。

## File Structure

**Create**
- `packages/flywheel-comm/src/lead-lease.ts` — store:两态状态机、acquire(CAS+死亡证明+幂等)、bind(CAS commit+history)、validate(bound 要求)、audit、`processAliveWithStart`
- `packages/flywheel-comm/src/lead-lease-mode.ts` — 独立 mode 控制面(原子读写 JSON)
- `packages/flywheel-comm/src/canonical-lead.ts` — 四态 canonical resolver(共享纯函数 + fixture)
- `packages/flywheel-comm/src/commands/lead-lease.ts` — CLI `lead-lease acquire|bind|status|set-mode|resolve|readiness|carrier-self-check`(**无 release**)
- `packages/teamlead/src/bridge/lead-dual-active-scan.ts` — ps 解析/分组/latch/文案 builder/audit 收割(outbox)
- `packages/teamlead/scripts/lib/lead-identity-preflight.sh` — bash 3.2/POSIX 进程表扫描
- 测试: `packages/flywheel-comm/src/__tests__/lead-lease.test.ts`、`.../lead-lease-enforce.test.ts`、`.../canonical-lead.test.ts`、`.../db-provenance-migration.test.ts`、`.../carrier-self-check.test.ts`(T5.5 + 共享 loopback guard conformance)、`packages/teamlead/src/__tests__/lead-dual-active-scan.test.ts`、`.../lead-lease-bridge-gate.test.ts`、`packages/teamlead/scripts/__tests__/test-lead-identity-preflight.sh`

**Modify**
- `packages/flywheel-comm/package.json` — subpath exports `./lead-lease`、`./canonical-lead`
- `packages/flywheel-comm/src/index.ts` — 注册子命令
- `packages/flywheel-comm/src/commands/respond.ts` — `:81`/`:119` 双写入位点前置校验+溯源;`routeThroughBridge` 请求体明列 `{leadId, leaseClaim, carrierClaim, provenance}`(加性字段,旧 client 兼容;R9 #1)
- **runtime→FleetPoller 证据通道**(R9 #3 + R14 #1,单写者边界 + generation-bound 无墙钟过期): Codex runtime 只写**私有 per-lead runtime assertion**(`~/.flywheel/state/carrier-assertions/<lead_key>.json`,0600、拒 symlink、unique temp+fsync+rename;schema `{leadKey, pid, lstart, instanceDigest, publishedAt, schemaVersion}`);**FleetPoller 是 `lead-carrier-evidence.json` 的唯一写者**——identity/digest/pid+lstart **活性复证**通过即复制 digest 进 evidence。**assertion 对授权不按 `publishedAt` 过期**(R14 #1: 同一活 generation 的旧 timestamp 不否决授权——否则健康 Codex 会在某个未定义 TTL 后突然失权,would_block 重置观察窗、enforce 误拒,违反验收 4;`publishedAt` 只作诊断 + 拒明显未来时间);evidence snapshot 自身沿用现有 30s poll/90s staleness(poller 停摆 → fail-safe protected,恢复采样即恢复)。「stale assertion」测试精确语义: 旧 timestamp + 同一活 pid+lstart **仍有效**;进程死亡、PID 复用、identity/digest 不匹配**必失效**;poller 停超 evidence TTL 失效、恢复采样可恢复;另测 runtime 写到一半、poller 验证后进程死亡
- `packages/flywheel-comm/src/commands/send.ts` — `:34` 前置校验+溯源
- `packages/flywheel-comm/src/db.ts` — 顶层 SCHEMA + ADD COLUMN + **全部 messages 重建 DDL/COPY** + Message 类型;insert 可选 provenance
- `packages/flywheel-comm/src/wake.ts` — envelope `senderProvenance`(加性)
- `packages/teamlead/src/bridge/founder-consent/gate-response-router.ts` — 保留 server-side **requestingLeadId**,`{requestingLeadId, leaseClaim, carrierClaim, provenance}` 作为**独立 context**(不可被最终 actor 改写)传入 writer(Codex R2 #4 + R8 #1)
- **Codex carrier 注入链**(R8 #1): 标准 Codex wrapper、Mufasa TUI launcher、infra-bot TUI launcher、`packages/teamlead/src/lead-backends/codex/codex-lead-runtime.ts`(`buildFullAccessEnv` 正向 allowlist)、`codex-lead-tui-runtime.ts`(`buildTuiDaemonEnv`)+ 各自 exact-env sentinel 测试——`FLYWHEEL_LEAD_CARRIER_INSTANCE_ID` 全链可达
- `packages/teamlead/src/bridge/approval-signal/write-gate-response.ts` — 写入前按 requestingLeadId 校验(先于 founder-consent attribution 改写);`insertResponse`/`insertFounderApprovalResponseWithSource` 穿透 provenance
- `packages/teamlead/scripts/claude-lead.sh` — resolve fail-stop、acquire(幂等)、preflight、env 注入、bind(+失败回收重试)
- `packages/teamlead/src/LeadWatchdog.ts` + `packages/teamlead/src/bridge/plugin.ts` — 装配 scan 进 30s tick + 告警 title/body switch + 只读诊断端点 `GET /api/lead-lease/diagnostics`(readiness 用)+ **`POST /api/lead-lease/self-check`**(T5.5,loopback-only/token-auth/read-only/不回显 raw)
- `packages/teamlead/src/LeadAlertNotifier.ts` — 新 kind ×8(§T8)+ **`drainQueue()` 排序改按 JSON `queuedAt`(fallback mtime,filename tie-break)**——修现存 TS/shell 文件名不可混排的共享 bug(Codex R4 #1)+ **lease-episode payload 的终态回写**(delivered/dead_lettered ack-before-unlink,Codex R5 #1)
- `packages/teamlead/src/lead-backends/lead-backend.ts`(+ 其 tests/exports)— `effectiveLeadBackend` 纯函数下沉到 flywheel-comm 后改为消费共享实现;fleet conformance fixture 保证非第二份拷贝(Codex R5 #3)
- FLY-247 fleet evidence(`fleet-data.ts` 相关)— 扩展 carrier 证据 provider: 标准 manifest + Mufasa TUI wrapper + codex-infra TUI wrapper + unknown/error 四形态,poller 原子写 `~/.flywheel/lead-carrier-evidence.json`
- `packages/teamlead/src/config.ts` + `packages/teamlead/src/bridge/loopback-origin.ts`(+ 既有 parity/fleet-routes/config 测试)— 改为消费下沉到 flywheel-comm 的共享 `isAllowedLoopbackHostname()`(R14 #2:server 侧不得保留第二份三值判断;Host header 的 `[::1]:port` 先正规化成 `::1` 再调 predicate;import/突变测试证明删改共享三值同时影响 client 与 server)
- `scripts/lead-alert.sh`(root)— shell 侧 kind + allowlist
- `packages/teamlead/src/StateStore.ts`(**真实路径,非 packages/core**;Codex R2 #3)— 仅当 outbox 选型需要;首选 alert-queue 确定性文件方案(见 T7c)

**不碰**(byte-compat 红线)
- `[lead-instruction <id>]` 前缀与 runner 回执协议
- FLY-1251 founder-consent **决策逻辑**(只加校验与 provenance 穿透)
- FLY-1285 takeover guard 现有判定(复用证明函数)

---

## M1 — lease store + 控制面 + resolver

### T1: `lead-lease.ts` + `lead-lease-mode.ts`

- [ ] **T1a 失败测试**:
  - 状态机: fresh acquire → gen1 unbound;bind CAS → bound + history 一行;**late-bind race 必红**: gen1 bind 挂起 → supervisor1 死 → gen2 acquire → gen1 bind 恢复 → `stale_generation` 且 gen2 row/history 不变(Codex R2 #2);同 key+gen 重复 bind 拒;
  - **ABA 必红**: gen2 acquire 后,持 gen1 的写校验必拒(含「gen1 pane 仍活着」反例);
  - **幂等 acquire**: 同 supervisor 对自己的 unbound row 重复 acquire → 同 generation 不增代;
  - denied_holder_alive(bound+活 pane);pid 复用(lstart 不匹配=死);**并发 CAS** fork×2 恰一赢;
  - **校验要求 bound**: 当前代次但 unbound → enforce 拒 / audit_only would_block;
  - **mode 独立控制面必红测**(Codex R2 #1): set-mode enforce → bind gen1 → **删除 lead-lease.db** → validator 自动重建空库 → configured lead 写**仍拒**;控制面文件损坏 → 按 enforce 从严+告警;`status` 输出 effective mode+来源;
  - store 损坏 → `LeaseStoreError`;audit 各事件写读;retention 只修剪**已 materialize 进 outbox** 的 audit 行(Codex R2 #3)。
- [ ] **T1b 实现**: schema(在 R1 版基础上加 `bound_at`,语义如 §状态机):

```sql
CREATE TABLE IF NOT EXISTS lead_lease (
  lead_key TEXT PRIMARY KEY, project TEXT NOT NULL, lead_id TEXT NOT NULL,
  generation INTEGER NOT NULL,          -- 单调,永不删行/回退
  holder_pid INTEGER, holder_start TEXT,
  bound_at TEXT,                        -- NULL=acquired_unbound, 非空=bound
  acquired_at TEXT NOT NULL, acquired_by TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS lease_generation_history (
  lead_key TEXT NOT NULL, generation INTEGER NOT NULL,
  holder_pid INTEGER NOT NULL, holder_start TEXT NOT NULL, bound_at TEXT NOT NULL,
  PRIMARY KEY (lead_key, generation)
);
CREATE TABLE IF NOT EXISTS lease_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, lead_key TEXT NOT NULL,
  event TEXT NOT NULL, detail TEXT, created_at TEXT NOT NULL,
  materialized_at TEXT                  -- outbox 摄取标记;retention 只删非 NULL 行
);
CREATE TABLE IF NOT EXISTS store_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
-- store_meta('store_instance_id') = 建库时生成的不可变 UUID(Codex R3 #2:
-- 跨「删库重建」epoch 区分 outbox batch;audit AUTOINCREMENT 复用不再撞键)
```

  mode 控制面 = `lead-lease-mode.json` `{mode, updated_at, updated_by}`,temp+rename 原子写。
- [ ] **T1c 测试过 + commit**

### T2: canonical resolver + CLI 子命令

- [ ] **T2a 失败测试**(`canonical-lead.test.ts` + CLI): 四态各有 fixture(ok/absent/ambiguous/**ENOENT、EACCES、解析失败均=source_error,绝不返回空集语义**);运行中删/损 projects.json → 后续调用转 source_error,恢复后自动恢复(Codex R2 #5)。CLI: `acquire`(幂等语义)/`bind`/`status`(含 effective mode+来源+resolver 状态)/`set-mode`/`resolve`;**无 release**(存在即红)。
- [ ] **T2b 实现 + package.json 双 subpath export + commit**

## M2 — 两个真实写边界的校验 + 溯源

### T3: CommDB 溯源列(幂等迁移,防重建丢列)

(同 R1 版,不变)6 列 `sender_lease_key/sender_generation/sender_holder_pid/sender_holder_start/writer_pid/writer_start`;顶层 SCHEMA + ADD COLUMN + **真旧 schema(pre-ack_receipt CHECK)重建路径 fixture 先红后绿** + 双 open/并发 opener + PRAGMA 断言 + round-trip。

- [ ] T3a 失败测试 → T3b 实现 → T3c commit

### T4: CLI 写边界(respond/send)

- [ ] **T4a 失败测试**(矩阵,分类经共享 resolver):

| mode(控制面) | 调用者分类 | claim 状态 | 期望 |
|------|---------|---------|------|
| off | 任意 | 任意 | 放行,零校验零审计(哨兵) |
| audit_only | configured lead | == 且 bound | 放行,无审计 |
| audit_only | configured lead | != / 缺 env / 无行 / **unbound** | 放行 + `would_block` + stderr |
| enforce | configured lead | == 且 bound | 放行 |
| enforce | configured lead | != / 缺 env / 无行 / 空库 / **删库重建** / **unbound** | **拒绝** + `blocked` 审计 |
| enforce | 非 configured(runner/bridge/founder 名) | — | 放行零变化 |
| enforce | resolver=**source_error** + 调用带 lead 标记 | — | 拒绝 + 独立告警;无标记放行(Codex R2 #5) |
| enforce + BYPASS=1 | configured lead | != | 放行 + `bypass_used` + alert-queue 告警 |
| enforce | configured lead | store 损坏 | 拒绝 + alert-queue + 本地日志 |
| 任意 | claimed 与 pane `FLYWHEEL_LEAD_ID` 不一致 | — | 从严 + detail 记录 |
| off/audit/enforce | desired-Codex 身份,carrier claim **matching** | — | passthrough(audit_only 也不记 would_block) |
| off | desired-Codex 身份,claim missing/wrong/stale | — | 放行(off=零校验哨兵) |
| audit_only | desired-Codex 身份,claim **missing/wrong/stale** | — | 放行 + `would_block(backend_drift)` 审计 |
| enforce | desired-Codex 身份,claim **missing/wrong/stale** | — | **拒绝**(留在保护集,无 lease 即拒)+ drift episode 告警 |

  **CLI suite 必红反例**(R9 #1): 健康 Codex carrier C(matching claim 可通过)+ 同身份 Claude intruder(无 claim 无 lease)并存 → intruder 的 `send` 被拒且零落库,C 的调用不受影响。**raw capability 传输合同**(R10 #1,唯一合法 transport 写死): raw claim **允许且只允许**出现在经 token 认证的 loopback Bridge request body 与处理栈内存中(公开 digest 可被同身份 intruder 重放,不能当 claim;因此 body 必须带 raw);**禁止**进入 response/error/request logging/审计/CommDB/queue/evidence/diagnostics/snapshot。负向测试相应改为: outbound 请求 body **必须**含 raw carrierClaim;除该单一 transport 外任何持久化/输出面出现 raw → 必红。

  溯源断言: `sender_holder_pid/start` 从 **history 按 claimed generation** 解析(缺→NULL+degraded,绝不冒充当前 holder);`writer_pid/start`=CLI;envelope metadata 同组;**可见前缀字节不变**(负向断言+突变验证);双写入位点(`:119`+`:81`)覆盖。
- [ ] **T4b 实现 + T4c 现有 CLI 全回归 + commit**

### T5: Bridge 写边界(gated approve_to_ship 真实落点)

- [ ] **T5a 失败测试**(`lead-lease-bridge-gate.test.ts`):
  - router 保留 server-side **requestingLeadId**;`{requestingLeadId, leaseClaim, carrierClaim, provenance}` **四字段独立 context** 传 writer,**不可被 founder-consent 的 actor 改写覆盖**(Codex R2 #4 + R9 #1);
  - **关键反例必红**: configured lead 的 **stale claim + evaluator 返回 allow + structured founder approval 路径** → Bridge 仍拒,messages 与 source-event **双不落行**;current+bound claim 同形态 → 放行且 pane provenance 落库;
  - **carrier claim 分支**(R9 #1): desired-Codex 身份的 matching/missing/wrong/stale 四分支均在 attribution rewrite **之前**按 preserved requester 校验;**structured founder approval + wrong/missing carrier claim → 双表不落行**;Bridge 对 raw claim 只做摘要常量时间比较,raw 值不出现在响应/日志/审计(负向断言);
  - **Bridge suite 必红反例**: 健康 Codex C + 同身份 Claude intruder → intruder 的 gated response 被拒且零落库,C 的照常;
  - trusted-actor 豁免仅限**服务器内部产生、无 Lead requester** 的调用(dashboard/founder endpoint),HTTP body 自报无效;
  - 旧版 CLI 无 claim(升级窗)→ audit_only 记账放行 / enforce 拒;幂等重试不重复写;
  - pass-through / audit_only / enforce allow / enforce deny / structured approval 全形态。
- [ ] **T5b 实现**(加性字段双向兼容;复用 `./lead-lease` + `./canonical-lead` exports;不改 FLY-1251 决策逻辑)。**raw claim 的客户端 loopback 守卫 = 共享 primitive**(R11 #2 + R12 #1——凡带 raw claim 的出站 HTTP 都必须走同一 seam,禁止各自复制判定): `lead-lease.ts` 导出 `assertLoopbackCarrierUrl()` + `postCarrierClaim()`——URL 解析后仅允许 `http:`/`https:`、无 userinfo、**精确三值 loopback: `127.0.0.1`/`localhost`/`::1`**(R13 #3: 与仓内现有 `config.ts:9-29`/`loopback-origin.ts:19-29` 的接受集合逐字一致,**不扩到 127/8**——客户端与服务端集合必须相同,否则出现「客户端判安全、服务端必拒」的假绿;纯函数 `isAllowedLoopbackHostname()` 下沉到 flywheel-comm,teamlead 消费同一实现,双向 parity 测试含 `127.0.0.2` 拒/`::1` 绿/非 loopback IPv6 拒/lookalike 拒),拒绝 lookalike hostname(如 localhost.evil)、非 loopback IP/主机;固定 `redirect: "error"`(307/308 不得把含 raw 的 body 转发出去)。**`routeThroughBridge`(carrierClaim 非空时)与 T5.5 的 `carrier-self-check` 客户端共同调用它**——Bridge endpoint 的服务端 loopback 校验只保护「已到达 Bridge」之后,client 出站前必须自查。无 carrierClaim 的 Claude 旧路径不启用(byte-compat)。必红/必绿(**两条调用链都跑**): 外部 URL、IPv6、userinfo、混淆 hostname、cross-origin redirect 全拒;合法 loopback 绿;**conformance test**: 任何 raw-bearing HTTP 调用绕过共享 guard → 必红。**+ T5c commit**

### T5.5: carrier-local self-check(R11 #1——从 Ship prose 变成真实实现任务)

- [ ] **T5.5a 失败测试**:
  - 新 CLI `lead-lease carrier-self-check --json`(**由真实 carrier child env 执行**): 同一 raw claim 走 (a) 本地 CLI validator(与写边界同一 side-effect-free 校验函数)与 (b) Bridge **`POST /api/lead-lease/self-check`**(token-auth、loopback-only、read-only、response 不回显 raw,复用同一 canonical/carrier validation);
  - **receipt store**: `~/.flywheel/state/carrier-receipts/<lead_key>.json`,0600、拒 symlink、unique temp+fsync+rename、含 schemaVersion/restart invalidation;`FLYWHEEL_LEAD_RECEIPT_DIR` 测试 seam;**receipt 的 pid+lstart 指向持久 carrier 进程,绝不误记短命 self-check CLI 自身**;
  - **两层证据角色定稿(R12 #2 + R13 #1——receipt 不是运行时授权前提,消掉自举环)**:
    - `carrierAuthorizationEvidence`(运行时授权用): 来自 runtime assertion + FleetPoller 的 identity/pid+lstart 验证;**运行时 disposition 只消费它 + 本次 raw claim**——写边界 validator **不要求 receipt**,故首次 `carrier-self-check`(receipt 尚不存在)可正常完成,无自举环;
    - `selfCheckAttestation`(= receipt): **只被 readiness 消费**;receipt 缺失/超龄**绝不**删除或降级 authorization evidence,运行时 disposition 不变。FleetPoller 可在同一 evidence JSON 里发布两组独立字段,但对 authorization 字段的验证只看 identity/digest/pid+lstart(**不含 receipt age**)。
    双边界测试: 首次无 receipt 的 self-check 完成;receipt 超龄后 CLI/Bridge 运行时 disposition 不变、仅 readiness 红。
  - **readiness 新鲜度常量定数值**(R13 #2): `export const READINESS_SELF_CHECK_MAX_AGE_MS = 3_600_000`(1 小时——足够覆盖 step 5b→step 6 的操作窗,又保证「最近刚由真实 child env 验证过」;超龄由 step 5b 重跑 self-check 续期,与 30s poller 节奏无耦合)。单一导出,CLI/Bridge diagnostics/FleetPoller readiness 字段/readiness 命令共用。`age < 0`、非有限时间、超允许 clock skew 一律 readiness red 并给明确 expiryReason,**绝不 clamp 成 fresh**。诊断输出 `receiptAgeMs/maxAgeMs/expiryReason`;测试断言 maxAge-1 绿/maxAge 红的具体毫秒值与 future-timestamp 的失败原因;
  - 必红: Bridge 不可达、任一路拒绝、写 receipt 前崩溃、旧 receipt、PID 复用、carrier generation 更换、raw 泄漏进 receipt/response/日志。
- [ ] **T5.5b 实现 + commit**

## M3 — supervisor 集成(claude-lead.sh)

### T6: resolve + acquire(幂等)+ preflight + bind(commit)

- [ ] **T6a bash 测试**(bash 3.2 真机): 匹配器(executable basename 属 claude 启动形态;`--agent X` 与 `--agent=X`;排除 `--agent-id` 与参数内容出现;整词);**突变验证**(子串 grep 化→阴性必红;去 equals→阳性必红);**阳性对照先行**;`LC_ALL=C`。
- [ ] **T6b 实现**: 顺序 = §状态机(resolve fail-stop[ok 以外三态各按契约] → acquire 幂等 → FLY-1285 guard+preflight → launch(env 注入)→ bind CAS at archive 写点;bind 失败回收自建 window[window_id+pane_pid 双证]重试;优雅 cleanup 不 release)。store_error 启动 fail-open 分支;denied_holder_alive→HOLD。
- [ ] **T6c 故障注入**(按 §crash fault 矩阵四格,断言各格「预期 row 状态」+ 永不二 VALIDATED writer + 不劣于现状的 HOLD + 下一 supervisor 可接替;**HOLD 循环重试不增代**)。
- [ ] **T6d shellcheck + 真机 bash 3.2 + commit**

## M4 — Bridge 检测层

### T7: dual-active scan + audit 收割

- [ ] **T7a 失败测试**(真实 ps 抓样 fixture): 同 R1 版全部(阴阳样本/突变/equals/连续两 tick/latch/ambiguous tie/SCAN=0 哨兵)+ ps 连续 ≥10 失败 → 单 episode `lead_dual_active_sensor_degraded`。**desired-Codex 身份三件套必红**(R9 #2): 健康 Codex + 零 claude-argv → 无告警;健康 Codex + **一个**同身份 claude-argv → drift/intruder episode(该类身份 ≥1 即报,两 tick 去抖;传统 ≥2 阈值只适用于 claude-backend 身份);同 fixture 下 CLI 与 Bridge 对 intruder 写均拒(ps-scan suite 与 T4/T5 反例三处呼应)。
- [ ] **T7b 实现**: `scanDualActive` 纯函数 + 装配壳;**输入含 canonical desired backend + live carrier disposition**(R9 #2);canonical 分组与 lease 同源;**不复用 `filterPaneWatchedLeads()`**(它会排除 confirmed-Codex 身份);文案 builder 在本模块,LeadWatchdog switch 接分支。
- [ ] **T7c audit 收割 = durable outbox(Codex R2 #3 + R3 #2/#3 定稿,单一协议)**:
  1. 每 tick 读 `lease_audit` 未 materialize 行(`materialized_at IS NULL`),按 lead_key+event 聚合;
  2. **batch 身份跨 epoch 唯一**(Codex R3 #2): `batchId = sha256(storeInstanceId | leadKey | event | sorted rows canonical JSON)`;文件名 `<batch 内最老 created_at, UTC ISO>-lease-audit-<batchId 前 16 hex>.json`(时间前缀只为人类可读,**不作正确性判据**);
  2b. **drainQueue 排序改为按内容真实时间**(Codex R4 #1,顺带修一个现存共享 bug): 现有 TS(`2026-07-16T...`)与 shell(`20260716T...`)两种文件名**本来就不能按字典序混排**(`2026-` < `20260` → 12 月的 TS 文件被当得比 7 月的 shell 文件旧)。`drainQueue()` 改为: 读每个 JSON 的 `queuedAt` 解析 epoch,缺失/非法 fallback `mtimeMs`,filename 仅作稳定 tie-breaker;cap/淘汰/投递顺序与测试全用该统一排序。**mixed-queue 测试必须同时含真实 TS、shell、lease-audit 三种文件,且刻意选「字典序与真实时间相反」的日期**;
  3. **materialize 顺序写准确**(不宣称 FS+SQLite 同一事务): unique temp 写 + fsync + rename + 目录 fsync → 然后 DB 标 `materialized_at`;**同名文件已存在时必须 parse 并校验 batchId/payload digest**——匹配才标 materialized;不匹配/损坏 → 行保持 NULL + 告警,**绝不 skip-ack**;
  4. 投递复用现有 alert-queue **drain**(at-least-once);**lease-audit 文件接受 drain 的 cap/age dead-letter 作为 terminal 本地兜底,但 readiness 与观察窗必须机器检查 lease-audit dead-letter 计数 = 0**(否则「24h 零 would_block」可能是被 dead-letter 吃掉的假绿);
  5. 崩溃语义: materialize 前崩 → 下 tick 重读;**rename 后/DB 标记前崩** → 下 tick 同名文件 parse+digest 匹配 → 补标,不重复投递超一次;drain POST 后 ack 前崩 → 至多重复一条,**永不漏**(四点 fault test);
  6. **必红 epoch 测试**(Codex R3 #2): 旧 epoch pending 文件在队列 → 删/重建 lease DB → 新 epoch 复用相同 audit id 段 → 必须生成**不同** batch/file,两个 payload 都可 drain;
  7. **mixed-queue 测试**(Codex R3 #3): 时间交错的 shell alert 与 lease-audit 文件超 cap 时,只 dead-letter 真正最老项(不按 lead 字母序、不挤掉无关告警);
  8. retention 只修剪 `materialized_at` 非 NULL 的行。
- [ ] **T7d 测试过 + commit**

### T8: 告警 kind 注册 + episode 语义 + parity

- [ ] **8 个 kind**: `lead_dual_active` / `lead_dual_active_sensor_degraded` / `lead_lease_store_broken` / `lead_lease_bypass_used` / `lead_lease_would_block` / **`lead_lease_control_broken`(mode 文件损坏)** / **`lead_identity_source_broken`(projects.json source_error)** / **`lead_backend_drift`(carrier 证据 mismatch/unknown/stale/probe error,Codex R6 #3)** + shell allowlist 同步 + **TS↔shell kind-face 双向 parity 守卫**。`ensureEpisodeMaterialized` 生成的 queue payload eventType 必须是合法 kind。
- [ ] **backend_drift 纳入统一 episode owner,且 fingerprint/恢复 owner 分型**(Codex R7 #3 + R10 #3): recurring-fault 集合 = `control_broken / identity_source_broken / store_broken / backend_drift` 全走 `ensureEpisodeMaterialized`。**同一 kind 下两类 source 必须分型**——关键反例: 健康 Codex carrier + 持续 Claude intruder 时,「carrier 证据健康」从一开始就为真,若作恢复条件会即时误清 episode → 无限重报:
  - `backend_drift:carrier:<shape>`(desired/actual 不一致、证据 stale/probe error): **恢复 owner = carrier 证据健康检查**(证据重新健康/desired==actual);
  - `backend_drift:claude_intruder`(desired-Codex 身份出现 claude-argv 进程): **恢复 owner = ps scanner**,该身份连续两 tick claudeCount=0 才 recovered;**健康 carrier 的请求/健康检查不得清此 episode**。
  **唯一通知策略**: drift 的 `would_block(backend_drift)` 审计行保留,Discord 投递复用同一 drift episode——collector 见「已有 specialized drift episode」不再生成第二条泛化 `lead_lease_would_block`。测试: **持续 intruder + N 次健康 carrier validation → 恰 1 条且 pointer 保持 active**;intruder 消失两 tick 才 recovered;再现=恰一个新 episode;N 次 validation 单告警、recover→recur、projects source_error 与 carrier drift 同时存在两 episode 互不吞。
- [ ] **持续性故障的单一 durable episode owner**(Codex R3 #4 + R4 #2 + R5 #1): `control_broken`/`identity_source_broken`/`store_broken` 会被每条 CLI 指令**和**每个 Bridge tick 同时观察——不允许两个独立 latch。共享协议 `ensureEpisodeMaterialized(sourceFingerprint)`(实现于 `lead-lease.ts`,CLI 与 Bridge 都只调它,任何一侧不得为同一 episode 单独调 notifier):
  - **两个正交状态轴 + 不可变 episode 身份,存储 = 独立小型 SQLite**(Codex R5 #1 + R6 #1 + R7 #2——普通文件没有「仅当内容仍为 E1 时 unlink」的原子原语,双 recovery + 复发会 ABA 误删 E2 的 pointer;故 pointer 与 episode state 都放 `~/.flywheel/state/lease-episodes.db`,BEGIN IMMEDIATE 串行化,与 lease DB 分离——删它最多导致重复告警,永不静默):
    - `episode_pointer(source_fingerprint PK, active_episode_id)` — active owner 唯一性由事务保证(create/clear 都是条件 UPDATE/DELETE WHERE active_episode_id=expected);
    - `episodes(episode_id PK, source_fingerprint, kind, fault_state active|recovered, delivery_state unmaterialized|queued|delivered|dead_lettered, ...)` — 身份不可变,状态列更新在事务内;pointer 发布与 record 创建同事务(不存在指向半创建 record 的毒指针);WAL+busy_timeout;`FLYWHEEL_LEAD_EPISODE_DB` 测试 seam;
    - **episode store 自身故障语义**(R8 #3,「最多重复、永不静默」的完整合同): store 打开/事务失败**不阻塞主写边界判定**,改为直接向 alert-queue 写带完整 payload 的 degraded alert(fallback id)+ 本地日志追加(宁重复);Bridge boot/tick 扫 queue/dead-letter 里的 episode payload,对 DB 缺行的 queued 项**重建最小 episode row**;drain terminal ack 遇 0-row(DB 被重建)→ 已成功 POST 即 unlink + 记 degraded-ack 日志(不无限重发);fault matrix: DB 分别在 `unmaterialized`/`queued`/POST-before-ack 三阶段被删/损坏/锁死,均断言不静默丢失;corrupt/locked 测试;
  - queue payload 携带 **episodeId**;**drain 终态回写永远按 payload episodeId 更新 `episodes` 行**(SQLite,非文件)——与 canonical pointer 当前指向谁无关(E1 已恢复、E2 已 active 时,drain E1 只更新 E1,绝不落到 E2);成功 POST → 先事务写 `delivery_state=delivered` **再** unlink(ack-before-unlink;崩在 ack 后 unlink 前 → 下轮见 delivered+文件在 → 只删不再 POST);cap/age/永久失败 → 先写 `dead_lettered/reason` 再移文件;
  - **ensure 的补 materialize 只允许 deliveryState 非终态**: delivered/dead_lettered 时 fault 持续也不重建(POST 后 ack 前崩允许至多一次重复,绝无无限重建);只有非终态且 queue/dead-letter 两处无记录才补;
  - **恢复 = 只动 pointer + faultState**: 健康检查成功 → 事务内条件清 pointer(WHERE active_episode_id=E1)+ 置 E1 `fault_state=recovered`(**不等待、不影响 deliveryState**);下次故障事务新建 pointer + 新 episodeId;BYPASS 保持 **per-use** 不并入;
  - **durable reconciler**(R7 #2——投递不得依赖故障再次发生): 每个 Bridge tick/启动扫描 `delivery_state IN (unmaterialized, queued)` 的全部 episodes(**含 recovered**),幂等补 materialize/确认 queue 文件在——recovered+unmaterialized 的 episode 也必然最终送达;
  - **必红竞态测试**(R6 #1 + R7 #2): E1 queued → 恢复 → 复发建 E2 → drain E1 只更新 E1,drain E2 各恰一次;**三进程竞态** R1 recover(E1) ∥ 复发 create(E2) ∥ R2 stale recover(E1) → E2 pointer 不被误删;recovery 后进程立即退出+重启 → E1 仍被 reconciler 送达;另测 recovery-before-materialize、recovery-before-dead-letter、双 episode 交错 drain;
  - 必红测试: 持续 fault → materialize → **成功 drain → 再 validation 不产生新文件/不再 POST**;dead-letter 后再 validation 不得复活;crash-after-POST/before-ack 与 ack-before-unlink 各自覆盖;真实并发(两进程 ensure → 恰一文件);crash-after-marker/before-queue;Bridge down 期间 CLI 入队;恢复后复发=恰再一条(新 episode id);连续 N 次 validation 全程 1 条;CLI 与 Bridge 同 incident 不双发。
- [ ] commit

## M5 — readiness 门 + 哨兵与全量回归

### T9: 可执行 readiness 门(Codex R3 #5)

- [ ] **T9a 失败测试**: 新 CLI `lead-lease readiness --json` + Bridge 只读诊断(`GET /api/lead-lease/diagnostics`,复用现有 token middleware,输出不含 secret): 双侧各报 lease DB 路径、mode 文件路径、effective mode+来源、`FLYWHEEL_LEAD_LEASE_MODE` override 是否存在、resolver 状态+projects.json digest、**queue/dead-letter 路径 + lease-audit pending/dead-letter 计数**(Codex R4 #4)、**episode DB path/health + unmaterialized/queued/dead-letter 计数**(R8 #3)、每个 **leaseProtected** Lead 的 row/bound/holder pid+lstart verdict + **backend_drift verdict**(desired effective backend vs carrier 证据 provider 的 fresh 证据,含证据 source/freshness)+ 每个 desired-Codex 身份的 **carrierInstanceReady verdict**(R8 #2;R10 #2 定稿判据——全局 readiness 进程拿不到 raw claim,**只消费 carrier-local self-check receipt**: receipt fresh、pid+lstart/instanceDigest 与当前 evidence 一致、cliDisposition 与 bridgeDisposition 均=passthrough 才 ready;旧 generation 无 receipt/receipt stale/任一 disposition 不一致 → 红)。readiness 命令比对双侧 + 全 verdict,**任一失配/dead-letter 非零/backend_drift → 非零退出**。必红反例: Bridge mode 路径不同;projects digest 不同;某 pane env override;某 lead unbound/holder 死;**存在一个 lease-audit dead-letter 文件(清理后恢复绿)**;**backend drift**;**carrierInstanceReady 四反例**(R9 #4——Ship step 4 的条件全部测试化): 旧 Codex generation 无 claim、wrong/stale digest、pid+lstart 复证失败、CLI 与 Bridge 对同一 claim disposition 不一致 → 均非零退出,新 generation matching claim 才绿。全一致 → exit 0。双侧 schema parity 断言含 dead-letter 与 carrierInstanceReady 字段;**secret-free 断言含 raw carrier instance id 不出现在 CLI JSON/Bridge JSON/日志/fixture snapshot**。
- [ ] **T9b 实现 + commit**

### T10: 哨兵与全量回归

- [ ] **T10a**: mode=off + SCAN=0 逐字节 byte-compat;无 provenance 时 envelope 字节不变;无 claim 的 Bridge 请求旧行为不变;**configured Codex Lead(codex-app-server)在全模式下行为零变化**——前提=writer 与健康 carrier instance 匹配(R7 #1;launcher 注入 carrierInstanceId 后其 CLI 调用天然携带)。
- [ ] **T10b**: 全仓 lint + 受影响包全测 + CI 绿。
- [ ] **T10c**: commit + push(docs 同 PR)。

## Ship 清单(钉子①——enforce 翻转是显式项,Lead task 跟踪)

1. PR merge(mode 无文件=audit_only,检测层默认开)→ 生产 `git pull` + dist rebuild。
2. **Bridge 重启** → 检测层 + outbox 收割上线;存量老 pane(无 env)的 lead 写入即产生 `would_block` 并可见——观察从此刻有真信号。
3. **批量 Lead 重启**(Tier-3)→ 每个 **leaseProtected**(claude-code)Lead acquire+bind+env。
3b. ☐ **存量 Codex carrier 迁移**(R8 #2——「Codex 不 acquire lease」≠「不参与 rollout」): Mufasa 与 codex-infra 两个 windowed TUI carrier 各做一次**显式、founder-gated 的 restart/rebind**(TUI 形态是 CLAUDE.md 硬规则,不得折进 Claude Tier-3 批里隐式做)→ 新 generation 注入 `FLYWHEEL_LEAD_CARRIER_INSTANCE_ID` → 等 FleetPoller 发布新 evidence → 触发 **carrier-local self-check**(R10 #2,全局 readiness 拿不到只在 carrier env 里的 raw claim,必须由 carrier 自己证明): 新 generation 从**真实 child env** 跑只读自检——同一 raw claim 分别过本地 CLI validator 与 Bridge self-check endpoint,**只持久化**原子 receipt `{leadKey, instanceDigest, pid, lstart, checkedAt, cliDisposition, bridgeDisposition, contractVersion}`(绝不写 raw);FleetPoller 验证并绑定 receipt 进 evidence。
4. ☐ **readiness proof(机器可查,enforce 前硬门;Codex R2 #6 + R3 #5 + R8 #2/#3)**: 运行 `node .../flywheel-comm/dist/index.js lead-lease readiness --json`——对每个 leaseProtected Lead 断言 row/bound/holder 活且与 ps 一致;**对每个 desired-Codex 身份断言 `carrierInstanceReady`**(live pid+lstart、evidence digest、运行 generation 已注入 claim、CLI 与 Bridge 对同一测试 claim disposition 一致——升级窗必红: 旧 Codex 进程无 claim 时 readiness 必须红,重启新 generation 后才绿);CLI 与 Bridge 的 control-plane 路径、effective mode+来源、projects.json digest 一致;双侧均无 `FLYWHEEL_LEAD_LEASE_MODE` override;resolver=ok 且 ambiguous=0;**lease-audit dead-letter 计数=0;episode DB path/health/pending 计数正常**。非零退出不许进 5。
5. 观察窗(≥24h): 预期**零** `would_block` **且 lease-audit dead-letter 保持 0**;出现先查因,修复后重新计窗。
5b. ☐ **enforce 前二次 readiness(双门;R11 #3——step 4 只证明 24h 前的状态)**: `set-mode enforce` **立即之前**再跑同一 `lead-lease readiness --json`,并要求全部 evidence/receipt age 在明确上限内;carrier generation 变了/receipt 过期 → 先从真实 child env 重跑 self-check;任一 readiness 红或观察窗出现 would_block/dead-letter → 重置观察窗。rollout 状态机测试: t0 绿 → t+23h carrier 无声重启且零写入 → 末次 readiness 必须拦下 enforce,重新 self-check 后才放行。
6. ☐ **ENFORCE 翻转**: `lead-lease set-mode enforce`(动态,无需二次重启)→ **立即双复验**(Codex R2 #6): stale `send` 被拒 **且** stale gated approve_to_ship 在 Bridge 被拒(各自零落库);BYPASS=1 放行且告警。**本项独立 checklist,Tadashi task 跟踪;不做完 FLY-1309 不算交付。**
7. 独立 QA(三段式 QA phase,529 Room 真机): 双活注入(preflight HOLD、`lead_dual_active` 恰一条、后起/ambiguous/持有者标注)、enforce stale 双边界拒、BYPASS 响亮、store 损坏两分层、**删 lease DB 后 enforce 仍拒**、KeepAlive/resume 回归(gen+1、旧代失权、零误告警)、fault matrix 抽样、溯源跨代映射两 pane、envelope runner 侧可见。
8. Follow-up 落单(Linear): terminal-mcp 旁路(→FLY-1306/后续)、Codex lead backend、per-Lead credential。

## 风险

| 风险 | 缓解 |
|------|------|
| enforce 翻早/两边界不一致 | readiness proof 硬门含双边界控制面一致性;set-mode 可即时回退 |
| 检测误报 | executable+双形态整词+连续两 tick+latch+ambiguous 不猜;突变验证 |
| lease 库单点 | 启动 fail-open;写入 fail-closed 响亮出口;mode 独立控制面(删库不降级);库坏告警不依赖库 |
| 迁移丢列 | SCHEMA+全部重建 DDL 同步;真旧 schema fixture 先红后绿 |
| 告警漏报 | durable outbox(materialize→drain→ack),三点崩溃测试,宁重复不漏 |
| 配置层故障 | resolver 四态契约,source_error 永不当空集;恢复自动 |
| bash 3.2 | POSIX;shellcheck+真机(FLY-694 教训) |
| 升级窗混布 | 加性字段双向兼容;audit_only 只记账 |

## Milestone 顺序与提交纪律

M1→M2(T3→T4→T5→**T5.5**)→M3→M4→M5;每 task RED→GREEN→commit;M2 后 CLI 真机冒烟(audit_only 无害);M3/M4 真 tmux/Bridge 冒烟后进 M5。单 PR(三段式共享分支),commit 前缀 `feat(fly-1309):`/`fix(fly-1309):`。
