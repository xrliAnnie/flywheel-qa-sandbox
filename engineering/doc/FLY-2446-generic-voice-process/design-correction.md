# FLY-2446 通用 voice 进程 — 设计修正
Issue: FLY-2446 (https://linear.app/geoforge3d/issue/FLY-2446/语音-通用-voice-进程会议模式所有-lead-可挂rg随身模式先-raya-用独立-codex-realtime-进程语音文字经)
日期: 2026-09-09
基于: plan.md

## FLY-2445 实际接口校正

2026-09-09，Lead 对问题 `ec23cc03-5113-4167-84fe-cb689763275b` 裁定：FLY-2446
拥有配对的 Raya nested PR。仅在 Flywheel 导出无人调用的 port 不构成可用能力。

该 nested PR 必须等 Flywheel PR #1134 与 Raya PR #61 合入后创建，范围只有：

1. 用 Bridge-backed port 替换 Raya `CoSPorts` 中 `createUnavailablePorts()` 的
   `voiceIntent` 注入；其他 port 保持原样。
2. 在 Raya 边界把 Flywheel 的详细失败原因映射为
   `voice_transport_not_available`；详细原因只留在 Flywheel 日志或 HTTP 返回体。
3. 增加 Raya 侧的精确接口测试。

不得修改 Raya persona、其他 CoS 业务或已钉住的 `plan.md`。Flywheel PR 正文必须引用
Raya PR 号；两个仓库都以 exact-head CI 通过后才可进入 `needs_review`。

## 跨仓模块加载配置

2026-09-09，Lead 对问题 `d8d8d72b-d896-4f9c-a8e5-99358e835bbf` 裁定：

- Raya loader 仅读取 `RAYA_FLYWHEEL_VOICE_INTENT_MODULE`，值为构建后的
  `flywheel-teamlead/cos-ports/voice-intent` 入口的绝对文件路径。
- 不猜测 `FLYWHEEL_HOME`，不扫描目录或推断安装根。变量未设时内部原因为
  `flywheel_not_configured`；模块加载失败时内部原因为
  `flywheel_module_load_failed`。Raya 公开边界仍统一映射为
  `voice_transport_not_available`。
- 只注入 `voiceIntent`。nested 分支必须以 Raya #61 合入后的 main 为基底。
- `raya.env` 中该变量属于部署配置。ship report 必须列为合入后的必要步骤，
  本实现与 QA 不编辑生产 `~/.flywheel/raya/raya.env`。

## 排队转写的归属

2026-09-09，Lead 对问题 `c4ba872b-6b0d-4b9c-8029-f39284d89ae7` 批准：
唯一尚未消费的说话时段保留到最终转写到达，不按时间过期。废止旧 Raya 的五秒
归属窗口，因为排队 TTS 可以让单说话人转写延迟超过五秒；plan 的排队不丢话
要求优先。保留说话时段歧义拒绝与匿名脱敏证据，混合或无法确认的归属不进
mailbox；不扩展其他归属机制。

## 配对门禁与批 G 归属

2026-09-09，Lead 对 `2cca6076-8c15-49b2-8bd3-f69db3c02502` 裁定：Raya
没有 CI lane，不在本单新增 workflow。Raya 以精确提交上的 lint、typecheck、build、
156 项单 fork 测试及真实构建跨仓 module smoke 的命令、exit code 和日志替代 CI；
PR 正文与报告均附证据。Flywheel 仍须 exact-head CI 14/14。远端已有历史，禁止
force push，以普通 merge 合入 main 后普通 push。

Lead 对 `c7213d53-ed55-4292-85a2-94882764b750` 裁定：实现阶段交付批 G 驱动，
QA 阶段拥有真房执行。驱动必须依现有 `doc/qa/framework/529-room-playbook.md`、
`test-deploy.sh` slot Lead 和 qa-fly-1182 测试 bot 契约，不增加基础设施或 bot；
包含 hermetic dry-run 与测试，说明 slot dir、两个 Lead id、recorder token env 输入。
真房执行当前依赖未合入的 FLY-2455 slot Lead bootstrap；若 QA 时仍未就绪，
报告限制段第一项明确列出，不能将批 G 算作 PASS。
