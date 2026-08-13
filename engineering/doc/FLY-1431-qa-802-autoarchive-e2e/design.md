# QA·FLY-802 真机 E2E 设计 — FLY-1431
Issue: FLY-1431 (https://linear.app/geoforge3d/issue/FLY-1431/qafly-802-real-e2e-of-pr-677-thread-auto-archive)
日期: 2026-07-22
基于: PR #677 (head `9a566975`)、`engineering/doc/FLY-802-roundtable-thread-autoarchive/design-correction.md`、FLY-1426 qa-report.md（报告形态参照）、FLY-529 QA Room roundtable/alerts 镜像

## 0. 一句话

在 FLY-529 隔离 QA 房（#test-leads-roundtable + #test-flywheel-alerts 镜像）里，用 PR #677 head 构建的真 Bridge 跑一次完整生命周期：建串 → 值断言 → ≥60 分钟静置 → Discord 原生归档发生，并证明归档不是我们代码干的（巡检员已彻底拆除）。

## 1. 被测合同（来自 design-correction.md 验收修订）

1. roundtable / alert 新 thread 的 create body 使用父频道 `default_auto_archive_duration`；fallback 合同不变（roundtable→4320 Discord API 默认，alert→1440）。
2. 空闲归档**只由 Discord 原生 auto-archive 完成**——Bridge 内不存在任何常驻巡检员/收敛循环。
3. 描述性命名保持（thread 名来自 topic 内容，非 `Roundtable topic` 占位）。
4. 全仓 grep 零：`channel-default-thread-reconcile`、`FLYWHEEL_THREAD_ARCHIVE_RECONCILE*`、`ROUNDTABLE_TOPIC_AUTO_ARCHIVE_MINUTES`。
5. issue chat thread（ChatThreadCreator / 3 天策略）字节不变——PR 文件清单已证未触碰，静态复核即可。

## 2. 验证矩阵（执行节点照此跑）

| # | 案例 | 前置 | 动作 | 断言（Discord API 为权威） |
|---|------|------|------|------|
| A3 | fallback：频道默认未设 | 两测试频道现状即 `default_auto_archive_duration: null`（已实测确认） | member bot(slot2) 发 topic → host Bridge 建串 | `GET /channels/{threadId}` → `thread_metadata.auto_archive_duration == 4320` |
| A1 | 主路径：按频道设置建串 | 把 #test-leads-roundtable 默认翻成 60（1 小时） | 再发一条新 topic → 建串 | `auto_archive_duration == 60` |
| A2 | **原生归档生效**（核心） | A1 的 thread，建串后零触碰 | 静置 ≥60 分钟，之后每 5 分钟 `GET` 一次，硬上限 T+150min | `thread_metadata.archived == true` 且 `archive_timestamp` 由 Discord 落；期间 host Bridge 日志**零** `PATCH /channels/{threadId}` |
| B | 描述性命名 | 随 A1/A3 | 同上 | `.name` 派生自 topic 内容，≠ `Roundtable topic` |
| C1 | 巡检员静态零 | PR head checkout | 全仓 grep（ts/js/sh/md/yaml/json，含 scripts/、排除 node_modules，**独立捕获 grep 退出码**，不许管道 head 吃掉） | 三个 pattern 全部零命中；无 scheduler wiring |
| C2 | 巡检员运行时零 | A2 的 ≥60min 静置窗 | 抓 host Bridge 全程日志 | 无 reconcile/converge/sweep 周期性行为；建串后无任何 auto_archive PATCH |
| D | alert thread fallback | #test-flywheel-alerts 默认为 null | 用 FLY-529 的 `qa-fly-529-fire-bridge-alert.mjs`（真 plugin.ts 组合）触发一条 alert 建串 | alert thread `auto_archive_duration == 1440`（fallback 合同保持） |

**合法 vs 非法 PATCH 的判别**（C2 关键）：创建-commit 时若 recovery 路径（如 Belle 抢建占位串）发现 current ≠ desired，做**一次性** PATCH 收敛是 plan 保留行为，合法；非法的是建串完成之后的任何周期性扫描/收敛。判据 = PATCH 只允许出现在该 thread 的创建事务窗口内。

## 3. Harness 搭法（复用 FLY-529 房，最小新增）

1. **构建**：worktree checkout PR head `9a566975` → `pnpm install` + `pnpm -r build`（FLY-582 教训：install 的 "Failed to create bin" WARN 意味着要 `-r build` 全 workspace）。
2. **部署**：从该 checkout 跑 `scripts/test-deploy.sh --mode roundtable 1`（host）+ `2`（member）——slot Bridge 用的就是发起 checkout 的 dist。alert 路径用 fire 脚本直驱真 plugin 组合，不需要额外部署形态。
3. **发 topic**：用 slot2（member bot）token 发（manager 默认跳过自己 bot 的消息，免 `THREAD_OWN_BOT` 注入）。
4. **翻频道默认**：`PATCH /channels/1519417773304975450 {"default_auto_archive_duration": 60}`。
5. **顺序**:先跑 A3（现状 null）→ 翻 60 → 等 >10min（provider 缓存 TTL）或直接进入 A1 → A2 静置。TTL 等待可与 A2 的 60min 静置合并，不额外花时间。
6. **收尾恢复**：把频道默认改回 null、teardown 两 slot、qa-report.md 落盘 commit。

## 4. 预检与已知风险

- **MANAGE_CHANNELS 未验证**（唯一硬前置风险）：翻频道默认需要该权限；FLY-529 时 bot 连建频道都不行。执行节点第一步就做 PATCH 探针；403 → 立即 `flywheel-comm ask` 请 Lead/Annie 在 Discord UI 把 #test-leads-roundtable 的「闲置后隐藏」设为 1 小时（一次性 UI 操作），期间先跑 A3/B/C/D 不阻塞。
- **归档是 lazy 的**：Discord 在 idle 窗口到点后延迟落 archived 标志（通常几分钟内）。轮询到 T+150min 仍未 archived → 判 INCONCLUSIVE 上报，不许静默 PASS/FAIL。
- **静置纪律**：A2 期间对该 thread 零消息零操作（任何消息重置 idle 时钟）；idle 起点 = seed 消息时间戳。
- **房间共享**：slot3/4 对该频道 403（FLY-582 实测）——只用 slot1/2；QA 结束恢复频道设置。
- Chrome/UI 佐证可选：Discord API 证据即权威（Tadashi 已在 FLY-582 接受 API-authoritative）。

## 5. 证据合同（qa-report.md，形态照 FLY-1426）

范围诚实划界 → 独立代码审查要点 → PR 焦点套件复跑（129 tests）→ 真机 E2E 矩阵逐条：thread id、原始 JSON 摘录、时间戳（建串时刻 / archived 观测时刻 / archive_timestamp）、Bridge 日志 grep 记录、静态 grep 全文记录（含退出码）→ Follow-up → Verdict。harness 脚本走 scratchpad，不 commit；qa-report.md commit 进本分支。

## 6. 本设计不做什么（诚实边界)

- 不改 802 实现一个字节（独立 QA 铁律）；发现缺陷 → 记录 + FAIL/上报，不就地修。
- alert thread 只验 create-body 值合同（D），不做第二轮 60min 原生归档静置——原生归档机制是 Discord 平台行为，A2 一次观测即代表性证明。
- 不验存量 thread 清理（design correction 明确：不要求代码自动处理存量）。
- 不动生产频道/生产 Bridge；全程 529 隔离房。
