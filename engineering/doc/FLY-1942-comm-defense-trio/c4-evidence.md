# FLY-1942 通信层防线三件套 — C4 实施证据
Issue: FLY-1942 (https://linear.app/geoforge3d/issue/FLY-1942/通信层防线-三件套发信短-id-静默死信-bot-永久偷听-guard-误拦并-19431953)
日期: 2026-09-11
基于: plan.md

## 范围

仅实现冻结计划 M4a：`scripts/hooks/flywheel-restart-guard.py` 及其现有测试文件。增加保留 pipeline 边界的命令 IR、静态 stdin、显式可执行边递归、plist 形状治理及结构化匹配。`scan_block(cmd, depth=0)` 继续返回模式字符串或 None。P4/P5/P6 的检测与治理函数保持原样。

本地未运行真实安装器、未重启服务、未执行矩阵内的命令。安装器测试在临时目录内使用夹具。

## RED → GREEN

1. 修改前运行 `python3 scripts/hooks/test-flywheel-restart-guard.py`：**286 passed, 0 failed**，包含原始 **84 MUST_BLOCK + 51 MUST_PASS**、bypass/audit、Homebrew、Calendar 等全部测试。
2. 新增直接 `_scan` 和兼容 wrapper 断言、计划 14 条命令、额外执行边与 pipeline 隔离、三种 plist 形状、deny/audit 读数。生产实现前运行：**286 passed, 27 failed**。旧实现没有 `_scan`；兼容 wrapper 同时暴露 quoted 消息/文档误拦、缺失 plist 漏拦等差异。日志：`/tmp/fly1942-c4-red.log`。
3. 首轮实现：**311 passed, 2 failed**。两个失败都是 `gui/$(id -u)/com.flywheel.lead.*`，原因是空白过滤丢弃包含命令替换的目标 token。保留这类目标的原文 label 后重新跑全套。
4. 最终：**313 passed, 0 failed**。日志：`/tmp/fly1942-c4-green-final.log`。

新增覆盖：quoted/unquoted heredoc、eval argv、echo/printf 管道喂 shell、xargs here-string、shell substitution/反引号/process substitution、rg executable option 两种写法、submit 嵌套 shell、raw UID label、核心 updater、缺失 plist、calendar-only plist 放行、KeepAlive/RunAtLoad/StartInterval 键存在即保护、跨 pipeline 目标不串线、普通消息和 commit 文本放行。

## 其他验证

- `bash scripts/hooks/test-restart-guard-install.sh`：**11 passed, 0 failed**，临时夹具验证安装/回滚/损坏配置处理；日志 `/tmp/fly1942-c4-install-test.log`。
- 修改前、修改后各运行 `python3 scripts/qa-fly-2456-guard-receipt.py engineering/doc/FLY-2456-bridge-restart-drill/host-runbook.md scripts/hooks/flywheel-restart-guard.py <receipt>`：两次均 **62 bash blocks、0 hits、exit 0**。
- 最终 receipt：`/tmp/fly1942-c4-final-receipt.json`；runbook SHA256 `606cdfc24e34d0f7db403b7e7f63fbe0bcd8b36aef93516ff33ee2432ef4d4bf`；scanner SHA256 `ed933e213b10aade4d9eee2f92b5c89d258303f8a28b268c2c85b53bc5df3866`。
- `node scripts/qa-fly-2456-drill-tools.mjs dry-run --runbook engineering/doc/FLY-2456-bridge-restart-drill/host-runbook.md --scanner scripts/hooks/flywheel-restart-guard.py --receipt /tmp/fly1942-c4-final-receipt.json`：**status=pass、commands=62**。日志 `/tmp/fly1942-c4-dry-run.log`。
- `git diff --check`（两个修改的 Python 文件）：exit 0。

## 证据边界

以上证明枚举命令矩阵及本地扫描/安装器夹具合同；不是任意 shell 程序的执行安全证明。递归深度按冻结计划仍最多一层。FLY-2456 dry-run 自身声明只是 lexical metadata/path/order + scanner receipt，不是宿主实际重启证明。本节点未完成全仓 lint/build/test 或代码评审；由主 implement runner 执行。生产 hook 收敛与生产回放留给后续获授权的上线/QA。


## 主仓 R1 HIGH 修复

`restart-guard-ir-fail-open` 的定向 RED：最初 16 个用例中 3 通过、13 失败（`/tmp/fly1942-r1-guard-focused-red.log`）。修复 command head 的 compound/control 前缀、kill 的带空白参数、被引用的静态赋值和不完整词法 token；保留单引号/转义变量为字面量，临时环境赋值不污染后续 stage。补充转义边界时先见 19 通过、2 失败（`/tmp/fly1942-r1-guard-escaped-red.log`），再最小修复。submit 嵌套 payload 复用容错 IR，避免额外 shlex.split 异常。

最终 21 个新增用例同时检查 `_scan` 与真实 hook JSON 拒绝响应，全套 **334 passed, 0 failed**（`/tmp/fly1942-r1-guard-final-approved.log`）。安装器临时夹具 **11/0**。既有 FLY-2456 runbook 仍为 **62 blocks、0 hits**，dry-run pass；最终 scanner SHA256 `c7293e70ebb98fb62f0573d3489aad4f8ad9171fe11f7338cb6505dc45706cbf`，回执 `/tmp/fly1942-r1-final-receipt.json`、`/tmp/fly1942-r1-final-dryrun.log`。未实际执行危险命令、安装 hook 或重启服务。


## 主仓 R2 HIGH 与第二层恢复

按 Lead 裁定 `27252ba2-023a-4fbe-9251-145ef76b6615`，恢复 P1_RE/KILL_RE/_p3_hit 的活动后备层；范围为保留引号来源的 command stage 与可执行载体 payload。合并标点拆为操作符和括号边界；tmux/watch/su/ssh/script/parallel/trap/find/解释器执行参数进入后备层，未知未引用片段默认检查。P1 后备仍使用 `_protected_target`，不绕过 plist 形状治理。

初始 RED **7通过/19失败**（`/tmp/fly1942-r2-focused-red.log`），应用明确治理边界后 RED **26通过/26失败**（`/tmp/fly1942-r2-policy-red.log`）。最终 T13–T15 **79/0**，其中 T15 **31条**载体/语法/负向控制；完整 guard **365/0**（`/tmp/fly1942-r2-guard-full.log`），installer **11/0**（`/tmp/fly1942-r2-install.log`），runbook **62块零命中、dry-run pass**（`/tmp/fly1942-r2-guard-receipt.json`、`/tmp/fly1942-r2-dryrun.log`）。

明确的治理差异：畸形引用消息、解释器 print-only 执行参数包含 restart 文本、含真实变量展开的引用 restart 文本现在拒绝；这来自上述 Lead 裁定。格式正确且无展开的引用消息、quoted heredoc、转义变量字面量继续放行，冻结 MUST_PASS 不回退。未删除 `_non_read_segments`，其未使用状态作为 LOW advisory 保留。新增测试仅进入 kill-path inventory 的 QA-only 夹具，生产 mutation 分类不变。

最终 scanner SHA256 `d20bd4369b6013a5ec144aa1ca931aec63195620b9196ad7fb71538af0fef6cf`。


## Lead 授权的有界 R4 tmux 确认

只扩充已授权 tmux 子命令及其别名、操作数提取。九个评审反例逐条 **merge-base deny → 75cfaf505 allow → 修复后 deny**，回执 `/tmp/fly1942-r4-red.log`；新增 T16 RED **5通过/17失败**，修复后 **22/0**（九反例、六别名、七参数/全局选项控制）。if-shell 条件在非-F时保留执行检查；title/name/target 参数不作为代码；不扩充 Lead 明确排除的其他载体。

全 guard **387/0**（保留既有365项），installer **11/0**，runbook **62块零命中/dry-run pass**。回执 `/tmp/fly1942-r4-full.log`、`/tmp/fly1942-r4-install.log`、`/tmp/fly1942-r4-final-receipt.json`、`/tmp/fly1942-r4-final-dryrun.log`。lint退出0，kill-path inventory5/0且夹具无需新增变化。没有实际执行矩阵命令、安装hook、重启或部署。
