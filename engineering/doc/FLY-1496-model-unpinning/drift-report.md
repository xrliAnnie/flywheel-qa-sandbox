# FLY-1496 模型解钉根治 — 漂移调查

Issue: FLY-1496
日期: 2026-07-27
基于: research.md

## 修订 — founder 2026-07-27:禁 4.8 机制已整块移除

下文 S1–S7 的**漂移来源分析与根治手段依然成立**,唯一失效的是其中把"ban"当作
处理手段的那部分表述:`banned` 名单、派发 400 `MODEL_BANNED`、Lead boot ban 替换、
sweep 残留门均已删除。

对每个源的实际结论因此变成:**根治靠的是权威源实时解析本身**,不靠第二层黑名单。
S2 的 SDK fallback 链、S3 的最终 spawn 缝、S5 的 cron writer 仍然逐项做
canonical 化(裸别名不得到达 CLI),只是不再附带"是否在禁用名单里"的判断。
S4 已发布 workflow revision 里的历史 4.8 pin **不再 fail-closed**,而是保持可解析
可执行 —— 那是旧 pin 向后兼容,`main` 本来就是这个行为。

## 结论

事故夜的主要“mid-session 漂移”不是 Claude 在同一进程里偷偷降级，而是 Lead 被 KeepAlive/统一重启重新拉起后，陈旧 manifest 以最高优先级把 Annie 手动拨回的 Fable 再压回 Opus 4.8。日志在 2026-07-26 20:43–23:57 共记录 7 次：

```text
model drift: env=claude-fable-5 manifest=claude-opus-4-8[1m] → using manifest
```

现实现把 manifest 从输入翻成只写证据：每次物理 launch 都重新读取 `projects.json`，在同一份模型配置快照上 canonicalize、校验 ban，再生成显式 `--model`；旧 manifest 和冻结的 launchd env 都不能参与选择。

同时确认 Claude Code 2.1.220 有 `--fallback-model`：默认模型 overloaded/unavailable 时自动尝试逗号分隔链。生产 Lead/Tmux 启动链未传该参数；EdgeWorker/Agent SDK 遗留链会传 `fallbackModel`，现已对主模型和 fallback 链每一项做同快照 canonicalize + ban 校验，4.8 会在调用 SDK 前以 `MODEL_BANNED` 拒绝。

## 漂移源清单

| 源 | 证据 | 处理 | 验证 |
|---|---|---|---|
| S1 陈旧 Lead manifest × 重启 | 事故夜 7 条 `using manifest`，均由 Fable 被 4.8 覆盖 | manifest 只写不读；`_launch_claude` 每次从 `projects.json` 实时派生 raw/resolved model 与 effort | `fly241-lead-model-override.test.sh` 证明旧 manifest/env 不能胜出、权威缺席清空旧值、日志不再含 `using manifest` |
| S2 EdgeWorker/Agent SDK fallback | `RunnerSelectionService` 产生 fallback，`ClaudeRunner` 传入 SDK；当前 Bridge 生产没有 `new EdgeWorker` 实例化点 | 虽当前生产不可达，仍把默认主模型改为 Fable、默认 fallback 改为 Opus 5；Sonnet/Haiku 仅保留显式别名识别，不再由 heuristic 生成；最终 SDK 缝对主模型及逗号分隔 fallback 全链执行 canonical/ban 守卫 | 四种 Claude 别名选择都得到 Opus 5 fallback；注入 `sonnet,claude-opus-4-8` 在 SDK query 前返回 `MODEL_BANNED` |
| S3 Claude CLI fallback、账号默认与手动 `/model` | CLI 2.1.220 帮助明确 overloaded/unavailable fallback；主 `~/.claude/settings.json` 为 `claude-fable-5[1m]`；账号池切换的是 credential identity，共用主 settings；5 个池目录中只有 personal 有 `settings.json` 且 model 未设置 | 所有 Flywheel Claude launch 显式传 allowed canonical `--model`；主生产 Tmux/Lead 不启用 `--fallback-model`；SDK 遗留 fallback 全链守卫；`FLYWHEEL_RUNNER_DEFAULT_MODEL=off` 在 ban 生效时被关闭 | Tmux、Lead、review、classifier、SDK 各最终缝测试；账号/设置只读审计 |
| S4 workflow 模板 pin | 已发布 revision 是不可变载体，旧模板可保存历史 model | 新写/严格解析走实时 registry+ban；未知 retired model 仍可展示修复，但 banned 4.8 连 repair parser 也不能绕过；本批不重写模板引擎的 pin 设计 | workflow/management writer 定向测试；sweep 扫当前 published revision，残留非零且要求 republish |
| S5 cron plist `--model` | cron argv 会跨配置代际落盘 | cron source/writer 热读同一快照；新增 sweep 解析直接 plist carrier，对 raw id 和“解析后被禁”的 alias 都检测，`--fix` 原子替换 | sweep fixture 同时覆盖 projects、manifest、alias plist、published workflow |
| S6 三段式 phase table | 旧 phase 值散在常量/tier 推导，改 tier 会意外改变 QA | generic tiers 最终为 heavy=Fable、其余=Opus 5；独立 phases 表 design=Fable / implement=Codex / QA=Opus 5；两者同一快照热读且受 ban | phase config 原子热替换、完整 vendor/model 决策与 label-bypass 测试 |
| S7 alias/raw id 到 CLI | 旧 manifest 可把裸 `fable`/`sonnet` 直接 append 给 CLI | 配置化 binding/model registry 热读；最终 Claude spawn 缝只接受 canonical allowed id | 同进程热替换 models.json 与 launcher argv 测试 |

