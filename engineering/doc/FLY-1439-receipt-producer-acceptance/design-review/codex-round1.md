# Design Review — FLY-1439 plan.md (Round 1)

Date: 2026-07-23
Author: Codex
Status: CHANGES REQUESTED

## Summary

计划的验收分层、head pin、阳性对照和四路取证思路是对的，且 S1–S5 与五条 acceptance criteria 基本一一对应。但当前版本仍有几处会让执行节点无法按既定 oracle 得到可信结论：生产插件检查仍可能写生产、S2 的 hang/kill 仍依赖 5 秒时序且会被并发 reply/settle 改写状态、S3 的 `chmod 500` 故障注入实际上打不中。补齐下面这些可执行合同后再实施。

## What's Good (Keep)

- 把被测 fork head 钉死为完整 SHA `bb0a150989c0d7477bbb03543052c87ee229d368`，并要求开跑前和落 verdict 前二次核验；head 漂移即作废重测，方法正确。
- 没有把独立 QA 变成第二次 code review；S1–S5 对应五条验收，且明确区分产品缺陷、harness 缺陷和已验证的上游范围。
- S1 为“processed 后零重发”配置了同一 patrol 下的未 settle 阳性对照，避免 patrol 根本没跑却空过绿。
- 正确识别窗口 env 的两个消费点：插件 complete 写 SLA 与 Bridge patrol advanceDue 必须看到相同 P0/P1 覆盖。
- shim 只顶替 `flywheel-comm` 根 CLI 入口这一机制判断成立：`packages/teamlead` 运行时代码使用 `flywheel-comm/*` subpath exports，没有导入根 `"."`；因此 Bridge 的库调用不会因为 `dist/index.js` 被顶替而改变。
- S2 覆盖 begin intent、notify→complete 和 settle write-ahead 三个最有价值的恢复窗；S2c 直接瞄准 code review R1 的真实缺陷边界，而不是只复述单测。
- `FLYWHEEL_DELIVERY_SECRET_PATH`、短 `TMPDIR`、证据先落盘再 teardown、FAIL 单消费与证据保留纪律都应保留。

## Issues & Recommendations

1. **[HIGH] “生产插件缓存全程只读”目前不是前置保证，启动 Lead 仍可能直接改生产。**  
   `plan.md:49,70-73,118-123` 把 `~/.claude/plugins` 定义为零写并把 G0.4 放在部署后；但 `packages/teamlead/scripts/claude-lead.sh:712-737` 每次启动都会调用硬编码 `$HOME` 的生产 `check-discord-plugin.sh`，失败即调用 `update-discord-plugin.sh`。后者在 `~/.flywheel/bin/update-discord-plugin.sh:6-56` 会 `reset --hard origin/main` 并 rsync 覆盖生产 cache/marketplace。事后看 mtime 只能发现事故，不能阻止事故，而且 rsync `-a` 也使“mtime 落在部署窗”不是可靠内容证据。  
   **建议修正：**Q1 增加一个仅由 test-deploy 显式传入、default-off 的 QA skip seam，使本次 slot Lead 完全不执行生产插件 check/update，并加 unset/set 两态守卫测试；若不愿加 seam，至少必须在任何 Lead 启动前执行生产 check 并要求 rc=0，非零立即停，绝不让 launcher 进入 update 分支。G0.4 改为 pre/post 内容快照：`installed_plugins.json`、实际 active cache 和 marketplace 的 `server.ts`/`.fork-sha` hash、生产 fork clone HEAD/status，而不是目录 mtime。另禁止把原始 `ps eww` 落盘：它会包含 Discord/API token；进程路径用不含 env 的 `ps -o pid,ppid,command`，companion marker 用 pane 内白名单 `env | grep '^FLYWHEEL_LEAD_COMPANION='` 取证。

2. **[HIGH] G0.1 的“该目录 git HEAD = bb0a1509”不能证明实际加载字节，按 E3 的 rsync 结构甚至可能不可执行。**  
   `plan.md:49,70` 先把 fork 内容复制到 isolated marketplace/cache，再要求对该运行目录 `git rev-parse`。复制目标通常不是 pinned checkout；即使 marketplace 上层恰有 `.git`，那个 HEAD 也可能是 marketplace 安装源，而不是后来覆盖进去的 Discord 字节。手写 `.fork-sha` 同样只是标签，不是事实。  
   **建议修正：**G0.1 同时证明三件事：(a) MCP argv/script path 在 isolated config 下；(b) `installed_plugins.json`/`known_marketplaces.json` 的绝对路径均指向 isolated root；(c) 对实际 runtime Discord 目录生成受控文件清单与 SHA-256，并与 `git archive bb0a1509:external_plugins/discord`（排除 `node_modules`、lock/install 产物和 `.fork-sha`）逐文件比较为零 diff。另单独记录 E2 checkout 的完整 HEAD。若沿用 rsync 的完整配置 recipe，必须明确包含 absolute-path rewrite 和 stale Lead session-id 清理，不能让 implement 节点从一句“按既有 recipe”自行猜。

