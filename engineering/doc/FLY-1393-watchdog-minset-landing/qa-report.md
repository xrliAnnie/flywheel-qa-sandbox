# FLY-1393 看门收编 — 独立 QA 预检报告
Issue: FLY-1393
日期: 2026-07-21
基于: plan.md

## 结论

**隔离代码/故障注入预检 PASS；真实 529 Room、Discord 投递与 24h soak 留给独立 QA phase，本文不冒充最终 `qa_result PASS`。**

独立 QA 首轮冻结在 `14a7704d683312433bb03f665968c6f7597db1d4`，392 项既有测试与 harness 均绿，
但负向审计发现一个 HIGH correctness 缺陷：W-2 manifest 的 per-Lead 行缺少 `freshness` 时，shell 与
TypeScript 两个 validator 都错误接受，外部 probe 会把已 latch 的 stalled episode 当恢复并发出假 all-clear。

实现阶段按 TDD 补红测并由 `6bb1b69ab` 修复：两个 validator 现在都要求非空 `lead_id`，且
`freshness` 只能是 `fresh|stale`。独立 QA 增量复验 PASS。

## 需求矩阵

| 面 | 结论 | 独立证据 |
|---|---|---|
| W-1 idle-only + G-1 四态死亡判定 | PASS（隔离） | bare-shell idle 发射；waiting/unknown/liveness=0 静音；real isolated tmux 验出 `dead_pin` 与 `absent`；alive/indeterminate 只 re-wake、不宣告死亡 |
| W-2 manifest/probe | PASS（隔离，修复后） | loop stall、manifest degraded、Bridge down、disabled 四桶互不遮；A stale → 缺 freshness 返回 `degraded 1`，stalled state 保持 latch，无 all-clear |
| 退役巷 hard-off / 真值检查 | PASS | `LEGACY=1` 与 `ZOMBIE_GATE_RESOLVE=1` 不可复活；tombstone/unknown/retiring 正反例通过 |
| W-4 两巷 | PASS（隔离） | Lead gate 位于 episode/recovery/cooldown/notifier 前；Runner gate 位于 query/dedup/notifier 前；`blocked=0` 四面静音；默认 10min (`600000ms`) |
| FLY-1402 rebase 共存 | PASS | `rules_bundle_legacy` 与 `stale_approved_ship_dead` 同时通过 event type、title/body、kind contract 与 launcher 回归 |

## 关键复现与关闭证据

首轮失败：

```text
stalled-before={"count":1,"escalated":true,"members":["A"]}
second=ok
stalled-after={"count":0,"escalated":false,"members":[]}
posts=["🚨 Lead inbox loop stalled: A...","✅ Lead inbox stalled 集合全部恢复..."]
```

修复后独立复验：

```text
first=ok
stalled-before={"count":1,"escalated":true,"members":["A"]}
second=degraded 1
stalled-after={"count":1,"escalated":true,"members":["A"]}
degraded-after={"count":1,"since":1060,"escalated":true}
posts=["🚨 Lead inbox loop stalled: A...","🚨 Bridge 可达,但 watchdog manifest 缺失或不完整..."]
```

## 命令结果

- config 全包：31 files / 534 tests PASS。
- watchdog targeted：W-1/W-2/G-1 59/59；W-4/退役/FLY-1402 242/242。
- `bridge-liveness-probe.test.sh`：20/20 PASS（新增假 all-clear 反例）。
- `check-flag-truth.test.sh`：2/2 PASS。
- FLY-1402 single-bundle shell：39/39 PASS。
- config + teamlead typecheck：PASS；全仓 `pnpm -r build`：PASS；本分支变更集 Biome：PASS。
- 全仓递归测试在本机未形成绿证：与本改动无关的 Terminal/osascript 权限、root-owned npm cache、旧测试 stub 与并发超时导致失败；PR CI 必须在干净环境重新给出最终证据。

## 未验证（不得外推）

- 529 Room 真 Runner kill 后 Lead/Discord 收件。
- approved-ship 真死、首投失败、Bridge restart 后 claims 去重。
- 完整隔离 Bridge 的单 Lead loop fault seam，同时观察 in-Bridge 与外部 probe 两通道及恢复。
- kill -9 Bridge 并阻止重生 ≥5min、生产 launchd 当前加载态、真实 Discord mention/all-clear。
- W-3 真 head drift / archived-thread 错误路径。
- 批 1 ship 后 24h claims/alert ledger 零假警报 soak。

这些由后续三阶段独立 QA phase 和 ship 后观察完成；在它们完成前，本报告只证明代码与隔离 harness，
不证明全部能力级验收已完成。
