# FLY-1948 slot Lead 通道活连接 — 实现续跑核对
Issue: FLY-1948 (https://linear.app/geoforge3d/issue/FLY-1948)
日期: 2026-09-14
基于: plan.md

## QA 返工 attempt 3（2026-09-15）

- QA 在 `fe75cff1a` 的 mirror 房记录 `reply_timeout`（exit 34）：消息已入箱并 ACK，但未收到回复。共享频道 FLY-152 规则要求正文包含目标 Lead mention 或 literal name；原探针两者皆无。QA 的带 mention 对照 16.2 秒回包，roundtable 对照亦通过。
- `dde12a0fd` 在自动发送和人工提示共用的 challenge 正文前添加坐标文件中的目标 bot mention，保留 mirror 支持、既有发送准入、禁止自动 mention 通知的 `allowed_mentions`、作者/nonce/路由校验与所有 deadline。
- 两条回归覆盖自动 mirror 请求体和人工提示，验证目标为收件 Lead 而非发送 bot、ack nonce 保留。修复前 28 pass / 2 fail（缺失目标 mention），修复后 30/30 通过；定向 Biome 与全仓 lint 通过。build、最终 HEAD CI/审查与 QA 真机复测分别取证，不将本地测试当作真实整圈验收。

## 最终实现核对（2026-09-14；以下旧批次保留为历史）

- C1–C6 已实现；C4 `d369d37b4` 的真实临时 SQLite / REST seam 测试 28/28，C6 `3b8005d95` 登记 CI、更新烟测和路书。未执行真实 Discord challenge 或生产操作。
- 设计复核 R2 的权威 check 已返回 `reviewVerdict=APPROVED`，request `fcf62c22-0ca0-4a2b-b439-05e0b7aac975`；原始回执见 design-review-resume-r2.json。早先 CLI 注册失败记录不再代表最新门状态。非阻塞建议已向 Lead 报告。
- `pnpm lint` exit 0（18 条现存 warnings）；`pnpm -r build` exit 0。完整 package gate 仍在运行，尚未声称通过。
- build 后 base/head 的相同 reaper fixture 均 exit 0，夹具 SHA256 `523f7d579b3b7f911cc61e4cf9b6af4253d011c0cd49efbc01ca78bd1207356a`；reaper 源码及既有断言未改。此前红色回执仍保留，恢复发生在 build 后，未据此断言根因。
- 部署重跑仅剩文档表格计数失败：新增退出码单元格命中了既有十五条踩坑表的全文件正则。已将新增退出码渲染为行内代码，原有十五条记录与断言不变；重跑已验证计数通过，但旧 daemon reaper 仍间歇失败。
- 代码审查、PR、exact-head CI 和真实 529 founder 整圈验收尚未完成。

## 续跑更新（下方为启动时快照）

- Lead instruction `b7760e74-9fc9-4c3f-bec3-3c4e1a0c2c30` 明确确认设计 APPROVED via leadAcceptance、要求直接按 v4 实现。已切换 stage implement；先前额外复核 gate 仍 pending，不覆盖此最新交接。
- `design-review.json` 未在任务目录找到；已读 plan 的 acceptance 记录和 `design-review-gemini-v4.md`，后者 verdict APPROVED。未伪造缺失 JSON，已在 Lead 报告说明。
- 冻结依赖安装已确认 exit 0（20.4 秒）。
- C2 的独立 timeout helper：RED `ff144a80d` → GREEN `31ac1e2d9`，qa-room-env 33/33。
- C2 的 coordinate writer：RED `8c72955c9` → GREEN `eb03c903e`，已验 ordinary/mirror/roundtable/extra/Codex 的精确频道、0600、相同输入字节稳定、ambient env 不改身份。尚未接入部署；`--no-lead` 的零文件行为必须由部署集成测试证明。
- C1/C3/C4 与 C2 接线、C6、全仓测试、代码评审、PR/CI 仍待完成。

## 权限与设计门

- 当前实现执行: `40a55a85-3d6c-452f-8f1a-cb9c452feb38`。
- TURN 已实查: `yours phase=implement epoch=3`, run `3887813b-263b-46db-8bb6-6d2771a87e99`, attempt 1。
- 已有设计交接 HEAD `bb9ee591f`; C1–C6 尚无实现提交。
- plan v4 记载 Lead acceptance `c04d28e5-1527-49f9-98d0-db2131dd5b2a`。续跑要求核实未确认的 gate，已注册设计复核 gate `75c43ed1-7f62-4b81-9c2f-19ef3d6ef686`、request `5ff10dc4-d710-4590-886c-fbd685e1fdb2`，accepted=true。当前 check 为 `not yet`，不是通过。
- 下一轮先 check 此 gate 和 inbox，不重复注册；有效 APPROVED 后 stage implement，再用 progress 的 implement phase。当前 stage design_review 会拒绝 implement phase 的 progress 写入。

## 当前源码核对

| 计划项 | 已确认的接线点 | 待交付证明 |
| --- | --- | --- |
| C1 | qa-launchd-lead.sh 提供 env 精确匹配、UTC incarnation、launchd PID helper；插件 0.0.7 gateway-health.ts 的 ready/resumed/reconnecting/deadline 文案与 v4 一致 | 12 个 reason、代际、轮转、观测失败、脱敏夹具 |
| C2 | qa_slot_start_lead 写 claude manifest 并做 topology verify；Codex 有独立分支；主/extra Lead 仍凭 lease 置 ready | 每 Lead 坐标、mode 精确频道、channel 门、清理失败路径、Codex N/A |
| C2 diagnostics | qa-lead-diagnostics.py parser 只接受 bootstrap/topology；body_snapshot 已有 carrier/manifest/launchd 三方 PID 校验 | channel 文件来源/大小/schema/身份验证及负例 |
| C2b/C4 | discord-chat-ingest 已内部 import parser，package export 有 discord-chat-ingest；createdAt 使用 envelope.ts | 公开 re-export、fresh dist import、真实临时 SQLite、绝对 deadline 与作者/回复路由负例 |
| C5 | launcher poller 捕获失败会清空 pane_text；日志写失败均 fail-open | 保留最后成功 capture 的分类数据，新增行不改变按键/超时/返回行为，禁止 pane 原文 |
| C6 | CI 显式登记 shell/diagnostics 测试；milestones README 要求 executor 最后 commit 创建本 issue 文件 | 新测试登记、路书、烟测、最后 milestone commit、全仓验证和 exact-head CI |

代码评审首轮必须逐项复核 v4 的 adapter generation cutoff、日志轮转 canonical merge、launchd PID seam。旧 research.md 含已被 v4 修订的描述，以 plan.md 为准。

## 当前环境与验收边界

- 冻结依赖安装使用 `CI=true pnpm install --frozen-lockfile`；日志 `/tmp/fly1948-install-ci.log`。最终退出码须单独确认。
- 当前 sandbox 拒绝 `ps`（operation not permitted）；这不证明进程缺失，也不能据此声称真机 liveness 已验证。离线观测 seam 测试可继续，真机 529 验收由 QA 节点承担。
- 尚无行为测试、实现、代码评审、PR 或整圈通过证据。本节点不 dispatch QA、不 merge、不重启生产服务。

## C1 / C5 / 诊断器批次（2026-09-14）

- C5：`d86aedbac`，poller 完整 suite exit 0，37 passed / 0 failed；raw tty 受限的 E 层仍未执行，不能据此声称 host PASS。
- C1：`69f6ab9b7` 初始实现，`198167305` 修复设计复核 HIGH；离线 suite exit 0，30 条 PASS，含 300KB/1000 行 ps 正例、4MiB 上界、候选数上界、适配器代际、轮转同时间戳排序、三次不稳定读取、身份来源拒绝、脱敏。该脚本尚未接入部署或 CI。
- C2 诊断器：`bcd47a313`，完整 node:test 17/17，含 channel 文件缺失、越界、symlink、agent 不符、live=true、未知 reason、超大文件的拒绝。
- 设计复核 R1 唯一 HIGH 为 ps 快照统一 64KB 上限；修复见 plan §14，原始回执见 design-review-resume.json。
- 新 gate `80787793-5e2e-46db-b624-06a4d6506e01` 已创建；request-review 命令运行 handle `91039`，连续三次请求超时后仍由 CLI 自带重试中。尚不能声称注册 accepted；下轮先轮询同一 handle，若明确终止失败则按 CLI 指出的 request-id 重试，禁止重复创建 gate。
- C2 主/extra Lead 部署接线、C3 CLI、C4 roundtrip、C6 路书/CI/烟测、全仓验证、代码评审、PR 和 exact-head CI 均尚未完成。没有 QA、merge 或生产重启动作。

R2 注册续记：handle 91039 已结束，四次重试均 aborted；CLI 明确 NOT registered，request ID `fcf62c22-0ca0-4a2b-b439-05e0b7aac975`。已用同一 request-id 发起恢复注册，当前 handle `46719`；Lead 报告命令 handle `77664`。下轮先读这两个命令的最终结果，不把 pending gate 当活评审。

## C2 / C3 / CI 接线批次（2026-09-14）

- `73e634a26`：主/extra Lead 的 lease 后通道门、每 Lead 坐标、channel 快照、Codex N/A、generalized room-info.lead、stdout.leads、preflight build flywheel-comm 与 parser 公开导出已实现。
- `d8f44c5df`：独立 C3 CLI 10 场景 exit0（套件退出码），覆盖 CLI 0/1/2/3/4/5、双 Lead、mirror/roundtable、缺失 agent、Codex 零 liveness 文件。
- `dd5b4cb70`：四条 hermetic shell suite 登记 CI，qa-room-env 从 manual-only 移出；enumeration suite exit0。
- qa-lead-coordinates 通过五类坐标夹具与真实 shared gate 函数的成功/失败快照路径；qa-lead-artifact-fixtures 7/7；comm build exit0，fresh dist canonical parser require 成功。
- **部署 aggregate 未过**：`/tmp/fly1948-deploy-red.log` 为 10 条新增接线断言失败 + 1 条 real daemon reaping 失败；`/tmp/fly1948-deploy-green.log` 新增断言全过，但两条 real daemon 断言失败（live socket without ledger proof；ledger/socket proven group reap，日志 outcome=unverifiable）。后者在接线前已失败；前者本轮新观察到，尚未完成 base/head 隔离，不得宣称全属已确认基线。未 skip、未改该断言或 reaper。
- 复核注册重试 handle46719 已明确 exit2、NOT registered；只读 Bridge /health 超时。现使用同一 request-id 再试，handle58899；先轮询该 handle，不重复 gate。待注册成功再 check gate80787793-5e2e-46db-b624-06a4d6506e01。
- 下一步 C4 roundtrip challenge/response + SQLite deadline 测试；C6 路书/烟测；全仓验证与部署失败隔离；有效设计/代码评审、PR 和 exact-head CI。没有完成或 QA 验收声明。

## 全仓验证与观测限制续记

- `35aa9774b` 已正常 push 到 origin/flywheel-FLY-1948；尚未建立 PR。
- `/tmp/fly1948-deploy-final.log`：完整部署套件 exit1，仅旧 real daemon reaper 的 ledger/socket proven group 回收失败。新增接线断言及十五条踩坑计数通过。
- 隔离夹具增加临时 PATH 观测 wrapper（不修改仓库脚本、不改变返回值或超时）：先观察到 lsof 2.21s，而后 reaper 内调用 1.26s，夹具通过。完整套件 trace `/tmp/fly1948-deploy-observed.log` 再现 exit1；外层 holder 查询 2.62s，reaper 内 wrapper 只有 start 无 end，符合现有 2s timeout 截断。原始轨迹 `/tmp/fly1948-lsof-observation.jsonl`。该诊断支持主机观测时限解释，不代替完整套件通过证据。
- `stage set code_review` 已持久排队，但 Bridge health 超时导致未结算。review_code gate 返回 STAGE_PENDING，**尚无代码评审 question/request，不得按 pending reviewer 等待**；待 stage 结算后重试 gate 和 request-review。
- 当前 package gate 的确切目录为 `/var/folders/zl/nz5kfm5976q8p6kbt4d0cpgr0000gn/T/flywheel-package-gate-cCwLWn`，root=本 checkout，head=`3b8005d95bff0101abd8b99e49611f620567d9af`。只使用此执行回执；其他 checkout 的 /tmp gate 回执不属于本次验证。

## PR #1200 首轮 CI 修复

- 草稿 PR https://github.com/xrliAnnie/flywheel/pull/1200 在 `e60dea243` 创建，milestone 为当时 literal last commit；GitHub mergeable。
- CI run `34910761777` 的 Quick Gate 在 CI structure guard 失败。本地原样复现：新增 FLY-1948 命名步骤未登记 `expected_shard_tests` 固定清单。
- 已补齐该清单，并增加精确命令顺序约束（先 build comm，再运行全部五个测试入口）。`bash scripts/__tests__/ci-structure.test.sh` 由 RED 转 GREEN；未移除或放宽原有守卫。
- package gate 仍运行；代码评审 stage/pr_created stage 仍延迟，尚无 reviewer 注册。草稿不是完成回执。

## Retention consumer 登记（2026-09-15）

- 第二轮 CI `34911091268` 已通过结构守卫、build、typecheck、lint；Quick Gate 最后在 retention consumer gate 失败：`unclassified_retention_consumer:scripts/qa-529-discord-roundtrip.mjs:mailbox:read`。
- 本地复现该唯一错误后，给 roundtrip 的只读 mailbox 查询增加独立 `candidate_guarded` 登记，与现有 slot QA 观测消费者一致。本工具查询当前 nonce/message 精确行，在有限 deadline 内完成，不要求保留历史归档行；不修改 retention policy 或生产查询。
- retention gate 测试 8/8，真实扫描 `ok=true, errors=[]`。
- 代码评审已恢复注册：gate `46d59d7c-66f6-4936-9379-c980f88e528a`，request `71b4dbc6-7ae7-4be3-b396-a5905e7e7c28`，accepted=true；请求时 HEAD 为 `d93ede70b`。后续 HEAD 的登记修复需要重新绑定最终审查和 CI，不能沿用旧 HEAD 的通过声明。

## CI 后续清单与部署夹具核对（2026-09-15）

- Unit heavy 在旧 HEAD 的唯一失败是 kill-path inventory 仍列出已被通道巡检替换的 smoke `kill -0` 探针。已通过 `scanKillPathInventory()` 重新生成，diff 仅删除该 qa-only 条目。专项 Vitest 的三项守卫通过，但两项扫描耗时 33.9s / 30.8s，超过既有 15s 上限，exit1；保留 `/tmp/fly1948-kill-inventory-green.log` 红色回执，不修改上限、不声称全过。
- CI script shard2 的 FLY-1389 hermetic fixture 未复制新库，造成启动前退出。正在补齐真实库及模拟 process/env/socket observations，让部署调用真实 reducer；已观察到 channel-liveness live=true 和主 Lead E2E 通过。
- 该旧夹具还使用 `chan-31` 等非 Discord ID，已改成数字身份。新增模拟 readiness 的 sleep 尚影响其 --alerts 1s lease 测试；当前 full fixture handle59901 正在运行，结束前不编辑。下一步移除 lease 前等待，改由观测夹具提供 fresh gateway 行，然后完整验证。
- 本地 package gate handle84131 已进入 flywheel-comm；claude-runner 阶段已有真实超时断言失败，不符合仅 onTaskUpdate 例外，最终完整回执仍待结束。

## Hermetic 部署夹具修复验证（2026-09-15）

- 去掉模拟 carrier 发布 lease 前的额外等待。模拟 ps/env/start/socket seams 只提供观测输入，真实 `qa_discord_liveness_wait` / reducer 与失败快照仍由部署脚本执行；gateway 行按观测时刻写入真实夹具文件。
- 旧完整重跑为 21 passed / 4 failed（alerts lease 与连带 extra Lead 检查）；提取同一测试文件的 T/D/A/D1/新增 D2/C 用例、保留原断言，修复后专项为 **6 passed / 0 failed**（`/tmp/fly1948-fly1389-focused.log`）。D2 证明 ready lease + missing socket 必须拒绝，且保留 0600 channel-failure 证据。
- 该专项不替代完整套件。完整套件将随本次最终 HEAD 的 CI 和本地重跑再验证；旧 CI 的其余分片已过，仅 retention / fixture / kill-inventory 三处失败，未把旧 aggregate 改报绿色。

## 最终交接核对（2026-09-14）

有效评审、CI、完整部署夹具及七条非阻塞建议见 follow-ups.md。Lead handoff `115a2126-98e6-475d-9bf0-9eb17da84ff0` 指定 exact-head CI 为权威验证、禁止继续主机全量套件。新启动的本地重跑在 build 阶段停止，未声称 package aggregate green。完成路由为 needs_review / PR1200，真实整圈验收保持 QA 边界。