3. **[HIGH] shim 的恢复与 hang 协议未冻结，现规格既不能保证确定性，也可能给后续 slot 留下污染。**  
   `plan.md:51,57-64,121,129` 直接改当前部署 checkout 的 ignored `dist/index.js`，但 teardown 写的 `git checkout -- dist` 无效（仓库 `.gitignore:16` 忽略 `dist/`）；QA 中途失败也没有 `trap` 保证复原。更关键的是 pinned runtime 在 `chat-receipt-runtime.ts:83,654-666` 固定 5 秒后 `proc.kill()` 并等待退出；普通 Node `sleep 3600` 会在 5 秒被杀，S2b/S2c 仍要求操作者抢在 5 秒内取证/kill。只有最终 ledger 行也无法区分“调用尚未开始”和“已进入但未结束”。  
   **建议修正：**使用本单独占的部署 worktree，安装 shim 前记录 original hash，原子 `mv index.js index.real.js`，从 Q1 起注册 EXIT/INT/TERM trap，复原必须 `mv index.real.js index.js` 或 clean rebuild 后核 hash，并删除残余 `index.real.js`；不要声称 `git checkout -- dist` 可恢复。ledger 改为同一 `callId` 的 `start`/`end` 两态，hang 命中时另写原子 barrier（含 shim PID、subcommand、message-id）。driver 必须等 barrier 后自动执行 kill，不靠人工；明确 shim 对 runtime 的 SIGTERM 行为、插件被 kill 后 orphan shim 的强制清理与零残留检查。S2c 的 write-ahead 证据应是“settle start barrier 已存在 + intent 已存在 + 尚无同 callId end”，不能只靠“没有结束行”反推已进入。

4. **[HIGH] S2a/S2b 的预期状态没有控制真 Lead 的并发回复；合法的 settle-before-complete 会让计划期待的 redelivery 消失。**  
   `plan.md:90-92` 假设 M3/M4 在恢复时仍是未处理 pending。但真模型收到 notification 后可以立刻带 `reply_to` 回复；`server.ts@bb0a1509:1228-1244` 会马上 write-ahead + settle，而 pending selector 明确排除 `processed_at IS NOT NULL`（`packages/flywheel-comm/src/lead-inbox-queue.ts:749-781`）。因此 M3 可能在 begin intent 补账后先由 settle intent 变 processed，M4 也可能在 kill 前 processed；两者都不会出现计划要求的 `[redelivery]`，这不是产品失败。  
   **建议修正：**给 S2a/S2b 冻结“不产生 settle”的确定性控制，例如场景期间使用独立 access 配置令 `replyToMode=off` 并在结束后恢复，或让 driver 在 `complete:start` barrier 出现时自动 kill 且先断言 Discord 无成功 reference、DB `processed_at IS NULL`。S2a 若仍允许真回复，必须预先写成两个合法 oracle：有 durable reply proof 时 `begin replay → settle replay → processed、零 redelivery`；无 proof 时才 `begin replay → pending reconcile → redelivery → delivered`，不能事后“以实测为准”。S2b 若目标就是证明 notify→complete crash redelivery，则必须强制第二条 oracle。每个场景结束还要断言没有遗留 begin/settle intent，避免污染下一场景。

5. **[HIGH] S3 的 `chmod 500` 不会造成 spool-write failure，且当前“恢复后 M6 自愈”的预期不符合实现。**  
   `plan.md:98-100` 对 spool 目录做 `chmod 500`，但 producer 每次写前都会在 `chat-receipt-runtime.ts@bb0a1509:541-543` 对同一目录执行 `chmodSync(..., 0o700)`，所以该故障会被被测物自己修复，M6 很可能正常落 intent。即使真正打中 begin+spool 双失败，系统也没有 M6 的 begin intent可供后来 drain，“恢复权限后 M6 自愈”不是合同；若 Lead 再带 reference 回复，还会触发 settle-intent 写入/第二类 advisory，使“总共恰一次 ⚠️”也不稳定。  
   **建议修正：**采用不会被 `ensureSpoolDir()` 修好的黑盒故障，例如先原子挪走空 spool 目录并在 `chat-receipt-spool` 路径放普通文件，或增加仅测试可用的 FS fault seam；全程用 trap 恢复。PASS oracle 明确为：M6 仍被模型收到（fail-open）、begin-spool-failed 专属 advisory 可见、comm.db 无 M6 行、无伪 delivered；不要要求 M6 自愈。恢复后另发 M7 做健康阳性对照并要求完整入账。若 M6 必须证明“Lead 能正常回”，要么临时 `replyToMode=off` 隔离 settle 腿，要么分别计数 begin 与 settle 两种 advisory，不能把它们混成一个 latch。

