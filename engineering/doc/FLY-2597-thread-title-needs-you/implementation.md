# FLY-2597 Thread attention — 实施记录
Issue: FLY-2597 (https://linear.app/geoforge3d/issue/FLY-2597)
日期: 2026-09-15
基于: plan.md, design-correction.md

## 实现

- `founder_ask` 持久记录显式提问，消息首块成功后才 materialize。发送失败、部分发送、404 恢复、撤回、问题回答及 founder 回帖分别处理，lit/settled 与状态原子写入审计事件。
- `founder_attention_reply` 保存非 ship gate 的回复水位；它只控制提醒，不回答 gate。Lead 可显式关联原 questionId 重新提问。
- 标题与 Epic 页共享本地事实、title 派生及 QA/review hold。blocked/completed/approved 的 answer 隐藏；ship 优先。未知读取保持标题，且不写完成指纹。
- 无 session 的 Epic 使用持久 ask 和 canonical thread 绑定；settled ask 仍提供清除上下文。清除失败保持 dirty，重启后由原有 Layer-1 重试。Layer-2 与 founder 回复扫描纳入 open asks，预算和节奏不变。
- 新的 ask 扫描从 asked_at 起读，避免初次 cursor bootstrap 吞掉已到达的 founder 回复。linked question 回答后先由只读事实隐藏，再由 GatePoller 有界批次落 `question_answered` 审计。
- 固定页 founder 列表只列有效 Discord thread 链接；未知记录仍保留在结构化审计数据。Epic 卡与 Lead 面板保留。
- Epic intake 采用设计修正的选项 (a)：complete/superseded 可不提供 Discord 凭证；服务端保存 bridge_record receipt。needs_founder 仍需实际消息。请求 receipt 被拒绝；重放忽略服务端元数据。
- 两套 Lead 规则同步：纯记录不回 Discord，Epic 状态只在固定页；显式 founderAsk / withdraw，禁止手工改名、手写周期进展与自动重亮。summary-inflow 未改。

## 聚焦证据

测试全部使用本地内存/临时数据库和 Discord HTTP mock；没有复制生产数据库。

- badge/display/visibility 104 条通过；后续 refresher 57 条通过。
- founder ask store + reply 55 条通过；GatePoller 相关 59 条通过。
- send/withdraw 66 条通过；新增发送失败/部分发送、settle 失败重试等 10 条通过。
- 页面/title 三种触发、founder reply、terminal 隐藏和 ship 优先的同源集成测试通过。
- 有界无 session 扫描与 answered audit 集成测试通过。
- Epic intake schema / observer / route / StateStore 24 条通过；无 Discord credential/read 的 quiet resolve、服务端 receipt 和 replay 已验证。
- rollback helper 的只读默认、显式 apply 与徽章范围测试通过。
- 完整包 gate、最终 lint/build、精确 head review/CI 的结果另记 verification.md；上述不代替这些门。

## 回滚

回滚代码前，在受控台架/授权维护窗口准备所有可能仍显示「要你答」的 thread inventory：
`[{"threadId":"<snowflake>","tokenEnv":"<对应 Lead bot token 的环境变量名>"}]`。
只读检查：`node scripts/fly-2597-strip-needs-answer.mjs --input inventory.json`。
确认目标后才运行相同命令加 `--apply`。脚本只剥开头的 `🔔要你答`，不剥 `🔔 ⏳待批`、中间文本或其它徽章；不自动发现/修改其它 thread。
随后 revert；保留 ask/reply 表及事件作为审计。旧页面可能恢复独立列出 held ship；ship 权限不变。
脚本本轮只做了 mock 测试，没有对真实 Discord 执行。

## QA 交接边界

真机 title 变化、founder 真人回帖和固定页实际发布证据：未执行。
QA 只使用自己的测试频道/thread，不借 founder 的真实业务 thread。
报告必须分开列单测、CI、真机 title REST/截图、固定页证据；实现与 CI 不构成 production activation。

## 完整 gate 返修

首轮完整包 gate 暴露旧 GatePoller mocks、founder 列表预期以及 ON/OFF 规则字节基线尚未同步。补齐 mock 查询、保持原扫描预算断言；页面只期待有效 attention 项。规则演进使用同目录固定 patch 和 capture 脚本重放，先核原始 bundle 哈希，保留原历史职责及 FLY-2557 overlay，只有获批的 attention/quiet receipt 行改变。重复重放字节一致，兼容性 rationale 说明两种模式的共同职责与 db attention 分类变化。具体失败和修复后验证范围见 verification.md。
