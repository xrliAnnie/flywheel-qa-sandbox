# FLY-2455 529 房启动恢复 — 根因与增量实施计划
Issue: FLY-2455 (https://linear.app/geoforge3d/issue/FLY-2455/529-房台架-test-deploysh-起不来-529-slot-lead卡在-qa-launchd-topology-校验)
日期: 2026-09-09
基于: plan.md, research.md, c3-repro.md

## 结论及证据边界

当前隔离 main 上稳定复现的启动阻断是 **inbox MCP 配置重算 CommDB 到 HOME，导致 readiness lease 写者与等待者路径不同**。Lead carrier 已启动，部署随后等待 `${SLOT_DIR}/state/comm/test-slot-2/.inbox-ready-flywheel-test-2` 120 秒并失败。正常 teardown 返回 0 后，旧 HOME CommDB 仍存在，所以整个取证流程明确失败，不能报“拆干净”。

这不是对历史 `ee113cab9` 上 topology failure 的追溯闭环。隔离修复后的两个干净 checkout 均通过启动拓扑步骤，失败前进到 inbox readiness。历史 H1 正文早退 / H2 tmux 客户端漂移在本轮未复现；不得把当前路径错误倒填成 9-8 原日志的唯一根因。目标仍是恢复当前 main 的完整起房、收件、干净拆房，而不是只交诊断。

本文件同时是 C3 所要求的新增量设计。原 plan.md SHA-256 `e77c5d19d3933fc2e6e96a0f6822762ffb82aa416813ec4322056ccff6df0df3` 未变。**此文件获得新的有效 design review APPROVED 前，不修改下述根因代码或测试期望。**

## 已满足的依赖和执行裁定

FLY-2454 PR #1137 merge `5cbd540f1bfdee28dd474f89ecb1523a4507473b`，合入时间 2026-09-10T01:02:32Z。隔离 QA head `98e45e000c3cd5b76cd42078d2eeb4b57d362c7d`，CI run `34412592817` 14/14 SUCCESS。[attempt 4 QA 报告](https://fw-reports-a53de2.vercel.app/r/73b017d734f2bcab8190af32605af55b/) 已核验 HTTP 200；报告是 fresh slot 4 的 runner/清理隔离证据，不覆盖 Lead bootstrap/Discord。本轮发现的 HOME 写入不能借该报告称安全。

Lead 的权威依赖指令为 `[lead-instruction 0cd70492-60b0-4b40-8bde-73d5eacac192]`。本 runner 无宿主进程查询权限，question `1b7f4dfd-9a9f-4b71-8261-4b5e064ac8b8` 指定 Lead 执行脚本，本节点只读分析回执。

question `fe688ae8-028d-44dd-9a98-f63633fe1a57` 将 fresh 定义落实为 **复用 2/3 前必须证明 absent**，不新增 slot 或改 token/allowlist。两轮均 `TMPDIR=/tmp/q7 bash scripts/test-deploy.sh 2 --extra-lead 3:Ops-Test`，没有 generalized/alerts。宿主在每轮前验证目录、锁、HOME comm、生产同名 tmux session、slot label 和端口 absent。已知旧空 session 由 Lead 单独处置，不是实现脚本自行清理生产。

question `ca062df3-f200-439c-bd40-a35315c59ddc` 的普通模式 HEAD fence 保持：不放宽 EXPECT_HEAD-only-with-generalized 守卫，启动后对本 slot `/api/health` HTTP 200 和精确 buildSha 作硬检查；不可达或不一致失败。本轮在 Bridge 启动之前失败，因此没有 HTTP/buildSha 成功证据，构建来源仅由干净 detached checkout、git HEAD 和成功 install/build 回执确定。

## 两次宿主回执

共用 driver head `1e58241d99d156ea72069cf8f3ce8ec9f0207da0`，脚本 SHA-256 `c9a6ce656b28610b94b78161a05ffa9f40d761bd7f9169d46cf399584c022fca`。Lead 在 question `29deeadb-ec22-440d-aa2d-c8e1ff1a931a` 确认实际加载该脚本，11 个 dry-run 守卫通过。

**baseline**：`~/.flywheel/qa-evidence/FLY-2455/20260910T012501Z-c3-5cbd540f1bfd`。HEAD `5cbd540f1bfdee28dd474f89ecb1523a4507473b`，checkout `/private/tmp/fly2455-c3-ry8dmroa/checkout`，install/build exit 0。部署 01:25:31.163048Z → 01:28:42.408563Z，191.244416625 秒，exit 1。正常 teardown 01:28:42.465183Z → 01:28:47.810534Z，5.345321500 秒，exit 0。最终 `complete=false, cleanupError=occupied_path`，唯一路径为 `/Users/xiaorongli/.flywheel/comm/test-slot-2`。权威回执 `[lead-instruction 0d09f2d5-a842-453c-b477-0917294536a4]`。

**diagnostic**：`~/.flywheel/qa-evidence/FLY-2455/20260910T013024Z-c3-1e58241d99d1`。HEAD `1e58241d99d156ea72069cf8f3ce8ec9f0207da0`，checkout `/private/tmp/fly2455-c3-dofa6jpc/checkout`，install/build exit 0。部署 01:30:53.225382Z → 01:33:41.728284Z，168.502085625 秒，exit 1。正常 teardown 01:33:41.782508Z → 01:33:44.781539Z，2.999013083 秒，exit 0。同样 `complete=false, cleanupError=occupied_path`、同一个 HOME comm 路径。权威回执 `[lead-instruction c3324381-a5a9-45e9-b0ce-f27f3ad5183a]`。Lead 已在两次之间及最后移除无进程持有的 HOME residue；脚本自身未声称零残留。

两份索引逐文件校验：baseline 24 files、diagnostic 26 files，全数 SHA-256 相符、全数 mode 0600。索引自身 SHA-256 分别是 `6f9d3a809cf1565dc7fae4beaccd650ba9174bdbe53533085ae14d2a2f0e697d` 和 `ba39ce1a85c6391d670043cb0a1712a65ac2f3e012176d3f7c92e2d2547c11d1`。原始正文不提交、不放 HTML；本文只列必要的净化路径摘录。没有复制活 SQLite 库；Lead 另称保留了无进程持有的 residue 副本，本节点未读取该副本，也不把它当 online-backup 证据。

中断目录 `20260910T011745Z-c3-5cbd540f1bfd` 不是上述 baseline，禁止混用。

## 同一尝试的精确观测

diagnostic 的 manifest：label `com.flywheel.qa.lead.slot-2.flywheel-test-2`、project `test-slot-2`、carrier PID `16193`、socket `/tmp/flywheel-test-slot-2/q/2/sock/fw-test-slot-2-flywheel-4f15afe70cbcdbd5.sock`。01:33:40.676651Z 的 launchctl 白名单记录为 running、runs=1、pid=16193。

`body-status.json` 关联同 carrier PID，bodyPid=17134，startedAt=01:31:19.616Z，endedAt=01:33:40.875Z，exitObservation=shell_exit、observedShellExitCode=0、claudeExitCode=null。这个时刻已在部署判 readiness 失败并停止 carrier 的阶段；不能把 shell exit 0 写成 Claude 正常结束或启动成功。最后保存的 session/window 探针在 01:33:41.77Z、停止之后，exit 1，只证明停止后的状态，不是原 topology gate 的失败证据。

正文内净化摘录：

```text
Comm DB: /tmp/flywheel-test-slot-2/state/comm/test-slot-2/comm.db
Inbox MCP: enabled (CommDB push delivery)
```

部署日志随后明确等待 slot 下的 lease，120 秒到期。Lead 在残留中发现同一生命周期创建的 HOME CommDB（389 KB、12 tables）及 readiness lease。baseline 无 dev-channels prompt，diagnostic 在 01:31:32Z 确认 prompt 后进入同一等待；因此 prompt 差异未改变共同失败点。

现场没有采到最终 Claude/inbox 子进程的完整 DB/ROOT 环境投影：Lead 观察器在停止后两秒才运行。以下 env-i 解释来自源码和独立 A/B，不冒充宿主逐进程 env 观测。

## 完整因果链与单变量 A/B

在冻结的 diagnostic head：

1. `scripts/test-deploy.sh:1575-1576` 将 slot `FLYWHEEL_COMM_DB`、`FLYWHEEL_COMM_ROOT` 写入 canonical manifest launchEnvironment。
2. `scripts/flywheel-lead-wrapper-v2.sh:427-466` 验证 manifest 键值后加入 SERVER_ENV，经 `env -i` 进入 carrier/body。正文打印的 slot CommDB 证明 launcher 实际收到正确值。
3. `packages/teamlead/scripts/claude-lead.sh:676` 保留调用者传入的 FLYWHEEL_COMM_DB；没有缺默认值。
4. 同文件 `:2082` 的最终 Claude env_args 显式携带该 DB；`:2259` 通过 `env -i` 启动 Claude。FLYWHEEL_COMM_ROOT 未在这个 allowlist 中，生成配置也没有 `${FLYWHEEL_COMM_ROOT}` 引用，不会由 required-env 扫描补入。
5. 同文件 `:2366` 为 inbox MCP 重新执行 `COMM_DB_PATH="${HOME}/.flywheel/comm/${PROJECT_NAME}/comm.db"`；`:2377` 将这个 HOME 值显式写进 MCP env。它覆盖 Claude 已继承的正确 DB。
6. `packages/inbox-mcp/src/comm-db-path.ts` 仅在 ROOT+PROJECT 均存在时选 slot root，否则采用显式 DB。`src/index.ts` 在此 DB 创建 schema，将 lease 写进 dirname(DB)。因此写者在 HOME，部署 `scripts/test-deploy.sh:1829` 的读者在 slot。

A/B 原件 `~/.flywheel/qa-evidence/FLY-2455/c3-commdb-ab/experiment.json`，mode 0600。实验读取当前真实 launcher 的 MCP stanza，运行真实 jq 生成器和已构建的真实 inbox resolver，不写工作区文件、不启动宿主 MCP/slot。A 使用原赋值：launcher DB 为 `/fixture/slot/state/comm/test-slot-2/comm.db`，MCP env 与 resolver 却落在 `/fixture/home/.flywheel/comm/test-slot-2`。B 只在同一变量 COMM_DB_PATH 的赋值之后、真实 jq 之前令它等于已解析的 FLYWHEEL_COMM_DB；其余环境（含 ROOT 缺席）完全相同，DB 与 leaseDir 都落回 slot。源码 SHA-256 为 `44cf021613afce462d8cca029d6dc9db3b6f1d1350740ad7a40782ba4deb9150`。

既有测试为何没抓到：`packages/teamlead/scripts/__tests__/claude-lead-comm-db-path.test.sh` 验证了顶层 export 的 override/default，却又显式要求 HOME MCP 赋值存在一次；inbox resolver 测试人为传入 ROOT，没有跨过真实最终 env-i + MCP env override。下一步测试必须穿过真实 launcher 配置与 env 边界，不能只改该字符串期待。

## FLY-2174、FLY-1948 与边界

两轮均不带 alerts，canonical identity 和 main carrier 均启动；不是 FLY-2174 duplicate projects/token 的 `identity_launch_env_conflict`。C4 仍须运行 alerts 变体，不因这次排除而跳过。

两轮显式 `/tmp/q7`；diagnostic host 与 carrier tmux 都是 `/opt/homebrew/Cellar/tmux/3.7c/bin/tmux`、3.7c、arm64。Lead socket 符合现有 <90 字节合同。Bridge 尚未启动，因此 Bridge tsx TMPDIR 超限不能解释当前 inbox lease 写到 HOME；这不等于所有后续 IPC 已验收。

FLY-1948 的独立历史 Discord 活连接问题尚未由本轮证明同源：本轮没有发送 Discord 测试消息。当前 CommDB readiness 阻断首先必须解除；修后执行原 C4 bot 身份/POST+DELETE/allowBots/唯一 nonce 收件检查。若 startup 恢复但消息仍不通，按原计划报回 FLY-1948，不扩展 Discord 权限或重构。

虽然 HOME 写入也暴露了 FLY-2454 未覆盖的 consumer，本增量只修本次已证实的 launcher→inbox 配置来源；不改隔离算法、进程清理、CommDB resolver 优先级、生产目录或 allowlist。此边界请增量设计审查明确判定。

## 增量实施步骤（等待本轮 APPROVED）

目标：生成 inbox MCP 配置时复用 launcher 已解析的 FLYWHEEL_COMM_DB；没有 override 的生产路径维持原 HOME 默认。技术栈和主体结构保持 Bash/Python fixture/真实 Node inbox MCP。

### 1. 在真实 body→Claude→inbox 边界建立 RED

修改 `scripts/__tests__/fly1697-v2-lease-body.test.sh` 的受控 Claude child fixture。在新专用用例中，为真实 body 设置临时 slot `FLYWHEEL_COMM_DB` 和 ROOT；从真实 Claude argv 的 `--mcp-config` 读取生成文件，解析 `mcpServers.flywheel-inbox`。用收到的真实 child env 合并 MCP env，启动配置指向的真实 Node inbox 入口，stdin pipe 保持打开；不 stub DB/lease 创建函数。

fixture 将结果写入临时文件，在外层断言：MCP DB 等于调用者 slot DB；真实 CommDB 与 `.inbox-ready-eng-lead` 都只出现在 slot 目录；lease PID 是活 inbox child；旧临时 HOME comm 目录不存在。明确断言 ROOT 没跨最终 env-i，避免测试靠 ambient ROOT 偶然兜底。子进程清理由 fixture 持有的 Popen/实际 child PID 完成，最终 lease 消失、无遗留 inbox 子进程。测试异常必须出现在外层断言，不能被 launcher 的 catch/wait 吞成 pass。

```sh
bash scripts/__tests__/fly1697-v2-lease-body.test.sh
```

预期 RED：该用例的 MCP DB/HOME residue 断言失败，而现有 16 项仍保持原行为。记录 rc 和具体两个路径。

### 2. 最小代码修复，再 GREEN

唯一行为修改文件 `packages/teamlead/scripts/claude-lead.sh`，将 inbox stanza 的赋值改为：

```bash
COMM_DB_PATH="$FLYWHEEL_COMM_DB"
```

不改变顶部 override/default 解析，不加入新 ROOT env 传播，不改 companion/external 的 MCP 禁用分支，不改 Codex，不更换 resolver、不增加重试或等待时间。

修改 `packages/teamlead/scripts/__tests__/claude-lead-comm-db-path.test.sh`：移除旧 HOME 字符串存在断言，执行真实 MCP stanza，分别验证默认 HOME、显式 slot DB（含空格路径）在生成 env 中不漂移。这里的轻量测试补默认行为；承重回归是上一步真实 body/真实 inbox 用例。

```sh
bash scripts/__tests__/fly1697-v2-lease-body.test.sh
bash packages/teamlead/scripts/__tests__/claude-lead-comm-db-path.test.sh
pnpm --filter flywheel-inbox-mcp exec vitest run src/__tests__/comm-db-path.test.ts --pool=forks --maxWorkers=1 --no-file-parallelism
```

以还原该一行的 mutation 验证真实 body/inbox 用例重新 RED，恢复修复再 GREEN；保存两份退出回执。生产 fallback、显式 override、companion/external 既有不启用 inbox、child 42/TERM/INT/清理失败语义都不能退化。

### 3. CI 与既有 C5

在 `.github/workflows/ci.yml` 的脚本分片明确登记现有 package shell `bash packages/teamlead/scripts/__tests__/claude-lead-comm-db-path.test.sh`；真实 body suite 已登记，不新建未枚举的 root suite。运行 `ci-shell-suite-enumeration.test.sh`，保留全 root Node 枚举及两项删行 mutation。然后执行原 plan.md C5 的每条命令（仍排除唯一真实 GUI 用例，Vitest 单 worker forks），另加上述 package shell；不能以本文的聚焦恢复检查替代。

### 4. C4 宿主整链与后续交付

修复提交后由 Lead 已授权的宿主通道继续真实 ordinary 双 Lead、alerts 双 Lead、`/api/health` 200 + exact buildSha、独立 live label/PID/socket/lease、正常拆房及前后进程核对。原 c3-repro.sh 只作限时起拆取证，**不代替** C4 的消息阶段，不能在没有 nonce 消费证据时称 C4 完成。

消息发送只用 test-slots.json 对应 slot bot，先实际目标频道 POST+DELETE/GET bot/allowBots 检查；不满足报“发送前置条件未满足”，不改 access，不用 founder 身份。受控失败只在 fixture 注入，不破坏宿主。

本节点不派 QA、不 merge/deploy，不请求 ship。C4 后再开 PR；milestone 是最后提交，推送后 HEAD 冻结、request-driven code review、当前 main 干净集成与 exact-head CI 14/14，按 needs_review 路由交接。

## 回滚

本增量无 schema/data migration。revert 根因一行修复和其回归可恢复原行为，但会重新造成 slot inbox 写入 HOME、readiness 超时；回滚后应停止这条 slot 演练。不得为“清理回滚”删除 HOME comm、关闭 residue 门、放宽 identity/ownership 或回滚 FLY-2454 隔离。历史已产生的 HOME residue 由明确 owner 在取证后按 Lead 指令处理，修复代码不自动搬迁或删除生产路径。
