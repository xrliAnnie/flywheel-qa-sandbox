# FLY-3122 Claude TURN 金丝雀 — 调研
Issue: FLY-3122 (https://linear.app/geoforge3d/issue/FLY-3122/529-canary-fly2127-canary-eeb549be-1af1-44c6-93d3-a0cb7f40022c-claude)
日期: 2026-10-01
基于: exploration.md

## 调研问题

动态任务要求追加“requested marker lines”，但 issue description 只给出 owner，没有逐字列出 marker。本调研定位 marker 的生成者、完成判据与安全边界，避免自行发明格式。

## 权威实现证据

FLY-2127 的 canary driver 位于实现工作树的 `scripts/qa-2127-codex-wake-canary.mjs`。`claudeMail()` 对本 case 使用以下确定性规则：

```js
const marker = `${c.owner.marker}-R4-CLAUDE`;
const boot = `${c.owner.marker}-CLAUDE-BOOT`;
```

同一函数随后把 BOOT literal 写进初始执行提示，把 R4 literal 写进 native Lead message，并以 `probeText.split(/\r?\n/).includes(...)` 检查两者为完整行。对应 owner 是 issue title 和 description 中的 `FLY2127-CANARY-eeb549be-1af1-44c6-93d3-a0cb7f40022c`，所以本单精确目标为：

```text
FLY2127-CANARY-eeb549be-1af1-44c6-93d3-a0cb7f40022c-CLAUDE-BOOT
FLY2127-CANARY-eeb549be-1af1-44c6-93d3-a0cb7f40022c-R4-CLAUDE
```

## 当前执行证据

- `flywheel-comm turn` 返回 `yours phase=design epoch=1`，所以共享 worktree 写权限已明确授予当前 execution。
- `flywheel-comm inbox` 返回 `No instructions.`，没有待处理的 Lead mailbox body。
- 当前 branch 是 `project-slot-2-FLY-3122`；开始时与 `origin/main` 同 head，root `probe.txt` 不存在。
- `git log --all -- probe.txt` 没有历史内容，因此“append”在当前快照等价于新建文件并逐行写入，不存在需要保留的旧行。

## 数据与结构模型

本探针不新增 schema。唯一持久化数据是一个纯文本文件：

| 字段 | 来源 | 作用 |
|---|---|---|
| owner prefix | Linear issue / canary owner | 把证据绑定到本次 canary nonce |
| `CLAUDE-BOOT` suffix | canary driver | 标识初始执行落盘 |
| `R4-CLAUDE` suffix | canary driver | 标识 claude transport case 的完成 marker |
| Git commit | 当前 feature branch | 提供不可变、可审计的完成点 |

## 边界与负向守卫

- 只允许修改 `probe.txt` 与本 design node 被明确要求的设计文档/HTML；不修改 packages、scripts 或配置。
- 不把 execution credential、token、mailbox body 或完整环境写入 `probe.txt`。
- 不创建 PR、不请求 ship、不合并、不部署。
- 不运行测试套件。验证使用 exact-line search、diff 和 commit/tree 检查；这既符合 bounded canary，也符合本仓 local-test-policy。
- 若文件在落盘前出现未知内容，必须保留原内容并只追加；若 exact marker 已存在，则不重复追加。

## 结论

marker 没有架构歧义：driver 是唯一 source of truth。实现阶段只需幂等追加两条 exact line、检查 diff 只含允许路径、提交并推送 feature branch；TURN `yours` 是本次“native mail or TURN”回执。
