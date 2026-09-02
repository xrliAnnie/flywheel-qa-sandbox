# FLY-2215 报告页生命周期 — 实施证据
Issue: FLY-2215 (https://linear.app/geoforge3d/issue/FLY-2215/publish-report-每发一份报告泄漏一个-chrome-页面而两道-reaper-都够不着它-3-天攒了-125-页-145gb)
日期: 2026-09-02
基于: plan.md

## 1. 审批后实现修正

设计评审通过后，真机观察与 code review R1 发现获批计划里的单 active-tab 清理不足，且已安装的 ProofShot 1.3.1 不能安全实现共享 browser 的 `stop --no-close`：CLI 将 `--no-close` 解析为 `options.close=false`，而 stop 路径读取的是 `options.noClose`。因此不能靠该参数证明 browser 被保留。

Lead 指令 `[lead-instruction 5a6b644d-de23-4d96-8ae4-2d96de44fbbb]`、`[lead-instruction 65817f96-e230-4a21-bff3-11c2bf51dd00]`、`[lead-instruction 9a9a8d96-593b-477e-9d7e-51db9b17c9fd]`、`[lead-instruction 807c3e51-b816-41eb-92ee-438cf604df9f]` 与 `[lead-instruction bc38a8ac-87d4-4c25-89fc-10bbf115af03]` 明确替代了计划中的清理序列；本文件记录偏差，不修改已绑定设计评审的 `plan.md`。

最终序列保持“open what you close”：

1. 用 `agent-browser session list --json` 判断目标 session 在 publish 前是否存在；仅对共享 session 读取 tab baseline。session probe 失败仍独立尝试 tab baseline，并按 unknown/shared 保留 browser；tab baseline 失败时 warning、继续截图，但禁止任何 tab close。
2. `proofshot start` 返回或抛错后，用 `agent-browser tab list --json` 取 post-state，按稳定 tab id 做集合差，并要求 URL 精确等于本次发布 URL。
3. cleanup 先用 `agent-browser record stop` 完成视频；失败时重试一次。两次均失败会明确 warning 说明 recording 可能残留，但绝不以此为由关闭不归本命令所有的 browser。
4. session 原先不存在时跳过逐 tab close，直接 `agent-browser close` 回收整棵自有 browser，避免 agent-browser 必然拒绝关闭最后一个 tab；whole-browser close 失败后才逐 id 尝试回收已识别的自有 report tabs。session 原先存在时只在 baseline 可信时逐个关闭本次新建的报告 page，不碰已有或其他 URL 的 tab。
5. start、截图、录制停止、单 tab 关闭任一失败均走显式降级或 warning；后续清理、temp dir 删除与 lock release 继续执行。

没有修改 reaper、TMPDIR/owner 规则、Bridge、公共 CLI 参数、依赖或 feature flag。

## 2. TDD 证据

- RED `a2fa8caa6`：先锁定 start 后截图失败也必须清理。
- 初版 GREEN `1a5361b76`：暴露单 active-tab 方案，随后由真机证据和 code review R1 否决。
- RED `98d17dfe9`、`7a1bd71b9`：覆盖 browser ownership、共享 session baseline、三个 retry-created report tabs、start/screenshot failure、record-stop/tab-close failure 与 tab 识别失败时不误关 ambient tab。实现前 focused suite 为 7 failures / 35 tests。
- GREEN `dd4fb04be`：改为直接 agent-browser cleanup；focused suite 35/35，通过 TypeScript typecheck。
- RED `bf9f2d9a5`：把 code review R2 的三条 advisory 固化为行为，focused suite 为 7 failures / 38 tests；双 stop failure 用例连续调用两次 publish，第二次 start 在未 reset recording 时会失败。
- GREEN `16922d83b`：owned browser 直接整树关闭、record stop 单次重试与 double-failure reset、preflight warning 降级；focused suite 38/38，连续 publish 的下一次 start 与截图均成功。
- RED `3c36e481f`：按 R3 ownership finding 删除 shared-browser reset 契约，分别锁定 session/tab 两种 preflight failure，并增加 owned close failure 的逐 tab fallback；实现前 focused suite 为 4 failures / 39 tests。
- GREEN `9e7265600`：严格限制 cleanup authority；focused suite 39/39，通过 TypeScript typecheck。

## 3. 浏览器证据边界

code review R1 的隔离真机复现看到一次 `proofshot start` 后有 3 个 page：两个相同报告 URL 与一个 newtab；生产 CDP 证据则显示长期累计 121 个已发布报告 page。这个控制组证明“只关 active tab”仍会泄漏，也解释了 retry page 必须纳入差集。

code review R2 对 built code 做了两组隔离真机检查：command-owned browser 清理后确认 session 已不存在；保留 shared browser 连续发布 4 次（其中一次强制 `record stop` 失败，下一次触发三轮 recording retry）时，清理仍关闭了 retry 留下的 `t4/t5/t6`，总 page 数每轮保持 baseline 3，没有随发布次数增长。该轮没有给出 renderer 计数，因此不能替代后续 renderer 验收。

本 implement resident sandbox 的隔离 Chrome 启动在写 `DevToolsActivePort` 前退出；另一次隔离 socket 尝试被目录权限拒绝。为避免误触共享 default session，这里没有伪造 AFTER 真机结果。独立 QA 仍需用同一隔离 harness 连续发布 N=3（含强制截图失败/retry），逐轮记录 page 与 renderer 的 BEFORE/AFTER，并验证下一次 start 成功；通过条件是 report page 回到 baseline、renderer 不随 N 单调增长。

## 4. 本节点验证

- `pnpm lint`：通过；14 条均为仓库既存 warning/info，本次文件无新增诊断。
- `pnpm -r build`：通过（22/23 workspace projects）。
- `pnpm --filter flywheel-comm typecheck`：通过。
- `pnpm --filter flywheel-comm exec vitest run src/__tests__/publish-report.test.ts`：39/39 通过。
- `pnpm --filter flywheel-comm test:run`：126 files，1759 passed，2 skipped。
- `pnpm test:packages:run`：唯一失败为 `packages/core/test/tmux-viewer.macos.test.ts` 的 2 个真实 Terminal.app/osascript 用例；resident session 收到 `Connection Invalid`。core 其余 219 个测试通过，失败与本单代码路径无关。
- 本单没有新增 `scripts/__tests__/*.test.sh`。

## 5. 审查记录

- design review：APPROVED，绑定 `a40db8516`。
- code review R1：CHANGES_REQUESTED，blocking finding `closes-only-active-tab-open-page-still-leaks`；已由 tab-id/URL 差集与 direct agent-browser cleanup 修复。
- code review R2：APPROVED，绑定 `552e91c63`。三条 MEDIUM advisory 为 command-owned browser 最后一页 warning、shared recording stop failure 的下一轮退化，以及 preflight JSON 漂移退化；Lead 要求在 QA 前全部修复，完成于 `16922d83b`。
- code review R3：APPROVED，绑定 `37dad46904`。两条 MEDIUM ownership advisory 指出空 baseline 可能误关被 `open` 导航的已有 tab，以及 double-stop recovery 会关闭 shared browser；一条 LOW 要求 owned close failure 尽力逐 tab 回收。Lead 要求全部处理，完成于 `9e7265600`。
- code review R4：APPROVED，绑定 `c66c542a7e`。唯一 LOW advisory 是 shared tab baseline 不可用时会按治理决定跳过 cleanup、可能残留本轮 page；reviewer 明确标记 no code change required，建议后续把 warning 接入 ops alert。
- 本机 `codex:rescue` review-only 启动在嵌套 macOS sandbox 初始化时报 status 71，未产生审查结论；code review R4 的 cross-family verdict 是最终有效审查结论。
