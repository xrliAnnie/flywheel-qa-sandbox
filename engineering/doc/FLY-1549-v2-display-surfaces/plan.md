# Plan: v2 三显示面(标题徽章 / 置顶 pipeline header / 状态行)— FLY-1549

**Issue**: FLY-1549 (https://linear.app/geoforge3d/issue/FLY-1549)
**Date**: 2026-07-30
**基于**: `engineering/doc/FLY-907-thread-display-refresh/plan.md`(PRD,founder 指定逐条照抄)+ FLY-1544 outbox→信使管线审计

## 0. 目标 / 边界

按 FLY-907 PRD 在 **v2 侧**实现三显示面,全部从真实状态派生,生命周期事件只做触发:

- **面 A · 标题徽章**:`🎨设计 / 🔨实现 / 🧪QA / ✅完成 / 🔴受阻 / 📬` 前缀,打在 v2 信使建的 `[FLY-XXXX]` thread 标题上。
- **面 B · 置顶 pipeline header**:DAG 各节点一行,词汇统一 `▶ 进行中 / ✅ 完成 / ◾ 未开始 / 🔴 受阻`;active 行带 tmux attach 命令(按当前真实 attempt 的 sessionRef 解析 + identifier 前缀防串线)。
- **面 C · 状态行**:按 PRD 终版(实施注记 §5.3,Lead 指令 `17ab4f53`)**收敛进面 B 置顶块**,不散发独立状态行消息。v2 thread 从未有过散状态行,无需删除自愈。词汇与面 B 同表(`PHASE_DISPLAY_GLYPHS` 复用 v1 导出)。

关键契约照抄 907:纯函数派生、per-issue coalesce-to-latest、fire-and-forget、429 退避、`DisplayWriteResult = changed|noop|deferred|failed` 写达确认才落 fingerprint、自愈 sweep 保最终一致。

**非目标**:v1/Bridge 侧行为(不碰);引擎新事件(不需要,见 §2);thread map 挪 kernel `thread_bindings`(FLY-1544 遗留,另开 issue);Linear 标题回填 thread 名。

## 1. 架构

```mermaid
graph TD
    subgraph 触发[触发源(已在流,零引擎改动)]
        E1[outbox 6 事件<br/>issue_opened/task_dispatched/node_completed/<br/>pr_ready/issue_merged/issue_closed] --> H
        E2[runner_ask 进度镜像] --> H
        H[V2DiscordOutbound.#handle] -->|post 后 enqueue| Q
        S[messenger 循环 piggyback sweep<br/>默认 180s,零新 timer] -->|fingerprint 失配| Q
    end
    Q[V2DisplayRefresher<br/>per-issue coalesce-to-latest] --> R
    R[readV2IssueDisplaySnapshot<br/>kernel 只读快照] --> D
    D[deriveV2IssueDisplay 纯函数] --> A[面A 标题徽章<br/>PATCH channel name]
    D --> B[面B+C 置顶 header<br/>post+pin / edit-in-place]
```

- **触发充分性**:rework(qa FAIL→打回 implement)把 task 置回 `ready` 后立即 `dispatchOnce` → `task_dispatched` 事件到信使 → 标题回退 🔨实现;attempt reap(kill/crash)同理经重派触发。两者与重派之间的窗口由 sweep(≤180s)兜底。**不需要新增引擎事件。**
- **派生输入 = kernel 只读快照**:信使进程 `Kernel.open({path, readonly: true, fileMustExist: true})`(WAL 读不阻塞写;teamlead 已依赖 flywheel-v2-kernel)。读 `meta dag_issue:<id>` → `tasks` + `task_dependencies`(拓扑序)+ `attempts`(active + 计数)+ `activations`(session_ref)+ `ship_gate:<id>` + `issue_closure:<id>`。控制面(delivery/settlement)仍全走 CLI,不变。

## 2. 派生映射(每行单测钉住)

### 2a. 节点状态 `deriveV2TaskDisplayState`

| 输入 | 状态 |
|---|---|
| `draft` | pending |
| `ready` 且从未有 attempt | pending |
| `ready` 且有历史 attempt(rework 打回 / reap 待重派) | active(▶ 返工/重排中 — FLY-543 语义) |
| `running` / `review`(schema 态,引擎暂未写,保守按在干) | active |
| `done` | done |
| `blocked` / `canceled` | blocked |

### 2b. issue 徽章 `deriveV2IssueTitleBadge`(优先级从上到下)

| 条件 | 徽章 |
|---|---|
| closure done 或 gate.settled | ✅完成(终态,**不留进行中**) |
| closure failed | 🔴受阻 |
| 任一 task blocked/canceled | 🔴受阻 |
| 全 task done 且 gate ∈ {open, approved 未 settled} | 📬待批 |
| 全 task done 且 gate rejected(rework 前瞬时) | 🔴受阻 |
| 拓扑序**最靠后的 active** 节点 | 该节点 kind 徽章 |
| 无 active:第一个 pending 的前一节点;全 pending → 第一节点;全 done 无 gate → 最后节点 | kind 徽章 |

kind 徽章表:`design/design_iterate → 🎨设计`、`implement/build/generic → 🔨实现`、`qa → 🧪QA`、`research → 🧠调研`、`produce → 📝产出`、`review → 👀审阅`、未知 kind → `🔨<kind>`。前三个逐字复用 `PHASE_THREAD_BADGE`(config)。

### 2c. 标题写法

v2 thread 名恒为 `<badge> [FLY-XXXX]…` 形态:base = 首个 `[` 起的后缀(founder 手改的自定义名无 `[` 则整名保留),badge 前缀替换式重打;同名 → noop 零 PATCH(Discord rename 限 2/10min,零 churn 是硬要求)。

### 2d. 面 B header

```
📌 **[FLY-1549] v2 流水线**
**[设计]** ✅ 完成 · attempt `ab12cd34` · claude
**[实现]** ▶ 进行中 · attempt `da54746c` · claude
`env -u TMUX tmux attach -t '=v2-<sha32>'`
**[QA]** ◾ 未开始
_自动更新:各节点状态与终端入口,置顶一条看全。_
```

- 行序 = task 拓扑序(Kahn,平级按 created_at, id 稳定序);label = kind 中文词(同徽章表);glyph = `PHASE_DISPLAY_GLYPHS`(v1 导出复用)。
- attach 行仅 active 且有活 activation 的行渲染;命令 `env -u TMUX tmux attach -t '=v2-<sha256(sessionRef)[:32]>'`。
- **防串线**(PRD Step 3 的 v2 形态):probe `tmux display-message -p -t '=<session>:' '#{window_name}'`;窗名存在且 `!startsWith("v2-<issueId>-")` → 不渲染命令,降级 `_(终端待解析)_` + console.warn 留证据;probe 无 session(running 但 tmux 缺)→ 同降级且面 B 记 `deferred`(sweep 重试)。命名公式提为 teamlead 导出 `v2RunnerTmuxNames()`,`tmux-runner-launcher.ts` 改引用同一函数(单一来源,v2-host 已依赖 teamlead)。

## 3. 刷新器契约(照抄 907)

- **coalesce-to-latest**:`Map<issueId, {rerun, done}>`,在跑标 rerun、跑完 drain,enqueue = fire-and-forget catch-all。
- **429**:标题 PATCH 429 → 重试 ≤5 次、sleep = min(Retry-After, 10s);Retry-After > 30s 直接 `deferred`(rename 窗最长 10min,长眠不如交给 sweep — 与 v1 的 600s cap 等价收敛,少一份挂起状态)。
- **写达确认**:面 A、面 B 各返 `DisplayWriteResult`;**全部 ∈ {changed, noop} 才落 fingerprint**(存信使 state JSON,`display[issueId] = {fp, headerMessageId, archivedAt?}`);任一 failed/deferred 不落 → sweep 候选。
- **sweep**:信使 pull 循环 piggyback(循环本就 ≤~10s 一轮,零新 timer),默认 180s 一轮、每轮 ≤50 issue 轮转;重算全量 fingerprint(含 tmux probe 分量)失配 → enqueue。**终态短路**:fp 带 terminal 标记且已 archive → 零开销跳过。
- **issue_closed 顺序**:post 收尾消息 → **await refresh(终态 ✅ 必须先落)** → archive;refresh 未落则跳过本轮 archive(记入 sweep:fp 追平后补 archive + 标记 `archivedAt`)。归档后 thread 无法 rename,顺序不能反。
- **逃生口**:`FLYWHEEL_V2_ISSUE_DISPLAY=0` → 不构造刷新器,信使行为与现状逐字节一致(含 issue_closed 内联 archive);哨兵测试钉住。

## 4. 交付物 / 测试

新文件(均 `packages/teamlead/src/`):
- `v2-issue-display.ts` — 纯函数 + 词汇/徽章常量 + `v2RunnerTmuxNames` + fingerprint 计算(零 I/O)
- `v2-display-state-reader.ts` — kernel 只读快照
- `v2-display-refresher.ts` — coalesce / 三面写 / 429 / fingerprint / sweep
改动:`v2-discord-outbound.ts`(state v1 扩 `display` 字段 + 触发接线 + issue_closed 顺序)、`v2-discord-ingress.ts`(env 装配)、`bridge/chat-thread-utils.ts`(+`getChannelName`/`renameChannel`/`editChatMessage`,与现有 helper 同风格)、`package.json` exports(+`./v2-issue-display`)、`v2-host/tmux-runner-launcher.ts`(命名改引用)。

测试:`v2-issue-display.test.ts`(映射逐行 + 徽章聚合含 rework 回退/终态/📬/受阻 + header 快照 + 标题重打幂等);`v2-display-refresher.test.ts`(真 in-memory kernel 建库播行;429 重试落地/耗尽 deferred 不落 fp;pin/edit/404 补发;coalesce 折叠;sweep 失配 re-enqueue + 终态短路;串线注入降级 + warn;issue_closed 先刷后归档);`v2-discord-outbound.test.ts` 扩(触发接线 + 逃生口哨兵)。真机验收:三段单逐节点截图(独立 QA 段)。

## 5. 已定决策(供 review 复核)

1. **面 C 收敛进面 B** — 依 PRD 终版(§5.3 Lead 指令),issue 文字里的"三面"以 PRD 为准。
2. **信使只读开 kernel DB** — 派生必须读真实状态;控制面纯度指 delivery/settlement,只读派生与 v1 Bridge 读自家 StateStore 同构。备选(新 CLI 查询 verb / 引擎侧派生塞 payload)分别是更多控制面管道 / 事件携带派生态与"事件只触发"相悖。
3. **零引擎改动** — 触发充分性论证见 §1;**sweep 是正确性主路径**(见 R1 #4 修订),显示时效上界 = ceil(live 候选数/50) × sweep 周期。
4. **未知 kind 徽章 fallback `🔨<kind>`** — DAG kind 开放集,显示不硬编码全集。

## 6. Codex design review R1 折入(2026-07-30,7 条全采纳)

1. **DB authority**:`FLYWHEEL_V2_DB_PATH` 改为**显式必填**(display 开启时缺失 → display fail-closed OFF + 启动大声报错,投递职责不受影响;绝不静默 default 到可能错误的库);reader 在同一读事务内校验 `meta.cutover_epoch` 为合法正整数,否则拒绝派生(合法-但-非引擎库不能读成"空状态"落 fingerprint)。残留:同库陈旧副本无法完全检测,靠显式路径 + 运维纪律,文档记录。
2. **终态优先级**:`closure failed` 提到最高(closure 只在 settle 后运行,failed 是更新的事实);`settled + closure.failed → 🔴受阻` 测试钉住。全 done + gate `expired`(ship retry 耗尽)→ 🔴受阻;rework-expired 时 task 已回 ready,走 active 徽章,测试钉住。
3. **429 忠实**:标题 429 deferral **持久化 `titleRetryNotBeforeMs`**(now + Retry-After,上限 600s 同 v1);horizon 未到前任何刷新/sweep 对标题**零请求**;写达成功清除。测试钉住 horizon 内零请求 + horizon 后落地。
4. **sweep 主路径化**:候选筛选先行 — terminal+archived+fp-current 条目在选批阶段跳过(仅查 record,零 kernel 读),**不再消耗批槽**;批内只有活候选。最坏陈旧度 ≈ ceil(live 候选/limit) × 周期,注释明示;>limit 场景测试钉住。游标进程内存(重启归零 = 从头轮转,无饥饿)。
5. **header 单消息预算**:`V2_HEADER_BUDGET_CHARS=1900`(镜像 discord-utils);超预算时 blocked/active 行全保(attach 命令在此),done/pending 尾部折叠为计数摘要行,拓扑序确定性;kind label 截 24 字符。500-task 合法 DAG 测试钉住 ≤1900 且 active 行存活。
6. **标题合同对齐 v1**:只剥离**自管 badge emoji + 粘连词**的前缀,founder 任意前缀(如 `URGENT [FLY-1549]`)逐字保留;组合后按 100 字符 thread-name 预算截尾。幂等 + 人工前缀 + 截尾测试钉住。
7. **probe 超时**:默认 tmux probe `execFile timeout 3s`(杀子进程);另外无论注入实现,`#probeBounded` 对任何 probe 统一 race 超时(默认 3s,超时读作 session 缺失 → deferred)。never-resolving probe 测试钉住。

## 7. Codex design review R2 折入(2026-07-30,3 条全采纳)

1. **pin 状态持久化**:record 新增 `headerPinned`;post 落地即持久化 `headerPinned:false`,pin 成功才置 true。未 pin 的 header 在内容相同的后续轮次**继续重试 PUT 并保持 deferred**(fingerprint 不落),绝不因内容相同误判收敛。403→204 恢复场景测试钉住(两次 PUT + 恢复后才落 fp)。
2. **多 active 展示合同重定义**:超预算时合同 = blocked → active → done/pending 优先序内,能装多少装多少**完整块**(拓扑序),装不下的行**全部折入一条计数摘要**(`▶×N` 等)——显示恒为全量且诚实(计数永不静默丢),但只有拓扑靠前的 blocked/active 块带可见 attach 命令。500-active 合法 DAG 测试钉住(shown + folded = 500)。
3. **标题 strip 收紧为精确 token 匹配**:只剥「固定 badge 集 ∪ 本 issue kind badges(`v2SelfBadges(snapshot)`)∪ 当前要打的 badge」的**完整 token**;`✅P0` 这类 founder token 逐字保留。测试钉住。

## 8. Codex design review R3 折入(2026-07-30,3 条全采纳)+ lead 指路

1. **pin 404 清记录补发**:`#ensurePinned` 对 `missing`(消息已删)清空 `headerMessageId/headerContent/headerPinned` 并持久化 → 下一轮 repost,绝不对死 ID 永久 PUT。POST→pin 404→下一轮 repost 测试钉住。
2. **快路径要求 pin 已确认 + render version 升 2**:fingerprint 快路径条件加 `!headerMessageId || headerPinned===true`;`V2_DISPLAY_RENDER_VERSION` 1→2 使所有 pre-R3 fingerprint 一次性失效(R1 期代码可能落过「有 fp 实际未 pin」的记录)。stale 记录迁移测试钉住(fp 相同但 headerPinned 缺失 → 不走快路径、补 PUT)。
3. **probe 有界并发 + 全快照预算**:`#probeSnapshot` 改 4-并发 worker + `probeSnapshotBudgetMs`(默认 10s)全局 deadline,超时剩余全部读作 session 缺失;500-active DAG 卡死 tmux 最坏成本 = 一个预算,不是 probes×timeout。40 个 never-resolving probe 壁钟测试钉住。

**Lead 指路(FLY-1255)已应用**:面 B 行的模型显示改为复用 `renderRunnerModelDisplay()` threadMarker(F/O/S/H/G/K/`Model <id>`),`attempts.model` 进快照与 fingerprint;面 A 无模型位不碰,零 scope 扩张。

## 9. Codex design review R4 折入(2026-07-30,1 条采纳)

**收敛后外删/取消置顶自愈**:sweep 对 live(未 archive)且 fingerprint-current 的 issue 每轮做一次远端核验(`getChannelMessage` 单次 GET,同时取存在性 + `pinned` 位,批上限内有界):404 → 清 header 记录 + fingerprint → enqueue 重发;`pinned:false` → 清 pin 确认 → enqueue 重钉(不重发,原消息只补 PUT);瞬时失败(429/网络)下轮重试;archived thread 冻结跳过(founder 在归档 thread 上删 header 是其自由)。删除/取消置顶两个收敛后回归测试钉住。注:v1 同位置存在同一盲区(内容不变期间外删不自愈),v2 借此补齐。

## 10. Codex design review R5 折入(2026-07-30,3 条全采纳)

1. **unpin/重钉失败不可卡死**:unpin 检出时**连 fingerprint 一起清**(仅清 `headerPinned` 时,后续重钉 403 会停在 `fp=current+headerPinned=false`,sweep 两个分支都不再触发);`#ensurePinned` 的 PUT-404 分支同样清 `fp`(否则 fast path 的 `!headerMessageId` 短路让 repost 永不发生)。403→下轮再钉、PUT-404→repost 两条测试钉住。
2. **核验瞬时失败挡住本轮归档**:GET 429/网络失败 → `continue`,未核验的记录本轮不得进 archive catch-up(否则 429 时归档落 `archivedAt`,记录被永久冻结)。测试钉住(429 轮 archive 不调用、恢复轮补上)。
3. **核验裁决防竞态**:GET 是异步的 — 写回前重读记录,仅当 `headerMessageId+fp` 仍是被核验的那份**且**该 issue 无 in-flight refresh(`#queue`)才应用裁决,否则本轮跳过。可控 GET gate 的确定性竞态测试钉住(迟到 404 裁决不清并发 refresh 刚落的 msg-2)。

## 11. Codex design review R6 折入(2026-07-30,2 条全采纳)

1. **CAS 纳入 archivedAt**:核验裁决的 `stillApplies` 增加 `!archivedAt` — GET 在 live 时发出、返回时 thread 已被 issue_closed 归档的迟到裁决直接丢弃(否则清掉 archived 记录的 fp = 永久复发且不可修复的 sweep 候选)。gated-GET + 并发归档竞态测试钉住。
2. **archive catch-up 全程 CAS**:归档分支调用前 CAS + `await archiveThread` 后**再次**重读 CAS,任一失败跳过本轮(archive 调用幂等,archivedAt 戳留待下一个安静轮);绝不用 pre-GET 的陈旧 record 覆写并发 refresh 刚替换的 header/fp。gated-archive 竞态测试钉住(msg-2/fp-2 不被回滚成 msg-1/fp-1+archivedAt)。

## 12. Codex design review R7 折入(2026-07-30,1 条采纳)

**内联归档窗纳入 fence**:refresher 增 per-issue `holdIssue()`(`#held` 集),`stillApplies` CAS 同时检查 `#queue` 与 `#held`;messenger 的 issue_closed 整段(refresh → archive HTTP await → `archivedAt` 落盘)裹进 hold —— 此前 refresh 返回后 `#queue` 已空、`archivedAt` 未落的 HTTP 空窗对 sweep 不可见,迟到 404 裁决会在窗内清掉 header/fp,随后 `#markArchived` 把 archivedAt 戳到被清空的记录上(terminal+archivedAt+无fp = 永不收敛)。refresher 侧 gated GET×hold 竞态测试 + messenger 侧序列全程在 fence 内的顺序测试钉住。

**R8(测试强度,1 条采纳)**:messenger 侧顺序测试加固到 mutation-proof —— archive PATCH 进同一事件序列、fake refresh 真落 record 使 archivedAt 戳可观测、hold 释放瞬间断言 `stamped=true`;archive 或 stamp 被挪出 fence 都会使断言失败。
