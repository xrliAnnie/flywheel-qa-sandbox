# FLY-2922 三域隔离收口与 QA@4 — 探索
Issue: FLY-2922 (https://linear.app/geoforge3d/issue/FLY-2922/病根修复-8-held-回滚之后有出口只留一个统一恢复口放行必须真铸出派发关死体不连带终结-run9-张-37)
日期: 2026-09-29
基于: 无

## 1. 这轮设计面对的事实

本节点是 QA slot-2 房中的 `eng_design`。它只负责设计文档，不合 main、不改产品或 harness、不起新房、不请求 ship。房间事实不能被当成生产授权：

- 当前 project 是 `test-slot-2`，host repo 是 `flywheel-qa-sandbox` 的隔离 worktree。
- 房内 design/implement runner 是真实 runner，QA runner 是 stub。stub 是脚本化测试替身，不是生产 QA 裁决者。
- `room-info.json.flywheelRepo` 指向生产源码 checkout；这是构建来源，不给房内 actor 生产仓写权限。
- 当前房本身已经由 `FLY-2922` 启动。若再把 `--issue FLY-2922` 注入内层 driver，会让内层 design 重读同一生产任务并递归起同类工作。

与此同时，生产 PR #1374 的权威只读快照已前进到 `6e21a123d34bb53ee29b8536503133d714f46435`：`main@b165d6490` 已包含、PR clean/mergeable、精确头 CI run `36544821509` 全绿；但本设计材料没有证明该头已有有效同头代码复审，QA@4 真房证据也仍缺。

## 2. 需要分开的三个授权域

| 域 | 唯一职责 | 可写对象 | 绝不能做 |
|---|---|---|---|
| 生产收口域 | 同步 latest main、定点验证、同头复审、精确头 CI、`needs_review` | 生产 feature worktree、分支、PR #1374 | 借用 QA 房的 stub verdict；让房内 runner `cd` 到生产 checkout |
| 房外 QA 控制域 | 冻结 source SHA、选两个空槽、启动/观测/快照/拆房、作最终 QA 判断 | 自己拥有的临时 source checkout、房间与证据目录 | 把房内 QA stub 的 PASS 当生产 PASS；使用生产 issue 递归 |
| 房内受测域 | 以安全 fixture issue 演练 design→implement→QA→rework→new dispatch | QA sandbox repo 与房内 StateStore/CommDB | 写生产 worktree/分支/PR；决定生产可合并性或 ship |

当前 slot-2 的 design、后继 implement 与 stub QA 都属于第三域；它们不是第一、第二域的执行者。

## 3. 方案比较

| 方案 | 优点 | 致命问题 | 结论 |
|---|---|---|---|
| 房内 DAG 直接合生产 main、复审 PR #1374、再给自己起 QA 房 | 步骤表面连续 | 跨越 repo/exec 权限；stub 可驱动生产 rework；`complete --pr 1374` 与 cwd 不绑定；会递归 | 拒绝 |
| 只把 `FLY-2922` 换成另一个 issue，仍让房内 QA 作最终判断 | 避免直接递归 | stub PASS 仍不是生产 QA；driver 的 repo authority 仍可能指错生产仓 | 拒绝 |
| **三域隔离**：生产 DAG 独立收口；房外 QA 用冻结源码和安全 fixture 起房；房内只写 sandbox；外层核验九步证据 | 权限、repo、issue 与 verdict 都可追踪；不会自递归 | 多一个明确的 host controller 与 fixture 前置门 | **采用** |

## 4. 一句话设计

生产 PR 只由生产 DAG 收口，QA@4 只由房外 QA controller 驱动，内层房只消费安全 fixture 并写 QA sandbox；三条链用同一生产源码 SHA 关联，但不共享写权限或裁决权。

## 5. 不变量

1. **生产写权限唯一**：只有生产 Bridge 绑定的生产 DAG 能写生产分支/PR；slot 房 actor 不继承这个能力。
2. **源码 SHA 唯一**：生产 PR head、review、CI、QA source checkout、`--expect-head` 与 evidence 都绑定同一 40 位 SHA。
3. **issue 不递归**：房内 driver 必须使用 Lead 明确授权的 QA fixture issue，且 `QA_FIXTURE_ISSUE != FLY-2922`。
4. **repo authority 隔离**：driver 查询/创建/推进的 PR 必须属于 QA sandbox repo；检测到 `xrliAnnie/flywheel` 就 fail closed。
5. **stub 不是裁决者**：房内 stub 只推动预定故障/放行；最终 QA PASS 由房外 owner 根据完整 evidence 给出。
6. **放行要有体**：必须有新的 execution、launch ordinal、dispatch ledger/receipt 与 consumer 证据；状态字段或展示事件不够。
7. **关体不关 run**：旧 actor 可关闭或停驻，run 在 replacement 真派发前不得被级联终结。
8. **本机只定点**：merge/harness 改动只跑发现后的具体测试文件、owning-package related、lint 与 affected build；full suite 只认精确头 CI。
9. **身份不由 cwd 决定**：生产/房外 owner 必须按 Bridge 的 StateStore 路径优先级定位数据库，以只读、UUID 校验后的参数化查询核对当前 execution 的 `project_name/session_role/worktree_path`；`turn + cd` 不能升级权限，缺少显式 DB 环境变量也不能误伤合法生产 owner。
10. **递归房先隔离清场**：已用 FLY-2922 自递归的 slots 2/3 只做取证、终止和 owner teardown，绝不复用为 QA@4；房内后继走 `no_code` 安全出口。

## 6. 明确边界

本设计不重新设计已经批准的统一恢复事务，不授权当前 sandbox 操作生产 PR，不把现有 CI 绿冒充同头复审或 QA PASS，也不请求 shipping authority。它补齐的是生产收口、host QA 与受测房三者之间缺失的权限和证据边界。
