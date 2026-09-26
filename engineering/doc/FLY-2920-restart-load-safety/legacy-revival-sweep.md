# FLY-2920 旧恢复入口消费者 — 实现核对
Issue: FLY-2920 (https://linear.app/geoforge3d/issue/FLY-2920)
日期: 2026-09-26
基于: plan.md、acceptance-G.md

G 开工前核对基线 `f4b0a9aaf`。检索 `makeCloseAndDispatchSuccessor`、`startSuccessor`、`session_stage` 的 teamlead 生产 TypeScript 消费者；本表记录保留理由，不代表 G 已验证完成。测试匹配及逐项排除见 consumers-G.json。

| 消费者 | 实际用途 | 本组处置 |
|---|---|---|
| bridge/progress-resume.ts | prior session stage 与 ledger 比对，产生 effectiveStage | engine-owned 路径改用当前持久节点权威；人工 legacy 路径保留 |
| bridge/run-infra.ts | 从 prior row 构造 resume 输入；读取 local ref 的已提交内容 | 传入精确当前 engine 绑定；保留 local-first 和同 SHA pin |
| bridge/rescue-runtime.ts、bridge/plugin.ts 的 makeCloseAndDispatchSuccessor/startSuccessor | FLY-871 login_expired 救援；先拒绝 engine-owned/ownership-read 失败，再要求 running，terminate→close→start | 保留。不是已证实的 FLY-2084 批量 boot 复活入口；既有 engine 拒绝和人工/登录救援负控继续执行 |
| StateStore.ts | sessions schema、类型、upsert/patch、序列化、one-shot 历史数据更正 | 保留存储兼容；G 不删除 stage 字段，不以它作为 engine 恢复相位 |
| DirectEventSink.ts、bridge/event-route.ts | started/stage 事件投影、完成证据推导显示 stage | 保留事件记录/显示；这些 stage 写入不授予 workflow 节点重新启动权限 |
| HeartbeatService.ts、bridge/issue-display.ts、issue-display-refresher.ts、issue-title-state.ts、voice-routes.ts | 心跳 badge、issue 标题、缓存指纹和语音返回字段 | 保留显示消费者 |
| bridge/commdb-probes.ts | session 行投影到 CommDB | 保留跨库兼容投影 |
| bridge/done-running-reconciler.ts | completed stage + running + 无 route/PR 的旧会话完成收口；保留 pending marker/parked veto | 保留终止方向的对账，不是启动 successor 的入口 |
| bridge/actions.ts | 已授权 approve 动作把显示 stage 推到 ship | 保留既有动作，不作为本次 ship 授权 |
| patrol-continuity-collector.ts | continuity evidence 采集与合法 stage 值校验 | 保留观察证据，不产生起体 |

没有将不存在的 literal `produce` 宣称为本次删除项。决定性负控必须来自真实持久库、真实 Git 本地独有提交与生产 boot/recovery 链；字符串搜索只用于列清调用方。
