# FLY-2598 R1 审阅处置 — 调研
Issue: FLY-2598 (https://linear.app/geoforge3d/issue/FLY-2598/语音激活-主机激活-2446-通用语音进程会议模式-随身模式注册表-huddle-块-lead-voicemodes-voice)
日期: 2026-09-16
基于: plan.md, research.md, host-runbook.md, self-filter-contract.md

R1 gate `d8177f64-e238-45dc-80f4-b671cff75d71` / request `42bb3722-6f77-4d16-91a4-dde02d77c1bc` 有效 verdict=CHANGES_REQUESTED。以下是本轮修订；新的 gate 通过前不宣称 APPROVED。

| findingKey | 核验和处置 |
|---|---|
| openai-key-washed-from-codex-child-env | 接受接线缺口。保留两层 child env 清洗，明确 account/login/start 私有 stdin 唯一认证通道；测试实际 spawn 无 key 与 RPC 先于 thread，不只测 env helper。Lead aa87aab0 已同意。 |
| openai-key-not-provisioned-for-launchd-daemon | 部分事实不成立：原 grep 漏 `export`，当前文件0600且 clean Bash 只带 HOME/PATH source 后 key 非空，见 r1-env-evidence.json。接受手册缺口：补实际 source 检查、缺失时本机安全配置步骤和失败停止条件。未调用 API，不能证明认证/余额。 |
| mirror-echo-guard-loses-its-only-fail-closed-preflight | 接受。替换为运行中自身作者过滤探测，并修 Claude guard 的 unknown/reconnect 行为；缺能力零 reserve。独立 fork PR、受管部署回执是显式依赖，Lead aa87aab0 已确认；见 self-filter-contract.md。 |
| missing-view-channel-surfaces-as-http-403-not-permission-reason | 纳入修订：按读取阶段映射 channel403，未知权限为 null；保留 HTTP/stage，新增 fixture。 |
| cross-project-room-invariant-in-global-validator | 纳入修订：ProjectConfig 只管局部 shape；跨项目同房在 start 503 voice_room_conflict，不阻断普通 Lead。 |
| shared-lead-bot-token-second-gateway-session-unanalyzed | 纳入设计假设/测试/运行观察：Gateway quota共享、无第二文字入口、重连/重复事件去重、首场 carrier 健康；未执行的生产共存不声称验证。 |
| hold-policy-means-no-drift-check-and-no-self-heal | 纳入手册：hold 无漂移检查/bootout自愈，Engineering Lead 每次激活/部署后及既有巡检检查。保留 hold，不新增自动安装。 |
| voice-host-json-adds-a-failure-mode-for-zero-behavior-change | 保留但说明：issue 明确要求物化该主机交接对象；等价默认且新增 mode 风险，载入前校验0600。非新功能收益。 |

五项 advisory 均已明确处置；真实首场共存/声音/RG、生产运行过滤收据仍是实现后验收，不在设计阶段补造证据。

## R2 有效通过与 Follow-ups
R2 gate `5ebee204-02f9-47e9-9c64-af1c92e1e9d1` / request `f609c547-10e0-4bd8-868c-62a4d41c934f`：effective reviewVerdict=APPROVED，reviewerVerdict=APPROVED。完整结构化结果见 design-review-r2.json。以下均为非阻断，报告 Lead 决定后续，不重开设计。

- **MEDIUM self-filter-socket-stale-bind-has-no-recovery** — Claude 侧新 probe socket 的非抢占 + 不清 stale 规则会让单个 Lead 静默永久 503，且 runbook 没有检测/清理步骤。处置：Follow-up，交 Lead 判断；本设计不声称此项已实现或验证。
- **MEDIUM fork-dependency-blast-radius-and-sequencing** — 跨仓 fork 依赖的影响面没有量化：14/17 个 Lead（含首场目标）在补丁落地并受管载入前都开不了会。处置：Follow-up，交 Lead 判断；本设计不声称此项已实现或验证。
- **LOW self-filter-probe-not-bound-to-receiving-carrier-incarnation** — probe 只证明「socket 背后某个进程」有 guard，没有把 runtimeId 绑到真正接收 messageCreate 的那个 carrier 实例。处置：Follow-up，交 Lead 判断；本设计不声称此项已实现或验证。

已有交付边界继续有效：fork PR 未合入/载入则 Claude Lead 记“未执行：缺 self-filter 载体”；首场目标仍 Engineering Lead，不临时换其他 bot 掩盖依赖。R2 对载体数量的观察是审阅时快照，实施前重新从 registry 冻结目标清单。
