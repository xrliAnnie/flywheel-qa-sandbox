# FLY-1942 通信层防线三件套 — C7 插件接线证据
Issue: FLY-1942 (https://linear.app/geoforge3d/issue/FLY-1942/通信层防线-三件套发信短-id-静默死信-bot-永久偷听-guard-误拦并-19431953)
日期: 2026-09-11
基于: plan.md

Fork：xrliAnnie/claude-plugins-official。本次重新核验 main=e122f46b44aef48e90539fa249e5e59e0403545e、Discord plugin=0.0.7，与计划一致。隔离 checkout `.flywheel/runs/FLY-1942-targets/claude-plugins-official`，分支 `flywheel-FLY-1942-reply-guard`。

server.ts 删除独立的 1500ms 宽泛 fail-closed 实现，reply/edit_message 保持原调用位置，委托共享 client；只有 outcome.deny 存在才返回 MCP isError，拒绝文本通过 formatGuardDeny 生成。插件版本增至 0.0.8。

接线测试提取实际 server wrapper、以 Bun Transpiler 执行并注入 client：跨频道 unavailable/local allow 不阻止回复，Bridge deny 原 outcome 传给 formatter，roundtableThread 参数透传。RED 为缺少共享 client 接线，GREEN 1 项/6 断言。日志 `/tmp/fly1942-c7-wiring-red.log`、`/tmp/fly1942-c7-wiring-green.log`。

`bun install --frozen-lockfile` 成功。客户端及验证结果见下文；上述不是生产探针、Discord 发信或受管上线证据。


完成回执：fork commit `4a34773`。客户端专属16项/69断言；插件全套 `bun test` 244项/674断言、0失败（`/tmp/fly1942-c7-full-test.log`）；`bun build external_plugins/discord/server.ts --target=bun --packages=external --outdir /tmp/fly1942-plugin-build` 打包15模块成功。最终仅格式调整，无逻辑改动。

回滚演练在 `/tmp/fly1942-plugin-rollback` detached worktree：对 4a34773 执行 `git revert --no-commit HEAD`，将 plugin.json 版本改为0.0.9；`git diff e122f46 -- external_plugins/discord ':!external_plugins/discord/.claude-plugin/plugin.json'` 为空，唯一余差为 plugin.json 0.0.7→0.0.9。演练工作树已删除；fork feature branch、fork main 与安装缓存未改变。实际部署/回滚均未执行。
