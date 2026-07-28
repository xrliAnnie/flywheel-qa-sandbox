# FLY-1505 Runner ship 轮询与批准保活 — 设计修正
Issue: FLY-1505
日期: 2026-07-27
基于: plan.md

## 修正来源

Design 阶段完稿并获批后,Lead 发来 implement 增量裁决。原 C1 用固定 40 分钟窗口包住 workflow 的 30 分钟上限,虽然能覆盖本次 25 分钟回归,但仍保留了「两个 deadline 各自漂移」的根因。

本修正只替换 C1/C5 的等待权威与 founder 图 d2;C2/C3/C4/C7 的服务端 deflection、批准保活、同 head 自动重唤醒抑制和 Lead 升级语义不变。

## 权威修正

1. **废除 runner 的固定 merge deadline。** 删除 `SHIP_MERGE_POLL_WINDOW_MINUTES=40` 与 margin 常数。轮询间隔可保持 60 秒,但它只控制查询频率,不决定 workflow 何时失败。
2. **本次 attempt 的 started receipt 是追踪入口。** Runner 发一次 `:cool:` 并保存 `COOL_ID`;只认 `trigger_comment_id=<COOL_ID> status=started` 的 receipt,从中取得 `run_id`。旧 attempt receipt 一律忽略。
3. **GitHub workflow run 是终态权威。** Runner 用 `gh run view <run_id> --json status,conclusion` 查询:
   - `queued` / `in_progress`:继续等;GitHub Actions 按 workflow 自己的 `timeout-minutes` 负责超时;
   - `success`:确认 PR 已 `MERGED` 后正常收尾;
   - `failure` / `cancelled` / `timed_out` 或其他 terminal non-success:立即 `SHIP-FAILED` 报 Lead。
4. **只有追踪链失灵时才用动态 fallback。** receipt 不出现、`COOL_ID` 不可得、或 `gh run view` 持续报错时,从当前 checkout 的 `.github/workflows/ship-on-comment.yml` 现读唯一 `timeout-minutes`,加固定 5 分钟传播缓冲。动态预算耗尽仍不 `complete --route blocked`;改报 `SHIP-STALLED`、park/待命并保持批准。
5. **C5 改为结构合同。** 不再断言窗口常数;断言提示词包含 attempt receipt → run id → run status 追踪、动态读取 workflow 预算的 fallback,并断言 workflow 文件中 `timeout-minutes` 恰好一处。
6. **失败 attempt 先持久化再 park。** Runner 走专用 `complete --route ship_attempt_failed`，Bridge 保持 `approved_to_ship` 并写入 approval-binding + head 的抑制 marker；新 approval binding 会自动解除同 head 抑制。离线 marker drain 必须等 Lead 告警成功后才删除 marker，告警暂时失败则保留并重试。

## 实证补强

PR #713 的时间线证明固定 10 分钟窗口不仅是理论风险:

- founder 批准:02:26;
- runner 假报 blocked:02:49;
- workflow 仍继续并于 02:56 自行合入;
- 对应 GitHub Actions run:`30323697177`。

这 30 分钟窗口内的真实 run 进一步说明:runner 应盯同一次 workflow run 的真实状态,不该自己维护一只更短或更长的第二时钟。

## 对实施与验收的影响

- Blueprint prompt 改为 run-state 驱动,删除 40 分钟文本与常数。
- `Blueprint.fly1505-ship-poll-window.test.ts` 改钉 run-state 协议、动态 fallback 与唯一 timeout 解析合同。
- `flywheel-comm complete` 新增非终态 `ship_attempt_failed` 路由；三个 Bridge ingestion 入口统一 deflect，不改变会话状态或 founder 批准。
- 同 approval binding + head 的失败 marker 暂停自动 re-wake；启动 drain 在 notifier 就绪后执行并 await 告警，避免 marker 被静默消费。
- founder HTML 的 d2 重画为「started receipt → run status → GitHub 自有 timeout / terminal conclusion」,删除 40 分钟窗口画法并重新发布。
- 其余已批保护机制与测试矩阵保持不变。