6. **[HIGH] S4 尚没有可照抄的 companion 启动路径，且“spool 目录不存在”会被 S2/S3 历史状态直接证伪。**  
   `plan.md:104-107` 只写“给 flywheel-projects.json 增 companion 条目再起 Lead”。现有 `scripts/test-deploy.sh` 在启动前已把构造出的 JSON 同时写文件、塞进 `FLYWHEEL_PROJECTS` env；`scripts/lib/qa-multilead.sh:19-55` 的 builder 也没有 companion 字段。部署后只改磁盘文件不会改变已启动 Bridge/Lead 的 boot-time config。若复用主 Lead 的 `DISCORD_STATE_DIR`，S2/S3 已创建 spool，绝不可能再断言目录不存在。  
   **建议修正：**计划写出一种唯一做法：要么给 test-deploy builder 增加 default-off companion test hook；要么停止标准 Lead 后，用新的 companion 专属 `DISCORD_STATE_DIR`、workspace/session-id 和预先含 `companion:true` 的 `FLYWHEEL_PROJECTS` env 手动调用同一 launcher，同时继续传 isolated `CLAUDE_CONFIG_DIR`。说明 Bridge 是否需要重启、使用哪个 bot/channel、如何恢复/teardown。断言改为 pre/post delta：该 companion lead 没有新增 `chat:<companion>:` 行、没有新增 begin/settle intent、没有 receipt advisory；不要依赖全局目录“从未存在”。

7. **[MEDIUM] S5 放宽为“断言同数量级”会弱化 pinned-head acceptance，mutation 也未隔离到可恢复的准确 seam。**  
   `plan.md:111-114,151` 一方面钉死 `bb0a1509`，另一方面允许 172/411 漂移后按“同数量级”PASS；这会让 test discovery 少跑一批仍可能过门。m3“破坏 begin 幂等”也未说明改 fork runtime、测试 wrapper 还是主仓 CLI；真正的 duplicate-row 幂等权威在 PR-1 CLI/DB，不在 fork producer，执行节点会被迫猜。直接在 E2 的被测 checkout 做 mutation 还会污染最终 head/byte evidence。  
   **建议修正：**默认硬门保持精确 `172 pass / 0 fail / 411 assertions` 且输出中零 `SKIP LOUD`；若 Bun 版本确实改变计数，先给出逐测试文件 discovery diff 和等价性证据，再由明确例外规则决定，不接受“同数量级”。三次 mutation 全部在额外 disposable detached checkout/copy 中执行，每次写清“改哪一行/跑哪个测试/必须出现哪个失败”，每次后立即恢复并验证 clean；m3 要明确 mutation 到真实 CLI integration seam。最终 verdict 前重新对运行 checkout 做 full SHA、tree diff 和 `git status --porcelain` 三重 clean 检查。

8. **[MEDIUM] S1 阳性对照的 ack 收尾缺少 lease/执行身份合同。**  
   `plan.md:82` 只写 `handle-receipt ack`，但该命令要求有效 Lead lease；FLY-1426 的 QA 报告也明确 module harness 因未配 lease没有执行这条腿（`engineering/doc/FLY-1426-inbound-message-receipts/qa-report.md:46`）。从 QA runner shell 直接调用未必有 pane 内的 generation/lease env，可能把 harness 权限失败误判为产品失败。  
   **建议修正：**冻结完整命令、唯一 `request-id`、执行位置（真实 Lead pane 内或显式注入经验证的 lease env）和 DB 后置条件；同时把阳性对照证据写成 resend child + root round/`receipt_resend_deliveries`/Lead 可见提醒中的至少两路。若本单不需要重新验 ack，可用已定义的 settle/隔离清理方式收尾，并把 ack 留在上游已验证范围，避免额外门。

## Verdict

CHANGES REQUESTED — address items above
