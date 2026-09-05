# FLY-2314 Terminal 冷启动判据 — 实施证据
Issue: FLY-2314 (https://linear.app/geoforge3d/issue/FLY-2314/判据卫生-macos-terminal-测试的-skip-守卫只查-which-osascript不查-terminalapp-能否解析)
日期: 2026-09-03
基于: plan.md

## A 侧首次实测发现

Lead 在问题 gate `bcf1ae48-cba5-40ae-ac94-c91c492fdd95` 中，于精确 head
`66330261decc35b819f477b4b6a950b49207dc21` 的 GUI-capable process context 观察到：

- 首次 `osascript -e 'tell application "Terminal" to count windows'` 使用 20 秒外层 timeout 时
  `rc=124`；
- 同一命令使用 60 秒 timeout 时 `rc=0`，输出 `2`；
- 预热后同一文件的 11 条测试全部通过、零 skip；两条既有真实 GUI 用例分别用时 6483ms 与
  491ms。

这证明已批准 plan 中的 15 秒预算不足：它会在可驱动但 AppleEvent 冷启动较慢的进程上下文中产生
“该跑却 skip”的镜像误判。依实现节点合同，已批准 `plan.md` 的 pinned blob 保持不改；本文件记录
Lead 在实现期基于真机证据要求的判据修正。

## 实施期首次判据修正

- 单次 probe timeout 改为 60 秒，依据是上述 20 秒失败、60 秒成功的实测边界，而非猜测；
- `execFileSync` 使用 `SIGKILL`，保证每次同步 probe 都有硬上界；
- 第一次 `ETIMEDOUT` 后重试一次，给冷启动一次恢复机会；
- 连续两次 `ETIMEDOUT` 时抛出明确错误并拒绝静默 skip；
- Terminal 解析/驱动的普通失败仍返回具体 skip reason，因此无 GUI/XPC 的 B 侧保持 skip、不是失败；
- 两条既有真实 GUI 测试的断言与行为不改。

最终 PR body 与 milestone 必须再次记录 20s/60s 原始数字，以及最终代码 head 上 A/B 两侧的
run/skip 结果。

## R3 预算对齐修正

代码审查 R3（question `05677e86-ea73-4efb-b2da-4cd53b91c2da`）在精确 head
`f766211ae3e7bef8559477b491806647a74d64bc` 给出 `APPROVED`，同时指出两个 MEDIUM advisory：

1. 只要 probe 在 60 秒内成功就判定可用，但真实 GUI helper 的单次 AppleScript 预算是 10 秒，
   仍存在“10–60 秒 probe 通过、随后真实用例超时”的假阳性区间；
2. module scope 上连续两个超时会先阻塞并使整文件 collection 失败，连纯 guard 单测也无法报告。

在 commit `3c73bdb12f1e6b3f4a9c2d75cb42c80d1910bc46` 中按 TDD 收敛：

- 第一轮保留 60 秒冷启动预算；无论第一轮是成功还是 `ETIMEDOUT`，第二轮都必须在真实 GUI
  helper 同样的 10 秒预算内成功，才判定 Terminal 可驱动；
- 第二轮超时仍显式抛错，不允许用 skip 隐藏“环境可能可用但仍然过慢”的人工判定需求；
- host probe 延迟到真实 GUI suite 的 `beforeEach`，并缓存结果；纯 guard 单测不再承受真实 GUI
  probe 的 collection-time 副作用或失败扩散；
- 动态 skip 在两个真实 GUI 用例上逐条保留具体原因；只有能力成功时才启用 Terminal 清理 hook；
- 新增单测分别锁住 `[60000, 10000]` 两阶段预算和 probe 的 lazy/memoized 行为。

`which osascript` 变异在本实现体上产生 6 个失败：关键 B 侧单测从预期 `false` 变为实际
`true`，且两条真实 GUI 用例不再 skip、随即因 LaunchServices/XPC 不可用而失败。这直接满足
“退回 which ⇒ B 必红”的验收要求。恢复后同一命令为 12 passed / 2 skipped，两个 skip 均带
`Terminal.app cannot be resolved by osascript in this process context`。

## 同机进程上下文边界

Lead 指令 `[lead-instruction 2314-can-you-do-A-yourself-now]` 要求确认 resident 是否只是被旧短超时
误判。未修改环境的实测结果是：

- `launchctl managername` 输出 `Aqua`；
- 正确的 60 秒 `count windows` probe 很快以 `rc=1` 返回，并报告
  `com.apple.hiservices-xpcservice` 的 `Connection Invalid` 与
  `Can’t get application "Terminal" (-1728)`，不是 `ETIMEDOUT`；
- 因此 Aqua manager membership 本身不足以证明当前进程可经 LaunchServices/XPC 解析 Terminal。
  这个 resident 仍是 B 侧，不能自行替代能驱动 Terminal 的进程上下文完成 A 侧。

Lead 在 `f766211ae` 的最终头 A gate 中另行实测到热 Terminal：probe `rc=0 output=[1]`，目标文件
12/12、零 skip；两条真实 GUI 用例分别 7672ms 与 609ms。该证据只证明“热 Terminal 可驱动时仍
运行并通过”；冷启动重试逻辑来自注入 `ETIMEDOUT` 的单测，不冒充真机冷启动实测。由于 R3
advisory 修正又移动了代码头，交付前还需要在 `3c73bdb12` 的后继精确头重新取得 A 侧和代码审查。

## R4 精确诊断修正

代码审查 R4（question `2f884df3-c400-478e-906a-ba248299cbfa`）在精确 head
`8535dbb60d79bf9ffc3279ae5fd4a396c46c240e` 继续给出 `APPROVED`。该轮确认 R3 的两个
MEDIUM 均已解决，同时指出一个新的 MEDIUM：第一轮成功、第二轮热态验证超时时，原消息仍声称
冷启动也超时，诊断事实不准确。它还指出真正被测的生产 close 路径预算是 5 秒，比 helper 的
10 秒更严格。

commit `306b3d463c53f0e05f07661452e5fb08024a500e` 再次按 TDD 收敛：

- 热态验证预算从 10 秒收紧为生产 close 路径一致的 5 秒，彻底关闭 5–10 秒假阳性区间；
- “两轮都 `ETIMEDOUT`”与“冷启动成功、热态验证 `ETIMEDOUT`”现在产生不同且事实准确的错误；
- 两种 timeout 都保持显式失败，不静默转换成 skip；新增测试锁住第二种分支；
- R4 的 LOW cleanup flag 直接覆盖建议作为非阻塞后续记录，不在本单继续扩大结构改动。

该轮修改后的本 resident B 侧为 13 passed / 2 skipped；再次退回 `which osascript` 的变异仍为
6 failed，包含关键 `expected true to be false` 与两条本应 skip 的真实 GUI 失败。恢复后 typecheck、
Biome 与 `git diff --check` 均通过。由于代码头再次移动，交付前仍需对最终 docs-only 后继头取得
新一轮 A 侧与代码审查。