## 边界与豁免

- Claude 交互 TUI 的人工 `/model` 是用户显式控制，CLI 未提供 Flywheel 可挂接的 slash-command allowlist。Flywheel 不伪装能拦截这项外部动作；下一次 launch 会重新按 `projects.json` + policy 收敛。自动 fallback 则已在所有 Flywheel 启用它的代码路径上守卫。
- 历史 token/价格记录和历史测试文本仍需识别 `claude-opus-4-8`，它们是只读兼容，不是可选模型或 launch 目标。
- 已发布 workflow revision 不原地改写。sweep 对此 fail-closed，要求通过 writer 发布新 revision，保留审计链。
- 真机服务重启必须走 founder 批准后的 self-hosting ship 工作流；实现阶段不绕过该边界直接重启生产。当前分支的真实 launcher 行为由隔离 HOME 的 shell E2E 验证，合并部署后再以真实重启日志确认。

## 机器校验与当前证据

1. 配置热生效：同一 Node 进程原子替换同大小 `models.json` 后，下一次 decision 读到新 inode/revision；Lead shell E2E 把 `bindings.opus` 改到 Fable，下一次 launch argv 无需改码即变为 `claude-fable-5`。
2. manifest 根治：注入 manifest=`claude-opus-4-8[1m]`、env=`claude-opus-4-8`，projects=`opus` 时，真实 launcher dry-run argv 为 `claude-opus-5`；manifest 写回 `{model:"opus", resolvedModel:"claude-opus-5"}`，输出无 `using manifest`。
3. 权威缺席：删掉 projects model 后，即使 manifest/env 仍是旧值，argv 也显式回到 `claude-fable-5`，旧 raw model/effort 从 manifest 删除。
4. ban 与限额路径：派发输入 4.8 返回 HTTP 400 `MODEL_BANNED`；Lead boot 输入 4.8 响亮替换 Fable；SDK fallback 链含 4.8 时在 query 前拒绝；fleet banned apply/rollback preimage 与管理台 account-default 同样 fail-closed。`projects.json` model 缺省不是账号继承，而是明确按 Fable 校验并保持字段缺省。
5. 残留门：2026-07-27 在本机对 `projects.json`、Lead manifests、LaunchAgents cron plist、当前 published workflow revision 运行只读 sweep，结果为 `status=clean, found=0, remaining=0, errors=0`。改 `banned` 后的运维合同是重跑 sweep，直至 exit 0。

## 重启触发器归类

事故日志同时包含 fleet 统一重启波次与 launchd KeepAlive crash-loop。账号 quota 切换代码只替换 credential identity，未找到直接 bootout/bootstrap Lead 的路径。触发器本身不再影响模型正确性：无论人工重启、部署重启还是 crash-loop，都会重新读取同一个 `projects.json` 权威源和当代模型配置。
