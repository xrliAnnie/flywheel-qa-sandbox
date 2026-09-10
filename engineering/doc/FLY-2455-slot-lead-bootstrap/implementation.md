# FLY-2455 529 房启动恢复 — 实施记录
Issue: FLY-2455 (https://linear.app/geoforge3d/issue/FLY-2455/529-房台架-test-deploysh-起不来-529-slot-lead卡在-qa-launchd-topology-校验)
日期: 2026-09-09
基于: root-cause.md, plan.md

## 根因修复与审批

增量设计 gate 2a16bc80-68b9-44ba-bbab-e857901b7dbd、request 3cb33a4b-bdeb-4128-bd81-878eec964634 有效/raw APPROVED 后，唯一生产行为修改为 claude-lead.sh inbox stanza 复用 FLYWHEEL_COMM_DB。顶部默认值、ROOT 传播、resolver 优先级、隔离算法均未改。原 plan.md 和 root-cause.md 审批字节未改。

审查非阻塞建议已报告 Lead（4fe9d36b-1ea0-4cc8-afc2-a5b529da8982）。本次落实 dist/stanza 硬前置与证据边界说明；不扩写 Lead DB/ROOT 合同或一致性守卫。package shell 显式登记 ci.yml；root 枚举门不宣称覆盖 package shell。

## 承重回归

真实 body/launcher 的 MCP 配置实际由 CWD .mcp.json 自动发现，没有 --mcp-config 参数。测试按真实入口读取生成文件，受控 Claude child 合并最终 env 与实际 stanza，启动真实 inbox Node 入口，持有 stdin，观察真实 DB/lease/PID，再 TERM、wait 并检查 lease 删除。外层检查防止内部异常被 launcher 吞掉。

这证明配置生成、进程环境和真实 inbox 落点，不证明真实 Claude Code 的 MCP 派生或 Discord 收件。共享 fixture 的默认 HOME 用例状态在 slot 用例前移入临时目录保存，用例后恢复；slot 用例仍严格断言 HOME 没有新 mailbox 目录。

回执在 ~/.flywheel/qa-evidence/FLY-2455/root-fix-085882bc/，日志 mode 0600：

- 初始有效 RED：body-red.log，exit 1，17 passed / 1 failed。实际 MCP DB 位于临时 HOME，ROOT absent，live lease PID 等于真实 child PID，homeResidue=true。
- GREEN：body-green.log，exit 0，18/18。
- 将唯一生产改动还原后的 mutation：body-mutation.log，exit 1，17/1，唯一失败仍为 slot coordinate/HOME residue。
- finally 恢复生产修复，再跑 body-restored-green.log：exit 0，18/18。

前两次试跑不属于有效 GREEN：第一次读取不存在的 --mcp-config 导致装配错误且执行中编辑脚本造成后段读取失败；第二次路径已正确但先前默认路径用例残留导致隔离断言失败。修正 fixture 后完成上述完整 mutation 链，不隐藏失败回执。

包级 claude-lead-comm-db-path.test.sh 先 RED 于含空格显式 override，再 GREEN；执行真实顶层 export 与 MCP jq stanza。inbox resolver Vitest 3/3；Lead rules bundle 25/25（有既有 .bashrc 条件语法 stderr，进程 exit 0）。

## C5 当前证据

c5-shell-receipts.json 逐项记录命令、退出码和耗时。9 项均 exit 0：qa-lead-diagnostics Node、fly1663-qa-launchd、其 mutants、fly1663-lead-v2-runtime、fly1726-lead-identity-wrapper、fly1402-single-bundle、test-deploy-qa-room、test-deploy-generalized、test-deploy-multilead。

CI 枚举 exit 0：301 root shell，22 Node，endpoint-client 与 qa-lead-diagnostics 删除 mutation 均转红。pnpm lint exit 0，3178 files、14 warnings，不宣称无警告。

宿主 instruction 637e06e4-bcab-4def-8649-db8909479f93 返回 test-deploy-fly1389.test.sh exit 0、23/23，前后 fixture slots30–35 absent、零 marker 进程。已直接读取日志尾部确认。宿主运行时 HEAD b339189a2 且工作树有未提交修改，应标为工作树回执；该 suite 的 deploy/lib 生产输入本批没有改动，不称纯净 HEAD 回执。原日志：/private/tmp/claude-501/-Users-xiaorongli--flywheel-lead-workspace-flywheel-eng-lead/794288d1-63cc-4be1-9959-2d064d2467ba/scratchpad/fly1389-b339189a2.log。

全仓 pnpm -r build exit 0（full-build.log）；分组 packages 仍在执行，不以聚焦证据代替完整 gates。C4 未跑。

## 后续顺序

Lead question e489b10b-8c29-4a93-a978-6ecea050688b 批准：全本地 gates → milestone-last → [C4 pending] 草稿 PR → exact-head review 与 CI14/14 → 同一 head 宿主 C4。不得提前 complete；真实 slot 仍仅宿主 Lead 执行。topology 复发则继续诊断，消息前置不足则如实报告，不放宽任何验收。

## 评审通道与宿主回执补充

Lead question 4c448caf-80ec-4d6a-a81f-6f492b31346a 明确裁定：codex-tmux 作者的有效评审路径是 request-driven cross-family gate/request-review，codex:rescue companion 不必执行。此前只读 companion task 在线程创建前 exit 1：fs sandbox helper exit71、sandbox_apply Operation not permitted；没有产生 verdict，不绕过沙箱、不使用 raw codex exec。最终 milestone-last HEAD 必须由引擎有效 verdict 验证。

Lead 对宿主 fly1389 回执的来源补充（question f82b7fda-4289-44fb-a3ea-ffff4fd58713）：worktree 为 b339189a2 加未提交根因/测试改动，但 suite 复制的 scripts/test-deploy.sh、scripts/test-teardown.sh 与 scripts/lib 均与 HEAD 字节一致；claude-lead.sh 在该 suite 中是 stub。保留工作树限定，不冒充整棵 clean HEAD 验证。

## 全仓首轮失败与清单修正

第一条 packages 分组命令 exit 1，440.882 秒；core 分组 exit 0，3.990 秒；release-contract exit 0，0.564 秒。记录在 full-package-receipts.json，原日志未覆盖。claude-runner 为 48 files/1223 tests 通过、1 file/1 test 失败、2 skipped；唯一失败为 kill-path-inventory 清单 637 条与实际 640 条不符，pnpm first-fail 因此未完成所有下游包。

已逐条核对本单新增项：wrapper fixture 的 fast_wrapper_pid signal-0；真实 inbox fixture 持有的 child.kill；QA diagnostics 持有的 probe 子进程 process.kill。三处均按既有 scanner 分类 qa-only，只补 fixtures/kill-path-inventory.json 的 18 行，没有改扫描器或生产信号路径。聚焦 kill-path-inventory 5/5 exit 0。完整 packages 将重跑，首轮不是 green full gate。

## C1 deadline 审计补正

独立执行真实 run_probe 的受控 fixture：直接 child 退出，但其睡眠 4 秒的 child 继承 stdout/stderr。旧实现 process.wait 已返回，thread.join 无期限等待 EOF，实测 4.19 秒仍成功，违反 C1 单项 2 秒合同。新增 Node 回归先 exit1（4.11 秒、错误地返回 success），不是猜测性修复。

改为 nonblocking selector 在一个 monotonic deadline 内连续有界捕获并等待直接 child；EOF 或 child 退出都不能单独绕过期限。超时返回 unavailable，finally 仅对自己启动的直接 child 执行既有 kill/wait 并关闭管道，不增添进程组或非 slot 清理权限。新用例约2.04秒，完整 qa-lead-diagnostics 9/9 exit0。

这次 Python/root Node 改动发生在 packages attempt2 运行期间。该回执不能称为从头冻结的 clean HEAD 测试；Python 诊断器由独立 root suites 验证，最终 CI 仍须在冻结 HEAD 验证整棵代码。attempt2 的原始日志继续保留。

## C5 最终本地回执

packages attempt2 exit 0，用时1298.495秒；driver 结束时 HEAD ddeba5224d203dcd242747016595750871f47bda，期间仅有已披露的 root Python/Node deadline 补正和文档/进度提交。主要结果：TeamLead918 files、12372 pass/7 skipped；claude-runner49 files、1224 pass/2 skipped；edge-worker111 files、1318 pass/14 skipped；flywheel-comm152 files、2172 pass/2 skipped。其余包结果在 full-packages-attempt2.log。

独立 core 分组19 files/219 pass，exit0，按计划排除唯一真实 Terminal GUI 文件；release-contract24/24 exit0。所有指定本地分组命令已返回通过，首轮 packages exit1仍保留并已修正；不称原始单命令 pnpm test:packages:run 通过，也不称测试从头运行于一个冻结HEAD。

pnpm -r build exit0；最后 pnpm lint exit0（14 warnings）；C1 deadline 后 Node9/9、verifier与mutants exit0、inventory5/5、CI枚举exit0。其余C5 shell回执见前文，唯一host suite为经确认无占用的fly1389 23/23。未新增root shell文件，新增root Node suite已登记CI并受删行mutation保护。全部原始回执放在同一0600证据目录。

最新fetch origin/main仍为5cbd540f1bfdee28dd474f89ecb1523a4507473b，git merge-tree exit0。接下来milestone-last、草稿PR、exact-head review/CI；C4未执行，不能完成节点。
