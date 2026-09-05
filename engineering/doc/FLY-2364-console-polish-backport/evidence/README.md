# FLY-2364 证据

Issue: FLY-2364 (https://linear.app/geoforge3d/issue/FLY-2364/2356p0-把原型里已改好的-8-条-polish-合回生产管理台9876dag-节点中文-label-按-nodetype-取色)
日期: 2026-09-05
基于: plan.md

## 设计段已产出(改前基线,生产 `:9876`)

- `ruler-baseline.mjs`:设计段用的只读尺子(只发 GET,任何非 GET 请求计入 `pageErrors`)。跑法:
  ```bash
  mkdir -p /tmp/fly2364 && TMPDIR=/tmp/fly2364 CONSOLE_URL=http://127.0.0.1:9876/ node engineering/doc/FLY-2364-console-polish-backport/evidence/ruler-baseline.mjs
  ```
  依赖全局 `~/.npm-global/lib/node_modules/playwright`(1.58.1)与本机 `chromium_headless_shell`;`TMPDIR` 必须短,runner 默认的 89 字符路径会让 socket 失败。
- `baseline-9876-2026-09-05.json`:上面这把尺子 2026-09-05 在 `:9876`(Bridge build `79f6fc39b`,1600×1000)量到的全部数字;plan §7「今日(改前)」一列逐格来自它。
- `baseline-9876-01-rail-model.png` / `-02-dag-engineering.png` / `-03-flags.png`:同一次运行的截图。

## 实现节点证据(plan C5,生产渲染器)

- `harness.mjs`:直接导入当前 worktree build 出来的 `getFleetConsoleHtml`,只提供只读 fixture 路由。`/__fixture` 会返回 fixture id、渲染器 SHA256 与进程 PID,供启动和清理两端核对身份。
- `ruler.mjs`:把 `ruler-baseline.mjs` 泛化为 fixture/production 两臂尺子;fixture 臂保留 plan §7 的确定性精确断言,production 臂接受真实项目数和真实 manifest。每项都打印 `PASS` / `FAIL` / `PENDING_DEPLOY`、期望值和当前值;`--require-all` 会把待部署项 fail-close。C7 的合法原因标签从当前构建产物(缺失时退回源码)里的 `LOCK_KINDS` 静态提取,不从待测 DOM 循环自证。两臂都监听所有请求并把非 GET 计红,另以 1000×900 视口检查模型列头的响应式行为。`--self-check` 故意对未激活 DAG 页断言宽度 > 0,只允许该负控失败。
- `run.sh`:固定使用隔离端口 18864 和 `/tmp/fly2364/{self-check,red,green}`;每轮先 build,再核对 fixture id 与 HTML hash。runner sandbox 不允许 `ps`,所以用只读 `GET /__fixture` 返回的 PID 做等价进程身份校验;Playwright 在这个 sandbox 以 `--single-process` 启动 Chromium。

可复现命令:

```bash
bash engineering/doc/FLY-2364-console-polish-backport/evidence/run.sh self-check
bash engineering/doc/FLY-2364-console-polish-backport/evidence/run.sh red
bash engineering/doc/FLY-2364-console-polish-backport/evidence/run.sh green
```

本实现节点结果:

- 自检只报 `SELF_CHECK_FAILED_AS_EXPECTED: HIDDEN_DAG_WIDTH`,脚本把这个预期非零结果判为有效。
- RED 精确为 `FAIL: B6,D,A4,A3`;既有 A1/A2/A5/C7/C8 与 DAG/error guards 均为绿。
- GREEN 为 `FAIL: none`,`11 项 / 0 红`;浏览器 console error、page error、非 GET 请求均为 0。
- 项目栏组标题 8→2,6 个真实项目仍全部可见;DAG 工程图 9 个主节点、产品图 9 个节点,design/implement/qa/generic 四种样式可区分。
- 7 个可编辑 DAG 模型行全部显示「模板绑定」;loop 文案为「QA 失败重来 ×3」「创始人打回重做」,旧 manifest 的未知 id 退回 `legacy_retry`,且路径先画、label 后画。
- Flags 页实测 0.93 屏;页面可见 CLI 重复 0、硬编码「四种」0、错误 0。按 Lead 决策仅报告高度,不为追求高度移除 founder 定义的状态行。
- 六张 GREEN 截图经人工核对:项目栏/模型、工程 DAG、工程 loop 放大、产品 DAG、Flags、窄屏模型均无截断、遮挡或响应式回归；窄屏隐藏共享列头后会恢复每行可见标签，三个下拉也各有 `aria-label`。

原始结构化结果见 `red-metrics.json` 与 `green-metrics.json`;截图见同目录 `green-*.png`。

## 真实 `:9876` 预部署复测

2026-09-05 在已部署 Bridge `79f6fc3` 上执行 `--target prod`:6 项 `PASS`、5 项
`PENDING_DEPLOY`、0 项 `FAIL`。待部署项是 B6/D/A4/A3/C7;每项的期望值与当前值已写入
`prod-9876-predeploy-2026-09-05/metrics.json`,同目录保留六张真实生产截图。当前生产数据包含
6 个项目;production 臂不再把 fixture 的 `projectCount === 6`、`tpl_legacy_loop` 或 loop 精确
文案当作生产判据,因此项目数或 manifest 改变不会让尺子崩溃。

预部署复跑命令(允许 `PENDING_DEPLOY`,任何真正的 `FAIL` 仍退出非零):

```bash
TMPDIR=/tmp/fly2364 \
  OUT_DIR=engineering/doc/FLY-2364-console-polish-backport/evidence/prod-9876-predeploy-2026-09-05 \
  CONSOLE_URL=http://127.0.0.1:9876/ \
  node engineering/doc/FLY-2364-console-polish-backport/evidence/ruler.mjs --target prod
```

## 部署后 `:9876` 全量复测(由 QA/Lead 执行)

实现节点不得重启 Bridge 或部署,所以 fixture 的全绿和上面的生产三态报告都不虚报当前
`:9876` 已更新。12:00 PT updater 班车部署后,QA/Lead 用下面一条命令完成八项全绿的最终
复跑;`--require-all` 要求每项都是 `PASS`,否则退出非零。最终 `metrics.json` 与截图收入
ship report:

```bash
TMPDIR=/tmp/fly2364 OUT_DIR=/tmp/fly2364/prod CONSOLE_URL=http://127.0.0.1:9876/ \
  node engineering/doc/FLY-2364-console-polish-backport/evidence/ruler.mjs --target prod --require-all
```
