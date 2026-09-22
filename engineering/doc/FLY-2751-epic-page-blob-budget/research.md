# FLY-2751 Epic 固定页 Blob 预算 — 调研
Issue: FLY-2751 (https://linear.app/geoforge3d/issue/FLY-2751/托管额度-epic-固定页每个事件都自动重发14h-159-次每次-4-次-blob-写列删-免费档-2000)
日期: 2026-09-18
基于: exploration.md

## 证据边界

- 工单已经核实 `epic_page_refresh` 在 2026-09-18 08:36Z–22:45Z 成功发布 159 次，约 11 次/小时；这是本单的生产基线。
- 受控数据库快照 helper 已按约定尝试，但当前 implement 运行没有 `TEAMLEAD_API_TOKEN`，返回 `snapshot_owner_unavailable`。没有直接读取或复制 live `teamlead.db`。
- 因此测试使用“工单观测频率 + 代码中真实注册的 refresh reason”构成的一小时代表性序列；不会把它描述成生产表逐行导出。生产逐行校准留给 QA 的冻结头环境。

## 写入链路与直接原因

```text
事件 -> refresher (仅 5 秒 debounce) -> attempt/materialize
     -> publisher (digest + 24h keepalive) -> Blob
     -> GET HTML + PUT audit + PUT HTML + LIST r/ + DEL stale audit
```

`hostedContentDigest()` 已排除 `freshness`、snake_case 采样时间和标量 `version`，但仍包含 `generator.trigger/reasons`。同一业务快照被不同事件触发时因此会得到不同摘要，解释了事件频率和 159 次发布几乎同速。每次发布的 `auditPaths()` 又分页扫描整个 `r/`，把固定成本放大成 4–5 次 Blob 调用。

## 设计评审后修正的四个隐含合同

### 1. manual 不等于发布意图

`POST /api/epic-page/generate` 同时服务：

- `flywheel-comm epic-page generate`（显式重新生成）；
- `epic-page show` / `render`；
- `dependency show`。

后三者是 Lead 日常只读巡检，不能每读一次就托管写入。现有 route materializer 还缺少 production 路径的 `readDeployment` 与 `readShipJudgmentHistory`，直接托管会发布降级页。

解决：只有 `epic-page generate` 在请求体发送严格布尔 `publish: true`；show/render/dependency show 不发送。route 为 publish intent 补齐与 production materializer 相同的 deployment/history 读取。`runEpicPageAttempt` 对普通 manual 保持 `ok_unpublished:<v>:manual`，仅显式 intent 调 `publishHosted(page, { force: true })`；publisher 不从 `trigger=manual` 猜测权限。这样既满足“手动刷新立即发布”，也不把读命令变成无上限写入。

### 2. founder-visible 内容也包含由 now 派生的语义

hosted renderer 是 `render(page, now)`：即使 page 不变，以下 founder 结论会变化：

- deployment 采样超过 12h 后，从“班车全部单元正常”变成“班车停跑/读数过期”；
- attention 等待时间按小时增长；
- shuttle drift age 按小时增长。

因此发布摘要分两层：

1. page semantic digest：删除 `generator`、`freshness`、标量 `version` 和原始采样时间 `generated_at/observed_at/source_updated_at/observedAt`；保留正文、可见业务 counts、`since`、lead-note `written_at`。
2. presentation digest：加入由同一套展示函数计算的 deployment stale 布尔值、attention wait 小时桶和 shuttle drift 小时桶。

精确采样时间与 minute-level audit age 仍视为噪音，不进入摘要；跨健康结论/小时展示桶则属于 founder 看得到的实质展示变化。RED 测试固定同一 page 推进 `now` 跨过 12h，必须得到不同 digest 并发布。

### 3. 24h keepalive 也是 TTL 保活

稳定 HTML 的 gateway 与 daily sweep 都执行 14 天 TTL。每次 mutable republish 会刷新 Blob `uploadedAt` 和 registry `createdAt`。若相同 digest 永久跳过，安静项目 14 天后固定链接会 404，publication 行仍会让后续 attempt 永久 `unchanged_digest`。

因此保留现有 24h keepalive，明确它是生命周期写入例外，不是业务事件重发。QA 的“内容不变不 put”在一小时回放中成立；跨 24h 的专门测试应重发一次，且远短于 14 天 TTL。

### 4. active mutable token 的 audit 孤儿不会按现有 TTL 自动消失

现有 sweep 对同 token 全部对象优先使用不断刷新的 registry `createdAt`；失败 audit（gateway/HTML/registry/DEL failure）会随 active token 永久保留。

解决分两层：

- 发布后：从旧 HTML 解析 current 与 `data-previous-audit`，只直接删除已知被淘汰的 old previous，不 list；A→B→A 和相同 hash retry 不删新 current/previous。
- 每日 sweep：继续一次 store-wide list；对 mutable token 的 audit 改用对象自身 `uploadedAt` 判断 14 天，并 GET 稳定 HTML 保护其 current/previous。GET/解析失败时 fail closed，保留该 token 的 audit。这样失败孤儿最终收敛，而每次 publish 的 list 仍为 0。

## 15 分钟闸与最后一版

refresher 在收到事件时先读 `epic_page_publication.last_published_at`：

1. 从未成功发布或时间无效：保持 5 秒 debounce。
2. 距成功发布不足 15 分钟：直接把 timer 排到到期点，不先物化；窗口事件只合并 reasons。
3. 到期重新物化当前状态并发布，因此上传的是最后状态，不是窗口开始缓存。
4. publisher 在 critical section 内重复同一检查，防并发/scan 绕过；返回 `minimum_interval` 时 refresher 把 reasons 放回并重排。
5. 未来时间/时钟回拨把 delay clamp 到最多 15 分钟；invalid/未发布视为无 cooldown。hosting retarget 仍遵守 15 分钟，显式 generate 可立即播种。

预排程让一小时约 11 个事件最多形成 4 个 attempt/publish 窗口，而不只是限制 Blob 写入。`minimum_interval` 是 accepted delay，不记作 intake failure；它也不等于 hosted-equivalent，不能提前清 dirty intake。`flushForTest()` 只完成当前 due drain，不穿越未来 cooldown。

## Blob 操作预算与额度口径

工单给出的额度口径是免费档每月 2,000 次 Advanced Requests；本单沿用该口径，不用其他套餐的百万级额度替代。

稳态实质发布最多：1 GET 当前 HTML + 2 PUT（audit、HTML）+ 1 已知路径 DEL，LIST=0；首次/无 old previous 时 3 次。15 分钟上限为 4 次/小时、96 次/天：

- 病理性每窗都实质变化：最多 384 次/天、11,520 次/30 天，**仍高于 2,000/月**。15 分钟是损害上限，不是绝对月配额保证。
- 只计两次 PUT 也为 192 次/天、5,760 次/30 天，仍高于 2,000/月。
- 内容稳定：事件回放 0 Blob 调用；24h TTL keepalive 每页约 3–4 次/天，即 90–120 次/30 天。
- 正常值取决于 founder-visible 实质变化次数；相较现状 159/14h × 4–5 ≈ 1090–1360 次/天，事件噪音将被归零。

每日 sweep 另有一次 store-wide paginated LIST，并对 active mutable fixed page 至多一次 GET；这与逐次发布的 `list=0` 分开计量。若真实业务内容长期每 15 分钟都变化，需后续另设日/月硬预算或升级套餐；本单锁定的要求没有授权该产品策略。

## 验证重点

| 风险 | executable guard |
|---|---|
| generator/时间抖动误发 | 参数化 digest 测试；一小时 11 事件 counting client 断言 unchanged put=0 |
| stale/等待展示永不更新 | 同 page 跨 12h/小时桶 digest 与 publisher RED/GREEN |
| cooldown 丢最后一版 | fake timers 窗口内多次改变 source，due 时重新物化最终值 |
| 读命令写 Blob或发布降级页 | CLI body + route intent + deployment/history parity 测试 |
| stable link 过期 | 24h keepalive 与 14 天前重发测试 |
| audit 删除错误/孤儿不收敛 | direct path、A→B→A、失败、gzip、daily protected sweep 测试，publish list=0 |
| fake timer 空转 | `flushForTest` cooldown 回归，并纳入 lead-note e2e |
