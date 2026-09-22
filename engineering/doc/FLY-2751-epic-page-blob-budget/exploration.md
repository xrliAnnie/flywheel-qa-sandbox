# FLY-2751 Epic 固定页 Blob 预算 — 探索
Issue: FLY-2751 (https://linear.app/geoforge3d/issue/FLY-2751/托管额度-epic-固定页每个事件都自动重发14h-159-次每次-4-次-blob-写列删-免费档-2000)
日期: 2026-09-18
基于: 无

## 问题与成功判据

`epic_page_refresh` 在 2026-09-18 08:36Z–22:45Z 记录了 159 次成功发布。事件刷新当前只有 5 秒防抖；每次 hosted 发布还会读取旧 HTML、写 audit、写 HTML、扫描整个 `r/` 前缀并删除旧 audit。结果是固定页本身成为 Blob 免费档的主要消耗源。

本单成功必须同时满足：

1. 自动事件只在 founder 可见的语义内容变化时写 Blob；仅刷新原因、生成时间、来源采样时间、版本与 freshness 计数变化时不写。
2. 自动成功发布之间至少间隔 15 分钟；间隔中的事件合并，到期后重新物化并发布最后状态，不能发布 15 分钟前缓存的旧页面。
3. 显式手动 `epic-page generate` 在 hosting 已配置时立即走完整 publisher，不受 digest 或 15 分钟限制；`show`、`render`、`dependency show` 等只读命令仍不发布。
4. 每次发布的 audit 清理不调用 `list`；只删除当前 HTML 已知的祖父 audit 路径。每日 retention sweep 负责按对象年龄收敛失败遗留的 audit 孤儿。
5. 一小时事件回放最多 4 次发布，内容完全不变时 0 次 `put`，Blob fake client 的 `list` 为 0。

## 当前链路证据

| 层 | 当前事实 | 影响 |
|---|---|---|
| 事件合并 | `epic-page-refresher.ts` 只有 `EPIC_PAGE_REFRESH_DEBOUNCE_MS = 5_000`；active 期间的新事件会立刻进入下一轮 | 高频事件约每 5 秒即可触发一次完整物化/发布尝试 |
| 内容摘要 | `epic-page-publisher.ts` 用 `hostedContentDigest(page)`；`model.ts` 虽去掉 `freshness`、时间戳与数值 `version`，仍摘要 `generator.trigger/reasons` | 相同页面由不同事件原因触发时 digest 改变，绕过 `unchanged_digest` |
| keepalive | 相同 digest 只在 24 小时内跳过 | 它同时刷新 14 天 Blob TTL，不能直接删除；应保留为明确的存活例外 |
| 手动路径 | `runEpicPageAttempt` 对 `trigger === "manual"` 直接记 `ok_unpublished:*:manual`，不调用 publisher | 需把显式 generate 与只读 show/render 区分，不能让巡检读取变成写入 |
| audit 清理 | `putEpicPage().afterCommit()` 调私有 `auditPaths()`，每页分页 `list({prefix:"r/"})` 后筛 token | 每次发布都扫全 store；对象数越多成本越高 |
| 已知指针 | 当前 HTML 同时含当前 audit `href=<hash>` 与 `data-previous-audit=<hash>` | 新提交后可直接删旧 HTML 的 `data-previous-audit`，无需列举 |

## 摘要边界逐项核对

| 字段族 | hosted 页面是否使用 | digest 处理 |
|---|---|---|
| `generated_at`、所有 `observed_at` / `source_updated_at`、camelCase `observedAt` 原值 | 只用于“多久前”、view/deployment 采样时间和出处采样时间 | 原始值排除；时间流逝与重复采样不构成业务内容变化 |
| `freshness`（版本、失败计数、last/next scan、host token） | hosted renderer 只把它放进 audit sidecar，且本身会被每轮刷新改写 | 整段排除，避免自反馈发布循环 |
| `generator.version/trigger/reasons` | hosted HTML 不渲染；只描述“为什么生成” | 整段排除；这是现有 159 次重发的直接抖动源 |
| `since`、lead note `written_at` | 表示状态切换或人工内容发生的业务时刻，页面据此展示等待时长/署名 | 保留；这不是采样抖动 |
| 由 `now` 派生的 shuttle stale、attention wait 小时桶、drift 小时桶 | hosted HTML 直接展示健康结论/等待时长 | 纳入 presentation digest；跨语义阈值必须重发 |
| root/child 标题、状态、阻塞、运行进度、attention、lead note、deployment、judgment/history | 页面正文或可展开详情直接展示 | 保留；改变就发布 |
| root counts、attention 数量、deployment totals、terminal counts | 页面正文直接展示 | 保留；不能把真实可见计数当噪音删掉 |
| freshness 内 publish failure/version 等计数 | 不属于 founder 当前工作内容，且由发布动作自身造成 | 随 freshness 排除 |

## 方案比较

### A. publisher 语义闸 + refresher 预排程/到期重放 + 定点删/每日收敛（选择）

- publisher 是所有自动 hosted 发布的单一写入口，在 critical section 内同时核 digest、hosting identity 与 15 分钟间隔。
- refresher 在 debounce 前读取权威 publication，把窗口内事件直接排到 `last_published_at + 15m`；publisher 仍保留并发 backstop，若返回限流 outcome 再把 reasons 放回 pending。
- 只有 CLI `epic-page generate` 发出的显式 publish intent 才调用 `publishHosted(..., { force: true })` 绕过两道闸；读类 manual 路径继续只生成。
- Blob 读取旧 HTML 时顺便得到旧 current/previous hash；提交后只删将被淘汰的 previous hash。失败孤儿由每日 sweep 按 audit 自身 `uploadedAt` 回收，同时保护稳定 HTML 当前/上一版引用。

优点：写入闸不会被 scan 或新调用方绕过；refresher 在物化前合并 cooldown，最后一版由到期时重新物化保证；无新持久表。缺点：presentation 小时桶的真实展示变化仍会产生发布，但受 15 分钟上限约束。

### B. 只在 refresher 里做 15 分钟定时

优点：事件窗口中减少 Linear/SQLite 物化。缺点：scan 或任何直接 publisher 调用可绕过；refresher 在物化前不知道内容是否相同；publisher 无法给出完整写入不变量。否决。

### C. 保持 list，改成每日 audit sweep

优点：发布路径改动更少。缺点：需要另建 audit-only sweep 选择/保留规则，且 retention sweep 目前按 14 天过期，不保证每页只留两版。相比已知 hash 定点删除更复杂。否决。

## 假设与边界

- 15 分钟间隔约束 hosted 自动发布，不限制纯本地/HTTP 响应生成；只有显式 generate/publish intent 在 hosting 已配置时强制重发，即使内容相同。
- 24 小时 keepalive 保留为 Blob 14 天 TTL 的生命周期例外；一小时“内容不变 0 put”判据不跨越 keepalive 边界。
- 失败尝试不推进间隔，只有 `commitEpicPagePublication` 的成功时间是节流权威。
- 不改每日 `sweepExpiredReports()` 的 `list`；QA 的 `list=0` 针对一小时固定页发布回放，不包含每日 sweep。
- 不部署、不改生产凭据、不运行真实发布。生产事件序列只通过受控数据库快照读取；若快照 helper 不可用，则把 issue 已给出的 159 次观测作为来源并在测试 fixture 标注。
