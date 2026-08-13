# QA·FLY-802 真机 E2E 验证报告 — FLY-1431
Issue: FLY-1431 (https://linear.app/geoforge3d/issue/FLY-1431/qafly-802-real-e2e-of-pr-677-thread-auto-archive)
日期: 2026-07-23
基于: `design.md`、FLY-802 `design-correction.md`、PR #677

**被测**: PR #677，HEAD `9a5669752346938852d6774e2f84a5a96b96ad89`
**验收权威**: `engineering/doc/FLY-802-roundtable-thread-autoarchive/design-correction.md` §验收修订
**Verdict**: **PASS** — 验收合同四条全部独立复核通过；唯一未观测项(Discord 原生 archive 翻转)是 Discord 平台侧行为，非 PR 验收项、非可归因 PR 的缺陷，转 follow-up。

> 本报告由两段工作合成：实现节点(exec `507d241a`)搭真机隔离房 harness 跑完整生命周期；verdict 节点(exec `867da13f`)在 `2026-07-23T00:04Z` 独立复核——重跑 grep-zero、重跑 129 焦点测试、按同批真 thread id 直连 Discord 回读(距最后活动 T+203min)、逐条对照 `design-correction.md` 验收合同——并据此出 PASS。

## 1. 范围（诚实划界）

- 独立 QA，只验证 FLY-802；**没有改** FLY-802 的实现代码一个字节。
- 主合同：roundtable / alert 新 thread 读取父频道的 `default_auto_archive_duration`；未配置或不可读时 roundtable 保持 4320 分钟、alert 保持 1440 分钟；roundtable 命名仍由 topic 内容派生。
- idle archive 必须由 Discord 原生机制完成；Bridge 内不能残留 archive reconciler / scheduler / runtime flag。
- 不验存量 thread 自动清理（设计纠正明确不要求）；issue chat thread 的 3 天策略不在 PR 文件清单内，做静态未触及核验。
- 真机环境只使用隔离 QA guild(`1485787271192907816`)：fallback 走 `#test-leads-roundtable` (`1519417773304975450`) 与 `#test-flywheel-alerts` (`1519421055805165842`)；60 分钟原生归档走同一 QA guild 中已配置 default=60 的 `#leads-roundtable` (`1512578695468941333`)。**没有触碰生产频道或生产 Bridge。**

## 2. 验收合同（design-correction.md §验收修订）与判定

`design-correction.md` 是 founder 纠正后的权威验收基线（founder 原话：「802我们不需要巡检员」）。它明确把**空闲归档的执行完全交给 Discord 原生 auto-archive**（§保留 line 22），验收四条如下：

| # | 验收条款 | 独立复核方法 | 判定 |
|---|---|---|---|
| 1 | 全仓不存在 `channel-default-thread-reconcile` 实现/测试/scheduler wiring/`FLYWHEEL_THREAD_ARCHIVE_RECONCILE*` 配置 | verdict 节点在 PR head 重跑 `git grep`(§4.1) | **PASS** |
| 2 | roundtable/alert 新 thread create body 使用父频道 auto-archive 设置；fallback 合同不变 | Discord GET 回读三条真 thread(§4.3) | **PASS** |
| 3 | 描述性命名测试通过、issue chat thread 行为无变化 | 焦点套件重跑 + thread `.name` 回读 + PR 文件清单静态核验(§4.2/§4.4) | **PASS** |
| 4 | 不要求代码处理存量 thread；Discord 原生 auto-archive 是唯一常驻 idle 归档机制 | grep-zero + 203 分钟静置窗零 Flywheel 进程(§4.3/§4.5) | **PASS** |

**关键判定原则**：`design.md` 里 A2「原生归档生效(核心)」是 QA 作者额外加的观测探针，**不是** PR 的验收条款。验收权威 `design-correction.md` 没有要求「观测到 Discord 把 thread 翻成 archived」——它把该动作显式指派给 Discord 平台。因此 A2 未观测到翻转不构成 PR 缺陷（详见 §5）。

## 3. 被测版本与独立代码审查

- GitHub `headRefOid`、detached worktree HEAD、被测 dist 三处都锁定 `9a5669752346938852d6774e2f84a5a96b96ad89`。
- `channel-archive-default.ts` 只接受 Discord 合法档位 `60 / 1440 / 4320 / 10080`；provider 是 10 分钟 TTL 的父频道 reader，读取失败使用调用点 fallback。
- roundtable 三条创建路径共用 resolver：Bridge poller、Belle/plugin recovery 的 `ensureThreadFromMessage`、Codex reply-in-thread wiring。名字继续走 `deriveRoundtableThreadName()`。
- alert `AlertChannelHub` 使用同一 provider，但显式传 `fallback=1440`，所以未配置父频道时保持旧行为。
- 最终 commit `9a566975` 删除 archive reconciler 实现 565 行、测试 598 行和 plugin scheduler wiring 38 行；两个 runtime 文件在最终 tree 中都不存在。
- PR 文件清单未包含 `ChatThreadCreator` / issue chat thread 路径，未改变 issue thread 的既有 3 天策略。
- **PR #677 CI**：全部 9 个 check SUCCESS（Quick Gate build+typecheck+lint、Unit teamlead ×3、Unit heavy/light、Script Tests、NPM payload、CI OK）。

## 4. 独立复核证据（verdict 节点，exec `867da13f`，2026-07-23T00:04Z）

### 4.1 巡检员静态归零（我方重跑）

在 PR head worktree `/private/tmp/fly1431-pr677.eOR0wR`（HEAD 已确认 `9a566975`）对 runtime code（`packages/**` + `scripts/**`，排除 tests/docs）：

| pattern | runtime 命中 |
|---|---:|
| `channel-default-thread-reconcile` | 0（`git grep` exit 1） |
| `FLYWHEEL_THREAD_ARCHIVE_RECONCILE` | 0（`git grep` exit 1） |
| `ROUNDTABLE_TOPIC_AUTO_ARCHIVE_MINUTES` | 0（`git grep` exit 1） |
| 符号 sweep `ThreadArchiveReconcil\|channelDefaultThreadReconcile\|archiveReconciler\|threadArchiveSweep` | 0（exit 1） |

历史设计文档仍会文字提到被废除的方案；那不是 runtime 实现、测试、scheduler wiring 或配置残留。

### 4.2 焦点套件（我方重跑）

在 PR head worktree `pnpm exec vitest run`：

```text
✓ src/bridge/roundtable/__tests__/roundtable-text.test.ts            (12)
✓ src/bridge/roundtable/__tests__/channel-archive-default.test.ts    (13)
✓ src/bridge/roundtable/__tests__/ensure-thread-from-message.test.ts (11)
✓ src/lead-backends/codex/__tests__/roundtable-reply-in-thread.test.ts (12)
✓ src/__tests__/AlertChannelHub.test.ts                             (43)
✓ src/bridge/roundtable/__tests__/RoundtableThreadManager.test.ts   (38)

Test Files  6 passed (6)
     Tests  129 passed (129)
```

覆盖：channel-default provider、RoundtableThreadManager、ensure-thread-from-message、roundtable naming、AlertChannelHub、Codex roundtable reply-in-thread wiring。stderr 里的 addThreadMember 503/403 是负路径测试的**预期**日志，全部断言通过。

### 4.3 真 Discord ground truth（verdict 节点直连回读，T+203min）

verdict 节点用 QA guild host bot token 对**同一批**真 thread 做只读 `GET /channels/{id}`（token 从 `~/.flywheel/.env` 读取，全程不落盘不回显）。观测时刻 `2026-07-23T00:04:05Z`：

**父频道 default（provider 输入源）**

| 父频道 | `default_auto_archive_duration` | 期望 |
|---|---|---|
| `#leads-roundtable` `1512578695468941333` | `60`（`hasDefaultField=true`） | 60 |
| `#test-leads-roundtable` `1519417773304975450` | 无字段 → null | null(fallback) |
| `#test-flywheel-alerts` `1519421055805165842` | 无字段 → null | null(fallback) |

**新建 thread（create-body 值合同 + 命名）**

| # | 场景 | thread id | `auto_archive_duration` | `archived` | 命名 | 判定 |
|---|---|---|---|---|---|---|
| A1 | 父频道配 60 → 新 thread 取 60（主路径） | `1529589050393235477` | **60** ✓ | false（idle 203.2min） | `QA-FLY1431 native-60 topic 1784752847969` | **PASS** |
| A3 | roundtable 父频道未配置 → fallback | `1529586769241047294` | **4320** ✓ | false（idle 212.3min） | `QA-FLY1431 fallback topic 1784752304053` | **PASS** |
| D  | alert 父频道未配置 → fallback | `1529586462746742816` | **1440** ✓ | false（idle 213.6min） | `[login_expired] flywheel-test-1 13:30` | **PASS** |
| B  | 描述性命名 | 同上 | — | — | 三条名字均由 topic/alert 内容派生，无占位名 `Roundtable topic` | **PASS** |

native-60 thread 回读原始 JSON：

```json
{
  "observedAt": "2026-07-23T00:04:05Z",
  "id": "1529589050393235477",
  "name": "QA-FLY1431 native-60 topic 1784752847969",
  "parent_id": "1512578695468941333",
  "type": 11,
  "idleMinutesSinceLastActivity": 203.2,
  "thread_metadata": {
    "archived": false,
    "auto_archive_duration": 60,
    "archive_timestamp": "2026-07-22T20:40:48.521000+00:00",
    "locked": false,
    "create_timestamp": "2026-07-22T20:40:48.521000+00:00"
  },
  "last_message_id": "1529589061096837152",
  "message_count": 2,
  "total_message_sent": 2
}
```

`last_message_id / message_count / total_message_sent` 与实现节点在 T+150min 的观测**逐字一致** → 静置窗内无任何 Flywheel 代码触碰该 thread。

### 4.4 issue chat thread 未触及

PR 文件清单不含 `ChatThreadCreator` / issue chat thread 路径；焦点套件与静态核验均未见对 3 天策略的改动。issue thread 行为字节不变（验收条款 3 后半）。

### 4.5 巡检员运行时零（C2）

创建事务完成后 harness 退出；整个 203 分钟静置窗内没有 Bridge、reconciler 或其它 Flywheel 进程持有这些 thread，也无任何 `PATCH /channels/{id}` 收敛。配合 §4.1 静态归零，**代码层不存在周期性收敛的可能**。

## 5. A2 原生归档翻转分析（为什么不是 FAIL）

- native-60 thread `auto_archive_duration=60` 已由 Discord 正确落值；静置至 **T+203.2min**（超窗 3 倍）仍 `archived=false`。
- Discord `auto_archive_duration` 的语义是「无活动 N 分钟后由 Discord 把 thread 从活跃列表**收起/隐藏**（消息保留、可搜索）」——正是 founder 要的效果；但**执行方是 Discord 平台**，不是 Flywheel 代码。REST `GET` 回读的 `thread_metadata.archived` 是服务端 lazy/最终一致字段，Discord 不保证在到点瞬间翻转，也不由一次 GET 触发。
- PR #677 代码里没有任何东西会**阻止** Discord 归档（grep-zero + 203min 零进程已证），也没有任何东西**代替** Discord 归档。翻转与否完全在 Discord 侧。
- 归档动作**不在** `design-correction.md` 的验收条款内；它是 founder 主动选定并显式指派给 Discord 的机制（同时显式否决了巡检员方案）。
- 因此把「未观测到翻转」判成 PR 缺陷是**错误归因**；且 FAIL 不可执行——runner 既不能让 Discord 更快归档，也不能重加被 founder 否决的巡检员。故 verdict 节点判 **PASS**，把翻转观测转为 follow-up，而**不**静默把未观测到的平台动作写成已发生。

## 6. Follow-up（转交 Lead / founder，非阻塞本 verdict）

1. **原生归档翻转补证**（产品可用性，指向 founder 核心诉求「别一排排堆在侧栏」）：本轮 REST 轮询至 T+203min 未见 `archived=true`。建议补一条 **gateway `THREAD_UPDATE` 事件**观测，或在 UI/客户端确认该 thread 是否已从侧栏活跃列表收起——以确认 Discord 原生 auto-archive 在当前平台行为下**确实**达成 founder 的「收起侧栏」目标。若长期不收起，则是对 founder 所选**机制**的再评估（新的产品决策），而非 PR #677 的返工项。
2. **codex code-review 节点**：verdict 节点未在 PR #677 上找到正式 codex code-review 记录（GitHub reviews=0）。本 QA/E2E 节点的 PASS 只代表真机 E2E + 验收合同复核通过，**不等于** ship 放行；codex code-review 是 DAG 独立节点，由编排器在推进 ship 前单独把关。

## 7. 结论

对照权威验收 `design-correction.md §验收修订`，四条验收条款——reconciler 全仓零残留、create-body 取父频道 default + fallback 合同、描述性命名 + issue chat 不变、Discord 原生为唯一常驻 idle 归档机制——均由 verdict 节点**独立**复核通过（重跑 grep-zero、重跑 129 焦点测试、直连 Discord 回读三条真 thread、203 分钟零进程静置），PR #677 CI 9/9 绿。未发现任何可归因于 PR 实现的 correctness 缺陷。唯一未闭环项是 Discord 平台自身的 native archive 翻转——不在 PR 验收范围、不可归因 PR、已转 follow-up。

**总 Verdict: PASS。**
