# FLY-2454 TUI socket 隔离 — 返工证据
Issue: FLY-2454
日期: 2026-09-09
基于: plan.md

Lead instruction c7cef5ff-9e7b-40f6-8a6b-907d93ab6926 限定四项返工。
QA 在 42f3e74eb 的新 slot 3 发现 defaultEnsureSessionAsync 显式传入生产
`-S /private/tmp/tmux-501/default`，在生产新增 runner-test-slot-3 session。
证据：`~/.flywheel/qa-evidence/FLY-2454/20260909T2115Z-attempt2-head-42f3e74eb/finding-tmux-socket-fallback.txt`。
旧 slot 2 已有同名 session，掩盖创建行为；后续 QA 必须使用非 2、非 3 的新房号。

## 因果与修改

`tmuxSocketPath()` 原先只识别 override，忽略 TMUX_TMPDIR。
现在优先级为合法绝对 override > TMUX_TMPDIR > 原 /tmp 默认；保留 realpath 解析。
slot 契约仍要求 override clear/mustBeAbsent，不通过改默认环境掩盖调用者缺陷。
TMUX_TMPDIR 的 confinedConsumers 登记显式 -S 的默认 ensure-session 调用者；
kill-path inventory 锁住该登记、root 解析和 override 禁用规则。
另增加一行契约断言，防止删除 unconfinedConsumers 披露。

## RED / GREEN

新 socket 测试经过 ensureRunnerTuiWindow 的默认 ensure-session 与 rescue 参数构造；
仅截获 child_process.spawn 和无关 window probes，避免旧代码实际向生产创建 session。
RED 捕获生产 socket，失败原文：expected ['/private/tmp/tmux-501/default'] to not include
'/private/tmp/tmux-501/default'。修后 slot、override、production 三种创建目标均通过。
这证明实际调用链的命令路由，不冒充真机 session 验收；后者仍由 QA 新房执行。

inventory 新断言先因缺 confinedConsumers RED；补登记后 GREEN。
删除 unconfinedConsumers 的 mutation 使 shell suite exit 1，点名 missing disclosure；
原契约已在 finally 恢复，正常 shell suite exit 0。
聚焦三文件 68/68 通过。原日志位于 `/private/tmp/FLY-2454-socket-*.log` 与
`/private/tmp/FLY-2454-disclosure-red.log`。

完整门禁正在运行，逐项实际退出码写入
`/private/tmp/FLY-2454-socket-rework/receipts.json`；不提前声称完整通过。
新头需要一次正常 push、fresh exact-head review 与 CI 14/14，随后 needs_review。
2231 长停留裁定、批准计划及生产服务均未改动。
