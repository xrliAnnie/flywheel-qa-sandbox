# FLY-2570 动态设计分流 — 调研
Issue: FLY-2570 (https://linear.app/geoforge3d/issue/FLY-2570)
日期: 2026-09-14
基于: exploration.md

## 本地调用链

- packages/config/src/model-config.ts: getModelConfigSnapshot 在业务决策调用时按 dev/ino/mtime/size 重读文件，默认 ~/.flywheel/models.json，可由 FLYWHEEL_MODELS_CONFIG 覆盖。原子 replace 会改变 inode。
- packages/config/src/agent-registry.ts: RegistryModelSplitPolicy 和严格 parser 定义 v1；新纯策略模块应供 registry/runtime/CLI 共用，避免验证漂移。
- packages/teamlead/src/workflow-menu.ts: resolveMenuOverrides 捕获 snapshot，计算 assignment，显式 override 不符拒绝，写入 basis。
- packages/teamlead/src/workflow-template-selection.ts: 固定 automatic assignment 和 dispatchPinned。保持该既有语义。
- packages/teamlead/src/workflow-dispatch-resolution.ts: 从 design_model_arm_assigned 事件恢复收据，检查唯一性与 pinned model；现有规则枚举需要扩展。
- scripts/fly2403-design-model-comparison.sql: immutable execution runtime 为模型归属依据，四口径分别计算样本数；新增基于持久事件 basis.ruleVersion 的可选筛选，不能按当前配置重算旧 arm。

## 设计选择

新策略 rule=issue_number_percentage，codexPercent 有限 0..100，enabled=true，arm A/astra、B/fable。固定算法 sha256('fly2570-v1:' + issueNumber) 前 13 hex / 2**52，乘 100；bucket < codexPercent 选 A。端点 0/100 精确覆盖。算法不依赖配置版本，因此调高比例只会增加 Codex 集合。

版本由规范化语义配置的 SHA256 生成 fly2570-v1:<full digest>，包括 rule、percent 与 arm/model。parser 在解析时派生版本，writer 不要求用户维护摘要；percentage 输入里旧 version 字段不作为校验门禁，手改比例自动得到新版本。收据回放使用冻结的 fly2570-v1 算法核验历史版本。basis 保存 ruleVersion、issueNumber、bucket、codexPercent、arm model 映射，旧 parity 结构仍可读。

操作入口 scripts/design-model-split.mjs：show、set --codex-percent <number>，默认/环境配置路径与运行时一致；--config 用于显式测试路径。show 输出 sourcePath、ruleVersion、百分比、下一新派单生效说明。set 与现有 fable-model-sync.ts 使用同一 authorityPath + .lock 独占锁，复用 withMkdirLock 的 PID/start-time/唯一 marker 恢复。Fable 凭据读取和 API 探测不占锁；探测后取锁、重读最新 authority、据此算更新，再写入/验证/必要回滚，避免回写旧比例。死 PID 自动恢复，活着但不可检查的持有者不被驱逐；空目录遗留按现有 120 秒规则恢复。竞争时明确 busy/重试。严格读取原 JSON，保留其他字段，验证完整候选配置，写同目录临时文件再 rename；失败不改目标。拒绝 symlink、异常 JSON、未知策略字段、非法 ratio；lock 已存在返回 busy，不自动偷锁。首次无文件可创建 version:1；创建及替换均为当前 uid、精确 0600，匹配 Fable sync authorityIsSafe。使用 Node 原子文件机制，不访问生产 DB。

新 policy 启用后的 rollback 是 set 旧百分比；内容版本恢复为同一策略版本。已有 v1 文件继续解析，缺失 runtime override 时继续 registry v1；损坏文件必须拒派，不能当作缺失。

## 验证限制

本单不执行 production set、不部署或重启。通过同一进程内临时文件原子替换证明下一新解析热生效，通过真实 StateStore fixture 证明历史派单回放；生产激活由独立授权流程完成。
