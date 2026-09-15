# FLY-1945 巡检证据与机制缺陷 — 调研
Issue: FLY-1945 (https://linear.app/geoforge3d/issue/FLY-1945/巡检体系-仪器假报修复-机制缺陷完成门并-1952)
日期: 2026-09-14
基于: exploration.md

## 结论

根因已由代码和旧报告交叉证实：仪器把最后渲染行当成工作状态，且 sidecar 不绑定 execution。修向是把状态跃迁与独立远端 head 观测合成进展证据，同时把未知与等待分开。机制缺陷门应扩展现有 awk，不再另造一个互不相知的完成门。

本调研来自当前 checkout、两项只读研究子任务与原始巡检报告。没有运行生产巡检、修改数据库、调用 Linear 写口或实现代码。Linear exact lookup 缺少本 runner 的 master API credential，已向 Lead 报告；任务注入的 issue 正文仍为范围依据。

## 历史反例与证据等级

`historical-observations.json` 保存 4 份报告的 8 条脱敏观测，保留源文件名和 SHA256。来源目录是运行期巡检报告，不是 memory。只提取身份、状态 hash、epoch 和 PR 行，不复制终端原文。

| 观察时刻（2026-08-20 UTC） | %7 / #891 head | %8 / #892 head | 两行 last_change |
|---|---|---|---|
| 17:51:17 | d4cbcb6c | 1f8d954c | 1787248266 |
| 19:38:02 | 10021cb4 | bed47598 | 1787248266 |
| 20:39:40 | fbc1a3c2 | 6628c784 | 1787248266 |
| 21:37:49 | 7529e403 | 6628c784 | 1787248266 |

%7 execution=`fa7e14cf-362e-48aa-9c2e-e09a8193ff82`；%8 execution=`7344a1a1-2be0-4e2b-b5af-772a4a206998`。两者冻结 epoch 对应 17:51:06Z。从连续观测可直接证明冻结区间内远端提交号变化；不需要把 `updated_at` 当 push 时间。旧报告只存 8 位 SHA，历史回放输入必须标明 legacy evidence；线上验证只能接收完整 SHA。

2026-09-14 `gh pr view` 只读确认 #891 为 FLY-1850 / branch `flywheel-FLY-1850`，#892 为 FLY-1851 / branch `flywheel-FLY-1851`，均已合并。当前 PR updatedAt 和最终 head 不能还原 8 月 20 日每次 push 的精确时间；本次没有获取原始 GitHub push 事件。验收回放必须明确其观察窗口，不能把 21:37 的结论无限延伸到未来。

`current-gate-gap.txt` 保存实际执行旧规则 awk 的输入与结果：含 `category=mechanism_defect`，没有 disposition，退出 0。说明只加 category 提示不能满足验收。研究子任务另确认重复 category 字段也被旧解析器忽略。

## 当前数据流

1. `scripts/lead-patrol-snapshot.sh:278-398`：跨项目 owner index 做 cardinality 检查，再筛当前 Lead，最后与 canonical pane 求交；不可先 capture 全机再过滤。
2. `:429-532`：target 查 TSV → capture 完整 scrollback → 最后非空行 hash → 继承 epoch → 60 分钟 STALLED → 原子 rename。没有串行锁；失败路径会以新 epoch 覆盖旧观测。
3. `:1194-1225`：GitHub 只取前 50 个 open PR、截短 head + updated_at，用于第 5 步展示。不是逐 execution 的完整提交核对。
4. `:1274-1275,1791-1822`：六 numeric STEP + DWELL 候选骨架；第 6 步留 Lead 判断。
5. `runner-patrol-rules.md:428-505`：基本完整性门、磁盘门、FINDING awk 均成功才算报告完成。不存在 server-side patrol completion API，本次不会声称增加这样的 API。

## 身份与状态的真实来源

| 信源 | 可使用的字段与限制 |
|---|---|
| CommDB sessions (`db.ts:195-205`) | execution_id、project_name、issue_id、lead_id、target；无 repo/ref |
| workflow_run_node (`StateStore.ts:26766`) | run_id/node_id/attempt 主键、execution_id、state；latest attempt 精确关联 |
| workflow_execution_binding (`StateStore.ts:5689`) | activation_id、execution_id、run/node/attempt；同一常驻 execution 可以再次激活 |
| three_stage_turn (`db.ts:231`) | holder_exec_id、epoch、activation_id、target run/node/attempt；不是只看 phase 标签 |
| workflow_activation_turn (`StateStore.ts:27969`) | activation 与授予 epoch 的不可变关联 |
| runner_declared_states (`db.ts:212,6471`) | parked/long_task、expires_at，毫秒；续期 updated_at 不能算跃迁 |
| runner_stop_declarations (`db.ts:220`) | state_key 是语义，content_hash 是展示；历史 stop 声明不独立证明仍等待 |
| sessions session_stage (`StateStore.ts:10614-10694`) | stage 值可用；重复 stage set 的事件 id/更新时间不算进展 |

`turn-wait-state.ts:13-77` 是检查当前 actor 的既有模式。只信当前有效且精确绑定的等待，文本推断 idle、旧 stop、未知状态均不得当健康依据。

## Repo/ref 绑定

`StateStore.ts:6529-6543,24652-24764` 的 worktree_binding_* 是唯一 set-once 权威组；普通 worktree_path/branch 可由 runner metadata 改写，不能用来归属提交。`repository-baseline.ts:9-23` 定义 `{version:1,repositories:[{relative_path,remote_identity,baseline_head}]}`，canonical JSON + digest 保证内容一致，但不含 nested repo branch。

`workflow_node_pr_binding` (`StateStore.ts:26800`) 有 target_repo_identity、probe_repo_slug、target_repo_path、generation、PR number，无实际 head ref。需要实时读取该 PR、校验目标仓与 generation，再解析其 head repository/ref；有 fork 时不能拿 base repo 的同名 branch 代替。多仓每个已绑定目标分别检查；没有可证明的 ref 就 unknown，不能用项目 open PR 列表猜。

GitHub 官方 [Get a reference](https://docs.github.com/en/rest/git/refs#get-a-reference) 返回单一精确 ref 与完整 object SHA；与会返回同前缀分支的 matching-refs 不同。设计采用精确 ref 读取，404/409/限流/格式错误均显式 unavailable。该接口不返回实际 push 时间，所以只能把 head 差异定位在两个采样时刻之间。

共享分支推进不能证明是哪位作者按下 push。保持同一 execution/activation/TURN episode 才可把分支变化用于该 runner 的巡检；epoch 更换则断开归属，单独记 branch activity。它只否定“这个工作区持续无进展”，不构成工作完成或权限证明。

## 现有机制账与扩展约束

- `runner-patrol-rules.md:325-348`：class_key 由错误码、源码 guard、结构形状组成，去掉实例值；完整分页查 FLY-2072 子单（含 archived），逐张读取完整 description，0/1/>1 三路处理。
- `:350-405`：首次 receipt 是 child UUID，重复 occurrence 是 comment UUID，写后回读 marker/count/title。可以让同一类别子单同时承担修复单，补充验收反例；不为记账与修复重复立单。
- `:435-505`：旧 gate 按 STEP 计数、首个字段匹配。新门需逐 finding identity，拒绝重复键，category 与 bridge_problem 正交。
- `epic=unavailable` 的旧例外不能自动满足机制去向；Linear 失败不能冒充选择 no_issue。
- Bridge `/api/linear/issues` (`plugin.ts:4310-4394`) 无分页 continuation、parentId/includeArchived，limit≤250。禁止假定加 query 参数就可完成 class-key 去重。
- `/api/linear/issue` (`plugin.ts:4514-4548`) exact identifier 返回 UUID/完整正文，但无 parent/team，不能替代 MCP parent 检查。
- create-issue 没有 idempotency key/CAS；先查再建不等于跨 Lead 原子去重。规则必须明确写入责任、重试先回读、发现重复时停写合并归账，不能承诺“绝不可能并发重复”。

## 必须同步的消费者

| 文件 | 影响 |
|---|---|
| scripts/lead-patrol-snapshot.sh | 调新 helper；修改 PANE_EVIDENCE schema；机制骨架 |
| packages/teamlead/lead-rules-base/runner-patrol-rules.md | 判据、动作、去重、三选一、同一可执行 gate |
| packages/teamlead/src/__tests__/fly369-patrol-rule.test.ts:174,290,404,765 | 多处精确提取 FLY-2080 哨兵，保留 awk 块并更新 fixture |
| scripts/__tests__/lead-patrol-snapshot.test.sh:753-781 | 当前反向锁死旧渲染行判据，必须替换 |
| scripts/flywheel-node-dwell-control.mjs | 可复用 wrapper 形状，不能直接改其业务 |
| scripts/package-onboard.sh + package-onboard-files.allow | 新 helper 随 payload |
| scripts/converge-flywheel-bin.sh:293,315,380 | strict symlink source / sanity / install loop |
| lead-rules-bundle.sh:366-368 + claude-lead.sh:2838 | 已向两种 Lead backend 注入同一规则；无需新增注入分支 |

锁可复用 `process-lock.ts` 导出的 `acquireProcessLifetimeFileLock`；内核锁随进程死亡释放，5 秒 readiness bound，onLost 可 fail closed。只锁 sidecar，禁止把远端请求放进生产 SQLite 写事务。原子 rename 负责发布完整文件，锁负责序列化 read/compare/write，两者缺一不可。

## 实施验证方向与未验证项

采用真实临时数据库 + fake tmux/gh 的现有 shell fixture；加入 helper 单测覆盖故障和跃迁，复用规则实际 awk 做去向门测试。对新增入口运行安装 symlink、payload 闭包测试。

本阶段已验证：源码断点、历史观测、当前 gate 漏验。未验证：修复后代码测试、生产部署、真实新巡检、浏览器交互。它们分别由实施/QA 或后续 HTML 交付验证承担，不能用本调研替代。

## 评审后的信源修正

首轮 HIGH 指出 optional baseline 可达性问题。复核 `packages/edge-worker/src/Blueprint.ts:1541-1547`：仅 allow_no_code_completion=true 才尝试采集 baseline，失败也不阻止启动；PR binding 则多在 gate-entry / completion 落账。2026-09-14 本次只读库聚合为 running=17、immutable binding=17、baseline=1；计数只是当时快照，不是永久比例。

因此普通 root runner 应用既有项目注册表的唯一合法 projectRepo + immutable worktree_binding_branch 读取 exact ref；optional baseline 存在时核对一致性，缺少时不报 unavailable。保持 fork/multi-repo 已声明目标的 exact binding 约束。新增运行期无 baseline/无 PR 的集成反例，避免仅历史 produce 节点样本过关。
