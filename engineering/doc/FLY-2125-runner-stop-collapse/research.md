# FLY-2125 停驻申报按机器状态收敛 — 调研
Issue: FLY-2125 (https://linear.app/geoforge3d/issue/FLY-2125/病根-停驻体的-runner-stopped-申报无服务端合并节流同内容申报逐轮铸出lead-节律指令双重回执后仍-160-秒连发-7)
日期: 2026-09-03
基于: exploration.md

## 1. 真实写入链路

Codex 每次 `agent-turn-complete` 都触发
`scripts/hooks/runner-stop-notify.sh`。hook 只校验主 TUI client、提取 `turn-id` 与
`last-assistant-message`，随后 detached 调用同一个 `flywheel-comm runner-stopped`。

`packages/flywheel-comm/src/commands/runner-stopped.ts` 的当前流程是：

1. 从 `sessions` / `session_receipt_lineage` 验证 execution、issue、Lead 三元身份；
2. 按 stop failure → completion breadcrumb → terminal session → pending gate/question →
   declared park → Codex quota/context text → fallback 的顺序推导 reason/detail；
3. fallback 把完整 `last-assistant-message` 拼进
   `idle without declared completion: <free text>`；
4. 生成完整 canonical `RUNNER-STOPPED … detail=…`；
5. 调 `CommDB.recordRunnerStopDeclaration()`。

`recordRunnerStopDeclaration()` 已在 `BEGIN IMMEDIATE` 中维护
`runner_stop_declarations(execution_id PRIMARY KEY, content_hash, content, question_id,
derived_at_ms, updated_at)`：完整 content 相同则 duplicate，较旧的不同推导则 stale，
否则入既有 `kind=report` question 并更新 current row。mailbox 的 `collapse_key` 列目前只是
存储/转抄字段，没有任何通用 collapse 行为；把值写进去本身不会合并。

因此正确修改点仍是现有 CommDB 原子原语，不是 hook、Lead delivery 或新服务。

## 2. 现网数据复核

读取 `/Users/xiaorongli/.flywheel/comm/flywheel/comm.db` 的只读查询结果：

| execution | issue | rstop/report 行 | distinct content | 最大 exact 重现 |
|---|---:|---:|---:|---:|
| `0f39390f…` | FLY-2296 | 27 | 26 | 2 |
| `8baa35c5…` | FLY-2147 | 50 | 46 | 3 |
| `c557863a…` | FLY-2259 | 270 | 255 | 4 |

对三条序列用 `lag(content)` 检查，**相邻 exact duplicate 为 0**。这证明 FLY-2017
原语没有简单失效；它收到的是持续变化的 content。

FLY-2147 在 2026-09-03 `23:40:21Z–23:58:44Z` 的十条样本中，九条都描述
`QA epoch 7 + inbox empty + read-only wait`，差异只是“未变化/状态未变/状态不变”、是否加
“保持/完成”等词；另一条短暂改成 pending `turn-wait:*` question。完全相同的一个
content hash 在 `23:44:29Z`、`23:51:26Z`、`23:58:44Z` 出现三次，但中间被其他改写
或 pending 状态隔开，所以 current-edge 合同每次都合法放行。

FLY-2032 的 archive 也显示同形：`16:05/16:09/16:12 → 17:34/17:37…` 每条 free text
都略有不同，但机器事实始终是“C0/C1 未到、继续等待”。这进一步确认问题不是随机 qid，
而是拿 free text 当 edge identity。

## 3. 可复用能力与不应使用的能力

### 3.1 复用

- Node `crypto.createHash('sha256')`：仓内已经用于完整 content 双重校验，无新依赖。
- `runner_stop_declarations`：保持一 execution 一 current row；只加状态 key 与发送水位。
- `derivedAtMs`：它在 content 推导后捕获并已有乱序语义，可同时作为可注入的窗口时钟。
- `BEGIN IMMEDIATE`：继续串行化多 detached process 的 compare-and-insert。
- 既有 `insertQuestion(..., {kind:'report'})`、ACK 与退役行为：全部不变。

### 3.2 不使用

- mailbox `collapse_key`：当前没有执行语义；若为本单新增通用 collapse，会扩大到 infra alert、
  reroute 等无关生产者，违反锁定范围。
- 文本相似算法/LLM：无法 fail-open 证明 detail 真变时一定放行，且违反最小代码原则。
- runner marker：不能跨主机/清理持久，也不能与 mailbox 插入形成原子事务。
- hook 时间节流：仍属于客户端纪律，多个 reporter/重启可绕过。

## 4. 状态 key 设计

推导结果增加内部 `stateKey`，不进入公开 wire text：

| 推导来源 | state key 材料 | 变化放行依据 |
|---|---|---|
| stop failure | `failure + error-code + reason-enum` | 结构化错误码/分类变化 |
| completion breadcrumb | `completion + event-id + route + PR` | 新 completion action / route / PR 变化 |
| terminal session | `session + status` | completed/blocked/failed/timeout 变化 |
| pending gate/question | `pending + checkpoint-kind + id` | 等待对象变化 |
| declared park | `declared + kind` | 进入/离开显式 parked 状态 |
| Codex quota/context classification | `classified + reason-enum` | 分类变化 |
| fallback idle | 固定 `fallback + idle_without_declared_completion` | free text 不构成机器状态 |

最终 key 只包含机器可观测的来源与结构化字段；`errorDetails`、park reason、Codex 原始
message 以及最终 `detail` 虽然可用于诊断正文，但都不进入 key，也不做自然语言解析。
同一结构化状态里的文本变化最多有 30 分钟盲窗；新 completion event、等待对象、session
status 或分类变化仍立即放行。这条不依赖关键词或语言。

## 5. 数据模型与原子判定

在现有表最小增加：

```sql
state_hash    TEXT NOT NULL,
state_key     TEXT NOT NULL,
emitted_at_ms INTEGER NOT NULL
```

hash 与完整 key 双比，沿用 content collision 防线。`derived_at_ms` 仍表示最近观察时间；
`emitted_at_ms` 只在实际插入新 report 时推进。两者不能合并：若每次 duplicate 都推进
发送水位，高频 reporter 会让 30 分钟心跳永远到不了。

旧库迁移用 `PRAGMA table_info` + `ALTER TABLE ... ADD COLUMN`，已有行回填
`state_key=content`、`state_hash=content_hash`、`emitted_at_ms=derived_at_ms`。这样 cutover 后
新的机器 key 最多多发一条，不会把旧 free text 错认成稳定 key；新库 `CREATE TABLE` 直接
带 NOT NULL 列。

原子矩阵（窗口 `W=30min`）：

| current | 新推导 | 结果 |
|---|---|---|
| 无 | S/content A | sent，保存 S/A，`emitted=derived` |
| S/A | S/A，任意时间 | duplicate；保持 FLY-2017 exact collapse |
| S/A | S/content B，`Δ<W` | duplicate；只单调推进 `derived`，不推进 `emitted` |
| S/A | S/content B，`Δ>=W` | sent 心跳，current=S/B，推进两个水位 |
| S/A | T/content B，更新 | sent 立即状态沿，不看窗口 |
| S/A | T/content B，但 derived 更旧 | stale，不写 |
| S/A | S/content B，同毫秒 | duplicate；同状态不需用提交顺序伪造边沿 |

semantic duplicate 且正文不同必须返回 `contentMatched=false`，避免未来某个 completion
分支错误消费一份并未实际入队的 breadcrumb；当前 fallback 本身没有 breadcrumb。

## 6. 失败与生命周期边界

- 入队与三个水位更新保持在同一个 immediate transaction；失败不推进任何水位。
- deterministic question-id 冲突继续保留首次内容；不能把未入队的 content/state 写成 current。
- 状态变化时，上一条只有已投递/ACK 才按既有逻辑 supersede；未投递事件仍可靠送达。
- `finalizeSession()` / issue-terminal phase lifecycle 继续删除 current row；late receipt-lineage
  reporter 可重建一次，随后重新受服务器窗口约束。
- ACK 仍只退休 mailbox report，不删除 current row；否则每次 Lead ACK 都会解除抑制。
- 30 分钟是代码常量，不新增环境开关：本单没有第二个被要求的生产策略，YAGNI。

## 7. 验证要求

1. 先写 RED：不同 turn、fallback 文案 A/B/C、间隔小于 30 分钟，只一条 mailbox row。
2. GREEN 后写 guard：fallback 文案变化满 30 分钟产生第二条，exact content 仍不重发。
3. RED/GREEN：pending/gate/declared/completion 等机器 key 变化在窗口内立即产生新 row。
4. 迁移：模拟旧表打开，三列回填完整且可继续写；重启后水位仍生效。
5. 并发：不同 free text、同 state key 的跨进程竞态只能一个 `sent`；mutation 去掉 semantic
   compare 后第 1 格必须红。
6. 反向 mutation：把 state-key 变化分支也 throttle 后，第 3 格必须红，证明未做吞消息机器。
7. 回归：runner-stopped 全套、race 套件、hook shell test、package build/typecheck，再跑用户
   指定的全仓 `pnpm lint`、`pnpm -r build`、`pnpm test:packages:run` 与全部新增 shell tests。
