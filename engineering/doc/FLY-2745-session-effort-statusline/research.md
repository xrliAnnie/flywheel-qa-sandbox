# FLY-2745 会话 effort 状态栏 — 调研
Issue: FLY-2745 (https://linear.app/geoforge3d/issue/FLY-2745/状态栏可信-cmux-里-leadrunner-的状态栏显示的-effort-不是本会话真实-effortstatusline)
日期: 2026-09-18
基于: exploration.md

## 当前实现与根因

`scripts/statusline-command.sh` 先完整读取 stdin，但 effort 单独从
`$HOME/.claude/settings.json` 的 `.effortLevel` 读取。全局字段不存在时，它又按
`model.id` 是否是 Opus 4.6 猜 `medium`。两条路径都描述配置或历史默认，不描述当前
会话；因此任意 Lead/runner 都会被同一个全局 `xhigh` 覆盖。

`scripts/install-statusline.sh::smoke_render` 在 fake HOME 的 settings 写
`{"effortLevel":"high"}`，而 stdin 不带 effort。smoke 因此只证明旧错误来源还能被
读取，无法阻止 source/target 安装一个继续谎报全局值的候选。

现有 `scripts/__tests__/fly1678-statusline-fable.test.sh` 已提供：

- fake HOME 与确定性 date/stat/tr；
- 禁止 curl/security 的无网络 harness；
- line 1 golden、line 2 quota 兼容性及恶意输入断言；
- CI 中的精确 shell suite 登记。

本单应扩展这条已登记 suite，而不是新增未纳入 census 的平行脚本。

## Claude Code 当前合同

Claude Code 官方 2026-W19 更新说明记录：hook JSON 通过 `effort.level` 提供当前 effort，
并向 hook/Bash 子进程提供与之相同的 `CLAUDE_EFFORT`。官方环境变量参考列出的活动值为
`low`、`medium`、`high`、`xhigh`、`max`；配置变量另允许 `auto`。

来源：

- https://code.claude.com/docs/en/whats-new/2026-w19
- https://code.claude.com/docs/en/env-vars

statusline 与 hook 都是 Claude 启动的命令子进程，但不同版本是否向 statusline 同步注入
`CLAUDE_EFFORT` 不能只靠文档推定。因此 stdin 仍为第一来源，环境为无需 Flywheel 启动器
改造的第二来源，Claude 祖先进程 argv 为兼容兜底。

设计评审又核对了本机 Claude Code 2.1.277 的实际二进制：当前 statusline 输入中的
`effort.level` 与子进程 `CLAUDE_EFFORT` 由同一会话 effort 生成。因此环境与 argv 路径
主要是旧版 CLI 的兼容兜底；测试仍显式清除宿主继承的 `CLAUDE_EFFORT`，避免夹具被当前
runner 的环境误导。

代码评审补充了环境兜底的成立域：若未来从外层 Claude 的 shell 嵌套启动一个没有自身
effort 的 Claude，后者可能继承外层 `CLAUDE_EFFORT`。当前 tmux fleet 不从 Claude 子进程
嵌套启动，且 2.1.277 的 statusline stdin 会先给出会话值，所以现网路径不可达；未来若新增
嵌套启动器，应在启动边界清除该变量。本单不改 effort 启动链。

## 解析与信任边界

### stdin

读取 `.effort.level`；为兼容题目中“effort 字段”的标量表述，也接受 `.effort` 本身为
字符串。只接受 allowlist 值并统一为小写，避免把任意 JSON 字符串送进终端。

### 环境

读取 `CLAUDE_EFFORT`，使用同一 allowlist。它由 Claude 会话注入，不读取全局设置，也不
要求 Flywheel 启动器复制 effort 决策。

### argv

从 statusline 的 `$PPID` 起有界向上检查至多四层，读取 `ps -p <pid> -o ppid= -o command=`。
只在命令含 Claude 可执行体且出现 `--effort <value>` 或 `--effort=<value>` 时采用；每个
候选仍经过同一 allowlist。四层足以覆盖 `claude -> shell -c -> bash script`，同时避免
无界进程树扫描。

### 未知

全部来源无有效值时固定为 `?`，继续沿用现有 `model/effort` 视觉槽，输出 `model/?`。
删除 Opus 4.6 推断；型号不再是 effort 数据源。

## 测试尺子

同一组用例始终把 fake global `effortLevel` 写成 `xhigh`：

1. stdin `medium`、env `high`、argv `low` → 必须只显示 `medium`；
2. stdin 缺失、env `high`、argv `low` → 必须显示 `high`；
3. stdin/env 缺、argv `low` → 必须显示 `low`；
4. 三者都缺 → 必须显示 `?`，且不能显示 `xhigh` 或型号推断值。

这四条同时证明优先级、三种来源和未知状态。将实现变异为读取
`settings.json.effortLevel` 后，第 1 条会得到 `xhigh` 而红。

installer smoke 把 settings 固定为 `xhigh`、stdin 固定为 `medium`，并同时断言
`medium` 存在、`xhigh` 不存在，防止 smoke 再次假绿。
