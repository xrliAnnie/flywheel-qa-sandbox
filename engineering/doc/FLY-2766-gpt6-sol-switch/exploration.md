# FLY-2766 Codex 升级前置兼容 — 探索
Issue: FLY-2766 (https://linear.app/geoforge3d/issue/FLY-2766/模型跟随最新-codex-模型别名化工作流模板-implement-节点与-cli-默认模型不再写死版本号gpt-56-sol-gpt-6)
日期: 2026-09-22
基于: 无

## 最新范围

Lead 2026-09-23 00:2xZ 更正覆盖此前“CLI 已升级、默认已切换”的描述。实测 Codex 0.156.0
会拒绝当前 founder TUI 命令：

```text
codex resume --remote unix://… -s workspace-write -c approval_policy=never …
Error: Permission overrides are not supported when resuming a remote task.
```

因此 Lead 已把本机 standalone `current` 回滚到 0.153.2，并把 CLI 默认模型改回
`gpt-5.6-sol`。0.153.2 不识别 `gpt-6-sol`，所以本轮必须严格按以下顺序交付：

1. 修复 Codex founder TUI remote-resume 命令，使 0.153.2 与 0.156.0 都能存活；
2. 把 native skill admission 重新钉到经过完整 digest 审计的 0.154.0/0.156.0 树，同时保留
   rollback 需要的 0.153.2 精确基线；
3. 在 PR 中给出四个 standalone home、native skill、验证和回滚顺序；
4. 只有部署兼容修复并把 CLI 升到 0.156.0 后，才把 CLI 默认和 active workflow
   template 的 implement 节点切到 `gpt-6-sol`。

## 故障边界

`CodexTmuxAdapter` 启动 app-server 时已经设置：

- `sandbox: "workspace-write"`；
- `approvalPolicy: "never"`；
- writable roots 与 network access。

但 `buildRunnerTuiCommand()` 又给 `resume --remote` 重复传 `-s workspace-write` 与
`-c 'approval_policy="never"'`。0.156.0 把 remote task 的权限视为 server-owned，并对这些
client-side override fail-closed；tmux fork 成功后 pane 立即退出，runner 本身继续执行，但 founder
失去可见 TUI。

`-C <cwd>` 不是权限覆盖，并维持现有 pane / TUI 工作目录语义；本轮保留。最小兼容修复只删除
`-s` 与 approval config override，不搬迁或重设 daemon 权限。

这与已经上线的 Lead TUI 路径相同：`packages/teamlead/src/lead-backends/codex/tui-window.ts`
明确记录 Codex 0.154 remote task 拒绝 client-side permission override，并只传 socket、`-C` 与
thread id。因此本轮是把 runner TUI 收敛到已有兼容合同，不是新发明命令形状。

## Native skill admission 边界

FLY-2519 的 capability-bundle-v2 会把实际 `codex --version` 和六个 native skill 的完整来源树
与代码内 baseline 比较，任何漂移都 fail-closed。当前代码只钉 `0.153.2`；只切 binary 会让
三个 Codex Lead 在下一次重启时因 `baseline_drift` 起不来。

只读盘点显示：共享 `~/.codex-259-qa` 的 binary `current` 已回滚到 0.153.2，但它的
`skills/.system` 会随当前 CLI 启动而刷新、不能作为 immutable origin；三个生产 Lead home
`~/.codex-raya`、`~/.codex-mufasa`、`~/.codex-infra-bot` 的 `current` 都是 0.154.0；它们的
native tree marker 为 `8bcfb84cfbe4722a`。用空的隔离 CODEX_HOME 启动 0.156.0 后得到的树与
三个 0.154.0 home 逐字相同；它们相对 0.153.2 旧树 marker `91663ef126b94ab1` 有 8 处
`openai-docs` 内容/清单差异。三种版本的来源都必须复制到共享 home 下各自的 versioned immutable
snapshot，再作为完整 origin digest pin 入库。

升级代码使用逐版本精确表：0.153.2 映射旧审计树，0.154.0 与 0.156.0 映射同一新审计树；
0.156.0 是目标基线，旧两条只服务有界部署窗口和 rollback。未知版本、版本/树错配、额外文件
继续 fail-closed，不能改成 semver 范围或从运行时 home 自动学习。

## 模型切换边界

- PR 可以把精确模型 `gpt-6-sol` 加入 registry / allow-set，让部署后的正式模板 revision 能通过验证。
- PR 不把 `codex` 默认别名从 `gpt-5.6-sol` 移走，不改 seed 默认，不改用户级 `config.toml`，
  因而 0.153.2 上的新单仍使用可运行的 5.6。
- registry 部署后、binary 切换前，management catalog 已能看到该 exact id；runbook 明确冻结
  template/model 编辑，直到四个 home 的 0.156.0 + 新 native tree 回读通过。
- post-deploy 切换只覆盖 active 的 `tpl_code` 与 `tpl_simple_code`；retired/unbound 的
  `tpl_eng_heavy` 保持历史原样，也不扩展 retired-template revision API。
- 已在飞 run 的 immutable snapshot 不变；Raya 继续使用 `gpt-6-astra`。
- FLY-2769 的产品线指针 / 自动跟随不在本轮实现。

## 不做

不直接写生产数据库，不修改 standalone `current` 软链，不修改真实 config，不重启 Bridge，
不派 QA，不 merge/deploy，不使用真实凭据做模型调用。真机双版本 TUI 与升级后新派单烟测由
QA/Lead 在相应时点执行；Lead restart smoke 只在 QA 隔离环境做，不重启生产 Lead。

## 完成定义

代码头需要证明：remote TUI 命令不含权限 override、daemon 权限仍保持、`gpt-6-sol` 精确 id
可被 workflow 验证但尚未成为默认。交接文档需要给出不可颠倒的 deploy → CLI upgrade →
CLI default → template revisions → fresh-run smoke 顺序，以及逐层回滚步骤。
