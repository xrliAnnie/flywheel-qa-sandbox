# FLY-2563 Bridge 响应与连接寿命 — 评审修订
Issue: FLY-2563 (https://linear.app/geoforge3d/issue/FLY-2563/bridge-ship-judgment-modetick-每-3s-同步跑)
日期: 2026-09-14
基于: plan.md

## R1 有效结论与处理

Gate `6ba20130-08e0-4db2-8772-a37fb8e3b713`，request `aec4ca61-1d09-4555-845c-8fcd597e4e70`，reviewVerdict=CHANGES_REQUESTED，reviewerVerdict=CHANGES_REQUESTED。原findingKey见已移除delivery nonce的`review-r1.json`。本文件不是Lead governance ruling。

| findingKey | 处置与设计落点 |
|---|---|
| closeout-zero-match-misclassified-as-dependency (HIGH) | 接受；§3.3普通零匹配正常消费，无pending/outcome/告警；T1新增725条空匹配、归档不受阻回归；显式restore才精确入队 |
| fd-limit-source-ignores-node-rlimit-raise (HIGH) | 接受；§5.2/6.1以min(进程soft,Darwin kernel cap)作真实分母，未知不通过F；wrapper失败warn而非阻断启动；真实launchd PID取证与历史事故未证实边界进入QA/HTML |
| js-time-filter-local-tz (MEDIUM) | 接受语义修正；候选内PK点查julianday→UTC毫秒，混合时间格式/非UTC TZ回归；不把昂贵时间过滤放回全表SQL |
| b2-trigger-couples-authoritative-verdict-insert (MEDIUM) | 移除新trigger，保持权威写入路径不变；主水位+60秒有界源身份轮转捕获迟到，已有outcome不查terminal holder |
| migration-failure-not-isolated (MEDIUM) | 补明确StateStore捕获该学习侧迁移失败与ready状态；observer禁用、health降级、归档保留，Bridge仍可listen；其他权威schema失败不改 |
| commdb-per-op-open-runs-full-constructor (MEDIUM) | 收缩变更：legacy常驻owner保持；两个裸new只明确finally-close；notify保留createIfMissing，zombie缺库空候选；不以逐消息迁移换取计数好看 |
| lag-acceptance-window-max (MEDIUM) | 保持max定义与严格阈值；明确失败归因/完整窗口保留流程，范围外问题Follow-up但B仍失败，不筛选样本 |
| duplicate-closeout-cursor-index (LOW) | 未采用：现场索引实为(project,source,issue_id,ts)，不是评审实验的(project,source)；指定备份EXPLAIN源id页有TEMP B-TREE，新(project,source,id)是不同访问路径；保留原索引且单列迁移开销 |
| fd-sampling-prefers-dev-fd (LOW) | 随HIGH的资源采样修正采用；/dev/fd异步读取已在本节点验证，lsof仅QA分类取证 |
| mode-off-transition-first-tick (LOW) | 明确初始unknown→off算转换，第一次tick也结算 |
| sync-op-marker-test-path (LOW) | 更正到claude-runner/test并加Bridge marker coverage文件 |

## 独立复核证据

- 指定事故备份（与exploration同路径）immutable只读：flywheel + bridge.lifecycle-closeout + closeout_report + canceled共725条；按既有project/issue/alias匹配run为0。连接已close，未修改备份。
- 同一隔离bash先`ulimit -Sn 256`，启动本机Node v25.6.1后`process.report.getReport().userLimits.open_files`输出soft=1048575/hard=unlimited；未批量打开fd、未触碰Bridge进程配置。
- Node异步`readdir('/dev/fd')`成功，当前测试进程数字fd计数12。不是生产Bridge计数。
- sysctl读取被sandbox拒绝。reviewer报告的kernel cap184320是reviewer证据，不能标成本节点验证值；实际生产Bridge软限/内核cap/EMFILE或ENFILE原因仍待QA取证。
- 对指定备份旧`idx_session_events_closeout_canceled(project_name,source,issue_id,ts)`运行源id页EXPLAIN，结果为prefix SEARCH + `USE TEMP B-TREE FOR ORDER BY`。因此新id顺序索引保留。

## Follow-ups 与证据限制

- 生产事故fd耗尽归因没有被本设计证明；必须在实施/QA记录真实PID/start identity、实际限制及errno，缺失历史证据就保持unknown。
- legacy backend若其有界常驻连接数量本身超过6P，单列实测未达标并交Lead决定轻量writer后续；不能扩大项目分母或把默认backend结果冒充legacy。
- lag严格max若被范围外GC/其他timer击穿，保存失败窗口与profile并记录后续，不擅自放宽验收。
- Mermaid本地浏览器权限限制继续保留；没有远程渲染或视觉QA替代声明。

修订仍仅包含设计文档及HTML；没有执行产品实现、迁移、重启、部署或继任派发。需要NEW review gate + NEW request-review取得有效批准。
