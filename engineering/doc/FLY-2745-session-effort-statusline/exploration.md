# FLY-2745 会话 effort 状态栏 — 探索
Issue: FLY-2745 (https://linear.app/geoforge3d/issue/FLY-2745/状态栏可信-cmux-里-leadrunner-的状态栏显示的-effort-不是本会话真实-effortstatusline)
日期: 2026-09-18
基于: 无

## 问题

cmux 中 Claude Lead/runner 的状态栏目前把全局
`~/.claude/settings.json` 的 `effortLevel` 当成本会话 effort。当前全局值是
`xhigh`，所以以 `--effort medium` 启动且逐请求确实使用 `medium` 的 Tadashi
仍显示 `xhigh`。这不是 effort 决定链失效，而是显示层读错了权威来源。

当前字节还在全局值缺失时根据 Opus 4.6 型号猜 `medium`。它同样不是会话事实，
也必须从显示路径移除。没有会话证据时应明确显示未知，不能省略字段或猜默认值。

## 已锁定边界

- 只修 `scripts/statusline-command.sh` 的显示来源及其测试、installer smoke。
- 不改注册表、模板、Lead/runner 的 effort 选择或启动参数。
- 不改全局 `settings.json`，也不讨论它是否仍作为 CLI 默认值。
- 不安装脚本、不重启 Lead/runner、不派 QA、不 merge。
- 本地不跑 `pnpm test:packages:run`；交付报告给出与 `origin/main` 的 merge-tree。

## 数据流候选

### A. stdin + Claude 原生环境 + 进程 argv（推荐）

按以下次序取第一个有效值：

1. statusline stdin JSON 的 `effort.level`；
2. Claude 为子进程提供的 `CLAUDE_EFFORT`；
3. 沿父进程链找到 Claude argv 的 `--effort <level>` 或 `--effort=<level>`；
4. 都缺失则显示 `?`。

优点：stdin 是本帧最直接的会话事实；原生环境无需修改启动器；argv 给旧版本或未继承
环境的会话兜底。缺点：最坏路径多一次有界进程查询。

### B. stdin + 修改 Flywheel 启动器导出环境

让 Lead 与 runner 启动路径都导出 `FLYWHEEL_SESSION_EFFORT`，statusline 读取它。
优点：显示脚本不必查询进程。缺点：要同时修改多个启动链，扩大本单范围，也让显示正确性
依赖所有入口同步接线。

### C. 只读父进程 argv

不使用 stdin 或环境，始终解析进程树。优点：不改启动器。缺点：忽略 Claude 已提供的
更直接数据，且每帧都产生进程查询。

选择 A：它覆盖题目列出的会话来源，同时保持 effort 决定链零改动。

## 可观察合同

- stdin 为 `medium` 时显示 `/medium`，即便全局设置为 `xhigh`。
- stdin 缺失而 `CLAUDE_EFFORT=high` 时显示 `/high`。
- 前两者缺失而 Claude argv 带 `--effort low` 时显示 `/low`。
- 三者都缺失时显示 `/?`。
- 来源值只接受 Claude 支持的 effort 名称；非法输入继续查下一来源，最终未知。
- installer smoke 的 stdin 带会话 effort，并把全局值设成相反值作为阴性对照。

## 验证策略

在已被 CI 精确登记的 statusline shell suite 中加入四个行为用例；用 fake HOME 固定全局
`xhigh`，用受控 `ps` 替身注入父进程 argv。第一条同时断言 `medium` 出现且 `xhigh`
不出现，因此把实现变异回读取全局设置时必红。installer suite 继续覆盖安装事务，但其
source/target smoke 都改用新的 stdin 形状。

真机截图需要把合入后的脚本安装到全局路径并观察 Tadashi 与 high QA runner，属于部署/QA
权限面；本实现节点只准备可交付代码和可复核测试，不越权激活。
