# FLY-2459 Honey Lemon 受控切换 — 实施计划
Issue: FLY-2459 (https://linear.app/geoforge3d/issue/FLY-2459)
日期: 2026-09-11
基于: plan.md、migration-decision.md

## 当前交付状态

**尚不可执行生产切换。** planner、能力接线、内部执行器、旧 owner 恢复、restart wave 与窗口外 verifier 已接通；最终全仓检查、代码审查和 QA 交接尚未完成。本文件不是重启或派单授权。完成实现、审查与 QA 交接后，由部署责任人填入实际部署 SHA 与下方证据。

部署 SHA：未部署。生产验收：未执行。当前实现节点不登录账号、不重启 Lead、不派验收 runner。

## 目标与配置含义

唯一目标是 `flywheel/flywheel-product-lead`（Honey Lemon）。目标字段为：

```json
{
  "backend": "codex-app-server",
  "codexProfile": "full-access",
  "model": "gpt-6-astra",
  "effort": "high",
  "canSpawnRunners": true,
  "codexRunnerActions": true
}
```

其他 Lead、bot identity、频道、部门及摘要职责不变。`codexRunnerActions` 是显式配置；仅设置环境标记不能获得派管 runner 权限。默认 Lead 不获得新动作。

管理台 backend/model/effort 展示的是配置值，生效以进程验收为准。管理台保留 `backendWritable=false`；不要通过改 model 名称替代 backend 迁移。

## 只生成迁移 intent

在将由班车部署的 checkout 中，由部署责任人确定目标 commit 后运行既有 planner：

```bash
node packages/flywheel-comm/dist/index.js lead-registry plan-backend-migration \
  --project flywheel \
  --lead flywheel-product-lead \
  --to-backend codex-app-server \
  --model gpt-6-astra \
  --effort high \
  --runner-actions \
  --codex-profile full-access \
  --deployment-sha "$(git rev-parse HEAD)" \
  --out "$HOME/.flywheel/lead-backend-migrations/FLY-2459-honey-lemon.json"
```

该命令校验当前 registry、summary receipt 和源文件摘要，只写 intent，不改 live registry、不启动服务。目录权限为 0700，文件为 0600。相同计划可重跑，冲突会拒绝；不要覆盖旧 intent 或擦掉 receipt 来强行重试。

intent 不唤醒 updater，不等于 R4 授权。正常执行只能经过独立 updater 的既有班车；紧急情况仍需要 founder 的现行紧急票流程。不得直接执行迁移 helper、kickstart 服务或自行解除 admission pause。

## 窗口中的执行合同

以下步骤由既有班车内的执行器完成，不是额外手动命令列表。

1. 核对实际部署、restart owner 进程链/PID/start time、锁目录身份以及本轮 admission lease。没有有效 intent 时无操作。
2. 停旧 owner 前核对静态 Codex 前置：auth 文件存在（不读取内容）、独立 home/link truth、项目 root、full-access profile、host tmux 门、编译工具及 token 可解析。保存源 manifest/plist 原字节。
3. 通过既有 lifecycle 停旧 owner；证明 job 已卸载、旧 carrier 及 lease holder/supervisor 已退出。探测错误不是退出证据。
4. 在现有 `${PROJECTS_FILE}.cfglock` 短锁内 CAS 修改目标六字段，保留其他 row 与 summary assignment。按目标精确生成 manifest/plist，不运行全量重物化。
5. 旧 writer 停止后用 Discord REST 采集每个订阅频道 cutoff。operator 文件保留首次快照，重跑不移动 cutoff。无旧 bot 后续回复的消息 ID 和受分页上限影响的历史范围，通过标准 mailbox 交给新 Lead；先核对已有副作用再处理。
6. 交接持久化后再写 transport cursor。空频道使用显式 `after=0`；已推进游标不得倒退。mailbox ACK 不表示业务完成。
7. config/manifest CAS 后、激活前运行完整既有 generic preflight。该检查失败时，按 Lead 裁定执行条件回滚并恢复旧 owner，以结构化失败原因返回；恢复中断后先继续恢复，不重新向前迁移。
8. 使用既有 generic lifecycle 启动新 owner 与可见 TUI。窗口只验证基础启动与身份，返回 `deployed_unverified`；不在 admission pause 内等待人工 @ 或派验收 runner。同一 wave 必须避免再次启动该目标。

其余未知状态保持 held，禁止把任意异常扩展为自动回滚。回滚只接受本迁移的目标字段及文件状态；不覆盖其他 Lead 的修改，不删除业务结果，不回退 cursor，不把 Claude sessionId 当成 Codex threadId。

## 窗口外验收证据

验收责任人先确认 restart wave 已结束，`GET /api/admission/pause` 返回 `ok=true` 且 `admissionPause.active=false`。未知或仍暂停时等待，不自行 resume 或发送测试 start。

| 要求 | 必须记录的权威证据 | 当前状态 |
| --- | --- | --- |
| 部署与持久配置 | 实际部署 SHA、目标 registry/manifest/plist 摘要、迁移 receipt | 未执行 |
| 新进程 | 唯一新 owner 的 PID/start、backend、model/effort；pane 与 sessions/fleet 证据 | 未执行 |
| 收件与派单 | 获授权的真实 #flywheel-core @ message ID；Flywheel-Product issue；run/execution 与 issue_delivery 事件 | 未执行 |
| 部门负例 | 越界 issue 的实际 403，且没有新增 run | 未执行 |
| 默认能力负例 | 未显式配置的 Codex Lead 不暴露或执行 start_runner | 生产未执行 |
| 停机窗口消息 | 原始 sourceMessageId 与标准收件链的对应证据，不使用补造 ACK | 未执行 |
| 持久重启 | 下一次获授权班车后的 backend/model/effort 与唯一 owner 复验 | 未执行 |
| 窗口外对账 | verifier 从权威状态核实证据并保存结果；不接受文件自称 passed | 未执行 |

测试 fixture、REST 响应样本、配置截图或 `deployed_unverified` 均不能替代上述生产证据。验收不齐时保持明确未验收状态。


## 窗口外只读对账命令

部署/验收责任人在上述 QA 证据齐备后使用。进程环境需具备本机 `BRIDGE_URL`、既有 Bridge token（`FLYWHEEL_API_TOKEN` 或 `TEAMLEAD_API_TOKEN`），以及 registry 指定的 bot token；不要把凭证写入 evidence 文件。founder 身份由既有 `.flywheel/.env`/founder resolver 读取，不接受 evidence 指定作者。

真实 Discord 请求的 start_runner key 必须为 `discord:<channelId>:<messageId>`，工具再绑定 issue 与 Lead 身份生成 Bridge reservation key。普通手动 key 明确返回 `source=none`，不能冒充本次 @ 验收。

证据 JSON 只包含以下 locator 字段；填入真实记录，不包含 passed、时间、token 或作者覆盖值：

```json
{
  "version": 1,
  "channelId": "<真实频道 ID>",
  "messageId": "<真实 founder @ 消息 ID>",
  "issueId": "<派单时的 issue ID>",
  "runId": "<workflow_run UUID>",
  "nodeId": "<首次节点 ID>",
  "executionId": "<首次 execution UUID>",
  "activationId": "<该 execution 的 activation ID>",
  "eventUid": "<issue_delivery event_uid>"
}
```

```bash
node packages/flywheel-comm/dist/index.js lead-registry verify-backend-migration \
  --migration FLY-2459-honey-lemon \
  --evidence /absolute/path/to/evidence.json
```

verifier 精确回读 Discord 消息，核对 founder 作者与 bot mention，再用来源 key 串联现有 reservation/run/node/attempt/execution/activation/issue_delivery，要求记录时间晚于 @、正文摘要正确、部门一致；同时核对部署 SHA、目标文件和现存 carrier/lease。它不发送消息、不派 runner、不 nudge、不重启或解除 admission。

两次实时核验成功后 CAS 写 verified/committed；最终检查失败保留可重放状态。相同证据可重复核验，不重复业务动作；不同证据冲突拒绝。committed 后原子退休该 intent 到同目录 `.committed.json` 不可变归档，之后正常班车恢复普通重启路径。失败/held intent 保留原路径。机器对账回执不替代上表的真实 403、界面截图、模型/effort 和后续获授权重启 QA 证据。


### Later updater waves with a retained intent

The updater inspects the intent without applying it when the planned deployment is stale, the static preflight is held without any stop, recovery has restored the source, or migration is already deployed pending verification. It continues the ordinary Lead wave only after the original source (registry/files/live owner) or completed target (registry/files/canonical live owner) is freshly proved. The output is `status=skipped` with `source_unchanged`, `source_restored`, or `awaiting_verification`; this is not migration success or authorization to retry it. The ordinary wave includes Honey Lemon as well as the other Leads. The receipt and active intent remain intact for operator reconciliation or the separate verifier.

Interrupted mutation, incomplete recovery, conflicting/missing artifacts, an unproven owner, changed intent/receipt, or lost restart/admission authority still holds the wave. Do not remove/overwrite the intent to bypass that hold. Migration mutations always require the original planned SHA; inspecting a newer deployment never authorizes migration there. A preflight rollback that proves the restored source permits the same ordinary wave to continue.
