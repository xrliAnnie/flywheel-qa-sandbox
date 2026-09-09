# FLY-2359 历史记忆种回 — 调研
Issue: FLY-2359 (https://linear.app/geoforge3d/issue/FLY-2359/2355b2-记忆回流-种回去任务结束把一次性家蒸馏出的记忆汇进-agent项目)
日期: 2026-09-08
基于: exploration.md

## 结论

使用 B1 持久 home 内的 `.flywheel-memory-seed/` 保存首次历史快照，AGENTS.md 的受管合同给出固定读取入口。不要拼接 Codex 自管 `memories/`，不要移植其 SQLite，不增加任务结束回流系统。快照按整个白名单 Markdown 树的内容摘要去重，保留内部相对路径、所有来源及不同版本。

## 证据等级与版本

- Flywheel 当前基线 `ee113cab956bf3d71f186e5d72b24baf545e629c`，包含 B1 的实现；本阶段未运行产品实现/QA。
- 上游 PRD 在 `flywheel-FLY-2119@305e9ed9d651cc78f65a2b06006ab00be12337da`，当前工作树没有该文件，已通过 `git show` 阅读指定 §5.3 和 §7.2。
- `/Users/xiaorongli/Dev/codex` 为较老的 `db6aa801`（2026-02-14），不能把它当现网版本。另读 `/Users/xiaorongli/Dev/codex-oss@49025589`（2026-07-28）和其本地 origin/main `eb10d91e`（2026-09-02）的新结构，本机二进制为 0.153.2，见下表；实现/QA 必须记录实际二进制版本并证明首轮读取。
- 已读取物化的 `.claude/skills/linear-issue-context/SKILL.md`，与动态 issue 描述一致。只读 Bridge Linear 代理返回 HTTP 401，未拿到更新的远端评论；非阻塞 Lead 问题 `b3c5f047-e608-4d40-8bef-0e8dd2b1dabb` 用于接收后续裁定。不宣称远端 issue 已独立复查成功。

## 消费者与接线位置

| 位置（基线行号） | 已有行为 | B2 处置 |
|---|---|---|
| `packages/claude-runner/src/codex-home.ts:302` | project/role 经校验与同一编码器建路径 | 原样复用，不加别名 |
| 同文件 `:572–629` | admit 持锁，核 marker，授租约 | marker 身份通过后、首次租约前发布 seed |
| 同文件 `:1947` | 每次 provision 写受管 AGENTS.md | 修改合同源，复用已有写路径；无需另一个 prompt 装配器 |
| 同文件 `:2024` | provision 同锁、凭据/技能装配 | 不在那里多文件覆写原生 memories |
| 同文件 `:2266` | execution home 反查：keyed/prepublished/legacy/unknown | 只允许 legacy 作为来源；其他种类不猜路径 |
| `packages/edge-worker/src/Blueprint.ts:978` | project + generalized nodeId 身份解析，启动事件前 admit | 传候选读取闭包给 admit；当前 node id 是唯一 role |
| `packages/teamlead/src/bridge/run-infra.ts:821,1444` | Blueprint composition | 构造器/工厂末尾注入最小查询闭包 |
| `packages/teamlead/src/StateStore.ts:10757` | `getProjectSessions(project)`，参数化 SQL，所有状态 | 精确过滤即可，无新表/迁移/查询 API |
| `packages/teamlead/src/DirectEventSink.ts:239,259,309` | 引擎 nodeId 与 session 同步落盘 | 历史身份事实来源 |
| `packages/teamlead/src/StateStore.ts:8070` | nodeId set-once 冲突拒绝 | 不从显示字段覆盖它 |
| `packages/teamlead/src/bridge/codex-session-reown.ts:291,309` | legacy 恢复不迁移，keyed 重新准入 | 恢复时不补种，避免恢复中的 home 发生结构变化 |
| `packages/claude-runner/agents/codex-runner-contract.md` | home 的开场说明源 | 固定指针；历史是资料，不是授权 |

`resolveRunnerMemoryIdentity` 支持 agentName 回退，但当前 Codex Blueprint 不传该字段。B2 维持这一调用形状；不能为了“多导一点”把 fallback 接回来。`session_role`、`agent_name`、tmux 标题、worktree、issue 名都不是新身份来源。`implement` 与 `eng_implement`、`design` 与 `eng_design` 各自独立；改名不隐式搬记忆。

## Codex 文件所有权与首轮读取

| 本地源码 | 事实与设计后果 |
|---|---|
| 旧 checkout `codex-rs/core/src/memories/prompts.rs` | 原生开场主要装入 memory_summary，不能保证任意拷入文件自动进入上下文 |
| 旧 checkout `codex-rs/core/src/memories/storage.rs` | DB 无输入的 Phase 2 路径可删除 MEMORY.md、summary、skills 并重建/裁剪 raw、rollout_summaries |
| 新 checkout `codex-rs/ext/memories/src/local.rs:30,46–59,75` | 原生工具根固定 home/memories，拒绝隐藏路径、绝对路径、越界和软链；不能读 `.flywheel-memory-seed` |
| 新 checkout `codex-rs/memories/write/src/extensions/ad_hoc.rs:8–24` | extensions/ad_hoc/instructions.md 是固定说明，不是个人历史 |
| 新 checkout `codex-rs/ext/memories/src/local/ad_hoc_note.rs:12–37` | extensions/ad_hoc/notes 下存在直接记下的真实记忆；精确保存它并区分未蒸馏来源 |
| 新 checkout `codex-rs/memories/write/templates/memories/consolidation.md` | Phase 2 的内容合并由模型判断，不能充当 B2 可复现的冲突规则 |

因此入口明确为 shell 读取 `$CODEX_HOME/.flywheel-memory-seed/index.md`，再读取所需 snapshot 文件。不声称接入 `memories/read`，也不把全量历史塞进每次 prompt。首轮“可用”必须同时有 provision 之前的落盘顺序证据和真实 runner 首轮读到标记的证据。AGENTS 指针自身不是模型已经读取的证据。

## 只读历史库存（2026-09-08）

sessions 中 606 条 `(flywheel, implement)` 有 workflow_node_id；152 条粗分类 implement 没有 nodeId，另有其他无 nodeId 旧分类。只统计 legacy home 的 Markdown 文件元数据，不输出记忆正文：有 nodeId 的 implement 中 288 个 home 含 Markdown（completed 211、failed 31、terminated 34、blocked 12）。其中 MEMORY.md 216、raw_memories.md 225、memory_summary.md 216、rollout_summaries Markdown 2；extensions 内有 288 份 Markdown，另有 7 份 phase2_workspace_diff.md。

所有已查 Codex session 的目录共 1466 份 Markdown、796118 bytes、最大单文件 4867 bytes（含不导入的内部说明）。这些是库存元数据，**不是有效记忆条目数**；也不将 `# Task Group` 作为硬解析条件。QA 应使用真实蒸馏格式的去敏夹具，并写明采集来源及原始文件 hash。

### Lead 补充：未导入的旧家要说人话

Lead 对问题 `b3c5f047-e608-4d40-8bef-0e8dd2b1dabb` 已答复同意全部范围/身份/RED 口径，无 B1 后新裁定；要求在设计产物明确多少旧家不导入及原因。按白名单且非空 UTF-8 重新只读盘点：`flywheel/implement` 有 225 个旧家可提供候选历史；另有 **127 个旧家有候选历史但缺少可靠岗位身份（flywheel 126 个、sub 1 个），因此不会自动导入，原文件保留**。本阶段未执行任何迁移；这些数量是 2026-09-08 盘点快照，不是上线完成数。上段 288 是含任意 Markdown 的宽库存，不能拿它当可导入数。

## 文件与数据边界

只读白名单：根目录 MEMORY.md、memory_summary.md、raw_memories.md；rollout_summaries/*.md；skills/**/*.md；extensions/ad_hoc/notes/*.md。保留原相对路径。跳过空白文件；其他内容必须是合法 UTF-8。不复制隐藏目录、.git、extensions 固定 instructions/resources、phase2_workspace_diff、脚本、auth/config、原生数据库或会话原文。

不分析语义、不自动挑“更可信”版本；相同树只保留一份物理快照，manifest 记录所有来源。不同树都保留，manifest 按 executionId 确定性排序；导航读取 session 已保存的日期/任务号/标题，按历史日期倒序，不把它当正确性排序。开场 index 最多 8 条/8 KiB，完整 catalog 可按任务号/主题搜索，不把全部来源 ID 和 skipped 强塞开场。旧文档中指向源 home/其他项目的绝对路径仍是历史文字，合同禁止据此跨家读取。引用缺失的脚本不执行。

## 原子发布与迁移

在现有家锁里先构建同目录 staging，完整验证后 rename 为固定 seed 目录；目录内 manifest 是唯一完成凭证。不要再在 B1 marker 镜像一个 seed 状态。已存在完整 manifest 直接复用；已有 B1 home 没 seed 且有租约时 deferred_busy，下次租约归零再尝试，不在忙碌家热迁移。恢复路径无候选 loader，不触发迁移。

旧 source 只要求是已终态执行的稳定文件快照：终态不等于进程已死。两次完整扫描（相对文件集+逐文件hash）必须一致，期间不稳定就失败、保留来源和未完成状态。此方案是首次准入时的快照，不承诺抓取该截止时刻之后旧任务追加的内容；不会删除它们。若未来要求晚到回收，另行扩展，不能偷偷接清理。

## 验证入口

- `packages/claude-runner/test/codex-home.test.ts` 已有身份、租约与 8 子进程栅栏，可扩展种回恰一次和崩溃恢复。
- `packages/edge-worker/src/__tests__/Blueprint.fly1356-skill-framework.test.ts` 可证明调用顺序及 adapter 开场前文件已在。
- `doc/qa/framework/529-room-playbook.md` 真 Codex 入口为 `scripts/test-deploy.sh <slot> --generalized --codex-runner --no-lead`；默认 QA 是 Claude，B2 需显式独立 Codex qa 身份夹具，不能拿默认房型冒充反向验证。
- B1 的 a2 lifecycle 写的是任意 sessions 文本，不是蒸馏记忆；a7 脚本依赖旧路径和公共凭据，不能照跑。
- 本节点只交设计；四条 RED/GREEN、真实首轮读取和源码变异由 implement 提供工具、QA 在隔离房执行。


## R1 导航规模纠正

评审实测同对历史可产生 217 个不同快照。初稿把目录/UUID 全列开场，没有任务名/日期，也没有生产规模夹具，构成 HIGH `seed-archive-unnavigable`。plan §3/6/7 已改为确定性来源元数据、有界近期入口、完整可搜索目录及旧任务首轮检索证据。2026-09-08 19:44 UTC 只读复核：607 条同对 Codex session 全有 started_at 和 issue_title，其中 605 有 terminal_lifecycle_id；来源事实已经存在，无需额外生成摘要。原有 Blueprint 测试名来自 B1 计划而非最终文件，已按当前仓库更正到 fly1356 文件。
