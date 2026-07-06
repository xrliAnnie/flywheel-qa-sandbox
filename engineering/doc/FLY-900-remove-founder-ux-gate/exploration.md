# FLY-900 撤掉 founder-UX 签字门 — 探索

Issue: FLY-900 (https://linear.app/geoforge3d/issue/FLY-900/infragovernance-撤掉-founder-ux-签字门fly-598-implement-前-signoff-annie)
日期: 2026-07-06
基于: 无

---

## 1. Problem

Annie 直接指令（2026-07-06 ~06:42 PT）：「能够把这个规定撤了吗，没必要。」指的是 **FLY-598 / FLY-869 founder-UX 签字门**——issue 进 `implement` 阶段前，若被标记 `founder_facing_ux`，必须先有 Annie 在 issue thread 里的 UX 签字（`record-founder-ux-signoff` → `await-founder-ux-gate`）。

现在必须撤，两条都成立：

1. **Annie 定为不必要**（founder 撤自己的 gate，合法）。
2. **它现在其实是坏的**：Bridge 没配 `FLYWHEEL_FOUNDER_USER_ID`（`~/.flywheel/.env` 和 Bridge env 都没有）→ 签字写路由 `verifyAndRecordFounderUxSignoff` 直接 503「founder identity not configured」→ **fail-closed 把所有 founder-facing issue 的 implement 永久挡住**。Annie 就算在 thread 里签了 OK 也记不进去。

---

## 2. Part 1 实证发现（先做的紧急解封，已暴露关键事实）

Lead 指令：清 FLY-887(`a210d551`) + FLY-898(`2e7cdea1`) 的 StateStore `founder_facing_ux` 标记，让它俩下一轮 poll 通过 `await-founder-ux-gate`（引 `stage-guard.ts:54`）→ 进 implement。

**实证核对（抓 runner pane + 只读查 DB）推翻了这个机制假设**：

- 两个 runner 真实卡点是 **`await-founder-ux-gate`（Layer A）**，poll 的是 `GET /api/founder-ux/status` → `signoffSatisfies()`（routes.ts:116 / signoff.ts:50）——**只看 sign-off 记录，根本不看 `founder_facing_ux`**。Lead 引的 `stage-guard.ts:54` 是 **Layer B**（`stage set implement` 事件时的 Bridge guard），是另一条路径。
- 所以**清 `founder_facing_ux` 只解 Layer B，解不了它俩实际卡的 await-gate**。
- 而且就在调查这 ~2 分钟里，887 + 898 两个 session 都从 running → `completed`，route=`phase_design_complete`（设计阶段已交付到各自分支）。它俩不再是「卡住的 runner」，是已完成的 design 阶段。
- 已用正规 `StateStore.patchSessionMetadata` API（非裸 sqlite）清了两个 exec 的标记（写前=1/写后=0 已验证）——这一步已报告 Lead，并说明「清标记对已完成 session + Layer A 卡点无法解封」。

**这个发现直接定义了 Part 2 的正确性硬要求**（见 §4）：撤门必须同时覆盖 Layer A（await-gate）和 Layer B（stage-guard），只关一层等于没撤——runner 还会卡死在另一层。

---

## 3. 系统现状：门的完整 enforcement 地图

founder_ux_gate 由单一 mode 驱动（`off | audit_only | enforce`）。当前生产默认 = `enforce`（FLY-869 default-on；absent config 经 `resolveEffectiveFounderUxConfig` 解析成 enforce）。

能阻断一个 runner 进 implement 的**全部路径**：

| 标 | 位置 | 作用 | mode 来源 |
|----|------|------|-----------|
| **A** | `Blueprint.ts:1128` | runner prompt 注入「FOUNDER-UX GATE」段（叫 runner 去跑 await-gate + record-signoff） | live config（run-infra `resolveEffectiveFounderUxConfig`） |
| **B** | `routes.ts:116` status 路由 | `await-founder-ux-gate` poll 它 → `signoffSatisfies()`（**不看 mode**，只看 sign-off） | 无（永远查 sign-off） |
| **C** | `event-route.ts:1744` stage-guard | `stage set implement` 事件 → `evaluateFounderUxStageGuard`（读 **per-session 快照** `founder_ux_gate_mode` 列 + `founder_facing_ux`） | session 快照（run-start 时定） |
| **D** | `event-route.ts:1717` `founder_ux_declared` | runner self-declare → 置 `founder_facing_ux=1`（喂 C） | 无 |

附带（非阻断，但属门的一部分）：
- `run-infra.ts:641` run-start 解析 mode → 传 Blueprint(A) + 快照到 session(喂 C) + trigger 置 founder_facing_ux。
- `claude-lead.sh:1935` 按 mode 给 Lead 追加 `founder-ux-rules.md` 规则文件。

**关键**：B（status 路由）**完全不看 mode**——所以哪怕把 live config 的 mode 改成 off，await-gate 仍会永远 fail。C 读的是 **session 快照** mode，不是 live config——所以改 live config 对已快照 enforce 的 session 无效。这两点是「只改 config mode」会漏掉的坑。

---

## 4. 正确性硬要求（撤门必须满足）

1. **同时关掉 A + B + C 三个阻断点**（D 随 C 失效）。只关任一层，runner 会卡死在另一层（这正是 887/898 的教训）。
2. **默认 OFF = 门永不 block**（Annie 撤掉；env flag 默认关）。
3. **代码可逆、不硬删**：`FLYWHEEL_FOUNDER_UX_GATE_ENABLED=1` 时逐字恢复原 enforce 行为。
4. **只碰这一个门**。绝不动：ship 的 founder 批准门（`approve_to_ship` / `founder-only-authority` / FLY-175 `founderConsent`——types.ts 明确 founder_ux_gate 与 founderConsent 蓄意分离）、codex 硬门（FLY-827）、独立 QA 门、三段式 Lead-对齐 `gate brainstorm`（与 founder-UX 签字门是**不同机制**，保留）。

---

## 5. 设计选项（env kill-switch 挂在哪）

新增全局 env 开关 `FLYWHEEL_FOUNDER_UX_GATE_ENABLED`，默认 OFF（未设 / 非 `1`/`true` → 门禁用）。语义定义收敛到一个 helper `isFounderUxGateEnabled(env)`（packages/config），shell 侧 claude-lead.sh 直读该 env。分歧在于「在哪应用它」：

### Option 1 — 挂进 `resolveEffectiveFounderUxConfig`（单一 choke point）
env OFF → 该函数直接返回 `mode: "off"`。
- 优点：run-start 集群（run-infra→Blueprint(A) + 快照(C) + trigger）一处搞定。
- 缺点：① 把纯函数变成 env-dependent，且改了它的默认（enforce→off），**大量既有测试断言「absent→enforce」会红**，需连带改。② **仍覆盖不了 B（status 路由不调它）和 C 的 stale 快照**（已 snapshot enforce 的 session 仍读快照 enforce）——还是得单独在 B、C 加 env 短路。→ 没真正省事，还引入纯函数默认变更的大 blast radius。

### Option 2 —（推荐）在三个 enforcement 点各自应用 `isFounderUxGateEnabled()`
保持 `resolveEffectiveFounderUxConfig` **纯 + 字节兼容不动**；env kill 精确挂在阻断/注入点：
- **A** Blueprint 注入条件：`founderUxMode !== "off" && isFounderUxGateEnabled()` → 禁用则不注入 prompt 段（runner 根本不会去跑 await-gate，从源头断 Layer A）。
- **B** status 路由：`if (!isFounderUxGateEnabled()) return { approved: true }` → 补上 Layer A gap + 兼容 stale session。
- **C** stage-guard 调用点（event-route:1744）：`if (!isFounderUxGateEnabled()) → pass`（读快照前短路；`evaluateFounderUxStageGuard` 保持纯，env 短路放调用点，或作参数传入）。
- claude-lead.sh：`isFounderUxGateEnabled` env 未开 → 跳过 `founder-ux-rules.md` 追加（Lead 规则侧一致）。
- 优点：每点局部、可独立单测；不动纯 resolver（零 resolver 测试 churn）；单一 helper = flag 语义单一真相；**A+B+C 完整覆盖**（见 §4-1 证明）。
- 缺点：3~4 个显式改点（可接受；且正好一一对应真实 enforcement 点，比"藏在 config 默认里"更透明、更难漏）。
- 可逆：env=`1` → A/B/C/规则全恢复；resolver 未动。

**倾向 Option 2**：blast radius 最小、最不易漏阻断点、纯函数字节兼容。§4-1 的「A+B+C 全覆盖」证明比 Option 1「靠改默认顺带覆盖」更可审计。

---

## 6. 部署 & 时序

- env flag 要 **Bridge 重启**才生效 → 归今晚 batched Tier-3（Lead 已定）。
- hold PR 在 founder ship-gate（Annie review 或 Lead 按隔夜授权 executor merge，随 Tier-3）。
- 887/898：设计已交付。它俩进 implement = 由 Lead re-dispatch implement 阶段；重启+flag OFF 后，新 dispatch 的 run-start 不再注入门、await-gate 直接 approved、stage-guard pass。**重启前**若要它俩立即 implement，需 Lead 决定是否走 per-issue 豁免（见 §7 open Q）——不由本设计擅自 re-dispatch。

---

## 7. Open Questions（brainstorm gate 确认）

1. **本 session 范围**：第一条 lead-instruction 说「Path A、单 session 做完」；正式 dispatch 说「design 阶段、别写实现码、complete phase_design_complete」。两者冲突。本设计按 **design 阶段** 走（出 exploration/research/plan + design review，不写实现码），除非 Lead 明确要 Path A 单 session 连实现+PR。请 Lead 定。
2. **设计选型**：认可 Option 2（三 enforcement 点各挂 env kill、保持 resolver 纯）吗？
3. **887/898 重启前是否要立即 implement**：要的话我把 per-issue 豁免路径在 plan 里核实清楚供 Lead dispatch；不要就随 flag+重启一起解。
4. **flag 命名/默认**：`FLYWHEEL_FOUNDER_UX_GATE_ENABLED`，默认 OFF（未设=禁用），`1`/`true` 才启用——确认？
