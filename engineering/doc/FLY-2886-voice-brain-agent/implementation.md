# FLY-2886 语音大脑 — 实现恢复核对
Issue: FLY-2886 (https://linear.app/geoforge3d/issue/FLY-2886)
日期: 2026-09-26
基于: plan.md v10、progress.md

## 当前边界

从救援提交 `94bef260a` 继续，执行身份 `88dd437e-4f73-4b69-947a-35512417723d`，TURN implement epoch 3。设计与 §5.3 已批准；没有重做设计。原账本的 7/8 是恢复游标，不代表只剩交卷。

## 本批修复与证据

- 救援代码构建失败：IdentityProjectRow 的 projectRoot 为 unknown、目标锁 client 上下文类型丢失、缺少显式 return、未使用 import。使用项目 schema 验证和类型标注修复；未将 unknown 强制断言成可信路径。
- report 提交前常驻 carrier 检查在重构中丢失：原测试 2 条红，恢复原检查后 report 7/7 绿。
- 语音租约续期不是撤权：新增真实 StateStore 测试先红，移除 expiry/state 快照相等约束后绿；每次仍检查当前有效租约与 fence，过期、失租约或配置变化仍拒绝。
- 目标锁派发前检查 deadline；已记录 dispatched 的锁不接受客户端 not_dispatched 清除，转 unknown，直到可信终态。两条测试先红后绿。
- 修复救援提交内格式与 import 错误。`pnpm lint` exit 0（25 个 warning，无 error），没有修改无关旧告警。

`evidence/resume-*.txt` 保存本批红绿记录与构建输出。8 个窄测试文件 69/69 绿；随后新增的目标锁文件 5/5 绿（包含原有 3 条）。`pnpm --filter 'flywheel-voice-codex...' build` 通过；`pnpm --filter '...flywheel-teamlead' typecheck` 通过。这里只是本批验证，不能当作整单完成、完整 CI 或 QA。

## 仍需完成的已批准实现

| 项 | 当前代码证据 | 下一步 |
|---|---|---|
| C1/C2 容器接 capability parent | `startVoiceCapabilityParent` 尚无 voice-codex 调用方；容器仍写 VOICE_CODEX_HOME_CONFIG、空 MCP、read-only thread | 接启动与关闭、订阅 account/read、权限/config/tools/list 断言、每 turn journal delivery context；启停不改常驻回执 |
| C3 浏览器三档 | resolver 有模式过滤，runtime-factory 仍固定 startBrowserProvider；parent 未传模式 | founder Chrome provider、off 保留模型代理、按模式 MCP/manifest/有效工具发现 |
| 版本基线 | 语音容器固定 0.156.1；native-skill-baseline 无 0.156.1/0.157.0 | 按既有采集流程准备实际启用版本基线，不放宽比较 |
| §4.3 目标锁 | acquire/mark/release/cancel 原型已存在；runtime-factory 无条件建立锁 client | 补 disabled/draining 范围、可信 reconcile 与带审计 force-clear、unknown 状态/信箱提醒、重启 waiter 清理、目标别名归一、终态证据分类与迟到成功 |
| C11 写日志 | target-lock release 中仅成功时 tryClaimLeadEvent | 完整 actor/回执/目标/纪要与通知失败幂等补送；失权/关闭后的未知状态与失败交接账本 |
| C6 改稿 | ScriptWriter 与测试已存在，生产源码没有调用方；CodexRoomFrontend.appendSpeech 仍 required readback | 接隔离订阅改稿器与单一 SpeechArbiter，按 enabled 档处理 Lead/tell |
| C10 | Bridge 已生产背景环；容器 restart 沿用旧 realtimeStart，尚无读取 contextRing 的生产路径 | 接自然重开恢复/按 generation 标记、播前 stale 复核；不实现未经准入的 live append |
| C12 | daemon 新增真实错误分支测试：410 跳过并播下一条、409 终止；35/35 绿 | 路由/StateStore 已有三态测试，最终相关验证再核对 |
| 完整实现收尾 | 无当前 PR/code-review/handoff 证据 | 剩余 TDD、相关测试、登记清册、最后 milestone commit、push、PR、有效代码审查、needs_review completion |

## 相关测试范围

已对 64 个变更生产 TS 文件逐个执行 `git grep -lF`，查询全路径、文件名、父目录；初次发现 78 个测试匹配（跨包的结构守卫也保留）。全量原始清单暂在 `/tmp/fly2886-consumers.json`、`/tmp/fly2886-retained-tests.txt`，实现最终稳定后刷新并归档。非测试文档/源码引用从直接测试清单排除；TS import 还需 owning package 的 `vitest related <files> --run`。计划指定的 tmux-viewer.macos 排除。当前仅启动授权边界四文件的 related 验证，整单相关测试与 retained matches 尚未全跑。没有本机全包套件，没有请求 full CI。

恢复修复已推送 `56dee3c79`。授权四文件 related 命令仍在运行（exec session `60899`，日志 `/tmp/fly2886-authority-related.log`）；它经路由依赖选中了 actions/event-route 等间接测试，目前不将未终态输出计作通过证据。继续时先轮询现有 handle，不要重启同一测试。

## 2026-09-26 目标锁恢复批次

新增关闭开关后的 policy/draining 路径：Bridge 恢复过期持锁者，未派发安全释放，已派发转 unknown；常驻 disabled 无存量锁只查一次 policy，draining 只检查已有目标，不新建无关锁。配置/身份变化仍使缓存失效。跨 project target 与 voice activation 别名 fail-closed。

broker 在回合超时后保留原 provider 调用的可信终态，并先结算原回执/fence，再检查是否可向当前回合返回结果。原 fence 是 parent-only 结算票据，只能结算原目标/请求/activation；失权不重新授予 acquire/mark 权限。泛化 rejected 没有明确未派发或 provider 拒绝证据时保持 unknown。真实适配器的证据标注、canonical alias、对账与日志仍在后续批次，不能据此宣称 §4.3 全部完成。

4 个定向测试文件 45/45 通过，红绿证据在 evidence/resume-{draining,lock-client,lock-route,late-terminal,terminal-client,terminal-evidence,lock-batch}*.txt。浏览器三档独立修改已通过其定向验证，但尚未连同容器集成提交；并行实现文件不能算本次锁提交内容。
