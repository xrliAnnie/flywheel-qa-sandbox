# FLY-2204 日历写凭据隔离 — 实施记录
Issue: FLY-2204 (https://linear.app/geoforge3d/issue/FLY-2204/治理-隔离-founder-google-calendar-写凭据agent-上下文不可读)
日期: 2026-08-31
基于: plan.md

## 结论

本次实现交付了方案 A/B 共用的机器隔离机制，但**没有激活生产隔离**。Lead 尚未在 A（独立 bot
Google 账号）和 B（founder 账号的独立 OAuth client/grant）之间裁决，并明确禁止本节点创建真实
用户/组、安装或启动 system LaunchDaemon、迁移或读取生产凭据、注册 Discord bot。因此当前准确状态是：

- 三角色 A/I/W 代码、固定 wrapper、LaunchDaemon renderer、OAuth/QA/负向探针均已就绪；
- 所有系统级动作只在临时 fixture root 验证；
- 没有读取、复制、轮换或输出任何生产 token/口令；
- 在 `runbook.md` 的 live Final gate 全通过前，**不得**宣称「唯一自动写入方」已获得机器强制。

## 交付面

### Flywheel 主仓

| 文件 | 作用 | 安全性质 |
|---|---|---|
| `scripts/calendar-write-sweep.mjs` | sweep 强制显式 `CALENDAR_SWEEP_CLIENT` | readonly grant 必须进入独立 revoke 域 |
| `scripts/calendar-isolation/raya-calendar-peer-proxy.c` | Unix socket + PEERCRED | 仅 euid=I 可进入 writer handler；非 I 在 adapter 前拒绝 |
| `scripts/calendar-isolation/install-calendar-services.sh` | `render/apply/activate/rollback` | render 必须显式传 root，live root 另需 root + literal ack；不接受 secret argv |
| `scripts/calendar-isolation/calendar-oauth-probe.mjs` | scope/revoke 证据 | 真实 gog/gws 写 grammar；canary only；输出分类、不输出 provider 原文 |
| `scripts/calendar-isolation/configure-qa-calendar-id.sh` | 激活 FLY-2137 QA 豁免 | 只接受 `@group.calendar.google.com`；原子 0600；拒 primary/邮箱/symlink |
| `scripts/calendar-isolation/verify-calendar-isolation.sh` | fixture/live 负向探针 | 验 A/I/W 组边界、凭据不可读、A socket transport denial、root-owned wrapper/plist/config/voice root；机械枚举 wrapper 字面赋值并与 identity plan 做精确集合/值比较 |

### Raya 伴生仓

| 域 | 入口 | 权限 |
|---|---|---|
| W | `apps/brain/src/calendar-writer-cli.ts` + `calendar-writer.ts` | 唯一持 Calendar 写 grant；强制显式独立 OAuth client；只接严格版本化 sync/cancel；不运行 agent |
| I | `apps/brain/src/meeting-ingress-cli.ts` | founder-only Discord exact-command；QA bot allowlist 为空；无 Calendar 凭据、无 agent |
| A | 原 brain/voice | Calendar 配置和 meeting write gateway 已移除；只消费 start/stop 能力与只读投影 |
| I→A | `meeting-voice-bridge.ts` / `meeting-voice-projection.ts` | 投影 + start/stop；无 schedule/cancel/writer 能力；请求幂等 |
| A→I | `meeting-voice-feedback.json` | 仅 ready/live/interrupted/ended 枚举状态；由 I 的原状态机再次验证 |

## 固定的权限拓扑

| 主体 | `_rayacal` | `_rayavoice` | Calendar 凭据 | Discord 排会 listener | 运行 agent |
|---|---:|---:|---:|---:|---:|
| A（现有 founder/agent uid） | 否 | 是 | 否 | 否 | 是 |
| I（`_rayacali`） | 是 | 是 | 否 | 是，仅 founder trigger | 否 |
| W（`_rayacalw`） | 是 | 否 | 是，file keyring | 否 | 否 |

`_rayacal` 只允许 I/W，保护 writer socket；`_rayavoice` 只允许 A/I，保护 meeting voice bridge。
两个 group 不得合并。I→W 先经 pathname group 权限，再由 PEERCRED 确认 peer euid；A 即使知道完整
socket protocol，也不能 traverse/connect。W/I 的 executable、wrapper、plist 和 Raya release 必须
root-owned 且 service uid 不可写。

## 已执行的证据

以下证据全部为 fixture/unit/integration，不是生产授权证据：

- sweep：23 个 shell case 通过，覆盖 client 缺失/非法/准确 argv；
- peer proxy：编译 `-Wall -Wextra -Werror`，合法 peer 通过，非 I peer 在 handler 前拒绝；
- service renderer：19 个 case，覆盖双 group、secret-free plist、W 内读口令（含无尾换行文件）、
  symlink 拒绝（含目标在当前 host 不存在的 macOS live 绝对路径）、render 显式 root/live ack、`//` 的 root inode 别名与 `/private`/firmlink live
  `/etc` 映射、`/System/Volumes/Data` 的 live `/usr/local` 与 LaunchDaemon 目标映射，以及
  socket 父目录必须由 W 拥有、I 只能 traverse 的出生时刻约束；runtime/voice 路径落在不会被真实
  reboot 清空的 `/var/db/raya-calendar-isolation/run`，其两级祖先固定 `root:wheel 0755`，A 不可
  rename/预置 endpoint；
- OAuth：8 个 case，覆盖 gog/gws dry-run + live grammar、403 scope、invalid_grant、意外成功 fail-close，
  并拒绝把「本地没有凭据」的泛化 unauthenticated 当成 server-side revoke 证据；
- QA calendar：8 个 case，覆盖 group calendar grammar、0600、primary/邮箱/注入/symlink 拒绝；
- isolation negative：22 个 case，覆盖 A 加入 writer group、成员查询的 error/yes/no 三态及 macOS
  非成员 `no + rc67` 合同、agent-owned
  runtime ancestor、plist secret、wrapper drift/口令读取回退、fixture/live 混淆，并钉住 live verifier
  从 root-owned hierarchy 派生 socket path，wrapper/plist/`writer.env`/voice root 的 owner/mode 矩阵，
  以及 ingress uid/password path/socket path/plist program、writer node/handler、ingress
  home/env/node/handler 的精确生成值。新增性质断言不再维护命名清单：verifier 机械枚举两个 wrapper
  中所有合法 shell identifier 的 quoted/unquoted 静态赋值，与 root-owned identity plan 的期望集合和值
  完全相等；缺失、重复、额外（含未知大小写名称）或漂移均 fail-closed。两个 `id -u` guard 也由 plan
  绑定回对应 W/I uid；
- Raya contracts/brain/voice：分别 64/143/325 tests 通过；另有 94 个 QA tests；全仓 typecheck、build、lint 通过。
  新增 companion 回归钉住 meeting runtime 的 canonical 两段 thread URL，并串行化重叠 voice command poll，
  避免 Calendar 正路被 writer 拒绝或慢 launchctl 导致重复启动。

Flywheel 全仓门禁也按实现节点要求原样执行，结果如下：

- `pnpm -r build` 通过；
- `pnpm lint` exit 0，仅报告 `origin/main` 已存在且本分支未修改的 Biome warning；本次变更 shell 经
  `bash -n`、`shellcheck` 通过；
- `pnpm test:packages:run` 在当前 head 的功能断言无本次回归；2 个未修改的真实 Terminal.app
  AppleScript case 因 resident runner 无法连接 `com.apple.hiservices-xpcservice` 而失败；并行
  config census 偶发触发 5 秒墙钟超时，同一 case 隔离重跑 440ms 通过。此前屏蔽 UI case 的串行
  运行得到 1,749 passed、2 skipped；
- 所有新增 `scripts/__tests__/fly2204-*.test.sh` 与更新后的 sweep test 共 83 个 case 通过；QA 上一轮
  `verify-four-deltas.sh` 独立只读探针 11/11 通过，随后 QA attempt 2 的盲变体另发现本轮修复的
  live-root 别名与 wrapper 值覆盖缺口。Lead 共享的全称量词只读探针（sha256
  `a0ad272d55981eaaad5387395efee3c1277ee5857f40cb108de50991a6729383`）在当前头保持阳性对照并对
  writer/ingress 任意赋值漂移与未知赋值 16/16 通过；当前头等待独立复验。
- PR 首轮 CI 捕获新增 shell suite 未进入显式枚举；`18383b846` 已补齐，枚举守卫本地通过
  （242 classified / 190 CI / 52 manual-only）。账户付款状态恢复后的 `d01c4609b` Linux CI 中，Quick
  Gate、全部 unit lane、payload 与两组 shell 的功能测试均通过；shard 2 最后仅因容量 tripwire 在
  1,077s 超过 1,020s 预算而失败。`278a2dca7` 用结构契约先红后绿，把完整的 FLY-913/2204（约 20s）
  和 FLY-2007（约 57s）step 移至实测 929s 的 shard 1，预期平衡为约 1,006s/1,000s；最终 exact-head
  rerun 作为 Linux 全仓结果的权威证据。

exact-head Linux run `33451678264` 把跨平台缺口具体化：Ubuntu 不存在
`/Library/LaunchDaemons`，旧守卫因 `-e` 为假而跳过指向该受保护路径的悬空 symlink，使 I14 未到达
live authority gate。`0d4a59c50` 在 inode 判定前先读取直接 symlink target，并对三个受保护绝对目标
fail-closed；本地 renderer 19/19、全部 FLY-2204/sweep 81/81、`bash -n` 与 ShellCheck 通过。该 run 的
另一个失败是未修改的 FLY-1330 SIGTERM 并发用例在 Ubuntu Bash 内部触发 trap parser/core dump；后续
exact-head rerun 同时作为 I14 修复和该无关波动的权威判定。

Round 4 后按 Lead 的 fail-closed 分拣追加四项核心修正：成员查询失败不再等价于“非成员”；W password
文件可无尾换行且空文件仍拒绝；live verifier 增补 root owner/mode 矩阵；render 不再隐式指向 live
root，显式 `/` 仍需 literal ack。其余 sweep installer、CI shard 余量、OAuth canary 清理、proxy
timeout/fork 恢复均登记为 follow-up，不在本 delta 扩 scope。

Round 5 的真实 macOS 复核补出 `dseditgroup checkmember` 的平台合同：明确非成员时输出首词 `no` 但
退出码为 67。受 Lead 限定的 R6 只修两项：`yes` 必拒、`no` 配 rc 0/67 放行、空/报错/未知组合
fail-closed；并将执行 PEERCRED 判决的 peer proxy 加入 `root:wheel 0755` live 断言。其余四个
follow-up 仍未触碰。

QA attempt 2 的三层复验确认上述两项已成立，但盲变体证明 Bash 会保留 `//`，且 macOS `/private/etc`
与 `/etc` 同 inode，旧字符串守卫会把 live 路径误当 fixture；同时 verifier 只枚举了上一轮点名的四个
生成值。返工将 root 判定改为跨 BSD/GNU 的 device+inode 比对，并把 node 与两个 entrypoint 写入
root-owned identity plan，逐项核 writer `NODE`/`WRITER` 与 ingress `HOME`/env/`NODE`/`INGRESS`。

R7 code review 虽整体 APPROVED，仍指出两个与本边界直接相关的 advisory：Data volume 不提供
`<root>/etc`，但会把 `/usr/local` 与 `/Library/LaunchDaemons` 映射回 live；identity plan 的
`root-owned` runtime 声明也尚未被 live verifier 执行。后续红绿切片改为逐个比较所有真实写目标，并在
live 探针前核 node/两个 entrypoint 的类型、非 symlink、`root:wheel` 与 group/world 不可写。

QA attempt 3 的九个盲变体确认 live-root device/inode 守卫已收敛；D3 随机把 writer `PROXY` 换成
`/bin/cat` 时，旧 verifier 仍返回 `ready:true`，暴露“只补点名字段”的根本缺陷。`fbbdea2e6` 将
render 输入派生的全部 wrapper 静态赋值写入 identity plan，并由 verifier 机械枚举实际赋值后做精确
manifest 比较；未来生成物新增字面量却未声明期望时会自动拒绝，而非默默漏检。另把 W/I 的 uid
self-check 值纳入同一 plan 合同。红绿证据为 repo negative 22/22、renderer 19/19、Lead 共享性质探针
16/16；本轮完整六组 FLY-2204/sweep shell 测试共 83/83，`bash -n` 与 ShellCheck 通过。

完整最终命令和实时证据槽位见 `runbook.md`。生产证据不得写 token bytes、refresh token、client
secret、keyring password 或 Discord token；只记录账号/客户端的非秘密标识、grant 域、scope 分类、
exit 分类、owner/mode、event id 和清理 receipt。

## 尚待 live gate 的项目

1. founder 选择 A 或 B，并准备对应独立 grant 域；
2. founder/root 按 runbook 创建 A/I/W 系统身份并安装 root-owned Raya release；
3. 在显式 founder calendar ID 上授最小 ACL，QA 只授测试 calendar；
4. Cutover 后完成 FLY-2130 create/cancel、冷启动、sweep readonly、A 侧 transport/read denial；
5. server-side retire 旧 grant，并同时证明「旧 grant invalid」和「现 grant valid 但 write scope 不足」；
6. 将 live evidence 回填并由独立 QA 复核后，才更新 FLY-2137 的机器强制声明。

## 威胁模型边界

本单覆盖机器 OAuth/CLI 凭据与 Raya 自动 ingress。它不声称防住已登录浏览器 UI、founder 人类
Discord 会话、持交互 sudo 密码的本地攻击者，也不依赖未实现的 per-uid 网络沙箱。任何 A 可读的
发送型凭据都不得映射到 I allowlist principal；生产 I 的 QA bot allowlist 固定为空。
