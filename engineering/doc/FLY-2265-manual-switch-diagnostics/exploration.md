# FLY-2265 切号器 apply 失败 — 探索
Issue: FLY-2265 (https://linear.app/geoforge3d/issue/FLY-2265/切号器-flywheel-claude-profile-use-name-在凭证两侧健康时仍-flywheel-manual-switch)
日期: 2026-09-02
基于: 无

## 问题边界

Founder 明确要求保留手动切号功能，但本单不得切换任何生产账号。交付必须同时满足：

1. `apply_failed` 在 stderr 或审计 details 中带可行动的底层原因；
2. 已进入 executor 的 terminal apply 失败追加一条 `phase=entry`、`exitCode=1`、`details.reason` 非空的 fallback 审计记录；候选为空、usage 错误和 runtime preflight 保持现有语义；
3. 修复真实根因，而不是只扩充日志；
4. 隔离环境中的健康账号切换成功并触发通知；
5. 隔离环境中的 apply 失败保持账号账本与凭证不变，并留下诊断审计。

## 已确认事实

- 生产观测中，pool 的 `personal1` 与 Keychain 的 `business` 都通过身份锚验证；失败前后账本仍为 `business`，不存在半写。
- FLY-2240 部署前五次 `use` 均成功；部署后第一次 `use personal1` 返回 `FLYWHEEL_MANUAL_SWITCH_FAILED reason=apply_failed`，且审计中没有本次 entry。
- 对 `155e1e78a^` 与部署版分别执行只读 `verify personal1 --source pool`、`verify business --source keychain`，四次都返回 `verdict=match`、rc=0。凭证读路径不是版本差异。
- FLY-2240 新增了手动入口：外层 `flywheel-claude-profile use` trampoline 到 `flywheel-claude-switch`，后者再由 `switch-executor` detached spawn `flywheel-claude-profile use` 做 apply。
- 当前交互 shell 中 `FLYWHEEL_CLAUDE_PROFILE_BIN` 未设置，`flywheel-claude-profile` 也不在 `PATH`。外层脚本知道自己的绝对路径，却没有把它传给新的 Node runtime。
- `account-switch-cli` 的生产依赖在 env 缺失时回退到裸命令 `flywheel-claude-profile`；detached spawn 因此可在 Bash 子进程启动前以 `ENOENT` 失败。这同时解释 `apply_failed` 与“没有 entry 审计”。
- 现有 public-use 集成测试显式设置 `FLYWHEEL_CLAUDE_PROFILE_BIN=PROFILE_BIN`，屏蔽了真实调用者的缺省环境。

## 假设

根因是假设“手动调用者会预设 `FLYWHEEL_CLAUDE_PROFILE_BIN` 或把命令放在 PATH”被 FLY-2240 引入，但 founder 使用的完整路径调用不满足该假设。若隔离 public-use 测试删除该 env 后稳定得到 spawn 失败，而外层脚本传递自身路径后同一测试转绿，则根因成立。

## 方案比较

### A. 外层 profile 脚本传递自身绝对路径（推荐）

在 trampoline 执行 switch launcher 前，把当前 `BASH_SOURCE[0]` 规范化为绝对可执行路径并导出为 `FLYWHEEL_CLAUDE_PROFILE_BIN`。入口知道“应该回调哪一个 apply primitive”，不会把 repo 布局知识泄漏到 Node runtime，也避免旧/新字节混用。

### B. switch launcher 从相对目录推导 profile 路径

`packages/teamlead/bin/flywheel-claude-switch` 可回溯到 `packages/claude-runner/bin`。但这让 teamlead launcher 依赖 monorepo 相对布局；单包安装、软链接或未来目录调整更脆弱。

### C. Node runtime 从 `import.meta.url` 推导 profile 路径

可让 default 更“聪明”，但同样绑定 dist 与源码布局，并掩盖混合部署。环境明确覆盖仍有用途，真正的调用入口更适合声明所用 primitive。

选择 A，并在 Node 层补全失败诊断与审计，因为 spawn 级失败时 Bash 根本没有机会执行 `begin_audit`。

## 非目标

- 不改变候选账号排序、cooldown、quota、freshness 或 identity 策略。
- 不修改 Keychain ACL，不重启 Bridge/Lead/launchd 服务。
- 不运行任何真实 `use`/`next`，不部署或合并。
- 不重构成功审计；成功仍由 Bash primitive 记录。
