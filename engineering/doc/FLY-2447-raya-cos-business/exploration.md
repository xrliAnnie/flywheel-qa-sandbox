# FLY-2447 Raya 统管业务 — 探索
Issue: FLY-2447 (https://linear.app/geoforge3d/issue/FLY-2447/rayacos-统管-leads-summaries88-日报-在新地基重排按-prd-fly-1846-的定义作为-raya)
日期: 2026-09-14
基于: 无

## 结论

Raya 用标准 Codex Lead 的同一轮对话，完成读各仓、理解 summaries、向 Lead 追问、形成方向判断、日报和会议业务。Flywheel 负责收发与进程，Raya 仓负责判断及业务记录。④提取的代码是本单起点，不能把其 `unavailable` 占位当作⑥的交付。

## 需求逐条落点

| 来源 | 本单必须交付 | 不可替代的证据 |
|---|---|---|
| PRD FLY-1846 §4、§5 | 大方向统管；逐仓读取；不需 founder 在场即可追问对应 Lead | 标准 Raya 主动发问、对方真实回复、Raya 引用答复 |
| §7、§10.4b | 从持续对话提炼目标、保留执行承诺和阶段性记忆；支持纠正/撤回 | 普通对话无需标记；后续回答引用目标出处；纠正可追溯 |
| §8.1、§13.7 | 自主采取方向级业务动作；不同意 founder 时说出判断；偏离其重点的动作披露理由 | 真实协调动作和披露消息分别有凭据；不是逐项人工请示 |
| §8.6.7 | 可见沟通走 #raya / #leads-roundtable；底层沿现有 mailbox | 不新增 2379 roundtable ask 或 Lead 问答 API；不冒用 runner ask |
| §8.8 | 各 Lead 写事实与判断到 Raya summary PR；merge 才是已读 | 钉住 PR head 的机械 merge 回执；memory provenance；未懂则不 merge |
| §8.7、2380 | 每晚一份仓内日报，可在 #raya 讨论并进入下一轮上下文 | 连续两个自然日真实消息与 `reports/YYYY-MM-DD.md`；一次 founder 回复被引用 |
| §6、§10.5、2381 | 6h 可调周期及事件触发；沉默项目也是信号；可被否掉的偏离观察 | 至少一个无人发问时的观察；缺证据不编造；不是排序表 |
| ⑤ | 会议业务与通用 voice 对接 | 同一个 meeting UUID，从标准 turn 启动；live/ended 与真实转写 |
| ④、本单 DoD | 标准 Lead 上线、两仓版本可核 | updater v2 standard-lead receipt + public verify + 本单业务验收 |

## 承接与纠偏

1. PRD 比旧拆单中的缩减方案优先。2381 的“巡视不能追问”“仅标记行记 goal”不延续为产品边界；普通对话可提炼目标，主动巡视可问 Lead。
2. 2380 已选定产品形态是仓内 Markdown 和 Discord 文字分片。设计 HTML 是本设计节点交付，不把产品日报换成另一个网页产品。
3. PRD 的全权不等于本 design runner 有 ship 权；运行时 Raya 保留既有业务动作，工程合入、生命周期、凭据规则仍由公共平台执行。summary 的窄例外不扩展到代码 PR。
4. 日报可读 open PR，但必须标“未吸收”；收集、格式合规、mailbox ACK 都不是理解，更不是 summary merge。
5. FLY-2382 后来的每轮对账要求保留：即使空轮也显示 frozen producer 缺交/未送达/未知行。这是收件事实；没有理由时不凑偏离提醒。
6. ④已完成业务提取；Raya main 当前 `.lead/raya/identity.md` 与 CLI 仍有不可用占位和空轮静默旧文案。只改当前消费者，不整支合回 2379/2380/2381。

## 比选

| 方案 | 判断 |
|---|---|
| 合旧 2379/2381 分支，重开私有 controller | 拒绝：恢复第二个脑、私有收信、计时器与名册 |
| 仅修 persona，声称业务都能用 | 拒绝：当前 CLI 只有 date/voice 占位，恢复与回执缺口仍在 |
| 再造通用插件宿主/跨 Lead RPC | 拒绝：任务指定现成 roundtable 和 summary-inflow，增加了不必要的系统 |
| 标准 turn 使用已有工具，Raya 一次性 CLI 管业务状态 | 选择：复用现有模块；工具收发在平台；业务输入/计划/回执可单独验证 |

## 非阻塞询问

向 Engineering Lead 发出 `7864eabe-93b8-4d7c-848f-8f773f98dfa1`（双仓最小接线边界与⑤ paired head），以及 `b9d33be4-3881-4491-9b45-dda0eb062c36`（复用 GatePoller 的每日唤醒）。继续独立设计；答复写入 plan 的裁定记录。这里不新增 brainstorm/founder/ship gate。

本节点只出探索、调研、实施计划、评审及 HTML。最终生产验收是后续实现/QA/部署的要求，本次没有实施或在线业务验证。
