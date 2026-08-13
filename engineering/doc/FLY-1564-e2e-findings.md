# FLY-1564 E2E 疏漏记录

**Issue**: FLY-1566（承接 FLY-1564 E2E 观察）
**Date**: 2026-07-31
**Status**: Complete
**Based on**: FLY-1564 真机 E2E 观察、FLY-1565 已合入修复

## 结论

FLY-1564 的 E2E 共暴露五条疏漏。两条 Codex runner 沙箱问题已由
FLY-1565 修复；Lead 重启后的凭据生命周期和 founder 消息镜像问题归
FLY-1561；issue thread 创建仍由 v1 Bridge 承担，不在 v2 出站信使内重复实现。

| # | 疏漏 | 修复状态 / 去处 |
|---|---|---|
| 1 | issue thread 不自动创建 | 由 v1 Bridge 承担 |
| 2 | 引擎重启后 Lead 取信凭据作废，取信静默失败 | FLY-1561 |
| 3 | founder 消息镜像到信箱后 payload 为空 | FLY-1561 |
| 4 | Codex 授权框未预置，每种新工具首次调用都会卡住 | FLY-1565 已修复 |
| 5 | Codex 沙箱连接信箱 socket 返回 `EPERM` | FLY-1565 已修复 |

## 1. issue thread 不自动创建

**现象**：启动 v2 issue / DAG 后，没有自动出现对应的 issue thread。

**后果**：Lead、Runner 与 founder 缺少自动建立的共享讨论面；后续消息即使已进入
v2 信箱，也不能依赖新 thread 作为可见的会话入口。

**根因**：v2 迁移时出站信使已停役，v2 DAG 不再负责创建 thread；该能力仍属于
现役 v1 Bridge，而本次 E2E 没有经过它的 thread 创建路径。

**修复去处**：保持由 v1 Bridge 创建 issue thread。v2 不重复实现第二套创建者；
若未来要移交所有权，应另开迁移 issue，并先定义唯一写者和兼容切换边界。

## 2. 引擎重启后 Lead 取信凭据作废，取信静默失败

**现象**：v2 引擎重启后，Lead 继续使用重启前落盘的 delivery credential 调用
`next`，无法再取到信，且 Lead 侧没有得到足够醒目的失败反馈。

**后果**：信件仍可能处于 pending，但 Lead 看不到内容，也无法结算；从使用者视角
表现为“没有新信”，会把真实积压误判为空闲。

**根因**：Lead delivery credential 绑定注册代际；引擎重启后旧注册被撤销，旧凭据
随之失效。当前生产生命周期没有在重启后自动重新注册 Lead、原子发布新凭据并让
取信端切换到新代际，失败又没有被提升为明确的重注册动作。

**修复去处**：FLY-1561。引擎重启后自动重注册 Lead、替换 credential，并让取信
失败 fail loud，不能把鉴权失败折叠成“信箱为空”。

## 3. founder 消息镜像到信箱后 payload 为空

**现象**：founder 消息的信箱镜像行能够出现，但投递 envelope 的 `payload` 为空，
原始消息正文没有随镜像进入 Lead 可读取的内容。

**后果**：Lead 只知道“有 founder 消息”，却不知道 founder 说了什么；无法可靠
判断、回复或留下可审计的处理记录。

**根因**：founder ingress 到 v2 mailbox 的镜像映射只建立了消息记录，没有把原始
正文映射进 envelope payload。E2E 已把缺口定位在镜像写入边界；具体 producer
字段映射由负责修复的 issue 继续钉死。

**修复去处**：FLY-1561。镜像必须携带原始 founder 文本，并增加非空 payload、
中文/换行内容和重放一致性的回归覆盖。

## 4. Codex 授权框未预置，每种新工具首次调用都会卡住

**现象**：无人值守 Codex runner 第一次调用新的 app / connector 工具时弹出授权框；
每种新工具都要人工确认一次，任务在确认前停止推进。

**后果**：runner 看似仍存活，实际停在交互审批上；commit、push 或开 PR 等正常
交付步骤可能逐个形成新的卡点，违背无人值守执行合同。

**根因**：app / connector 工具有独立的 tools approval mode，不能由 Codex CLI 的
`approval_policy=never` 覆盖；旧 launcher 没有为 daemon 和 pane 预置该模式。

**修复去处**：FLY-1565 已修复。daemon、resume pane 与 bare pane 统一注入
`apps._default.default_tools_approval_mode="approve"`，并用 sandbox policy version
阻止旧策略 daemon 被静默沿用。

## 5. Codex 沙箱连接信箱 socket 返回 `EPERM`

**现象**：Codex runner 在 workspace-write 沙箱内调用 v2 `next` / `submit` 时，连接
认证 host Unix socket 直接返回 `EPERM`。

**后果**：runner 既无法领取后续信件，也无法结算手中的 delivery；ask 回环、进度
报告与最终 proposal 全部断开。同时 linked worktree 的 Git metadata 位于主仓库
`.git` 下，旧 writable roots 也会让本地 commit 卡在 `index.lock`。

**根因**：Codex workspace-write 默认 `network_access=false`，macOS Seatbelt 因而
禁止 Unix socket `connect()`；sandbox writable roots 又只覆盖工作目录，没有覆盖
linked worktree 实际写入的 `--git-dir` / `--git-common-dir`。

**修复去处**：FLY-1565 已修复。所有 Codex daemon / pane 形态统一启用
`sandbox_workspace_write.network_access=true`，并把 fail-loud 推导出的 Git metadata
目录加入 `sandbox_workspace_write.writable_roots`；策略代际闸避免旧 daemon 绕过
新配置。

## 验收边界

- 本文只记录 FLY-1564 E2E 已观察到的五条疏漏及其归属，不把 FLY-1561 的待修项
  写成已完成。
- FLY-1565 的两项修复以已合入的 sandbox policy 为准；本次 FLY-1566 runner 能经
  `next` 收到中途信和任务简报，已经覆盖 socket 连接路径。
- 本次还需由实际执行证明本地 `git commit`、`git push` 与开 PR 全链可用；这些操作
  是 FLY-1565 修复后的验收步骤，不由本文文字替代。
