# FLY-2886 语音大脑 — 实现恢复核对
Issue: FLY-2886 (https://linear.app/geoforge3d/issue/FLY-2886)
日期: 2026-09-26
基于: plan.md v10、progress.md

## 范围与当前边界

从救援提交 `94bef260a` 继续，执行身份 `88dd437e-4f73-4b69-947a-35512417723d`，TURN implement epoch 3。设计与 §5.3 已批准，没有重做设计。7/8 是恢复游标，不代表只剩交卷。所有证据只说明本地实现；没有真房、生产、完整 CI 或 shipping 证明。未拆 529 房、未调度 QA、未合并或部署。

## 已提交批次

- `56dee3c79`：救援构建与类型错误、report 常驻授权回归、语音租约续期误判、锁派发 deadline 与已派发 not_dispatched 保护。对应红绿输出及 lint/build/dependent typecheck 已存 evidence/resume-*.txt。
- `b59f06455`：outbound 410 跳过并继续后续消息，409 失租约仍停止，定向 daemon 35/35。
- `2fa3dede8`：disabled/draining policy、过期已派发锁保持 unknown、原 fence 迟到终态结算票据、跨项目与 activation 别名拒绝，4 文件 45/45。
- `fb96254cf`：订阅 capability parent 接容器，ChatGPT account/config/native/tools 断言、隔离无工具 scribe、每 turn delivery context；founder_chrome/isolated/off 三档；0.156.1 实机原生技能树采集；会话动作账本与关闭快照。详见 resume-container-wiring.md / resume-browser-ledger.md。

## 当前组合收尾

- 目标写入别名 canonical 化；可信 provider 终态在超时/撤权后结算原回执，绝不授予新操作权限。Linear/GitHub/Bridge/浏览器适配器分别验证原响应；没有观察到成功响应的远端写保持 unknown。Bridge 内层无目标锁也能更新自身回执。适配器 7 文件 132/132，broker+GitHub 36/36。
- 对账只读原 activation/request/target 的 durable success；同时支持语音 parent 与 Bridge 内层 journal。未知值、当前 provider 值、其他请求均不能清锁。resident force-clear 要明确风险声明并留审计。重复 release 无副作用。相关 3 文件 8/8。
- unknown 目标进入 bootstrap 受阻节和 durable Lead 事件，30 分钟再提醒一次；动作日志写入与锁结算同事务，通知失败可重试、不重复外部写。
- C6/C10：Lead/tell 经隔离改稿、字段校验、单一 SpeechArbiter；20/40 秒等待 cue、插话/迟到结果保留；自然 realtime generation 读取 durable 背景环，tell 每次播前复核。§5.3 live append 仍未准入，保持关闭。
- C5：实际完成工具结果带 itemId，最终回答/文字版不能自证；使用 Bridge roster 与可信快照保护字段；文字版发布成功才播指针，失败材料进入纪要。6 文件 94/94，services24，session追加关闭场景42。

## 尚未完成的边界

1. C9 实际 admitted manifest 工具类别接开场简报，以及 enabled 状态读取失败的如实 unavailable 回退，正在按批准计划补齐。
2. §4.5 founder-only 分类、拒绝日志回执和据实口述，正在补齐；没有新 founder 请求入口。
3. §3 重复义务：0.156.1 先 StartOrSteer 后 handoff 通知，事后附账本不能证明重复写尚未发生。已询问 Lead `cd6d1609-baf9-4792-8f74-3abe0ec1a133`，不把规约或事后 steer 算作结构性防重复。独立的每 turn 回执关联继续实现。
4. 当前最终相关验证、PR、有效代码审查与 needs_review completion 尚无完成证据。

## 验证范围

清册见 evidence/related-test-scope.md：逐个 changed production TS 的全路径/文件名/父目录固定字符串检索，保留直接消费者与变更测试，逐项说明排除；另跑 owning package vitest related。明确排除计划批准的 tmux-viewer.macos。没有本机全包套件，没有请求普通 head full CI。

早期四个授权文件 related 经 import graph 选中 127 文件，120 文件通过、7 文件9测试失败。失败项逐个定位：createLeadRuntime 冷动态 import 超15秒污染下一用例（改为collection阶段静态导入，5/5）；默认parent新增policy探测需fixture响应（1/1）；runner fixture缺当前carrier evidence（36/36）；其余rotation53、runsroute1、epicwiring3、services24复跑通过。该早期 related 不是当前完整通过证据。

保留 Node 脚本消费者16文件447测试通过（resume-retained-node.txt）。shell、最后依赖构建/typecheck/lint及最终TS相关验证仍在进行。实际 Chrome 接管、真人语音、订阅真请求、写操作及 founder 门验收归 QA；0.156.1 canonical host 基线部署仍为部署前置，未在本实现阶段操作生产。
