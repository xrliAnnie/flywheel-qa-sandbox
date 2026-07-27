# Flywheel v2 场景全表(先枚举场景,再判机制)
前提:DAG 形状可变(1个/2个/4个/任意 task,由每个 issue 的 DAG 决定);"design/implement/qa" 只是常见例子

## A 消息类(核心问题:不丢、不重、崩溃可恢复)
| # | 场景 | 谁→谁 | 需要我处理? | 崩溃点与后果 |
|---|---|---|---|---|
|A1|Annie 主频道派活|Annie→Lead|是(要派 runner)|收到未处理就崩→必须重放|
|A2|Annie 在 issue thread 说话|Annie→Lead(可能转给 runner)|是|同上|
|A3|Cass/别 Lead 派活或问事|Lead→Lead|是|同上|
|A4|我给 runner 下指令|Lead→Runner|runner 要处理|注入失败/runner 没读到→指令丢失|
|A5|runner 提问(阻塞)|Runner→Lead|是(不答它卡着)|我没答→runner 永久等|
|A6|runner 汇报状态|Runner→Lead|否(只更新账)|丢一条=状态过期,可由下条修正|
|A7|我给 Annie 汇报/提问|Lead→Annie|Annie 看|Discord 发送失败→她不知道|
|A8|系统告警(runner死等)|System→Lead|是|漏了=无人管|

## B 任务流转类(DAG 形状可变)
| # | 场景 | 怎么走 |
|---|---|---|
|B1|正常流转|task 完成→解锁它挡住的下游 task(依赖满足者才可跑)|
|B2|打回(下游发现上游有问题)|上游 task **不变**,开新 attempt(generation+1);下游已完成的 attempt 标 superseded;能复用 session 就 resume|
|B3|loop(implement↔qa 反复)|两个 task 各自轮流开新 attempt,直到通过;attempt 数不限|
|B4|中途改需求|当前 attempt 收到指令→要么在本 attempt 内消化,要么 Lead 判断开新 attempt|
|B5|并行分支|DAG 里无依赖关系的 task 同时可跑(唯一约束:同 worktree 同时只一个写者)|
|B6|单 task issue|DAG 就一个 task,一个 session 干完|
|B7|取消|Annie 说不做→task 置 canceled(终态),活着的 attempt 终止|

## C 失败类
| # | 场景 | 系统怎么发现 | 怎么恢复 |
|---|---|---|---|
|C1|runner 进程死(额度/崩溃/被杀)|探针观测 absent|attempt 标 failed→Lead 判断:重开 attempt 还是升级给人|
|C2|runner 活着但卡住|探针看不出(它"活着")→靠 Lead 观察或 runner 自报|Lead 判断→可 resume/换 attempt|
|C3|Lead(我)死/重启|supervisor 拉起|从队列重放未处理消息(用 generation 挡住旧进程)|
|C4|Bridge 死/重启|launchd 拉起|所有状态在库里,重启后照常;进行中的外部动作靠 receipt 对账|
|C5|vendor 挂(Codex 503)|派发/执行失败|attempt failed→重试或换 vendor(Lead 判断)|
|C6|CI 红|ship 前检查|ship 门拒绝;Lead 决定修还是等|
|C7|派发失败(起不来进程)|dispatcher 报错|重试 N 次→仍失败则升级给人|
|C8|DB 写失败/锁|事务失败|整个操作回滚,消息未销账→下次重放|

## D 人介入类
| # | 场景 | 怎么走 |
|---|---|---|
|D1|Annie 批准 ship|批准绑定精确 head 写进 gates→runner 自己 merge|
|D2|Annie 拒绝/要求改|等于 B2 打回|
|D3|Annie 打断正在跑的活|指令进队列→Lead 判断→终止 attempt 或转达 runner|
|D4|Annie 问状态|Lead 读只读视图回答(不改状态)|
|D5|Annie 改主意(需求变更)|等于 B4|

## 基于场景表:每个机制到底要不要?
| 机制 | 哪些场景需要它 | 判定 |
|---|---|---|
|**消息持久化**|A1-A8 全部|**必须**——这是不丢的唯一保证|
|**处理与销账同事务**|A1/A2/A3/A5/A8(需要我处理的)|**必须**——防"处理了没记上/记上了没处理"|
|**幂等键**|A4(注入)/B*(派 attempt)/D1(merge)/所有外部副作用|**必须**——重放时不重复生效|
|**claim 抢占**|理论上只有 C3(Lead 旧进程复活)|**删除**。理由:①每条消息只有一个确定收件人,不存在竞争 ②C3 用 lead_generation fence 解决更干净(旧进程写不进去) ③Annie 指出:租约过期会制造重复处理|
|**租约/超时回滚**|同上|**删除**。它试图解决"处理到一半崩了",但正确解法是"未销账即未处理,重启后重放"——不需要计时器,也不会有"第16分钟处理完但已被别人拿走"的 bug|
|**lead_generation fence**|C3|**保留**——旧 Lead 进程复活时,它的写入被拒(generation 过期),不会与新进程双写|
|**探针**|C1/C2|**保留**——但只回答"进程在不在",判断交给 Lead|
|**依赖检查**|B1/B5|**保留**——调度只挑依赖满足且未完成的 task|
|**终态不可逆**|B2/B3/B7|**保留**——但返工是"同 task 新 attempt",不是改回旧 attempt|
