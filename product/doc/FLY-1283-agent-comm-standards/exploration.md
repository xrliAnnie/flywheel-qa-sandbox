# FLY-1283 Agent-to-Agent 通信标准 — 探索

Issue: FLY-1283 (https://linear.app/geoforge3d/issue/FLY-1283/research-agent-to-agent-通信标准调研-google-a2a-mcp-业界-agent-消息模式-vs-我们的)
日期: 2026-07-16
基于: 无

---

## 0. 这份文档要解决什么

Annie 2026-07-14 深夜的原话:我们的 commdb+Bridge 总线形状对(durable queue + per-family adapter),但都是自建的;A2A 协议可能有新做法,"**有没有什么东西是我们可以直接去操作使用的**"。

这份探索定义问题边界 + 记录进场前的审计发现。结论在 `research.md`,落地建议在 `plan.md`。

---

## 1. 进场前审计:两处 issue 原文已过期/冲突(已经 Lead 确认)

Research 的第一条纪律是**先审计再建议**。审计推翻了 issue 的两条前提。

### 1.1 时序前提已过期 —— 4a 从"绿地选型"变成"retrofit"

issue 原文写:「**不阻塞 FLY-1279**,今晚的洞在流血,1279 照跑;本研究决定 1279 的 wire format」。

**事实**:FLY-1279 已于 2026-07-15 21:42 **Done**,PR #606 已 merge。它已经自建完成:

| 1279 建的东西 | 落地位置 |
|---|---|
| park-watch 行状态机 `NEW→LEAD_NOTIFIED→(ACKED\|ESCALATED)→RESOLVED`(+`CLEARING` TTL rebound) | 巡检 + 通知阶梯(`StateStore.ts:524-533` 核实) |
| 显式 ACK 命令 | `packages/flywheel-comm/src/commands/ack-event.ts` |
| 未 ACK 事件重投 | `GUARDRAIL_EVENT_TYPES` (lead-runtime) |
| QA 死亡检测 + clean-retry | `auto-qa-coordinator` + `event-route` |

且带 25/25 QA(含真 Discord readback)。

→ **4a 的问题变了**:不是"选个标准来建送达保证",而是"**已经建好且验过的这套,要不要向标准靠**"。约束 = 保住现有生产语义 + QA 资产。Lead 已确认按 retrofit 框架答。

### 1.2 交付项与 Runner 铁律冲突 —— HTML 我不产不投

issue 原文写「founder-friendly HTML 摘要发本 issue thread」。但 Tadashi 终裁铁律(FLY-1048/1062/1071 三次收紧)= **founder 物料 Runner 连产都不产**;`publish-report` 不带 `--channel` 也会默认投卡落 core。

→ 已与 Lead 确认:我只 relay 素材(对比矩阵事实 + 结构建议),**HTML 由 Lead 产 + Lead 投**。

---

## 2. 我们自己的总线 —— 真实审计(不凭印象)

| 项 | 实测 |
|---|---|
| 核心实现 | `packages/flywheel-comm/src/db.ts` = **2190 行** |
| 总线相关合计 | ~2799 行(db + types + wake + inbox-mcp delivery/index) |
| CLI 命令数 | **40** 个 (`packages/flywheel-comm/src/commands/*.ts`) |
| **调用面** | **208 个 .ts 文件** 文本命中 `flywheel-comm`/`CommDB`(见下方口径) |
| 存储 | 单机 SQLite,`better-sqlite3`(同步、进程内) |
| 部署 | 全部 agent 在一台机器(Annie 的 Mac);~10-25 session |
| FLY-1279 增量 | **+6191 行 / 72 文件**(`packages/` 下,含测试) |

> ⚠️ **统计口径(Codex R1 要求,采纳)** —— 否则是把近似统计当稳定 API 面指标。每个数字的可复现命令:
> ```
> wc -l packages/flywheel-comm/src/db.ts                                  → 2190
> ls packages/flywheel-comm/src/commands/*.ts | grep -v __tests__ | wc -l → 40
> rg -l --glob '*.ts' 'flywheel-comm|CommDB' packages \
>   | grep -v __tests__ | grep -v '\.test\.ts' | wc -l                    → 208
> git show --numstat --format="" 8f6b330b1 \
>   | awk '$3 ~ /^packages\//{a+=$1;f++} END{print a,f}'                  → 6191 72
> ```
> **「调用面 208」是文本命中数,不是稳定 API 面指标**(Codex 用略不同的过滤器数到 206 —— 差异来自 Vitest 配置等边缘项)。它只支撑「触及消息模型的改动要穿过一个不小的面」这个**量级**判断,不承载精确语义。

### 2.1 `messages` 表真实字段(db.ts:13-32)

```
id / from_agent / to_agent
type      CHECK IN ('question','response','instruction','progress','ack_receipt')
content / parent_id / read_at / created_at
expires_at    DEFAULT (datetime('now','+72 hours'))
relay_state   CHECK IN ('open','protected','terminal_disposed')
logical_event_id
sender_lease_key / sender_generation / sender_holder_pid / sender_holder_start
writer_pid / writer_start
+ checkpoint (后加列)
```

**关键观察**:这张表携带的语义远超"消息信封"——租约(lease)、世代(generation)、写者进程身份(pid/start,用于崩溃恢复对账)、relay 状态机、checkpoint(门)。这些是**我们的信任地基**,不是可有可无的装饰。谁要"换成标准",就得先回答这些字段去哪。

---

## 3. 问题拆解:三个落点(承 issue 的 4a/4b/4c)

| 落点 | 原问题 | 审计后的真问题 |
|---|---|---|
| **4a** 送达保证 | 直接采用某标准/库,还是自建但用标准 wire format? | 1279 已建好并验过 → **retrofit 的成本/收益**是什么? |
| **4b** 边缘说 A2A | commdb 内核不动,适配层讲标准协议,可行吗? | 我们的语义**能不能**用 A2A 的数据模型表达?表达不了的部分去哪? |
| **4c** 跨机器/跨公司 | 标准协议价值多大? | **今天有没有真实的互操作对象?** |

---

## 4. 进场假设(Lead 已确认是合理起手,但**是假设,证据推翻就推翻**)

1. commdb = 单机 SQLite 进程内总线;A2A = 跨组织 HTTP/JSON-RPC 协议 → **不在同一层**。
2. 送达保证是 **durable-queue 层**的事,不是 **wire-format 层**的事 → A2A 大概率不能"直接采用"来解决 4a。
3. 真价值(若有)在 4b/4c,不在 4a。

> Lead 原话:「记住是假设 —— 证据推翻就推翻,别预设结论」。

**假设 1/2 的验证结果见 `research.md` §1:被 spec 原文证实,且比假设更强 —— A2A spec 亲口否认自己是可靠投递机制。**

---

## 5. 方法与纪律(Lead 钉死的两条)

### 纪律① — DR 会幻觉,涉及送达保证语义的每一条回 spec 原文核

**执行方式**:把 A2A v1.0.0 spec 原文(3610 行)+ a2a.proto(权威数据模型)+ MCP spec 拉到本地自己 grep + 逐条读上下文,**带阳性对照验尺子**(先 grep 已知存在的词,证明 grep 没坏,那些 0 才是真 0)。

**这条纪律当场就抓到两个错**:
1. **WebFetch 的小模型摘要读错** —— 它说 A2A spec 对 at-least-once "完全沉默",实际 spec 第 882 行有一整节叫 **Server Guarantees**。
2. **DR 自己也略微过头** —— DR 说"no normative language ... at-least-once",同样漏了那节。

→ 若不回原文核,这份研究会带着一个事实错误交付。**证据已冻结成带行号的文件**(`evidence-a2a-*.txt`)可复核。

### 纪律② — DR 要浏览器 paired,browser 空就 funnel 不空转

DR **跑完了**(7 分钟 / 38 引用 / 353 次搜索),但卡在**导出**:报告渲染在跨域 iframe,↓ 导出菜单合成点击进不去(headed 已验 `headless:false`、已登录 Pro、iframe rect 已 laid out、CSS→截图坐标两种独立算法给出同一坐标 = 位置是对的)。按 skill 纪律**停止暴力重试、不假装拿到报告**,已 funnel 给 Lead(question `e6b6c53f`)。

→ 研究**没有因此停**:一手 spec 我自己读,业界盘点我并行铺开。**我自己读 spec 本来就比 DR 可靠**(见纪律①抓到的两个错)。

---

## 6. 未决 / 交给下游

- DR 全文若拿到 → 并进 `research.md` 作为交叉验证(不作为唯一来源)。
- founder HTML 素材 → relay 给 Lead,由 Lead 产 + 投。
