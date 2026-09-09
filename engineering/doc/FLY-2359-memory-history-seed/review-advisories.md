# FLY-2359 获批设计交接补充 — 实施计划
Issue: FLY-2359 (https://linear.app/geoforge3d/issue/FLY-2359/2355b2-记忆回流-种回去任务结束把一次性家蒸馏出的记忆汇进-agent项目)
日期: 2026-09-08
基于: plan.md

## 获批依据

R2 有效 `reviewVerdict=APPROVED`，原始 `reviewerVerdict=APPROVED`，request `e867bdd6-eb14-44dd-a526-447247b65989`，question `dba18a8f-92bd-4a0f-8697-0a293ff1554e`。获批 plan 来自 commit `d936c9d87`，Git blob `a25b22675b2bb7689a822aaafebb74271783a999`。保留送审文件原样，以此文件记录 APPROVED 附带建议的最小实施澄清；plan 顶部的“待复审”描述的是送审快照，最终状态以本裁定为准。

## Implement 同时落实的三点

1. **历史日期是 UTC，不按宿主本地时区猜。** `sessions.started_at` 的 SQLite 形态 `YYYY-MM-DD HH:mm:ss` 或带毫秒的同形日期，是 UTC 值但没有时区后缀。先把空格换成 `T`、显式补 `Z`，再解析并输出标准 UTC ISO（无毫秒时标准输出 `.000Z`）。已有显式 `Z`/偏移的 ISO 时间按其时区解析；无效、缺失或不支持的形态置 null，不用当前时间填补。参照 `packages/teamlead/src/bridge/commdb-fsm-reconcile.ts:96` 中显式补 Z 的已有做法；该函数还依赖 nowMs 做其它业务过滤，所以复用这条转换规则即可，不直接引入当前时钟。T1 在 TZ=UTC、Asia/Tokyo、America/Los_Angeles 三个子进程中对相同输入断言 manifest/index/catalog 逐字相同。设计阶段已用真实 Node 验证 `2026-07-19 18:36:36.052` 显式补 Z 后三时区均为 `2026-07-19T18:36:36.052Z`。
2. **“档案存在”的条件覆盖全部阅读动作。** §5 合同落实为：“Only when `$CODEX_HOME/.flywheel-memory-seed/index.md` exists, read the bounded index, search catalog.md by the current issue or topic, and read relevant snapshots. If the index does not exist, skip all archive-reading steps.” 继续保留 plan 其余关于旧经验、权限、原生记忆、禁止默认全量读的约束。T4 的无索引用例还断言没有对 catalog.md 的失败读取。
3. **记录目录大小，不新增分片机制。** §7 每轮证据增加 index.md/catalog.md/manifest.json 的实际字节数；保留真实首轮读取的文件/字节记录、≤8KiB 入口和旧任务检索测试。完整目录允许搜索，单文件规模仍是已知软边界，不能把禁止默认全读的合同当作硬沙箱。

这些内容澄清既有确定性、缺档可用和读取成本要求；不新增服务、搜索系统、存放身份或清理范围。全部三条以 advisories 向 Lead 报告，不是另一轮未解决的 HIGH gate。

## 后继必须知道的边界

plan §9 已记忙家等待自然窗口、种回失败拒绝该次准入、SIGKILL staging 残留及锁内耗时等风险；实现/QA 应按其中的观测和恢复边界执行。两张 Mermaid 图的本地渲染受沙箱限制，已按任务允许的方式显示 pending 占位并保留源文件，未冒充图已渲染。设计获批不等于产品四条验收已完成。
