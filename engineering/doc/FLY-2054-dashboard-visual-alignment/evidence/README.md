# FLY-2054 管理台视觉回归 — 浏览器证据
Issue: FLY-2054 (https://linear.app/geoforge3d/issue/FLY-2054/dashboard视觉-管理台视觉回归原型逐屏-side-by-side-对齐-fly-1038-prototype-观感founder-8)
日期: 2026-08-25
基于: plan.md

## 当前状态

实现侧自动证据已完成，真实浏览器截图在本 implement runner 内被运行权限阻塞，必须由后续独立 QA 在 browser-authorized phase 运行本目录 harness 后补齐。这里不把 happy-dom 或静态 CSS contract 冒充真实浏览器截图。

- focused management suites：17 files / 115 tests PASS；
- FLY-1262 PRD §6：§6.1 aggregate、§6.2 no manual inventory、§6.3 auto discovery、§6.4 unified writeback 四项分别 PASS；
- full-repo static gates：`pnpm lint` 与 `pnpm -r build` PASS；
- full-repo package tests：本机 sandbox 下没有出现本单相关失败，但总命令无法给出全绿结论：
  - `flywheel-core` 的 2 个真实 Terminal/AppleScript 测试因 UI service `Connection Invalid` 失败；排除这 2 个 host-only 测试后 core 为 19 files / 219 tests PASS；
  - 其余 package 并发 shard 为 721/728 files PASS，红灯是 10 个资源超时或只读 `~/.npm` cache；用可写 cache 隔离复跑全部 7 个红灯文件后均 PASS（其中 `createLeadRuntime-preflight` 再单文件复跑为 4/4 PASS）；
- browser capability probe（2026-08-25 15:13–15:15 PT）：
  - `chrome_devtools` connector 暴露在 tool surface，但调用返回 `MCP tool call requires approval, but approval policy is never`；
  - system Google Chrome `151.0.7922.174` 与 Playwright Chrome for Testing `145.0.7632.6` 均在启动时报 `MachPortRendezvousServer ... Permission denied (1100)`；
  - macOS LaunchServices 同样无法从该 sandbox 打开 Chrome。

## 可复现 harness

`harness.mjs` 只提供两个 loopback 页面和内存 fixture：

- `/prototype`：直接读取唯一形态权威 `product/doc/FLY-1038-unified-management-dashboard/prototype/dashboard.html`；
- `/production`：读取当前 worktree build 的 `getFleetConsoleHtml()`；
- `/production-missing`：只为真缺模型阳性对照给普通 agent DAG 注入 error；
- `/api/fleet/snapshot`：内存 fixture，包含 ordinary flywheel + derived Infra、长值 `Anthropic` / `Opus 5 (1M)`、正常 land-v1 DAG、Cron、Feature Flags；
- 不实现 stage/apply/progress 写接口，不读取 live inventory/config/plist。

在可启动浏览器的同一 worktree 执行：

```bash
pnpm --filter flywheel-teamlead build
node engineering/doc/FLY-2054-dashboard-visual-alignment/evidence/harness.mjs
node engineering/doc/FLY-2054-dashboard-visual-alignment/evidence/capture.mjs
```

如 Chrome/ffmpeg 不在默认位置，分别设置 task-scoped `FLY2054_CHROME_EXECUTABLE`、`FLY2054_FFMPEG_EXECUTABLE`。capture 使用 1440×1000@1x，生成 raw prototype/production PNG、六张 `side-by-side-*.png` 与 `metrics.json`。

## QA 逐屏矩阵

| screen | 产物 | 过门观察 |
|---|---|---|
| 模型 | `side-by-side-model.png` | 浅色 mac-window；sidebar、rail、detail 密度；`Anthropic` / `Opus 5 (1M)` 完整 |
| Infra | `side-by-side-infra.png` | flywheel/Infra 各一个入口；Infra 仅两个 dept Leads；无 Runner/DAG/Cron tabs |
| DAG 正常 | `side-by-side-dag.png` | land-v1 不产生 model error；agent stages 可编辑 |
| DAG 阳性 | `side-by-side-dag-missing.png` | 普通 agent 真缺 model 时红字仍出现 |
| Cron | `side-by-side-cron.png` | schedule/toggle/model 层次与原型一致，交互 target 保留 |
| Feature Flags | `side-by-side-flags.png` | 分组、全局值与 override 层次清晰；统一提交栏行为未变 |

`metrics.json` 的硬断言应全部满足：

1. inactive Feature Flags page `display:none`；
2. provider/model/effort 的 canvas `textWidth <= availableTextWidth`；且每屏所有可见 `select[data-model-part]` 的 right 不得越过所属 `.card` / `.lead-row` 的 right（容差 1px，违规时 capture 直接失败）；select 使用 `appearance:none` + 明确 `padding-right:28px` 自有箭头保留位，不猜 native arrow 宽度；
3. sidebar `flywheelButtons=1`、`infraButtons=1`；
4. project header 无 `file:` / hash；
5. normal DAG `role-error=0`，missing-model fixture `role-error>0`。

这些是作者 harness 与待补证据，不替代独立 QA 结论或 founder 终验。
