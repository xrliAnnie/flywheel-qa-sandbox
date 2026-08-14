# FLY-1764 大喇叭重设计 — 独立 QA 报告(implement 阶段)

Issue: FLY-1764 (https://linear.app/geoforge3d/issue/FLY-1764/机制-大喇叭lead-events-推送通道整体重设计-先聊清设计再动手告警该投给谁要不要专用通道与邮局的关系)
日期: 2026-08-14
基于: plan.md(implement-ready 版)

**被验 head**: `b73fc8cc7efa4c0cf81a2f322cbd6682c9a0c000`(PR #836,OPEN、非 draft、MERGEABLE;开跑与出判决前各核一次,无漂移)
**判决**: **FAIL** — 1 条阻断级缺陷(部署会把生产 Bridge 打停)。其余全部通过。

---

## 0. 一句话结论

产品设计的四个工作块(A 退役广播腿 / B 邮局终态修复 / C 旋钮 α-β / D 旋钮 SLA)**行为全部正确,真机 Discord 实测 25/25 通过**。
但工作块 A 的 **cutover 脚本会在下一次真实部署时 fail-closed 打停整个 Bridge** —— 原因是生产磁盘上有一个老 schema 的 `comm.db`,而退役 UPDATE 写了它没有的列。

---

## 1. 🔴 阻断缺陷:退役脚本在真实生产数据上 fail-closed,新 Bridge 永不启动

### 现象(真数据实测,生产只读、改动只发生在副本上)

把生产 `~/.flywheel/comm/` 全量 10 个 `comm.db` 复制到沙箱,用本分支的
`retire_legacy_swap_broadcasts` 跑一遍:

```
[restart] legacy swap retirement …/flywheel/comm.db:  matched=2 changed=2
[restart] legacy swap retirement …/geoforge3d/comm.db: matched=1 changed=1
[restart] legacy swap retirement …/growth/comm.db:     matched=2 changed=2
[restart] ERROR: legacy swap retirement schema/open failure for …/sub/comm.db (update):
          Parse error near line 10: no such column: delivered_at
RC=1
```

### 根因

生产 `~/.flywheel/comm/sub/comm.db`(sub 项目并入 tidal-echo 后遗留,最后写入 8-08,**mailbox 行数 = 0**)
的 mailbox 表缺两列,而退役 UPDATE 无条件写它们:

| 列 | 其余 9 个库 | sub |
|---|---|---|
| `delivered_at` | 有 | **无** |
| `lease_retry_count` | 有 | **无** |

`legacy_swap_find_dbs` 按设计扫全盘(计划明确要求「不得只枚举当前 Bridge projects 配置」),
所以这个**空的、零待退役行的**陈旧库照样被纳入,并且一击 fail-closed。

### 为什么这次部署一定会撞上(可证伪的三步)

1. 生产 `~/.flywheel/deployed-sha` = `f3a27971`;
2. 该 commit 的 `packages/teamlead/src/bridge/fleet-sensors.ts` 里 `broadcastLoadShed` 出现 **5 次**
   ⇒ `legacy_swap_retirement_required` 返回 0 = **一次性闸会触发**;
3. `retire_legacy_swap_broadcasts` 在 sub 上返回 1。

### 后果(读 restart-services.sh 调用链)

`deploy_and_verify` 的顺序是 `pause_admission → stop_bridge → build → 【退役】 → start_bridge`。
退役失败走 `return 1`(`scripts/restart-services.sh:2450-2458`),而 `deploy_and_verify` 在
`:2768` 是**裸调用,没有任何 rollback / 重启老 Bridge 的兜底**。

⇒ **Bridge 已停、新 Bridge 不启动、脚本打印 Done 结束。全舰 Bridge 掉线,直到人工介入。**
这恰好发生在「ship 这个 PR」的那一次部署上。

### 建议修法(实现方定夺,两条都建议做)

- **(a) 零命中即跳过**:先用只读 SELECT 数一遍待退役行(该 SELECT 只用 `id`/`from_agent`/`type`/`state`,
  这四列在盘上每种 schema 变体里都有),为 0 就跳过该库 —— 直接消掉本次的 sub 场景;
- **(b) 按实际列构造 SET**:从 `PRAGMA table_info(mailbox)` 取列名,只清理**存在**的 lease/retry 列 ——
  这样即使某个老 schema 库**真的带着**待退役行也能收敛。

两条都不能削弱「库打不开 / 表缺失 / 锁重试耗尽 → fail closed」的既有合同;
要区分的是「老而合法的 schema 变体缺列」与「库损坏」。

**另外建议(非阻断)**:退役失败=Bridge 永久不起,建议与 `mqb_begin` 一样至少考虑
`rollback_and_restart` 兜底,否则任何一次锁竞争耗尽都等于一次计划外停机。

---

## 2. ✅ 通过项(全部有真凭据)

### 2.1 真机 Discord E2E — 隔离 529 房 `#test-flywheel-alerts`(25/25 PASS)

模块驱动 harness:真编译 dist + 真 test bot token + 真 Discord POST/GET,零 mock;
生产 Bridge / 频道 / claims.db / comm.db 全程未碰(临时 queue/dl/claims + 临时 StateStore)。
频道:https://discord.com/channels/1512577412069658634/1519421055805165842 (标记 `[QA1764-276951]`)

| 组 | 验的是什么 | 结果 |
|---|---|---|
| A1-A9 | **本单新增的 `no_action` 路径**:manual hold 占着 live episode → 工单 `MONITORING`、`repair_status=no_action`、**attempt_count=0**(不烧 ARC 预算)、hold 未被改动、Discord 线程里真的出现中性句「已有 pressure-hold 生效;不重复动作,继续监测」、**该消息零 founder mention**、全线程无「安全闸拒绝/修不了」误导文案 | 9/9 |
| B1-B3 | **对照组**:同样 live episode 但**没有** hold → `needs_human` + 工单 `ESCALATED` + Discord 里真的 @ 了 founder。证明 A 的沉默是**判断**,不是一条永远发不出声的死路 | 3/3 |
| C0-C4 | **MONITORING 升级时序**(真 row 的 first_seen_at + 真 `decideTicketEscalation`):5 分钟 unclaimed 窗内不升级、超 30 分钟 kind timeout 才升级、1 秒龄对照不升级;**旋钮 2** `FLYWHEEL_SWAP_PRESSURE_TIMEOUT_MIN=1` 真把窗口改成 1 分钟 | 5/5 |
| D0-D4 | **旋钮 1 的 β 档**:两个**真 FleetSensors 产出**的 episode(A 已恢复 / B 仍活)经真 enqueue 落盘 → β drain:A 判 stale 弃投进 dead-letter(`stale-episode-…json`)、B **真的投进了 Discord**;`staleSuppressed=1`、`deadLettered=0` | 6/6 |
| E1 | **α 默认档字节兼容对照**(同一份 fixture,env 不设):两条**都**真投递,零抑制 | 1/1 |
| F1 | 弃投**不会**触发「告警链路坏了」meta-alert;真投递故障仍然会 | 1/1 |

诚实边界:Discord 无法被要求按需返回 503,所以 D/E 的**入队**动作在 fetch 边界注入了一次瞬时失败。
入队之后的一切(producer payload、队列文件、freshness 探针、drain 判定、幸存者的真实投递)都是真的。

### 2.2 既有 fleet 告警全链真机 E2E(FLY-1082 harness,38/38 PASS)

`FLYWHEEL_MEM_PAGE_DEBOUNCE_SEC=0` 下 5 类 fleet 告警全过,swap 告警真的落进隔离频道;
其中直接对应本单的断言:
- `① pressure alert emitted zero per-Lead mailbox instructions — notified=0`
- `①′ no per-Lead mailbox instruction during the scar scenario`

⇒ 广播腿确实退役了:**同一个压力 episode 只产生 owner-routed 工单,零 per-Lead 邮箱指令**。

### 2.3 退役脚本在真数据上的正确部分

同一次副本实测里,**除 sub 之外全部正确**:
- 3 个库共 **5 条真实存量 live 行**(flywheel 2 / geoforge3d 1 / growth 2)被精确退役,postcondition 归零;
- **非目标行按 SHA 逐字未变**(退役前后指纹同为 `2a0383ff…`)—— 历史 ACKED/DEAD 广播行、
  非 bridge 产的同名行、普通消息都没被误伤。

### 2.4 单测 / 静态门

| 门 | 结果 |
|---|---|
| teamlead 定向 6 文件 | **110/110** |
| flywheel-comm `db.test.ts` | **100/100** |
| `legacy-swap-broadcast-retirement.test.sh` | **11/11** |
| 全仓 `pnpm lint` | RC=0(7 条既有 warning) |
| 全仓 `pnpm -r build` | RC=0 |

### 2.5 变异检验(证明测试是把能用的尺子,不是空过绿)

四处故意改坏生产代码,**每处都恰好打红对应用例**,改完立即还原、`git status` 归零:

| 变异 | 打红的用例 |
|---|---|
| `buildAlert` 去掉 `episodeId` | `real FleetSensors payloads retain episode identity…` |
| `shouldReportDeadLetteredDrain` 把 staleSuppressed 也算故障 | `reports only actual dead letters, never expected stale suppression` |
| 删 `decideTicketEscalation` 的 MONITORING 分支 | `MONITORING ignores unclaimed fallback and waits for the kind timeout` |
| Hub 把 `no_action` 写成 `needs_human` | `no_action → MONITORING without founder mention or attempt consumption` |

顺带:我自己第一版 harness 的 `decideTicketEscalation` 调用签名写错(把 `nowMs` 当 `ageMs` 传),
导致 C1 **假绿**;发现后改成真 row 的 `first_seen_at` + 加了 C3 反向对照才作数。

### 2.6 工作块 B(邮局终态行不重投)

两条读查询改成 JOIN 物理表 + `state IN ('QUEUED','LEASED')`。
生产 10 个 comm.db 里实际出现的 state 只有 `QUEUED / LEASED / ACKED / DEAD` ——
新过滤排除的恰好是两个终态,无误伤面。

---

## 3. 一条 pre-existing 的仪器缺陷(不是本单的锅,建议顺手修)

`scripts/qa-fly-1082-fleet-alerts-e2e.mjs` 场景 ① 在默认 env 下**必然 FAIL**:

```
✗ ① swap ticket opened + AutoRepairBot ran the reversible hold repair (REPAIRING) — status=undefined repair=undefined
```

harness 用 `env: process.env` 且**从不设** `FLYWHEEL_MEM_PAGE_DEBOUNCE_SEC`(默认 120 秒),
而场景 ① 只连打两个 tick(相隔毫秒级)→ 永远到不了 page due 点 → 不出工单。

**归因证据(三条,不是猜)**:
1. `maybePage` 的去抖闸 `if (elapsedMs < debounceSec * 1000) return;` 与 merge-base **逐字相同**
   (整个函数的差异只有被删掉的那行 `broadcastLoadShed`);
2. `pageDebounceSecFromEnv` 与 merge-base **代码行完全相同**;
3. merge-base 版 harness 同样 `grep -c MEM_PAGE_DEBOUNCE = 0`,场景 ① 的驱动与断言逐字未改。

⇒ 与 FLY-1764 无因果关系;显式设 `FLYWHEEL_MEM_PAGE_DEBOUNCE_SEC=0` 后该 harness **38/38 全绿**。
建议在 harness 里把该 env 钉死,别让一条恒红断言长期消耗后来者。

---

## 4. 计划符合度

| 计划要求 | 实现 | 结论 |
|---|---|---|
| A 精确刀口:删 `notifyLead`/`listLeadIds`/`broadcastLoadShed`;**保留** `leadProjectByAgentId` / `notifyLeadInstruction` / server-loss 接线 | 逐条相符;FLY-1082 harness 的 server-loss 场景仍 `ONE grouped casualty notification per affected Lead` 通过 | ✅ |
| A 伴随合同:`RepairOutcome` 三态 + `assertNever` exhaustive switch;Hub 四处 outcome 消费点全改 | 已改,并有真机断言覆盖初次与重试两条路径 | ✅ |
| A `MONITORING` 显式分支:不 ARC 重试、不落 NEW 的 unclaimed fallback、只在 kind timeout 后升级 | 相符(C1/C2/C3 真机验证) | ✅ |
| B cherry-pick #829 的 42 行修复 | 相符,原测试一并进来且绿 | ✅ |
| C 旋钮 α/β、同步 probe、fail-open、`staleSuppressed` 不算故障 | 相符 | ✅ |
| C 判定表 `bridge_abnormal_exit`:`bootReconcileDone → true` | **实现更保守:一律 `null`**(附理由:崩溃是时间点事实,替代 Bridge 完成 boot 对账不该让崩溃证据过期) | ⚠️ 有意偏离,**方向是更安全的 fail-open**,可接受;建议在 plan 里补一句备案 |
| C 判定表 ①:healthy → true(未区分 holdfail) | **实现更保守:`swap-holdfail:` 一律 `null`**(hold 写失败是「派发没被保护」的唯一信号,不能被恢复抹掉) | ⚠️ 同上,更安全,可接受 |
| D 旋钮 2 零新代码 + 三态解析验收 | 相符(C4 真机验证 env 覆盖真生效) | ✅ |
| A cutover 合同:停旧 Bridge → 装新 bytes → 全盘扫描退休 → postcondition → 才起新 Bridge | 顺序正确,但**第 3 步在真实盘面上 fail-closed**(见 §1) | ❌ |

---

## 5. 没测什么(honest boundary)

- **没做整机真部署**:没有在生产上跑 `restart-services.sh`(会真停生产 Bridge)。§1 的部署后果是
  「真数据实测的函数返回值」+「读调用链」两段拼出来的,不是观测到的停机。要看到停机本身需要一次真部署 —— 而那正是我建议先别做的事。
- **没验 β 档在生产的长期回放行为**:β 默认不开,本次只验了单次 drain 的判定与投递。
- **没验 Discord 真的挂掉时的排队**:用 fetch 边界注入的 503 代替(§2.1 已声明)。
- **没跑全量 `pnpm test:packages:run`**:按既有教训(全量套件会压死生产 Bridge)只跑触达文件;
  全量以 CI 为准。
- **`no_action` 在 `infra_bot_down` / `tmux_server_lost` 等其它 kind 上的渲染**没单独验 —— 本单只有 swap 会返回 `no_action`。

---

## 6. 复测清单(修完 §1 后我要重跑的)

1. 真数据副本再跑一次 `retire_legacy_swap_broadcasts`:**RC=0**,sub 被安全跳过或安全收敛,
   5 条真实 live 行仍归零,非目标行指纹仍为 `2a0383ff…`;
2. 补一条针对「老 schema(缺 `delivered_at`/`lease_retry_count`)且**带**待退役行」的用例,证明 (b) 修法真的收敛;
3. 重跑 `legacy-swap-broadcast-retirement.test.sh` + teamlead/flywheel-comm 定向套件;
4. 重跑本单真机 Discord harness(25 项),确认修 §1 没碰坏告警腿。
