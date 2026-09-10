# FLY-2455 529 房启动恢复 — C3 宿主取证交接
Issue: FLY-2455 (https://linear.app/geoforge3d/issue/FLY-2455/529-房台架-test-deploysh-起不来-529-slot-lead卡在-qa-launchd-topology-校验)
日期: 2026-09-09
基于: plan.md, resume-check.md

## 依赖与执行权限

FLY-2454 PR #1137 于 2026-09-10T01:02:32Z 合入，merge SHA `5cbd540f1bfdee28dd474f89ecb1523a4507473b`。验证头 `98e45e000c3cd5b76cd42078d2eeb4b57d362c7d` 的 exact-head CI run `34412592817` 为 14/14 SUCCESS。Lead 通过本执行的 question `2de4ce60-1c77-42bf-a195-84cf0e65090b` 和权威信箱指令 `[lead-instruction 0cd70492-60b0-4b40-8bde-73d5eacac192]` 提供合入及隔离证据，明确 C3 放行。

[FLY-2454 attempt 4 QA 报告](https://fw-reports-a53de2.vercel.app/r/73b017d734f2bcab8190af32605af55b/) 已以 HTTP 200 下载核验，归档 `~/.flywheel/qa-evidence/FLY-2455/c3-dependency/2454-report.html`，mode 0600。报告验证 fresh slot 4、同头 buildSha、起 run/terminate/11 个清扫周期/拆房；生产快照有 6 条减少，报告逐条归因于其他 implement 节点进入 ship_parked，不能称快照字节相同。该报告不证明 Lead bootstrap 或 Discord 收件；其原件在 `~/.flywheel/qa-evidence/FLY-2454/20260909T2320Z-attempt4-head-98e45e000`。

本 resident 沙箱执行 `/bin/ps -p $$ -o pid=,ppid=,lstart=,comm=` 被系统拒绝（operation not permitted，exit 127），不能获得宿主 PID/launchd/tmux 证据，未绕过限制、未启动 slot。Lead 在 question `1b7f4dfd-9a9f-4b71-8261-4b5e064ac8b8` 指定由 Lead 在宿主执行脚本，每个 ref 一次，再回传证据目录；实现节点准备脚本及 dry-run。没有自行派 QA。

## fresh 的最终裁定

当前配置只有 slot 1–4。Lead 在 question `fe688ae8-028d-44dd-9a98-f63633fe1a57` 裁定不增加 slot、不改 token/allowlist，两次均顺序使用普通 `2 --extra-lead 3:Ops-Test`。fresh 意图通过起房前严格证明 absent 实现：2/3 的 slot 目录、锁、旧 HOME comm 目录、生产默认 tmux 的 runner-test-slot-2/3、对应 launchd labels、端口必须不存在；否则非零退出且不起房。Lead 负责事先处置已知 9-3 的空 runner-test-slot-2 会话并记录证据；脚本不做生产清理。宿主应为两次执行安排独占的 2/3 使用窗口。

保留 `ca062df3-f200-439c-bd40-a35315c59ddc`：不加 generalized，不改 EXPECT_HEAD 守卫；成功启动后要求本 slot `/api/health` HTTP 200 且 buildSha 等于 checkout HEAD，失败即 fail closed。保留 `c80a599e-0a9f-464b-80fe-d85c2fa17c75`：取证、root-cause.md、新增量 design review APPROVED，之后才写根因修复。plan.md 保持原 SHA-256 不变。

## 可重跑命令

脚本为同目录 `c3-repro.sh`，只接受 `--dry-run` 或 `2 <git-ref>`。始终从该 ref 建 detached 干净 checkout，验证包含隔离 merge，执行 frozen install 和全仓 build，然后用 `TMPDIR=/tmp/q7` 执行原普通双 Lead 命令。build/install 各上限 1800 秒，deploy 观测上限 900 秒，超时仅 TERM 自己直接创建的 deploy 子进程并等 30 秒；未退出则保留现场交 owner，不做跨进程组清理。teardown 上限 180 秒。

```sh
bash engineering/doc/FLY-2455-slot-lead-bootstrap/c3-repro.sh --dry-run
bash engineering/doc/FLY-2455-slot-lead-bootstrap/c3-repro.sh 2 5cbd540f1bfdee28dd474f89ecb1523a4507473b
bash engineering/doc/FLY-2455-slot-lead-bootstrap/c3-repro.sh 2 <实现体交接报告中的完整诊断-head>
```

每次输出只含证据目录与 receipt。原始 deploy/build/Lead/Bridge/body 日志进入 `~/.flywheel/qa-evidence/FLY-2455/<UTC>-c3-<head>/` 的 0600 文件。已存在的 slot 日志保留末尾 256 KiB；install/build/deploy/teardown 子命令持续 drain，只保存首 256 KiB 并写 truncated 标记，避免无界 stdout 文件。所有文件硬上限 256 KiB；证据目录总上限 64 MiB（其中预留 1 MiB 给最终 receipt/digest），超限拒绝继续归档，不冒称取证完成。正文 recorder 本身也有 256 KiB 上限。manifest/plist 仅保留 PID/socket/identity 与 wrapper argv，launchctl print 仅留标量状态白名单，不输出 EnvironmentVariables。SQLite 不复制。每份探测带时刻；helper 自身 generation 结论以 topology/body-status 文件为准。

先取证后拆房；归档失败保留 runtime。清理前要求本 deploy 日志确实认领 slot 2、runtime inode 未替换，否则拒绝 teardown。拆房使用该 checkout 的原 test-teardown.sh，逐项核验 post-state absent、曾观察到的 socket 消失、PID generation 退出。宿主非 slot node/codex/claude/tmux 的 PID+start-time 变化另列 `processes-changed.json`，须人工因果核验，不能将自然并发变化直接写成零伤害或误伤。checkout 保留供证据核验，不等同于 slot runtime 残留。

`receipt.complete` 表示起房尝试已记录且 slot 清理检查完成，**不表示起房成功**。必须分别读 deployExit、healthBuildShaVerified、teardownExit、zeroSlotResidue、error/cleanupError；C3 失败复现允许 deployExit 非零，不允许把它写成 C4 通过。

## 已执行验证与尚未执行

普通 merge main 为 `4699ac731`，只解决两处已记录冲突：qa-room 保留诊断接线及 contract delivery-secret；Node 枚举保留全量根目录 suites 与 endpoint-client、qa-lead-diagnostics 两个真实递归删行突变。聚焦检查：enumeration exit 0（301 shell / 22 Node），qa-room exit 0（19/19），diagnostics exit 0（8/8），qa-launchd exit 0（52/52）。这些不是 C5 全仓或最终 exact-head CI。

脚本 dry-run 合同测试先 RED（无脚本），实现后 GREEN；再增加未认领和 inode 被替换拒绝检查，先 RED 后 GREEN。`bash -n` 通过。dry-run 直接运行真实输入/absence/build/cleanup 守卫，报告 hostCalls=0；它不证明宿主 launchd、真实起拆或消息链。

宿主交接后复查增加固定深度采集：仅枚举 launchd 两层与已知根/extra-lead 日志，不递归进入 sandbox/workspace/node_modules。新增 bounded_discovery 控制先 RED 后 GREEN，合计九项 dry-run 检查。外部子命令 stdin=DEVNULL，install/build 使用 CI=true。Lead 的旧 ref `04010a516` 宿主开始回复与此次修订交叉；已报告保留旧脚本实际回执、暂停诊断轮等待替代 ref，不冒称已运行修订脚本。

`04010a516` 本地整合检查：lint exit 0（3178 files，14 warnings）；首次全仓 build exit 2，claude-runner 的新增 codex-memory-distill.ts 缺 better-sqlite3 模块，先按锁文件同步依赖再重跑。首次非零回执保留在 `c3-dependency/04010a516-build.log`，不记成通过。

随后 frozen install exit 0；在 `2e01e3a33` 重跑 `pnpm -r build` exit 0，日志为 `c3-dependency/2e01e3a33-build-after-install.log`。根因代码未写，仍不是最终 C5 回执。

Lead 在 ac0d93e4 回答要求目录总限额后，增加 evidence_budget 与 bounded_log 两项 dry-run 控制，先 RED 后 GREEN（合计 11 项），验证超限拒绝、正常控制与超限后仍 drain 到 EOF。脚本没有在此沙箱运行宿主起拆。

权威中断回执 `[lead-instruction a945e996-590e-4006-b6c0-66bda589de83]` 更正了此前“只到 build”的口头状态：旧 baseline 尝试在 01:18:28Z 已认领 slot 2，01:18:38Z 启动 Lead PID 36915，01:18:45Z 中断释放锁。Lead 后续核验 PID/launchd label 已消失、19872/19873 关闭，并对残留 runtime 执行正常 teardown rc0；slot-2 runtime、旧 HOME comm、生产 runner-test-slot 会话均 absent，生产 runner-flywheel windows 不变。`~/.flywheel/qa-evidence/FLY-2455/20260910T011745Z-c3-5cbd540f1bfd` 只属于中断尝试，**不是 baseline 证据**。Lead 将使用加入总限额后的脚本从干净 pre-state 重跑两次。

尚待 Lead 执行 baseline 与 diagnostic 两次并回传证据；根因未判定，未写根因修复代码，未开 PR。
