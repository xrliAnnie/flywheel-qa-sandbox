# FLY-2024 constructor regression pin — QA rework 证据
Issue: FLY-2024 (https://linear.app/geoforge3d/issue/FLY-2024/xiaohongshu-mcp-搜索调用卡住时泄漏一个有-dock-图标的-chromium-60s-超时被下一行-contextctx)
日期: 2026-08-25
基于: plan.md

## 双仓 head 绑定

- Flywheel 主 PR: xrliAnnie/flywheel#954
- xiaohongshu-mcp companion PR: xrliAnnie/xiaohongshu-mcp#8
- 修复后的 fork commit: `a67785e7a2698368feac3d3b9533967bc0d92045`
- 上一轮被 QA 判定为空过绿的 fork commit: `2de27d51a168d8ab0c1659436448e2e92a0867d0`

本轮只改 `service_timeout_test.go` 的 `TestConstructorStall` fixture。`/` handler 在写任何 header/body 之前先等待 `r.Context().Done()`；没有生产代码改动。

## 四行 mutation matrix

下表来自 attempt 1 QA 在无沙盒 macOS 宿主上的独立进程实测；行 3/4 使用的 fixture 改动与 `a67785e` 字节级一致。

| 行 | constructor 源码 | fixture | 结果 | 耗时 / 出口 |
|---|---|---|---|---|
| 1 | 保留 `Timeout(60s)` | 旧版先写并 flush | PASS | 14.3s，`err=没有捕获到 feeds 数据` |
| 2 | 删除 `Timeout(60s)` | 旧版先写并 flush | PASS（证明旧钉失效） | 11.3s，同一无数据错误 |
| 3 | 保留 `Timeout(60s)` | 新版先等待 request context | PASS | 66.3s，`panic=context deadline exceeded` |
| 4 | 删除 `Timeout(60s)` | 新版先等待 request context | FAIL（mutation 被咬住） | 120s 未返回 |

权威原始报告: `/private/tmp/claude-501/-Users-xiaorongli-Dev-flywheel-FLY-2024/94283841-84d2-4b24-a9fa-480d82c0857c/scratchpad/qa/qa-report.md`。

## implement 侧验证与边界

- `GOFLAGS=-mod=readonly go test -count=1 ./...`: PASS。
- `GOFLAGS=-mod=readonly go test -count=1 -tags integration -run '^$' .`: PASS，证明新 fixture 在 root integration package 可编译。
- 当前 Codex sandbox 的真机命令在 1.44s 失败于 rod launcher 无法取得 Chrome debug URL，尚未进入被测行为；该结果不计入 mutation matrix，也不冒充 RED/GREEN。
- attempt 2 QA 必须在无沙盒宿主上对新 fork head `a67785e` 重跑行 3/4。仍不部署；rebuild/restart xiaohongshu-mcp 继续需要独立 founder 确认。
