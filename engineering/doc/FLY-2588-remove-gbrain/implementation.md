# FLY-2588 移除 gbrain 集成 — 实施记录
Issue: FLY-2588 (https://linear.app/geoforge3d/issue/FLY-2588)
日期: 2026-09-15
基于: issue 描述；Lead ruling 33f2db00-1d8a-4b16-a76f-891056f694ac

## 批准范围

本单为 simple_code；Lead 明确 issue 的现状、要做、QA 判据为批准范围，无独立设计阶段或设计评审。仅做删除，不增加替代集成。

- `packages/teamlead/scripts/claude-lead.sh`：删除二进制探测、专用 MCP 注册和配置合并参数，保留其它 MCP 继承。
- `packages/teamlead/scripts/lib/mcp-inherit.sh`：移除专用第五参数和 JSON 合并分支；保留原子写、0600、环境变量检查及通用继承。
- 同步既有 MCP 继承、特殊字符、companion/external launch-plan 测试；保留其它服务和角色隔离断言。
- 删除 `scripts/restart-services.sh`、`scripts/daily-standup.sh` 的同步调用以及 `scripts/sync-gbrain-docs.sh` 本体。
- 更新当前操作文档 `doc/engineer/onboarding/lead-mcp-setup.md`，历史记录不改写。

## 验证路径

1. 修改前：MCP 继承测试 22/22；相关四份 shell 文件 `bash -n` 通过；`pnpm install --frozen-lockfile`、`pnpm -r build` 通过。
2. TDD：先使既有配置写入测试要求四参数接口和三个合并来源，确认旧实现失败，再删除实现。启动 dry-run 需验证其它 MCP 保留及移除后的服务器集合。
3. 运行受影响 shell 测试、restart 静态检查、递归引用检查、`pnpm lint`、`pnpm -r build`、`pnpm test:packages:run`。
4. 提交、PR、有效 code-review verdict、精确头 CI；按 needs_review 路由交接。QA、merge、部署由控制器及 operator 负责。

## 部署后 operator 退役 runbook（Lead 执行）

以下尚未执行；runner 不读取或修改宿主配置内容，不重启服务。

1. 确认新版本已按正常部署流程安装，并记录部署 SHA。在修改配置前按宿主既有安全流程备份，备份可能包含凭据，不打印或上传正文。
2. 检查 `~/.claude/settings.json`，仅移除 gbrain MCP server 项，保留其它配置；同时检查 `~/.claude.json` 顶层 `mcpServers` 并移除同名项。通用继承读取后者，残留项会被作为用户 MCP 重新继承。不要修改不相关的 project-scope MCP。
3. 删除部署副本 `~/.flywheel/bin/sync-gbrain-docs.sh`；检查是否有旧进程或单独配置的同步调度，确认目标身份后由 operator 停止/撤销。删除源文件不会自动删除旧部署副本。
4. 按宿主数据保留策略退役 `~/.gbrain`：先确认没有其它消费者并安全归档必要配置，再移除活动配置；不递归盲删数据。同步 checkout、锁和日志如需清理，先确认不再被进程使用。
5. 通过正常 Lead 更新/重启流程重新生成 workspace `.mcp.json`；仅检查服务器名称，确认不再存在 gbrain 且原有其它 MCP 正常。确认 restart 与 daily-standup 不再调用同步副本。
6. 记录上述每一步结果及真实 Lead MCP 名单作为 host 退役证据。本 PR 的测试/CI 不代表宿主退役已完成。

回滚：仅在获授权后恢复先前源码版本及安全备份的配置/部署副本；不要自动恢复已退役集成。其它 MCP 故障优先排查差异，避免覆盖整份宿主配置。

## 当前实施证据

- 四参数测试红侧：旧 helper 在 Test 11 报 `line 227: $5: unbound variable`，退出 1；删除专用第五参数后 22/22 通过。
- `rg -ni gbrain packages/teamlead/scripts scripts` 无匹配；同步脚本已删除；四份受影响 shell 文件语法通过。
- 特殊字符 10/10、external launch-plan 38/38、restart-deploy-consistency 16/16 通过。
- 修改后 `pnpm -r build` 退出 0；`pnpm lint` 退出 0，报告 21 warnings，未运行自动修复。
- companion launch-plan 最终 52/52 通过。标准 Lead 的精确 MCP 集合为 `flywheel-inbox,flywheel-terminal`。基线 `b9418b780` 的原始 launcher/helper/test（只重定位路径，在隔离 HOME 中运行）复现 47 通过、5 失败：五个 T8 golden 均只缺 `env=DISCORD_OWN_CHAT_CHANNEL=set`。按 Lead ruling 9200b9ef-38ed-4278-95b4-738e9373d093 分支 (a)，仅补 DEPT/COS 两行 fixture，再测全绿；没有修改运行时代码。
- 包测试、代码评审与精确头 CI 的最终状态以 PR 上的测试证据、绑定头评审回执和 Checks 为准；以上 focused 结果不代替全仓门禁或宿主退役。


### 基线 fixture 差异证据

命令：`bash /tmp/fly2588-baseline-companion.sh`（从 `git show b9418b780:<path>` 提取原始 test、launcher、helper；只重定位 SCRIPT_DIR/LEAD_SH/helper source，使用既有隔离 HOME fixture）。退出 1：

```text
T8 product-lead / ops-lead / cos-lead / joycon-lead / sub-lead:
6a7
> env=DISCORD_OWN_CHAT_CHANNEL=set
FLY-231 launch-plan test: 47 passed, 5 failed
```

更新后的仓库命令：`bash packages/teamlead/scripts/__tests__/fly231-companion-launch-plan.test.sh`，退出 0：

```text
FLY-231 launch-plan test: 52 passed, 0 failed
```
