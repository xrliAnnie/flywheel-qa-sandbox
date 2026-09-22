# FLY-2693 语音健康与失败告警 — 调研
Issue: FLY-2693 (https://linear.app/geoforge3d/issue/FLY-2693/语音静默失败-comflywheelvoice-装上后-55-小时-67-次迭代全部失败0-次成功launchd)
日期: 2026-09-17
基于: exploration.md

## 证据与当前基线

设计工作树基线 d11bb892d；生产只读客户端路径为主 checkout 的 packages/voice-codex/dist/{config,bridge-client,daemon}.js，不将工作树源码冒充运行中已载入代码。执行时使用 Node v25.6.1。

| 观测 | 实际结果 | 能证明 / 不能证明 |
|---|---|---|
| /tmp/flywheel-voice.log 聚合 | 78 行：3 启动，25 fetch failed，50 timeout | 失败日志数；没有成功数、逐条时间戳或原因码 |
| 已安装 plist | wrapper，RunAtLoad=true，SuccessfulExit=false，ThrottleInterval=30 | 监督配置；不证明业务健康 |
| 当前 .env → deployed config → client.desired，3次 | 68/10/6ms，均 null | 当前配置、HTTP客户端与路径可用；不是 PID1668 |
| 实际 deployed daemon.runOnce 只读适配 | 2026-09-17T23:13:45.878Z，idle，960ms | 能完成空转；探针没有 claim/会话/生产写入，不代表原PID最近一圈 |
| fake bridge 永远抛错，真实 deployed run() | 3次异常、3次catch、0健康通知，断言 RED | 当前循环不会通知健康观察器；尚不是修复后的投递测试 |
| ps 读取PID环境 | sandbox Operation not permitted | 本节点无法独立核实PID环境，未升级权限或重启 |
| Lead脱敏回传 | token与当前.env逐字相同、无proxy、Node25.6.1、连接127.0.0.1:9876 | 外部只读证据；不把相同token当成功证明 |

诊断重放脚本见 `diagnostic-red.mjs`，只使用假 bridge 和无状态 store。其 health 注入为拟议观察接口，旧代码忽略它，故 RED 只证明缺少该通知接缝；不能作为已验证真实频道通知的证据。实现必须新增穿过真实 sender/投影的回归，不靠这个旧版探针判绿。

## 请求链和配置来源

1. `scripts/launchd/com.flywheel.voice.plist` → `scripts/flywheel-voice-wrapper.sh`。
2. wrapper 先 host_config_load，再 source `$FLYWHEEL_STATE_DIR/.env`（缺省 ~/.flywheel/.env），检查 key/entry/tmux gate/restart brake，再 `--check-config`，最后 exec cli。
3. `packages/voice-codex/src/config.ts:78` 读取 **BRIDGE_URL**（缺省 http://127.0.0.1:9876）、**TEAMLEAD_API_TOKEN**、**FLYWHEEL_VOICE_LEASE_HTTP_TIMEOUT_MS**（2000）、**FLYWHEEL_VOICE_IDLE_POLL_MS**（5000）。不读取 FLYWHEEL_BRIDGE_URL 或 FLYWHEEL_VOICE_HTTP_TIMEOUT_MS。Lead回传所列后两种名字不能替代实际变量核验。
4. `cli.ts:98` 构造 BridgeVoiceClient；`bridge-client.ts:90,242` GET `/api/voice/sessions/desired`，Bearer master token，AbortSignal.timeout，响应正文也经 json()。当前 json parse 异常被吞，可能将 malformed 200当undefined idle；这是健康证据可信度必须一起修复的边界。
5. `daemon.ts:306` desired null → sleep → return idle；有 session 才 claim。`voice-session-routes.ts:140` masterOnly → store.getDesiredVoiceSession → JSON，未调用外部网络。
6. `voice-host-config.ts` 是 Bridge 侧 QA权限/证据目录配置，不是 daemon URL/token；仅 schemaVersion 合法（其他文件权限等校验仍适用）。

## 原因分类，避免过度结论

| 候选原因 | 预测与验证 | 结论 |
|---|---|---|
| 当前地址/token错误 | 同配置真实client GET应失败 | 3次成功，当前配置错误被反证；PID启动时配置仍需准确变量核对 |
| 原PID环境与当前漂移 | 精确变量/token比对不同 | token一致且无代理（Lead）；准确URL/timeout变量尚待核对 |
| Bridge启动不可用 | 同时段拒绝连接 | 25 fetch failed与Lead启动窗口一致；旧日志缺cause.code，不能声称逐条证实 |
| 主机负载/事件循环延迟 | timeout时间与延迟相关 | 负载观察有，相关测量无；未证实 |
| 响应正文/后续操作失败 | headers/body/operation分段揭示 | 旧日志不能区分；加入结构化分段后再下结论 |
| voice-host配置空缺 | desired路径依赖这些字段 | 路径不依赖，缺省配置合法，排除为此空转超时原因 |

## 启动与告警消费者

`startup-alert.ts` 仅处理 cli 锁 conflict/unavailable；顶层 fatal 只 stderr+exitCode=1。wrapper 自检 fail_loud 调 meta-alert；该脚本写本机文件/桌面通知，不发频道，且 best-effort 返回码不是送达证据。启动自检不发 GET，因此运行期 timeout 不会触发启动拒绝。这解释“为什么 startup-alert 没响”，不是未经证实的 Discord 故障。

FLY-2669：远端跟踪 d1b0f3eaa 是设计；本地分支 03a7613cc 有实现，fc091e536补 kind 合同。只读对照，不合并其分支。实施只以最终合入版本为准。

- kind `shuttle_unit_unhealthy` 的 union、INFORMATIONAL_KINDS、kind-contract、ticket-owner-map、copy、shell 白名单完整配套；owning_lead + none_escalate。
- 工程路由 `bridge/shuttle-alert-route.ts`/`scripts/shuttle-route-bindings.mjs`，配置身份解析与权限检查；不接受任意channel参数。
- 源库 notification_intents 与 notification_batches 分层，queue 使用 shuttleBatchId/routeKey/bindingDigest；不可伪造 shuttle 身份给 voice。
- projector→StateStore→epic-page共用刷新与来源/预算；deployment模型有班次/版本含义，不可直接塞进runtime心跳。
- 核查发现队列drain必须额外确保当前binding核验；不能因为首发已验证就认为排队后也安全。

## 按需改动面与真实恢复性质

provisioner desired CAS、runtime 3s扫描、services依赖组装、meeting统一POST入口、daemon idle退出、supervisor非-k start、install与restart/patrol均需审计。SuccessfulExit 会隐含 RunAtLoad（本机 launchd.plist man）；单改RunAtLoad=false不能保证加载后完全不空启。

当前 lease：4s renew、2s HTTP、两次miss或本地deadline停会；本地deadline是 sentAt+15s−2s，迟到响应不复活失效租约。独立daemon不会随Bridge父进程结束，但长Bridge中断仍安全结束通话。recover()恢复证据后把旧会话failed并隔离，不自动接回。见plan具体竞态与拆单验收。

## 后续精确环境核对（Lead只读回传，标注23:21Z）

question `3da751f1-ef6d-4300-94c0-99c39337de3c`：PID的BRIDGE_URL不存在，仅有源码不读的FLYWHEEL_BRIDGE_URL；实际走默认127.0.0.1:9876；FLYWHEEL_VOICE_LEASE_HTTP_TIMEOUT_MS、FLYWHEEL_VOICE_IDLE_POLL_MS均不存在，走2s/5s。由此排除所核对PID的地址/timeout配置差异为当前解释；启动未显式规范BRIDGE_URL属于配置脆弱点，增加来源诊断/测试，不把它误称已证实的故障根因。原PID最近一圈仍没有消费侧成功证据。

Lead已采纳拆单，FLY-2701承接按需启动（依赖2693+2655），要求完整附录与调参触发数据，见plan附录A/B。

最新Lead指令faf41313-a917-410c-b2ba-cd84cb02dd9a提供单次实机基线：会话5142f2ab创建→starting5.2s、starting→live46.9s。这里只作2701启动延迟参考，非本节点实测或长期性能保证。新增需求门读取现有StateStore会话唯一事实，不能假定producer一直存在。
