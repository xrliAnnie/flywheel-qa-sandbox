# FLY-2257 管理台 UX 落地 — 验收证据

Issue: FLY-2257 (https://linear.app/geoforge3d/issue/FLY-2257/管理台ux-fly-2071-实现-dag模板统一框尺寸花名册sourcelink链接删项目面板flag语义化删governance)
日期: 2026-09-03
基于: plan.md

## Snapshot v2 的旧页面读者实测

从 `main:packages/teamlead/src/bridge/fleet-console-html.ts` 读取并执行旧页面脚本,在 happy-dom 中喂入一份 schema v2 snapshot。snapshot 含一条没有 `category` 字段的 flag;执行结果为:

```json
{"oldReaderSource":"main","snapshotSchema":2,"groupTitle":"undefined1","flagRows":1}
```

旧页面没有报 schema 错,而是仍然渲染这条 flag,同时把分组标题显示为 `undefined`(后跟数量 `1`)。因此新页面的版本握手只保护「新页面遇到旧 / 回滚后端」;部署前已打开的旧 tab 不受保护,实际退化是可见的错误分组标题。

## 可复现浏览器 harness

先构建,再分别启动 fixture server 与 capture:

```bash
pnpm -r build
node engineering/doc/FLY-2257-console-ux-implement/evidence/harness.mjs
node engineering/doc/FLY-2257-console-ux-implement/evidence/capture.mjs --self-check
node engineering/doc/FLY-2257-console-ux-implement/evidence/capture.mjs
```

`harness.mjs` 只在 `127.0.0.1:18857` 提供生产 `getFleetConsoleHtml()` 和内存 snapshot,没有写接口。fixture 自检结果:

```json
{
  "schemaVersion": 2,
  "dags": 6,
  "roles": 3,
  "flags": 21,
  "onMeans": { "disables": 2, "nonBool": 3, "enables": 16 },
  "longest": 9
}
```

其中产品 3 卡;工程 3 卡,包含 5 节点、4 节点和 9 节点换行阳性卡;花名册 3 人且 1 人没有 `sourceLink`。如 Chrome 不在默认位置,设置 task-scoped `FLY2257_CHROME_EXECUTABLE`。

负向自检故意不打开 Flags 页,直接执行与正式 capture 相同的四列几何断言。正确结果必须打印 `hidden-page assertions correctly failed` 并以非零退出;如果隐藏页也能通过,尺子无效。正式 capture 为 1024 / 1280 / 1440 三档各新建一个已经设好宽度的 target,不靠导航后的 resize 纠正。

正式运行应生成 `metrics.json` 与 9 张 PNG:

- `1024|1280|1440-product.png`;
- `1024|1280|1440-engineering.png`;
- `1024|1280|1440-flags.png`。

`metrics.json.captures` 对每一张图记录 `file`、`tab`、`requestedWidth` 和浏览器内实测的 `measuredViewportWidth`;脚本要求 9 条记录齐全且请求宽度与实测宽度逐条相等。每档 Flags 截图前都会显式点击 Flags、等待页面 active 且表头宽度大于 0,再执行四列几何断言。

## 浏览器能力实测(当前 implement sandbox)

当前环境未能进入页面断言,所以没有 PNG 或 `metrics.json`,也不把静态 / happy-dom 证据冒充 A11:

- system Chrome 153 与 Playwright Chromium Headless Shell 145 均在启动时失败;直接探针的根因是 `MachPortRendezvousServer ... Permission denied (1100)`;
- 临时下载到 `/private/tmp` 的 Playwright Firefox 146 启动后收到 `SIGABRT`;
- 独立 `chrome_devtools` connector 的 page-list 调用也没有返回。

`capture.mjs --self-check` 在本环境的非零退出发生于浏览器启动层,**不是**预期的隐藏页断言,因此没有把它记为自检通过。实现节点已通过非阻塞问题 `52f7b404-e132-452c-8ff5-2af9da9bdb8e` 把浏览器宿主缺口报告给 Lead;独立 QA 应在 browser-authorized host 跑上面的两条 capture 命令并人工查看 9 张图。

## 自动断言与产品定义映射

| capture 硬断言 | 产品定义 / process-log | 证明什么 |
|---|---|---|
| 产品与工程两次量测合并后,chip 宽高集合大小为 1 | §1.4 / 13 | 框尺寸跨卡、跨 tab 一致 |
| `resizeCount === 0`,每个 `scrollWidth <= clientWidth` | §1.4 / 14 | 冷路径不靠 resize,没有横向滚动 |
| chip right 不超过所属 squad right | §1.4 / 14 | 最右节点不裁切 |
| 9 节点卡 `rows > 1`,且尺寸仍属于唯一集合 | §1.4 / 15 | 超下限就换行,不继续缩小 |
| 两个 href 与 fixture 逐字相等,null 项没有 href | §5.1 / 18 | 链接只来自后端 `sourceLink` |
| 激活 Flags 页后表头宽度 > 0,表头与首行四列 left 对齐 | §5.2 / 18 | 真量可见页面,避免隐藏态几何假绿 |
| 每行 `.flag-read` 文案写入 metrics | §5.3 / 18 | 开关显示的是含义,不是裸 on/off |

## Flag 值不变量

2026-09-03 再读同一个生产 Bridge 的 21 条 global / project override 值,与本目录基线逐项比较:

```text
SAME: 21 live flag values and project overrides match the 2026-09-03 baseline
```

registry 的 `[name,default,polarity,valueKind,scope,source]` 在 C1 改前 / 改后均为 21 条,sha256 均为 `c195f607d24dfed364ed82aeeebe9ff54f437fefe3a959ce43a073fba9e5bf33`。值解析测试没有改写;本单新增的 `onMeans` 只用于 snapshot / 页面展示。

## 非视觉验证结果

2026-09-03 在 implement worktree 执行:

- `pnpm lint`: exit 0(仓库既有 14 warnings);
- `pnpm -r build`: exit 0;
- FLY-2257 焦点测试: config 58 / 58,teamlead 137 / 137;
- 本分支新增的 5 个 `scripts/__tests__/*.test.sh`: 全部 exit 0;
- registry 重算:21 条,上述 fingerprint 不变,展示语义为 enables 16 / disables 2 / 非 bool 3。

`pnpm test:packages:run` 的原始宿主运行只失败于 2 条需要真实 Terminal.app Apple Events 的 macOS 用例;当前 sandbox 返回 Connection Invalid / AppleScript syntax error。按测试文件既有的 headless 跳过条件重跑后,所有产品相关包均通过,但仓库全量运行分别遭遇两个与本改动无关的宿主抖动:一次与正在运行的 ProofShot 争抢全机锁而得到 `ELOCK_TIMEOUT`,另一次在 claude-runner 972 / 972 断言通过后由 Vitest worker 报 `Timeout calling "onTaskUpdate"`。针对性复验为 `visual-capture` 65 / 65、`claude-profile` 126 / 126、FLY-1253 默认调度 1 / 1。问题 `05500d2e-e111-4545-8e3a-3ef88a155268` 已把原始失败与复验证据同步给 Lead。
