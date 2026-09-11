# FLY-1942 通信层防线三件套 — C6 实施证据
Issue: FLY-1942 (https://linear.app/geoforge3d/issue/FLY-1942/通信层防线-三件套发信短-id-静默死信-bot-永久偷听-guard-误拦并-19431953)
日期: 2026-09-11
基于: research.md

## 改动

`claude-lead.sh` 在 core channel 派生块后通过同源 `loadProjects()` 精确匹配 PROJECT_NAME 与 LEAD_ID，取 lead.chatChannel；缺失或配置读取失败则空值，不回落到 inherited env。child env_args 无条件设置 `DISCORD_OWN_CHAT_CHANNEL=${LEAD_CHAT_CHANNEL:-}`，通过原 env-i 传递路径进入插件进程。

`cross-dept-channel-rules.md` 增加一句要求：guard 拒绝文本含 probe= 读数，上报时贴完整拒绝文本。未改 Codex child allowlist。

## RED → GREEN

新增 `packages/teamlead/scripts/__tests__/claude-lead-own-chat-channel.test.sh`，先跑 RED：exit 1，`missing exact-project/lead chat-channel resolver`；日志 `/tmp/fly1942-c6-red.log`。

最小实现后原测试 GREEN：**5 cases passed，exit 0**；日志 `/tmp/fly1942-c6-green.log`。

测试从实际 launcher 提取 resolver 与无条件 env_args 项，用临时 ESM ProjectConfig 模块执行实际派生代码；不执行 launcher。检查不同项目同名 Lead、同项目其他 Lead 不串线，以及 missing lead、missing project、missing chatChannel、配置抛错五种情况；每种都预置错误 inherited derived/chat 值，最终 `env -i` 子进程仅看到期望 own-channel 字段（缺失为空），不泄漏无关 inherited 变量。另断言该项位于真实 env_args 至 env-i 边界内，原遍历仍把 env_args 转入 child_env。

补充验证：

- `claude-lead-comm-db-path.test.sh`：passed，exit 0。
- `claude-lead-config-root.test.sh`：**2 passed / 0 failed**，隔离 fixture。
- 两个 shell 文件 `bash -n`：exit 0。
- 修改文件 `git diff --check`：exit 0。

主 runner 已在 CI 中紧邻 comm-db-path shell test 登记新增测试（其负责的单行改动）。未 build、提交、推送、修改安装环境或启动/重启真实 Lead。此证据验证 env 接线，不替代 C7 插件测试或生产跨 Lead 回放。
