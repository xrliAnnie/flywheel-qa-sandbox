# FLY-2608 Raya 线程双向对话 — 调研
Issue: FLY-2608 (https://linear.app/geoforge3d/issue/FLY-2608/raya工程修复-discord-thread-中的-founder-提问必须送达-raya并在原线程回复)
日期: 2026-09-15
基于: plan.md

## 设计阶段实际执行的验证
- 源码基线 557d2b00e；Bridge /health buildSha 同值。仅健康/身份观察，不代表会话验收。
- by-thread 查询两次401；跨 raya 受管快照 runner_snapshot_context_invalid；未借用Lead凭据、未复制live数据库。
- Lead问题 f65445d7-a479-4cd5-8a6c-5ae6c79a54ad 已答，定位两条源问题。补充精确登记/归档证据问题 ee3d76ac-8f88-40d9-aaf7-858808009f2c。
- HTML script 经 `node --check` 通过。Node VM DOM替身检查通过：单 nonce script、无外部资源/inline handler、pathname隔离存储、超长意见每段<=1800字符且都有精确marker、派生文字仅textContent/value、剪贴板缺失/拒绝均fallback、存储失败仍可汇总。
- 以上是静态与脚本控制器验证，不是浏览器视觉或真实CSP执行验证；发布后还需托管HTTP/CSP/source验证。
- 产品代码和生产运行未修改；没有执行受控提问、补投或回帖，QA矩阵均为下游要求。

## Mermaid 本地渲染失败
初次与一次标准参数重试均失败。命令：
```
mmdc -i engineering/doc/FLY-2608-raya-thread-replies/flow.mmd -o engineering/doc/FLY-2608-raya-thread-replies/flow.svg -w 1000 -b white --svgId FLY-2608-d1
```
两次关键错误均为 Chromium `MachPortRendezvousServer` / `bootstrap_check_in ... Permission denied (1100)`。无SVG产物；保留flow.mmd，HTML明确显示 `DIAGRAM PENDING LOCAL RENDER`。没有远程渲染或伪造图形。此为任务明确允许的本地渲染失败交付降级。

## 已完成的托管交付验证（2026-09-16 UTC）
- R3有效 `reviewVerdict=APPROVED`；最终设计提交 `5d1aef85f`，推送后静默发布；未发送频道消息。
- URL: https://fw-reports-e8af2b.vercel.app/r/b69057303a8a84c780ec90bf62e55c49/
- `verify-report --expect FLY-2608` 返回 ok=true / HTTP 200，noncePlaceholder、scriptCsp、scriptNonce、expect全部通过。
- 独立fetch确认：去除发布器注入的CSP、noindex、nonce替换与新增空白后，托管HTML与提交源文件完全一致；零外部资源；渲染失败提示可见。详见 hosted-verification.json。
- 发布原始CLI输出在上下文切换时被截断；从发布registry定位唯一对应文件并核对托管内容恢复reportId，没有重复发布。
- Lead必需的 `DESIGN-HTML ready` 报告回执 `bef84d59-5f22-425c-a954-e8de0f46ea58`。非阻塞建议报告回执 `f06f48aa-737a-40f6-b574-e02597a0e538`。
- 本轮没有浏览器视觉QA、受控线程提问、生产补投或真实回帖验证；没有把静态/托管验证当作业务验收。

## 实施阶段验证（2026-09-16 UTC）

### 已实现边界

- 只扩展既有 `founder-reply-deliverer` / `GatePoller` / 标准 `CommDB.ingestDiscordChat` 链路；没有新建收件器或 Raya 私有传输。
- owner 只按登记的 `lead_id + channel_id` 唯一匹配；`projectName` 只用于选择既有 CommDB，不参与 thread owner 判断。
- mailbox envelope 显式携带 `replyChannelId=<源 thread id>`；持久化成功后只唤醒既有 Lead inbox，重复 message id 仍由标准 delivery id 去重。
- rollout 默认关闭。启用必须同时具备环境绑定的 marker、其 SHA-256 绑定的 activation receipt、当前 owner 一致性、固定 snowflake 下界，以及 `automaticReplayBeforeBoundary=0` 的 dry-run 证明。
- 未登记、已归档、owner 缺失/冲突、原生订阅重叠、guild/subscription 读取失败都 fail closed 并留下明确日志理由。
- 两条历史输入 `1549573491060244602` / `1549573499914297409` 没有自动回放；恢复仍须在获授权后重新审计并通过标准 `chat-ingest` 路径执行。

### TDD 与定向证据

- 先增加“Raya rollout 开启时不得改变无关 Lead 同线程任务”的回归断言；初次失败为 owner conflict 导致无关任务被吞，最小修正后通过。
- teamlead 8 个相关文件：147/147；flywheel-comm `discord-chat-ingest`：29/29；合计 176/176。
- 覆盖：源 message id 到标准 inbox row、`delivery_id=chat:raya:<msgId>`、`source_kind=discord_chat`、`to_agent=raya`、原线程 `replyChannelId`、主频道回归、跨 Lead 隔离、重复去重、未登记/归档/非 Raya owner、原生订阅重叠和 rollout fail-closed。
- `pnpm --dir packages/teamlead typecheck`：通过。
- `pnpm lint`：退出 0；仅既有无关 warning。
- `pnpm -r build`：退出 0。

### 全仓 package gate（代码头 `b52fb471615f69447aaafd2ce98806ee9b582871`）

- `pnpm test:packages:run` 完整跑完并产出 receipt；17 个包中 14 个通过。receipt 计数为 23678 passed、32 skipped、9 failed counters、1 error；日志归并后是 3 个唯一断言超时，均不在 FLY-2608 改动路径。
- `flywheel-claude-runner`: `codex-memory-seed` 生产规模目录测试超过 5 秒；单测独跑仍约 6.5 秒，因此默认门限下失败；仅将运行时门限放宽到 30 秒后，同一断言 1/1 通过（约 5.15 秒）。整文件单线程复跑还触发其既有 4096 文件测试 60 秒超时。
- `flywheel-config`: `fly1981-final-ledgers` 15 秒超时；`VITEST_MAX_FORKS=1` 整文件复跑 11/11 通过。
- `flywheel-teamlead`: `StateStore.workflow-ledger` 5 秒超时并伴随 `onTaskUpdate` RPC error；`VITEST_MAX_FORKS=1` 整文件复跑 29/29 通过。
- 因上述 3 个默认门限超时，本地 aggregate **不声明 green**。最终提交头是否可接受由 PR exact-head CI 独立判定。

### 未执行／不得冒充的验收

- 未写 rollout marker 或 activation receipt，未重启 Bridge，未部署，未改生产数据库，未读取/复制 live `teamlead.db` 或 `comm.db`。
- 未在真实 `#raya` 或真实业务 thread 发消息，未恢复两条历史输入，未取得源 message id → 生产 mailbox receipt → Raya 同线程回帖的真环境链路。
- 受控沙盒 thread 验收、QA 判决与 founder 在生产的亲测仍属于后续 QA/ship 阶段；源码测试和 CI 不能替代这些证明。
