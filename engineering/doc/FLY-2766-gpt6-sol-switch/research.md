# FLY-2766 Codex 升级前置兼容 — 调研
Issue: FLY-2766 (https://linear.app/geoforge3d/issue/FLY-2766/模型跟随最新-codex-模型别名化工作流模板-implement-节点与-cli-默认模型不再写死版本号gpt-56-sol-gpt-6)
日期: 2026-09-22
基于: exploration.md

## 1. 真实故障链

Bridge 日志记录本执行体的 founder window 三次出现 “tmux reported success 后 pane 立即消失”。
日志保留的实际命令为：

```text
codex resume --remote "unix://…sock" -C "…/flywheel-FLY-2766" \
  -s workspace-write -c 'approval_policy="never"' <thread-id>
```

Lead 在 0.156.0 真机拿到明确错误：

```text
Error: Permission overrides are not supported when resuming a remote task.
```

这不是 socket、thread identity 或 tmux admission 失败。tmux 成功建立 window，Codex client
解析到 remote task 后主动拒绝权限覆盖并退出；现有 liveness probe 随后正确判定 `window_died`。

## 2. 权限的单一权威

`packages/claude-runner/src/CodexTmuxAdapter.ts` 构造 daemon runtime 时已传入：

```text
sandbox = workspace-write
approvalPolicy = never
sandboxWritableRoots = <execution roots>
networkAccess = true
```

`packages/claude-runner/src/codex-runner-tui-window.ts` 的
`buildRunnerTuiCommand()` 随后又把 sandbox / approval 放进 remote client argv。新 CLI 取消了这种
双重权威：remote thread 的权限来自 app-server，attach client 只能选择 socket、thread 与非权限
会话参数。

最小修复是删除 `-s workspace-write` 和 `-c approval_policy=never`。`-C` 只指定工作目录，
0.156.0 的错误也没有把它列为 permission override，因此保留它可避免不相关的 pane cwd 行为变化。
环境清洗、`CODEX_HOME`、execution/state coordinates、exact socket 与 thread id 全部不变。

仓库里已有直接先例：`packages/teamlead/src/lead-backends/codex/tui-window.ts` 在 Codex 0.154
兼容修复后构造的命令正是 `resume --remote <socket> -C <cwd> <thread>`，并解释 remote thread
继承 app-server 权限。runner helper 应与这个已上线形状一致。

## 3. 测试 seam

公开行为 seam 已存在：

- `buildRunnerTuiCommand(spec)`：纯函数，适合精确断言 remote argv；
- `ensureRunnerTuiWindow(spec, deps)`：通过注入的 tmux executor 观察 `new-window` argv；
- `CodexTmuxAdapter` runtime factory test：已经断言 daemon 收到 workspace-write、never、roots、network。

TDD 应先把当前“命令必须含权限 override”的测试改成相反合同并见红，再删除两段 argv。适配器
daemon 权限测试必须保留，以证明修复不是把权限保护一起删掉。无需 mock Codex 内部实现；真机
0.153.2 / 0.156.0 窗口存活属于 QA 的跨进程 acceptance。

## 4. Native skill baseline 是独立升级门

capability-bundle-v2 的 `startDefaultLeadCapabilityParent()` 会运行实际 `codex --version`，随后
`preparePinnedNativeSkillHome()` 用 `PINNED_NATIVE_CODEX_SKILLS` 校验版本、六个 `SKILL.md`
digest 与完整 origin 文件清单。当前 singular baseline 只接受 0.153.2；版本不符会抛
`baseline_drift`，最终拒绝 Lead 启动。

当前主机有三种必须显式表达的受信状态：

| 版本 | home / 用途 | native tree |
| --- | --- | --- |
| 0.153.2 | `~/.codex-259-qa` 当前 runner binary；companion homes 当前 tree | 旧树，marker `91663ef126b94ab1` |
| 0.154.0 | `~/.codex-{raya,mufasa,infra-bot}` 当前 symlink/tree | 新树，marker `8bcfb84cfbe4722a` |
| 0.156.0 | `~/.codex-259-qa` 已保留 release；隔离空 home 实际生成 | 与 0.154.0 新树逐字相同 |

单纯把 singular pin 改为 0.156.0 会在“代码先部署、binary 后切换”的窗口拒绝仍运行旧 binary 的
任一冷启动，也会破坏 rollback。安全形状是 version-keyed exact baselines：每个受信版本都绑定
一棵完整 origin tree 与六个 source digest，manifest 记录本次实际选中的 baseline；未知版本和
交叉配树均拒绝。0.156.0 是 exported target，旧版本不是自动跟随机制，只是明确审计的过渡项。

active/companion home 的 `skills/.system` 会随 CLI 启动刷新，不能作为长期 origin。三个固定
origins 分别设为 `$(cd ~/.codex-259-qa/packages && pwd -P)/native-skill-baselines/<version>/skills/.system`：
当前主机的 realpath 是 `/Users/xiaorongli/.codex-242/packages/native-skill-baselines/...`，不能把
含软链的 `.codex-259-qa/packages` 逻辑路径当作最终 identity。0.153.2 从当前旧树、0.154.0 从
任一三载体一致新树、0.156.0 从空的隔离 CODEX_HOME 启动 0.156.0 后生成；逐个复制并用
committed 完整清单复核。受信配置入口先 canonicalize，再执行完整树验证；后续切 binary/config
或 rollback 都不覆盖这些 snapshots。

现有 `scripts/qa-fly-2519-native-skills-canary.mjs` 固定读取 `~/.local/bin/codex` 与单一 baseline，
不足以验证四个 standalone home，也不能验证没有 binary/config 的 immutable origin。需要两个
no-argument、read-only 入口：home canary 从受信 Codex home 的 `current/codex` 取得版本并验证其
`skills/.system`；origin canary 从 caller-supplied exact version 解析 committed origin root，再要求
输入 path 与该 root 逐字相同。两者都不启动模型、不读凭据、不修改文件。

## 5. 模型 registry 的安全前置

`packages/config/src/model-builtins.ts` 当前只有：

- `CODEX_STANDARD = gpt-5.6-sol`，持有 `codex` alias；
- `CODEX_ASTRA = gpt-6-astra`，持有 `astra` alias。

正式 workflow publication 会通过 model snapshot 验证精确 model id。要让部署后的模板 revision
可写 `gpt-6-sol`，本 PR 需要新增一个 exact registry entry，开放 runner/workflow 所需 effort；但
`CODEX_STANDARD` 与 `codex` alias 仍必须指向 5.6，直到 CLI 已升级。这样“能验证新 id”和“当前
默认选择新 id”被明确分离，0.153.2 期间不会意外派出 GPT-6 Sol runner。

新 entry 的形状锁为：`surfaces=[runner, workflow]`，无 alias，runner 只允许 `xhigh`，workflow
允许标准 role efforts，不开放 lead/cron/dispatch。`codex` 仍指 5.6，Astra entry/alias 不改，
不存在的模型仍 fail-closed。

`buildModelCatalog()` 会在代码部署后立即列出该 exact id，management writer 又依据
`isModelSelectionSupported()` 接受 workflow 修改；因此 binary 切换前存在一个真实暴露窗口。
本轮不引入新的 activation 状态机，而是在同一受控 cutover 内冻结 model/template 编辑并要求
四个 home 回读 0.156.0 后才发布 revision。这个风险与约束必须出现在 runbook/PR，而不能隐含。

`modelDisplayName()` 对所有非 5.6 GPT 目前只返回 `GPT`，会把 Sol 与 Astra 的 phase label 混在
一起。本轮为 exact `gpt-6-sol` 增加 `GPT-6 Sol` 显示分支；tmux 短码仍保持既有 `G`。

## 6. 正式模板 revision 面

现有 Bridge 已提供 snapshot → stage → apply 的治理写入面，以及 template-specific
`/api/workflow/templates/:id/publish/stage|apply`。它们最终以 CAS transaction 写 immutable revision、
publication pointer、audit 与 receipt；无需直接写 SQLite，也不修改已物化 run snapshot。

本轮 post-deploy 切换只需对当前 active founder-owned 的 `tpl_code` 与 `tpl_simple_code` 发布新
revision，把 `implement.model` 改成精确 `gpt-6-sol`，同时保持 vendor、effort 和其他节点不变。
`tpl_eng_heavy` 已 retired/unbound、近 30 天无运行，按 Lead 裁定保留历史，不扩展 API。

“已在飞 snapshot 不改”只描述 snapshot bytes。`resolveNodeDispatchAtLaunch()` 对没有
`dispatchPinned` 的节点会重读 template current revision 并返回 `source=live_template`；因此切模板
会影响开放 run 后续尚未 launch 的 implement 节点。模板 publication 绝不能早于所有相关 CLI
home 的 0.156.0 回读，rollback 发布旧 model 也正是借这条 live lookup 生效。

## 7. 升级安装形状

本机 Codex 不是 `codex update` 管理的安装。runner 共享安装位于 `~/.codex-259-qa`；三个
Codex Lead 各自从 `~/.codex-raya`、`~/.codex-mufasa`、`~/.codex-infra-bot` 下的
`packages/standalone/current/codex` 启动。升级必须由 Lead 在兼容修复随班车部署后，为四个 home
分别准备 versioned release、native tree 与可回滚 symlink，再逐项验证；implement 节点不操作
这些外部状态。

安全顺序是：

1. merge/deploy remote-TUI compatibility + versioned native baselines；
2. 从空隔离 home 生成并冻结 0.156.0 versioned native snapshot，按 committed digest 复核；
3. QA 隔离环境验证 0.153.2/0.156.0 runner TUI 与 0.156.0 Lead cold start，生产 Lead 不重启；
4. 冻结 model/template 编辑，为四个 home 安装 0.156.0 release + 新 native tree，再切 symlink 并回读；
5. 用 0.156.0 分别 smoke `resume --remote` 与 design/code review companion `codex exec` lane；
6. 修改各 CLI / phase Codex home 默认到 `gpt-6-sol`，Raya model 保持 Astra；
7. 通过正式 revision API 更新两个 active template；
8. 派一张全新 Codex 实现单，核 pane 首屏、窗口存活与 dispatch resolution；
9. grep 最新 active revisions 中 implement 的 `gpt-5.6-sol` 为 0。

任何一步失败都停在当步，不把后续选择面提前打开。

## 8. 受影响包与直接消费者

- `flywheel-claude-runner`：remote TUI argv 兼容；直接测试为
  `codex-runner-tui-window.test.ts` 与已有 `CodexTmuxAdapter.test.ts` daemon-policy 覆盖。
- `flywheel-config`：新增 exact `gpt-6-sol` entry，但不移动 current default/alias；直接测试为
  `model-registry.test.ts` 与 model display / phase label 的公开行为断言。
- `flywheel-teamlead`：version-keyed native baselines、实际 baseline manifest 与 read-only canary；
  直接测试为 native skill/home/runtime-factory/canary contracts。

不修改 workflow seed 或 migration；post-deploy publication 复用现有正式治理面。
