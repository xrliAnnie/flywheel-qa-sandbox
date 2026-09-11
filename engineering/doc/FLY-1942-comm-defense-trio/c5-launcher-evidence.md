# FLY-1942 通信层防线三件套 — C5 启动器实施证据
Issue: FLY-1942 (https://linear.app/geoforge3d/issue/FLY-1942/通信层防线-三件套发信短-id-静默死信-bot-永久偷听-guard-误拦并-19431953)
日期: 2026-09-11
基于: plan.md

## 范围

- `scripts/flywheel-lead.sh`：从权威 selector 的 roundtableChannel 同时导出 CROSS_DEPT 与显式 `FLYWHEEL_ROUNDTABLE_CHANNEL_ID`，保留先清理 ambient routing 的行为。
- `packages/teamlead/scripts/run-codex-lead-mufasa-tui-fullaccess.sh`：导出显式 roundtable parent，默认沿用既定 Mufasa roundtable ID。
- `packages/teamlead/scripts/codex-lead-tui-home.sh`：autoContinue marker 只认 trimmed 显式 roundtable ID；删除 crossDept[0] 回退。
- 更新三者已有 shell 测试，不修改运行时 TS、claude-lead.sh 或部署状态。

## RED → GREEN

先修改测试，再修改三个生产脚本：

| 套件 | RED | GREEN |
|---|---|---|
| `scripts/__tests__/flywheel-lead.test.sh` | 29 passed / 2 failed | **31 passed / 0 failed** |
| `packages/teamlead/scripts/__tests__/run-codex-lead-mufasa-tui-fullaccess.test.sh` | 22 passed / 1 failed | **23 passed / 0 failed** |
| `packages/teamlead/scripts/__tests__/codex-lead-tui-home.test.sh` | 59 passed / 5 failed | **最终 64 passed / 0 failed**，首轮 stale-dist 结果见下 |

Generic RED 两个失败中，一个是预期的显式 parent 缺失；另一个是既有 stop 测试临时输出 age CLI Usage。生产修改仅一行 export，完整 GREEN 不再复现 stop 失败。

新增/更新 tui-home 断言覆盖：只有 crossDept、有 retired flag、空项前缀、chat overlap、空白显式 parent 都不输出 `FLYWHEEL_ROUNDTABLE_THREAD_AUTOCONTINUE_EFFECTIVE`；显式 parent 与 trimmed parent 输出 marker。均通过。两个 launcher 测试使用已有 mock runtime/env capture，generic case 证明 selector 值覆盖 ambient 错误值。

日志均在 `/tmp/fly1942-c5-{generic,mufasa,home}-{red,green}.log`。

## 编译产物边界

首轮 home GREEN 中 4 个失败均为最终 shell→compiled-runtime gate 比较；测试读取旧 dist parser，仍含 crossDept 回退，与本次新 shell 合同不同。不是将失败 suite 报绿。C5 TS 主体完成并由获分配 build slot 的 runner 重新构建成功后，本子任务重跑完整 home 套件：**64 passed / 0 failed，exit 0**，包含全部 shell→runtime gate 比较。日志 `/tmp/fly1942-c5-home-fresh-dist.log`。本子任务未自行 build。

三个生产脚本 `bash -n` 通过，六个修改文件限定 `git diff --check` 通过。只运行隔离临时目录中的既有测试，未启动真实 Lead、安装服务、修改安装环境、提交或推送。
