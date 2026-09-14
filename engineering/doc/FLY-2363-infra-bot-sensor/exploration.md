# FLY-2363 InfraBot 传感器 — 探索
Issue: FLY-2363 (https://linear.app/geoforge3d/issue/FLY-2363)
日期: 2026-09-13
基于: 无

## 当前结论

生产配置缺项已复核。Lead 在问题 gate 86eefe5a-71a4-4620-9773-3311f4af79bf 裁定为无意漏配：没有留空决策记录，FLY-2239 只延期演练，不等于决定不配置。本轮不修改生产；Lead 指定在 FLY-2530 修复出生自锁后，另取 founder 当次授权启用并演练。

当前只读采样见 `host-observation.txt`，只提取目标变量、job 状态及相关错误，不保存完整环境或秘密。

- `~/.flywheel/.env` 与 `com.flywheel.bridge.plist` 未配置 `FLYWHEEL_CODEX_INFRA_BOT_JOB`。
- Bridge 的 `launchctl print gui/501/com.flywheel.bridge` 可读且显示运行；进程 `ps -E` 被沙箱 EPERM 拒绝，进程实际变量仍须 host 执行人补证。`launchctl list` 无匹配不能代表 host job 不存在。
- 精确候选 label 为 `com.flywheel.lead.flywheel-codex-infra-bot-lead`，plist 指向已安装的 Codex InfraBot wrapper，`KeepAlive=true`、`ThrottleInterval=30`。
- 候选 job 首次观察 `state = spawn scheduled`、`last exit code = 3`；日志重复 `state=refused reason=lead-job-running` / `codex-home-link-truth failed rc=3`。稍后持久化采样短暂显示 running、runs 已增至 137，但同一日志继续退出码 3；单次 running 不能作为稳定健康基线，也不证明所有 InfraBot 后端进程均已死亡。

## 历史证据边界

- `git log --all -S FLYWHEEL_CODEX_INFRA_BOT_JOB -- packages scripts` 返回 FLY-1082 引入及 QA、FLY-1455 注册变更。引入提交 `c01bf582a` 的注释明确 unset 跳过探测、等待 FLY-1071 武装；这是代码默认策略，不能证明今天有意禁用。
- 当前工程/产品文档目标变量检索仅找到 FLY-2239 exploration §1.3 和 research §7：生产没有武装，是否有意归 Lead。未找到已批准的留空理由。
- FLY-2239 `cutover-status.md` 明确演练延期、旧授权不得复用。其旧 founder 消息不构成本次强停权限。
- 本次未读取或复制生产数据库；未审计全部历史外部通信，因此历史结论仅限上述检索。

## Lead 裁定与当前交付

已消费上述 gate 答复：无意漏配；当前自锁由 FLY-2530 修复，不扩入本单。交付配置文档及 deployment env template 注释、拒绝 crash-loop 启用的 preflight guard、RED→GREEN 方案，然后 PR 与 needs_review。生产配置、plist 和重启零触碰；生产启用及演练由 Lead 后续执行，作为 issue 收官步骤。
