# FLY-2885 引擎 B 改走 WebRTC + 订阅 — 本地定向验证记录
Issue: FLY-2885 (https://linear.app/geoforge3d/issue/FLY-2885/语音b核心连接层-引擎-b-改走-webrtc-订阅替换-websocket-api-key房间进程-webrtc)
日期: 2026-09-25
基于: plan.md

这是本地的**定向**验证，不是全量套件。全量证据只认 QA 冻结头时的 exact-head CI（`CI OK`）。runner 环境的 `TMPDIR` 路径过长，会让 Unix socket 类用例失败，所以下面的用例都在 `TMPDIR=/tmp/fly2885` 下跑。

## 构建与类型

| 命令 | 结果 |
|---|---|
| `pnpm lint`（biome，全仓） | 0 error（全仓 25 个 warning，均不在本分支改动的文件里；对本分支 49 个改动文件单独跑 biome：0 诊断） |
| `pnpm --filter "flywheel-voice-codex..." build` | exit 0 |
| `pnpm --filter "...flywheel-teamlead" typecheck` | exit 0（teamlead 新增导出 `voice-context-contract`、`bridge/voice-session-context`，`LeadConfig.liveVoice`） |
| `pnpm --filter "...flywheel-voice-bridge" typecheck` | exit 0（`ResourceSource` 新增 `opus-stream`） |

## 测试

| 范围 | 文件 | 结果 |
|---|---|---|
| voice-codex：本分支所有改动源文件的 `vitest related` | 29 个文件 | 448 过、3 跳过（原有 smoke）。`daemon-health` 并发时超时一次，单进程重跑 13/13 过 |
| teamlead：改动文件的直接测试 + 全部 `parseAndValidateProjects` 测试 | 11 个文件，单进程 | 322/323 过，失败的一个见下文「已知的本地失败」 |
| teamlead：`codex-lead-runtime.test.ts` | `vitest related ProjectConfig.ts` 时被带进来，runner 自带的长 TMPDIR 下失败 | 短 TMPDIR 下 145/145 过（环境问题，与本单无关） |
| voice-bridge：`discordWiring.ts`、`LeadSpeaker.ts` 的 `vitest related` | 8 个文件 | 93/93 过 |
| config：feature-flag 漂移守卫 | `feature-flags-drift`、`flag-truth`、`fly1981-final-ledgers` | 69/69 过（4 个新环境变量已登记） |
| 脚本 | `flywheel-voice-wrapper.test.sh` | 37/37 过 |
| 脚本 | `fly2655-voice-room.test.mjs`、`fly2799-codex-container.test.mjs`、`fly2598-voice-coexistence.test.mjs` | 20/20、4/4、1/1 过 |

**合并前的本地失败（合并 main 后已消失）**：teamlead `voice-session-services.test.ts` 里的「projects authoritative demand into the durable voice health store」曾报 `Cannot open database because the directory does not exist`。
- 当时用 `origin/main` 版本的同一测试文件跑，失败完全一样，判为已有问题。
- 合并 `origin/main`（`afb4b25eb`）后重跑：`huddle-config` + `voice-session-services` 53/53 过。

## 合并 origin/main 之后（`afb4b25eb`、`4da2adb25`）

- **冲突**：main（FLY-2860）删除了 `voice-bridge/src/__tests__/qa-fly967-round2-fixes.test.ts`。本分支在那里只加过一个用例（`opus-stream` 声明为 `StreamType.Opus`），已挪到新文件 `opus-stream-resource.test.ts`；其余内容按 main 的决定保持删除。
- **合并后暴露的测试基建问题**：合并后 `git ls-files` 输出 1,051,121 字节，超过 `execFileSync` 默认的 1 MiB。于是 `feature-flags-drift` 和 `required-wall-clock-thresholds` 两个测试还没断言就以 `spawnSync git ENOBUFS` 失败。
  - main 自身是 1,043,760 字节，只差几 KB；换成下一个加文件的分支也会撞上。
  - 修复（`4da2adb25`）：两处 `maxBuffer` 调到 64 MiB。修复前两者都复现 ENOBUFS，修复后 1/1、69/69 过。
  - 之后 main 的 FLY-2907（`dcc7142e2`）用同样的 `maxBuffer` 修了这两处。第二次合并 main（`9030308e5`）时两个文件都采用 main 的版本，本分支不再改动它们。合并后 `required-wall-clock-thresholds`、`run-infra-async-child`、`repository-git-listing-buffer` 共 5/5 过，漂移守卫 69/69 过。

| 命令或范围 | 结果 |
|---|---|
| `CI=1 pnpm install --frozen-lockfile` | 通过（main 改了 lockfile） |
| `pnpm --filter "flywheel-voice-codex..." --filter "flywheel-voice-bridge..." build` | exit 0 |
| `pnpm --filter "...flywheel-voice-bridge" --filter "...flywheel-teamlead" --filter "...flywheel-voice-codex" typecheck` | exit 0 |
| voice-bridge：`discordWiring.ts`、`LeadSpeaker.ts`、新测试文件的 `vitest related` | 31/31 过 |
| teamlead：`huddle-config`、`voice-session-services`、`voice-session-context`、`required-wall-clock-thresholds` | 53/53、11/11、1/1 过 |
| voice-codex：`codex-container`、`codex-room-webrtc`、`projection` | 61/61 过（main 没改 voice-codex） |
| config：漂移守卫三件套 | 69/69 过 |

## 没在本地跑的，及原因

- **`package-onboard-smoke.test.sh`**：它要打整个 onboard 包，是重型冒烟。已读 `scripts/package-onboard.sh` 的依赖合并逻辑：`opusscript` 在 voice-bridge 与 voice-codex 两处都精确钉 0.0.8，没有冲突；`werift` 只有 voice-codex 声明。交给 CI。
- **全量包套件**：按 implement 角色规则不在本地跑。

## 服务端实测（不是单测，属于设计证据）

- `evidence/probe4-initialitems-summary.md`：41 场 v3 WebRTC 实测，覆盖 `initialItems` 的角色、容量上限和每条包装开销。
- `evidence/probe-run*.jsonl`：设计阶段的 3 场。

## §12 实现之后（`c67c8e629` … `8590e532f`）

plan §12 第 4 轮复核 APPROVED（`7d7299528`，blob `9813d70d`）后，设计门按新 blob 重绑（requestId `7ddb669a…`，`await-codex-gate design` 通过），然后写了 §12 的生产代码。

| 命令或范围 | 结果 |
|---|---|
| `pnpm lint` | exit 0（全仓 25 个 warning，不在本分支改动的文件里） |
| `pnpm --filter "flywheel-voice-codex..." build` | exit 0 |
| `pnpm --filter "...flywheel-teamlead" --filter "...flywheel-voice-codex" typecheck` | exit 0 |
| teamlead：`vitest related` 三个改动源文件（`voice-context-contract`、`voice-session-context`、`voice-session-routes`） | 110 个文件，1,325 过、2 失败。两条失败都在 `epic-residual-plugin-wiring.test.ts`，均为 5 s 超时（当时 load1 约 97）；单独重跑 3/3 过 |
| voice-codex：`vitest related` 四个改动源文件（`bridge-client`、`CodexVoiceContainer`、`context-tokens`、`CodexRoomFrontend`） | 9 个文件，175/175 过 |
| `git grep` 找到、`related` 没带上的消费者 | voice-codex `session.test.ts` 33/33 过；teamlead `StateStore.voice-session.test.ts` 23/23 过 |

`git grep` 排除的同名匹配：
- `xiaohongshu-write/*claude-bridge-client*`、`voice-headphone` 的 `bridge-client`：都是各自包里另一个同名模块，与 voice-codex 的 `bridge-client.ts` 无关。

§12.7 要求的测试逐项对应：
- **teamlead 构建器**（`voice-session-context.test.ts`）：
  - 恰好 7,600 全进 items，多一段回填 prompt；
  - 中文夹具字节没超、token 超，只进 ≤7,600；
  - 分段 ≤2,000 token、≤8,000 字节，只在行边界切；
  - 12,000-token 多行夹具装配成功，余下按序进 prompt；
  - 超长单行及其后的段都进 prompt；
  - Raya 规模每段恰好出现一次、顺序不乱；
  - 双超时抛 `context_too_large`，details 只有白名单字段；
  - 计数器抛错、返回 NaN 或负数，都抛 `context_token_count_unavailable`。
- **负对照**：临时去掉打包里的 token 条件，上面 5 条失败；还原后全过。
- **路由**（`voice-session-routes.test.ts`）：两类错误返回 503 + `{reason, details}`，details 只有白名单字段；warn 日志里没有记忆正文和路径。
- **voice-codex 客户端**（`bridge-client.test.ts`，真实本地 HTTP）：
  - 两类 503 正文都保留 reason 和过滤后的 details；
  - 多余字段被丢弃；
  - 非 JSON 正文、未知 reason 只保留状态码。
- **container**（`codex-container.test.ts`）：
  - Bridge 的两类错误分别映射为 `context_too_large` / `context_invalid`，不 spawn 进程；
  - tokenizer 不一致、逐条复算不符、缺逐条计数、合计不符、超过 7,600、计数器抛错，都报 `context_invalid`，不 spawn 进程；
  - 默认计数器是真实 o200k。
- **前端提示**（`codex-room.test.ts`）：两类原因走到前端回调，文案准确，不含任何上下文内容。

### 自查修复（`c699f3078`、`a1d7d05e0`）

开评审前自查 §12 代码，修了两处：
- **切段退回丢行**（`c699f3078`）：一段按逐行累加估算放得下、整段复算却超过 2,000 时，要把尾部几行退回给下一段。原来的递归实现在文件末尾会**丢掉**退回的行；遇到只能进 prompt 的超长行时，退回的行会**排到它后面**。
  - 修复：改成按下标推进的循环。
  - 新增两条测试：换行按 50 token 计的 11 行夹具；标题与正文拼接后多出 500 token 的夹具。两条在旧代码下都失败（前者 `[5, 5]` 丢了最后一行，后者丢了 `b`），修复后通过。
  - 真实 o200k 下整段计数通常不超过逐行之和，这条路径很少走到；但一旦走到就是丢记忆。
- **details 白名单放过了路径**（`a1d7d05e0`）：标识正则允许 `/`，`memory/MEMORY.md` 这样的相对路径也能放出去。
  - 修复：标识只允许字母、数字、`.`、`_`、`-`；`tokenizer` 只放行契约里那一个值。
  - 路由测试改成在 `block` 里放路径、在数字字段里放中文，修复前失败，修复后通过。

修复后重跑：teamlead `voice-session-context` + `voice-session-routes` 44/44；voice-codex `bridge-client` + `codex-container` 83/83。

修复后的最终一轮：
- `pnpm lint`、`pnpm --filter "flywheel-voice-codex..." build`、`pnpm --filter "...flywheel-teamlead" --filter "...flywheel-voice-codex" typecheck` 全部 exit 0；
- teamlead `vitest related src/voice-context-contract.ts src/bridge/voice-session-context.ts`：110 个文件，1,329/1,329 过。

## 代码评审 R1 的修复（`a9d29f37b`、`5c11f17e2`）

Codex 代码评审 R1（gpt-5.6-sol xhigh）给了 1 HIGH、1 MEDIUM，都已修复：
- **HIGH（T5c 顺序）**：v3 实测里 data channel 的 `turn.done` 比 app-server final 早约 12 ms。原来 done 一到就结算并清掉 pending，只有 final 才越界的情况因此漏检，越界内容会被完整持久化和镜像。
  - 修复：done 最多等 2 s app-server final 再结算。越界若在 done 之后才判出，丢弃态直接按「done 已到」处理，静音 240 ms 就恢复，不会等一个不会再来的 done 而被迫换代。
  - 新增测试：speaker 两条（done 先、final 后越界 ⇒ `speech_overrun` 并截断；final 不来 ⇒ 2 s 后按 done 转写结算）；房间一条（done 先、final 越界 ⇒ 尾音静音、镜像截断、静音后恢复、不换代）。
  - 负对照：去掉「回合已 done」分支，房间用例失败。
  - 旧测试改为按实测顺序（先 done 后 final）驱动；无声回合没有 final，改为推进 2.7 s。
- **MEDIUM（container 复算不全）**：measurements 不在 digest 覆盖范围内。
  - 修复：container 用自己的 o200k 复算 base、prompt 和每条 item，要求与 Bridge 的测量完全一致（安全非负整数）；每条 item 限 2,000 token（含 8 的包装）且 8,000 字节。Bridge 按真实标题守同样的单条上限，发出的 item 不会被 container 拒收。
  - 新增测试：container 五条（prompt / base 少报、小数、单条超 2,000、单条超 8,000 字节）；构建器一条（真实标题比预留标题贵时，该段改进 prompt）。

修复后的定向验证：
- `pnpm lint`、`pnpm --filter "flywheel-voice-codex..." build`、`pnpm --filter "...flywheel-teamlead" --filter "...flywheel-voice-codex" typecheck` 全部 exit 0。
- voice-codex：`vitest related` 三个改动源文件（`CodexProofSpeaker`、`CodexVoiceBackend`、`CodexVoiceContainer`）共 5 个文件，135/135 过；`git grep` 找到的消费者都在其中。
- teamlead：`vitest related src/bridge/voice-session-context.ts src/__tests__/voice-handoff.test.ts` 共 110 个文件，1,323 过、7 失败。
  - 7 条都是 5 s 超时，出现在 `bridge.test.ts` 和 `event-route.codex-trigger.test.ts`，当时 load1 81–135。
  - 两个文件单独重跑，65/66 过；剩下的 `routes QA report publishing` 单独跑也过（3.1 s）。

## 代码评审 R2 的修复（`407daf94d`）

R2 确认 container 复算的修复完整。剩 1 条 HIGH：final 晚于 2 s 等待时限到达时，块已结算、pending 已清掉，晚到的 final 仍然绕过越界检查和截断，还可能被当成下一个块的 final。上游没有 2 s 送达保证。

修复：
- 已发出的块若在 final 到达前结算，留下一个「final 待核」记录（最长 30 s，与计划 T5c ③ 截断标记的上限一致）。晚到的 final 按该块自己的期望文本检查；越界就静音、截断镜像，并写审计（`late: true`）。
- 记录存在期间不发出任何别的朗读块。
- final 不带回合 id，所以一出现新的用户回合或另一个 assistant 回合，记录立即作废，之后的回答不会拿旧句子去对齐。
- 越界已处置、确认无声（重试念的是同一句）、换代和关闭这四种情况都不留记录。

新增测试：
- speaker 四条：晚到 final 越界 ⇒ 截断、审计，下一块等它落地后才发出；插话后晚到的 final 仍截断；founder 新回合 / 另一 assistant 回合之后的 final 不被误判，且阻挡解除；换代清掉记录。
- 房间一条：2 s 后到的 final 仍截断镜像，随后 founder 新问题的回答原样保留。
- 负对照：不留记录时，房间和插话两条失败。

验证：`pnpm lint`、`pnpm --filter "flywheel-voice-codex..." build`、`pnpm --filter "...flywheel-voice-codex" typecheck` 全部 exit 0；voice-codex `vitest related src/codex/CodexProofSpeaker.ts` 4 个文件 81/81 过。

## 代码评审 R3 的修复（`43906d4bd`，Lead 裁定 `205bea02` 的最后一轮）

R3 只审 `407daf94d`：正常的晚到 final 路径已经正确，但单个「final 待核」记录在几种事件顺序下有归属漏洞，共 3 HIGH、2 MEDIUM。已改为按发出顺序的待收 final 队列（`owed`）：v3 的 final 不带回合 id，但按回合顺序到达，所以下一个 final 归最早的待收项，并对照该项自己的句子检查。

| 问题 | 修复 | 复现用例（负对照） |
|---|---|---|
| H1 founder 抢占后，记录被重建，她的回答被误判越界 | 被抢占的块不入队；她的回合在结算之后清空队列 | 同时去掉排除和顺序，用例失败 |
| H2 绑定前被打断的块，被自己迟到的 `turn.created` 作废 | 未绑定的待收项认领第一个未结束的 assistant 回合 | 去掉认领，用例失败 |
| H3 无声尝试迟到的 final 顶替了重试块自己的 final | 无声尝试也入队，final 先归它；同句重试不被阻挡，同句越界直接切断当前重试 | 恢复「无声不入队」，用例失败 |
| M1 传输被拒的块也挡住后续朗读 | 传输失败不入队 | 去掉排除，用例失败 |
| M2 晚到越界的审计缺 `stopLatencyMs` | 与所有越界共用 500 ms 窗口计量 | 晚到越界时不写该字段，用例失败 |

**残余边界（按 Lead 裁定写明）**：新的用户回合或另一 assistant 回合开始之后，仍未到达的旧朗读 final 不再检查，按普通 final 持久化。原因是 final 不带回合 id，新回合开始后下一个 final 可能是新回合自己的。在「漏截断一段旧朗读」和「误伤她的回答（静音加截断）」之间，选前者。这需要旧 final 晚到超过新回合的开始，而 v3 实测 final 只比 `turn.done` 晚约 12 ms。

验证：
- `pnpm lint`、`pnpm --filter "flywheel-voice-codex..." build`、`pnpm --filter "...flywheel-voice-codex" typecheck` 全部 exit 0；
- voice-codex `vitest related src/codex/CodexProofSpeaker.ts` 4 个文件 85/85 过；
- 五条负对照各自单独失败，还原后全过。

## QA@1 返工（`eb6a27f42`、`a68bdedd1`）

QA 在 `cd30b6ee9` 判定失败，唯一阻塞项是判据 3（不留锁和孤儿进程）。其余项全部通过：无 API key、延迟均值 1690 ms ≤ 1890、断线重连、kill -9、远处人声、朗读 20/20。

**根因**：werift 0.24.4 默认 `max-compat`。作为 offer 方，音频和 data channel 各建一个 ICE/DTLS transport，各自收集 udp4 和 udp6。应答做 BUNDLE 之后，被丢弃的那个 transport 不再被跟踪，`pc.close()` 留下它的两个 host socket，daemon 因此永远不退出。
- 用 `dgram.createSocket` 插桩定位：留下的正是 `ice.js:803` 收集 host 候选时建的 udp4 和 udp6。
- 复现：QA 的 `werift-leak2.mjs` 连接时 6 个 UDP 句柄，关闭后剩 2 个；offer 方改用 `max-bundle` 后，连接时 4 个，关闭后 0 个，进程正常退出。

**修复**：
1. `WebRtcLeg` 使用 `bundlePolicy: "max-bundle"`（`eb6a27f42`）。真实 v3 会话验证：
   - 应答 SDP 带 `a=group:BUNDLE 0 1`；
   - 连接建立，data channel 收到 `session.started`，问答正常；
   - 关闭后 0 个 UDP 句柄。
   - 探针是设计阶段 `evidence/probe4.mjs` 的一次性变体，只加了 `max-bundle` 和句柄计数，不进仓库。
2. 退出兜底（`a68bdedd1`）：`main` 结束后，用一个 unref 的 5 s 计时器检查。若仍有句柄让进程活着，就记录句柄类型和数量（不含内容），并以 `process.exitCode` 退出。干净收尾时进程在它触发前就已自然退出。

**测试**：
- `webrtc-leg.test.ts`：连接会话关闭后，worker 的 UDP 句柄必须归零。负对照：去掉 `max-bundle` 后失败。
- `shutdown-exit.test.ts` 3 条：不持有事件循环；残留句柄超过宽限期后按 exit code 退出，并只记录类型和数量；默认退出码为 0。

**验证**：
- `pnpm lint`、`pnpm --filter "flywheel-voice-codex..." build`、`pnpm --filter "...flywheel-voice-codex" typecheck` 全部 exit 0。
- voice-codex `vitest related src/codex/WebRtcLeg.ts src/cli.ts src/shutdown-exit.ts` 5 个文件 109/109 过，`git grep` 找到的 `WebRtcLeg` 消费者都在其中。
- `flywheel-voice-wrapper.test.sh` 37/37，`install-voice-launchd.test.mjs` 9/9。

**给 QA 复测的说明**：
- 本机没有 529 房，daemon 级别的「空闲退出、SIGTERM 后进程确实退出」要在房内复测。
- QA 诊断预加载脚本 `handles.cjs` 自己装了 `process.on("SIGTERM")`，会阻止 SIGTERM 的默认终止行为；判断「SIGTERM 能否停掉进程」时，请不要带这个预加载。
- 插话（barge-in）有效样本不足，QA 已标为下一轮复验。本次返工没有改动插话相关代码。

### 按 Lead 返工裁定 `c8e10764` 补齐（`68e3889c2`、`3a9875cc3`、`4e7ac3301`）

| 裁定项 | 做法 | 测试（负对照） |
|---|---|---|
| ① 关腿时显式释放底层传输，不能只靠 `pc.close()` | leg 在 offer 后、answer 后、关闭前三个时点记下 werift 的全部 DTLS transport；`pc.close()` 之后逐个 `stop()`（DTLS 和 ICE），每次最多 2 s；关闭证据带 `transportsReleased` | 强制 `max-compat`（仅供测试的选项）会多建一个 transport，关闭后 UDP 句柄仍归零，`transportsReleased: 2`。去掉显式 stop，正好剩 2 个，用例失败 |
| ② 空闲退出与 SIGTERM 都限时必退 | 收尾一开始（收到信号，或 idle 下 `run()` 返回）就挂 15 s 硬期限；清理完立即显式退出，不等事件循环排空。15 s 覆盖 5 s 关闭屏障和最后几次写 Bridge，早于 launchd 默认 20 s 的 ExitTimeOut；超时以退出码 1 强退并记下剩余句柄 | 子进程测试：先跑一场真实 werift 会话，留下 QA 看到的 2 个 UDP socket。SIGTERM 后在 grace 内以 0 退出；收尾卡住时在期限处以 1 退出；idle 退出以 0 退出。去掉退出调用，子进程退不出，用例失败 |
| ③ 不改 Bridge 的 kickstart | 未改动 | — |
| ④ 评估升级 werift | npm 上最新就是 0.24.4（2026-09-26 查询），无可升级版本；①、② 都已做 | — |

返工评审 R1（gpt-5.6-sol，审 `dbb092f80`）结论：
- `max-bundle` 修复正确：各代重连都用它；对端若不接受 BUNDLE，会有界失败并走 T7 清理。
- 提出 1 条 MEDIUM：退出兜底可能切断正在发送的 lead 告警。已修（`4e7ac3301`）：
  - 释放锁之后，给在途告警最多 8 s 送完；到时仍在跑的发送子进程直接终止。
  - 收尾后不再接受新告警，也不再重试。
  - 测试 3 条：在途告警送完再退；到时终止发送子进程且不启动排队项；收尾后不重试、不收新告警。

验证：
- `pnpm lint`、`pnpm --filter "flywheel-voice-codex..." build`、`pnpm --filter "...flywheel-voice-codex" typecheck` 全部 exit 0。
- voice-codex `vitest related src/codex/WebRtcLeg.ts src/cli.ts src/shutdown-exit.ts src/health-alert.ts` 6 个文件 119/119 过。
- teamlead `voice-health-alert-delivery.test.ts` 3/3 过。它是 `git grep` 按名字匹配到的，实际引用的是另一个模块 `voice-health-alert-route`，仍然跑了一遍；`ci-structure.test.sh` 的匹配是不同的脚本名，排除。

下一轮 QA 的硬性要求（按 Lead）：真实 529 房连续 ≥3 场引擎 B，每场后 UDP 回到基线；最后一场后 daemon 在 idle 或 SIGTERM 的 grace 内真正退出，下一场能正常认领；插话补足有效样本。


### 返工评审 R2 的修复（`73df66c17`）

R2 在 `af28c0497` 上提出 2 HIGH、2 MEDIUM，均已修复。

- **H1 告警 shell 和它等待的 curl 会成为孤儿进程**：`execFile` 会悄悄丢掉 `detached`，所以告警发送进程根本不在自己的进程组里，按组终止打不到它。
  - 改用 `spawn` 让发送进程自成进程组，同时保留 `execFile` 原有的 utf8、`maxBuffer`、`timeout` 行为。
  - 收尾时对整组 SIGTERM，最多等 2 s，再对整组 SIGKILL；强制退出前也先 SIGKILL 这个组。
- **H2 15 s 期限会切断合法的清理**：期限改为 60 s，比所有有界清理步骤加起来还长。
  - 进行中会话约 22 s：realtime stop 5 s、`pc.close` 3 s、transport stop 4 s、app-server 10.05 s。
  - 其余：Bridge 写入约 10 s，health 0.5 s，告警收尾 8 + 2 s。
  - 这个期限现在只会打断真正卡死的清理。**上表第 ② 行写的「15 s」以此为准，已被取代**。
  - idle 的 daemon 清理不到 1 s，清理完立即退出，不受期限影响。
- **M1 `pc.close()` 本身无上界**：限 3 s，之后的显式 transport stop 一定会执行。
- **M2 测试依赖主机网卡，且没覆盖 CLI 真实顺序**：
  - CLI 的 run → cleanup → exit 顺序抽成 `superviseDaemon`，CLI 和进程测试共用这一份。
  - 进程测试跑的就是这个顺序：真实 werift 泄漏（断言 ≥1 个 socket，不再依赖网卡数量），加一个真实派发器，其 lead-alert 脚本会挂着一个孙进程。
  - 结果：SIGTERM 以 0 退出；清理卡住时在期限处以 1 退出；idle 以 0 退出；bash 和孙进程都不会残留。
  - 负对照：让发送进程回到 daemon 的进程组，进程测试失败。

验证：
- `pnpm lint`、构建、typecheck 均为 exit 0。
- voice-codex `vitest related src/codex/WebRtcLeg.ts src/cli.ts src/shutdown-exit.ts src/health-alert.ts` 6 个文件 122/122 过。
- 负对照跑过之后，残留的测试进程已清理。

### 返工评审 R3 的修复（`40d81b554`，Lead 裁定 `bfcaeb10` 选 (A)，不动部署）

| 问题 | 修复 | 复现用例（负对照） |
|---|---|---|
| H1 launchd 对 `com.flywheel.voice` 的 exit timeout 实为 5 s（plist 未设；`launchctl print` 显示 `exit timeout = 5`），到点直接 SIGKILL，60 s 期限和强退 hook 都来不及跑 | 收到信号后期限提前到 **4 s**，只会提前、不会推迟；强退前先对告警进程组 SIGKILL；idle 路径仍为 60 s。受管 stop 时，进行中会话较长的关闭步骤会在 4 s 被截断，这和原来 launchd 5 s 的截断一样；app-server 靠 stdin EOF 自行退出，残留根目录在下次启动时清扫 | 单测：idle 清理进行中来了 SIGTERM，期限提前到 4 s，之后的 `run_returned` 不再推迟；信号期限 < 5 s。进程测试：idle 期限 60 s、信号期限 2.5 s，清理卡死时在 2.5 s 处以 1 退出。实现过程中一个把 idle 期限当成计时值的 bug 正好被这些用例抓出，等于做了一次负对照 |
| H2 shell 关闭后丢了 pid，孙进程忽略 TERM 时收不到 KILL | 停止开始时就锁定进程组 id，TERM 和 KILL 都发给这个组；`killNow` 也用它 | shell 收到 TERM 就关闭时，仍依次发 SIGTERM、SIGKILL。负对照：KILL 改为按 `current` 发，用例失败 |
| H3 超时或输出超限时只发一次 TERM 就回调，派发器误以为已排空 | 整组 TERM，2 s 后 KILL，等 `close` 后才回调 | 真实 bash 加孙进程，两者都忽略 TERM：回调在约 2 s 的 KILL 之后才到，两个进程都已不在。负对照：超时即回调，约 300 ms 就回调，用例失败 |
| Lead 追加：受管 stop 截断后，重启要零残留 | — | daemon 替身在会话中被 SIGKILL，app-server 替身因 stdin EOF 退出；下次启动清扫后零残留根目录、零残留子进程。会话进行中启动时保留该根目录。负对照：清扫不删目录，用例失败 |

验证：
- `pnpm lint`、构建、typecheck 均为 exit 0。
- voice-codex `vitest related src/codex/WebRtcLeg.ts src/cli.ts src/shutdown-exit.ts src/health-alert.ts src/codex/stale-roots.ts` 共 7 个文件，131/131 过。
- 负对照跑完后没有残留进程。进程测试失败时，也会一并清掉 fixture 和它的独立告警进程组。

QA@2 判据（按 Lead）：
- SIGTERM 路径约 4 s 内退出；
- idle 路径清理完立即退出；
- 无残留子进程（含告警 shell 和 curl）；
- 重启后清扫干净；
- 连续 ≥3 场，每场后 UDP 回到基线，下一场能正常认领；
- 插话补足有效样本。

### 返工评审 R4 的修复（`8b6c5f386`，Lead 裁定 `f6c495fa`，最后一轮）

R4 结论：H1、H2 和重启清扫测试都没有新的 HIGH。唯一的 HIGH 出在 H3 修复内部。

- **问题**：已经发起停止后，如果 shell 的 `close` 先到，原逻辑会取消 SIGKILL 升级计时器。孙进程若忽略 TERM 且已放开管道（例如 curl 把输出写到 /dev/null），回调后它仍然活着。
- **修复**：已发起停止、`close` 又先到时，立即对整组发 SIGKILL，再回调，不再依赖计时器。
- **测试**：bash 收到 TERM 就退出，孙进程执行 `trap '' TERM` 并把输出重定向到 `/dev/null`；断言回调之后孙进程已经退出。
- **负对照**：去掉整组 SIGKILL，用例失败。

验证：
- `pnpm lint`、构建、typecheck 均为 exit 0。
- `health-alert.test.ts` 10/10 过。
- `shutdown-exit.test.ts` 10/10 过。它的 fixture 在子进程里加载 `health-alert.ts`，不在 `vitest related` 的依赖图里，所以单独跑。

## QA@2 返工：4 条 CI 守卫（`d0ade5876`，Lead 2026-09-26 11:3xZ）

QA@2 房内判据全过；唯一阻断是返工引入的 4 条确定性 CI 红（上一版 `cd30b6ee9` 全绿）。本轮只修守卫，已验过的语音行为不动。

| 守卫 | CI 上的红 | 修复 | 本地证据 |
|---|---|---|---|
| teamlead FLY-2331 子进程普查 | `health-alert.ts` 新 `spawn(` 未登记（104 ≠ 103） | 登记进 `child-process-census.json`：`standalone_runtime_bounded`，写明边界：仅 voice daemon 的 lead-alert 发送；`/bin/bash lead-alert.sh`、`shell:false`；独立 detached 进程组；30 s 超时、4 KiB 输出上限；整组 TERM，2 s 后 KILL；关停时整组停止；Bridge 不 import（`git grep` 确认只有 `cli.ts` 引用） | `bridge-child-process-census.test.ts` 过 |
| teamlead 真实时长守卫 | `shutdown-exit.test.ts:244` 断言 `at - sentAt < signalGrace + 1500`，是宿主时长上限 | 守卫不删。进程测试改为断言“是哪条路径结束的”：sigterm 模式清理完即退，stderr 有 `exiting after shutdown … UDPWrap×N`，没有 `overran`；hang 模式 stderr 为 `shutdown (signal) overran 2500 ms`。idle 期限是 60 s，所以只能是信号期限或清理完成结束了进程。`Date.now()` 已从测试中移除 | `required-wall-clock-thresholds.test.ts` 过。负对照：信号期限改成 idle 期限，hang 用例失败 |
| heavy FLY-2211 kill-path 清单 | 新增 12 处（11 处测试 + 生产 `process.kill(-pid)`） | 收敛：voice 测试里 11 处探活和发信号都改走新助手 `__tests__/process-probes.ts`（`isAlive` / `signalOwn`；pid 必须是正整数，杜绝 `Number("")=0` 给测试自身进程组发 SIGKILL）。清单只新增 3 条，见下表 | `kill-path-inventory.test.ts` 5/5 过。重新扫描与原清单对比：只新增 3 条，无删改 |
| Script 3/6 onboard smoke ②i | 启动拒绝时多打一行 `[voice] exiting after shutdown with handles still open (PipeWrap×3)` | `finish()` 只在关停真正开始过（`begin` 被调用过）时才报残留句柄；启动拒绝路径不打这行。已开始的关停照旧 | 单测：未开始关停时即使有 3 个 PipeWrap 也不打日志（RED→GREEN）。按 CI 原命令（`env -i … cli.js --check-config 2>&1`，三路 stdio 都是管道）：旧构建复现 CI 的两行输出，新构建只剩契约那一行。完整 `package-onboard-smoke.test.sh` 本地 PASSED=26 FAILED=0（含 ②i） |

kill-path 清单新增的 3 条及理由：

| 条目 | 分类 | 理由 |
|---|---|---|
| `packages/voice-codex/src/__tests__/process-probes.ts:process.kill(pid, 0);#1` | qa-only | 测试对自己启动的进程做 signal-0 探活（daemon/app-server 替身、告警 shell 及其孙进程） |
| `packages/voice-codex/src/__tests__/process-probes.ts:process.kill(pid, signal);#1` | qa-only | 测试给自己启动的进程发信号：用例动作 SIGTERM，失败清理 SIGKILL。不是自己启动的 pid 一律不发 |
| `packages/voice-codex/src/health-alert.ts:process.kill(-pid, signal);#1` | out-of-scope | 生产侧唯一 kill 点（`signalGroup`），对象只会是本 daemon 以 detached 方式起的 lead-alert 发送进程组，不会是 runner、Bridge 或 tmux。理由也写在调用处注释里 |

验证：
- `pnpm lint` exit 0；`pnpm --filter "flywheel-voice-codex..." build` 通过；voice-codex `tsc --noEmit` 通过。
- voice-codex `vitest related`（改动的 TS 文件 + 3 个测试）：3 个文件 26/26 过。
- 3 条 vitest 守卫：`bridge-child-process-census.test.ts`、`required-wall-clock-thresholds.test.ts`（teamlead `--project=parallel`）、claude-runner `kill-path-inventory.test.ts`，全部通过。
- `origin/main` 比本分支多 3 个提交（`eabcd72a5`、`af729d662`、`6145a4038`）：`git merge-tree` 无冲突，也没有改到任何守卫清单，所以本轮没有同步 main。
- 消费者排查（`git grep -lF` 查完整路径和文件名）：`shutdown-exit` → `cli.ts`（无单测，已用构建产物按 ②i 原命令验证）、`leaky-daemon.mjs`（由 `shutdown-exit.test.ts` 覆盖）；`health-alert` → `health-alert.test.ts`、`leaky-daemon.mjs`、两份清单。排除项：`voice-health-alert-route.*`、`ci.yml`、`ci-structure.test.sh`、`lead-alert.sh` 只是子串命中，与本文件无关；`engineering/doc/**` 为文档；`ci-test-costs.json` 为耗时数据。

## founder 朗读返工（`d40acabc9`，Lead 打回 `rework:48e91c59`，2026-09-26）

设计见 `plan.md` §13。本轮只动朗读路径。

**先红后绿**

| | 修复前（base `aebc7e3c3`） | 修复后 |
|---|---|---|
| 回放 `1043b4a4`（`codex-readback-replay.test.ts` 第 1 条） | 红：只发出第一句。回放复现了录制的越界（27/9 字，4266 ms）、丢弃态 4974 ms（录制 4994 ms）、两次准入超时 `busy=assistant_turn_open`、回执 `failed`。见 `evidence/readback-rework/red-replay-before-fix.txt` | 绿：两句都发出，第二句在 T1+25.27 s（她的问答轮结束、安静 600 ms 后）发出。没有准入超时，没有「剩下的内容」提示，镜像第一行与真实 thread 一致。回执 `unconfirmed`（首块越界，未得到证明）。见 `evidence/readback-rework/green-replay-after-fix.txt` |
| 她连续说 32 s 时回复排队（第 2 条） | 红：10 s 后被丢弃，一句都没发出 | 绿：她那轮答完后念出，回执 `confirmed` |

**负对照**（逐个去掉守卫，确认有测试变红，之后恢复）：

| 去掉的守卫 | 变红的测试 |
|---|---|
| 越界后一律停止（去掉 A） | 回放第 1 条，以及「接着念」「整块念完进下一块」等 8 条 |
| 忽略房间活动，改用固定窗口（去掉 B） | 两条回放，以及「等过 10 s」「8 s 安静放弃」「120 s 上限」 |
| 不做未读提示（去掉 C） | WebRTC 房间的 3 条（插话后口头提示；提示说不出来时发 thread；会话结束时发 thread） |
| 念出 Handoff ID 行 | 回放第 1 条 |
| 重连期间不等待 | 「等重连后在新一代上念」的两条（说话者层、房间层各一条） |

**新增、修改的测试**

- `codex-speak.test.ts` 新增 14 条：
  - 等待：等过 10 s；安静 8 s 放弃；120 s 放弃；
  - 越界：从下一句接着念；整块念完进下一块；零进展重念一次后停；
  - 停止：插话即停并计未读；会话关闭时全部计未读；
  - 继续：已播放、未证明的块照旧进下一块；
  - 并发：等待中 `cue` 先说；`cue` 进行中回复排队；同时只念一条回复；
  - 重连：等重连后在新一代念。
- 原「10 s 放弃」用例改用 `cue`：10 s 规则现在只对非朗读类生效。
- `speech-overrun.test.ts`：切句、已念前缀（改写容差、被编造内容擦到的句子、全部念过、一句没念、纯标点尾巴）、Handoff ID 整行匹配（3 种会去掉，4 种不去掉）。
- `codex-room-webrtc.test.ts` 新增 4 条：插话后口头提示；提示说不出来时发 thread；会话结束时发 thread 且不开口；重连后在第 2 代念出。
- `session.test.ts`：只有前端支持时才暴露 `speakReply`；回复与 `speak` 互斥；stop 时把挂起的回复结算为 `failed`。
- `daemon.test.ts`：运行时有 `speakReply` 时，整条交给它，不再逐块 `speak`，回执照转。

**本机验证**（按规定只跑相关测试）

- `pnpm lint`：exit 0（25 个 warning，都在既有 `scripts/*`）。
- `pnpm --filter "flywheel-voice-codex..." build`、`pnpm --filter "...flywheel-voice-codex" typecheck`：都通过。
- voice-codex `vitest related`（7 个改动的源文件）：12 个文件、239 条通过。另有 `realtime-live.test.ts` 3 条跳过：它按环境变量门控，是既有的跳过。
- 消费者：teamlead 的 `StateStore.voice-session.test.ts`、`voice-handoff.test.ts`（直接 import `daemon` / `CodexVoiceBackend`），36/36 通过。
  - 排除 `scripts/__tests__/flywheel-voice-wrapper.test.sh`：它只把 `daemon.ts` 的路径字符串当作 `classify_changes` 的输入，与文件内容无关。
  - `session`、`speech`、`daemon` 这类短文件名的其余命中，都是无关文件里的子串。
- 上一轮的 CI 守卫仍然全绿：
  - `required-wall-clock-thresholds.test.ts`、`bridge-child-process-census.test.ts`（teamlead `--project=parallel`）；
  - `kill-path-inventory.test.ts` 5/5。
  - 本轮没有新增进程、kill 或真实时长断言：新测试全部使用 fake timers。
- CI 按包分片跑 voice-codex，没有逐个列出测试文件，新测试文件不需要登记。

### 返工评审 R1 的修复（`c1770ef0b`）

Codex R1（xhigh，线程 `01a0deae-a3b0-7390-8544-05306aac5885`）：2 HIGH、1 MEDIUM，全部成立，全部修复。

| 问题 | 修复 | 回归测试 | 负对照 |
|---|---|---|---|
| HIGH：增量上判出越界后，这块的 final 没有归属。丢弃态结束后才到的旧 final 会被续读块当成自己的，二次截断，标记也可能贴错镜像 | 越界块登记为「仍欠 final」，挡住下一块；final 到达只接走标记；标记绑定所属块；她插话、新回合不丢，过期/换代/关闭才丢 | `codex-speak`：续读等旧 final（5 s 内不发）、只截一次、续读自己的 final 不截；旧 final 丢失时等满 30 s 再发、不在 8 s 放弃；她先开口时旧 final 仍截断、她那轮的回答不截。`codex-room-webrtc`：下一块等到越界回合的 final 才发 | 不登记 → 3 条红；她插话即丢 → 2 条红（含回放）；等 final 不算进展 → 1 条红 |
| HIGH：`spokenPrefix` 用整块全局 LCS，任一句对上就推进前缀，重复措辞会把没念的句子判成已念 | 逐句按顺序对齐，每句只在上一句之后找连续一段，缺字、多字都在容差内；第一句没对上就停 | `speech-overrun`：评审反例（「第一项完成。第二项完成。」）、后一句只念一半、后句重复前句措辞 | 换回旧算法 → 评审反例和重复措辞 2 条红 |
| MEDIUM：提示只播出一个包就算 `submitted`，thread 不发文字 | 提示没有 `completed` 就发 thread 文字 | `codex-room-webrtc`：提示播出一个包后被打断 → thread 有文字 | 改回按 `transport` 判 → 1 条红 |

测试顺序修正：3 条原有 T5c 用例和 3 条本轮用例原先直接调 `truncateAssistantFinal`，或者没发越界回合的 app-server final。现在按生产顺序（`turn.done` 后约 12 ms 到 final）经 `assistantTranscript` 投递 final，断言含义不变。

验证：`pnpm lint` exit 0；voice-codex `tsc --noEmit` 通过；`vitest related`（7 个源文件）12 个文件 245 条通过（`realtime-live` 3 条按环境门控跳过）；teamlead 消费者 36/36。

### 返工评审 R2 的修复（`1dd968219`）

Codex R2（同一线程）：1 HIGH，成立。R1 让越界块的「仍欠 final」跨过她的发言和新回合保留；如果那条 final 丢了，而她在 30 s 内开了新回合，新回答的 final 会被当成旧的，镜像被改写成旧朗读前缀加截断标记。

修复：登记里记下越界时已念的前缀；一条 final 只有从开头对上这个前缀（按顺序逐句匹配，至少第一句）才归这一块；对不上就放弃这条登记和它的标记，这条 final 原样镜像。一句都没念到的越界块不认领任何 final（fail closed）。

- 回归测试（`codex-speak`）：旧 final 丢失后她问了新问题 → 新回答不截断，续读照常念出；一句都没念到的越界 → 它的 final 不被认领、不截断，同一句重念一次。
- 负对照：去掉认领检查 → 这 2 条红。
- 残余边界（R3 已消除）：原先一句没念到的越界会让它自己的 final 原样出现在 thread 里；R3 改为按增量全文认领后，它也能被正确截断。
- 验证：`pnpm lint` exit 0；voice-codex `tsc --noEmit` 通过；`vitest related` 12 个文件 247 条通过（+3 条环境门控跳过）；teamlead 消费者 36/36。

### 返工评审 R3 的修复（`2ca19a86e`，Lead 答复 `47d0bc66`：按此修法跑 R4，R5 仍未过且只剩该边角时停下问）

Codex R3：2 HIGH，都成立。
1. 只比第一句：「好的。」这类共同开头仍会让丢失的旧 final 认领她的新回答。
2. 放弃认领后，同一条 final 落到正在进行的同句重念上，被当成重念的越界。

修复：
- 越界登记记下增量已显示的全部转写（已念 + 编造部分）。final 必须从开头按顺序对上全部这段才归它（`SpeechOverrun.opensWith`）。
- 越界登记存在期间，同一句重念也要等（`awaitingFinal`）。
- 被放弃认领的 final 保持无归属。

| 回归测试 | 负对照 |
|---|---|
| `codex-speak`：共同开头「好的。」的新回答不被认领，续读照常念出 | 退回 R2 的「第一句」规则 → 红 |
| `codex-speak`：一句没念到的越界，2 s 内不重念；旧 final 晚到后按增量全文认领，镜像只剩标记，只截一次；随后重念并完成 | 去掉同句重念的等待 → 红 |
| `speech-overrun`：`opensWith` 认领自己的 final、不认领只同开头的回答、空前缀不认领 | — |

另：一条 T5c 老用例投递的 final 与它自己发过的增量不一致（「目前/现在」、编造尾巴长短不同），改为与增量一致的全文，断言不变。

验证：`pnpm lint` exit 0；voice-codex `tsc --noEmit` 通过；`vitest related` 12 个文件 251 条通过（+3 条环境门控跳过，含 founder 回放两条）；teamlead 消费者 36/36。

## QA@2 返工：打断朗读后模型续念（`12642644d`，QA 执行 `098cd90b`，head `cf47afa01` FAIL）

QA@2 唯一阻断项：她打断 Lead 朗读后，模型的下一轮先补上没念完的部分再回答。529 房复现 3/3（R4、R7、R8）。其余全部通过（A 越界续读、B 排队、C 提示、延迟、普通打断、UDP 清零），下一轮只需复核本项。设计见 `plan.md` §13.7。

**先定位，再修**
- 事件时间线（`qa-attempt2/session-3a07c03f/events.jsonl`，R8）：20:37:44.991 本地切断，朗读块结算为 `speech_interrupted`，`codex_readback_unfinished` 被记录；20:37:47.287 `codex_barge_in_resumed{boundary:"replay"}`。随后服务端第二个 assistant 回合的 final 是「第三个是主干上有一条旧的红灯。这些都在跟进中。四加四等于八。」，说明剩余内容是**模型在新回合里说出的**，不是本地回放旧音频。
- Codex 源码（本机 `codex-oss`）：v3 的 `appendSpeech` = `session.context.append`（speakable）；v3 没有取消或截断这类追加的上行消息。
- 探针 8 在生产条件下复现，并给出对照（见 plan §13.7 的表）：对照 2/12 续念；带原文的提示 0/8。

**测试**
- `codex-speak`：
  - 已发出的朗读块被打断或被抢先时，通知后端并带上这块的原文；
  - 还在等待的块、遇到换代的块、`cue` 不通知。
- `codex-room-webrtc`：
  - 她一打断就以 developer 角色追加提示（第 1 代、内容含原文、不作为语音发出），随后照常念「剩下的内容在频道里。」；
  - 追加被拒时记录 `codex_readback_abandoned_note_failed`，回复照常停止并给出提示。
- 先红后绿：这 4 条在实现前是红的（没有通知或追加），实现后变绿。

**本机验证**
- `pnpm lint` exit 0。
- voice-codex `tsc --noEmit` 通过。
- `vitest related`（7 个源文件）：12 个文件 258 条通过，另有 3 条按环境门控跳过（含 founder 回放 2 条和 A/B/C/D 主路径）。
  - 第一次全量运行时，`daemon-health.test.ts` 有 1 条失败（「opens on the third required-demand poll failure…」）。本轮没有改 daemon 或 health 代码；单独重跑 3/3 通过，全量重跑 258/258 通过，判为并行负载下的偶发。
- teamlead 消费者 36/36。

**复现探针**：问句 WAV 用 `say -v Tingting -o q.aiff "打断一下，四加四等于几？" && afconvert -f WAVE -d LEI16@48000 -c 1 q.aiff q.wav` 生成；运行命令为 `PROBE_ARM=control|steer|steer2 PROBE_LOG=… PROBE_SCRATCH=… PROBE_WAV=q.wav node probe8-bargein.mjs`。

### QA@2 返工评审 R1 的修复（`3e06dcd94`）

Codex（新线程 `01a0df98-9c61-7cc3-9505-31cd30ca0302`，范围 `cf47afa01..HEAD`）：1 MEDIUM，三点都成立，已全部修复。

| 问题 | 修复 | 回归测试 | 负对照 |
|---|---|---|---|
| 「剩下的内容在频道里。」也走朗读路径，她打断它会再追加一条内容错误的提示 | `readReply` 增加 `noteOnAbandon`；提示本身传 `false` | `codex-room-webrtc`：先后打断回复和提示，只追加一条提示且原文是 Lead 的块；`codex-speak`：提示本身不追加 | 提示也追加 → 红 |
| 房间停止走 `cancelSpeech → interrupt`，在 `closing` 置位前，可能被当成她的打断 | `cancelSpeech(id)`：`__conversation__` 是打断，其余 id 是停止，改走 `stopSpeech()`，按 `session_closed` 结算 | `codex-room-webrtc`（经 `GenericVoiceSession` + `CodexRoomFrontend`，结束态 lifecycle 耗时 200 ms）：停止时不追加；经房间的真实打断追加 | 停止当打断 → 红（lifecycle 不耗时的话 `closing` 会先置位，测试分不出来，所以加了耗时） |
| 越界截断后、续读发出前她打断：没有进行中的块，钩子不触发，没念完的 speakable 仍在上下文 | 记下这次截断；她此时打断就对原块追加提示并停掉回复 | `codex-speak`、`codex-room-webrtc`：追加提示（原块原文、第 1 代），不再续读，随后念提示；只是在排队的回复不受影响 | 去掉这段处理 → 2 条红 |

另：钩子带上块所在的代次，提示只发往存有原文的那一代。

验证：`pnpm lint` exit 0；voice-codex `tsc --noEmit` 通过；`vitest related`（7 个源文件）12 个文件 265 条通过（另有 3 条按环境门控跳过，含 founder 回放与 A/B/C/D 主路径）；teamlead 消费者 36/36。

### QA@2 返工评审 R2 的修复（`11954c4d7`）

第一次 R2 刚开始就报「You've hit your usage limit」。Lead 答复 `14040b73`：共享账号已换到 personal1，在同一线程重跑，不走同族通道。重跑的 R2 确认 R1 的三点都已修好，另提 1 MEDIUM，成立：换代后旧的越界截断记录还在；重连后她打断新一代自己的回答，会把仍在排队的 Lead 回复误停掉，并播出提示（旧代的提示本身已被代次检查拦下）。

修复：换代或关闭时清掉截断记录；打断时只认当前这一代的截断。回归测试（`codex-speak`）：越界后换代，再在新一代上打断，不追加提示，也不停止，剩余部分在新一代读完。负对照：去掉这两处检查 → 这一条红。

验证：`pnpm lint` exit 0；voice-codex `tsc --noEmit` 通过；`vitest related`（7 个源文件）12 个文件 266 条通过（3 条按环境门控跳过）；teamlead 消费者 36/36。

## QA@3 返工：朗读打断后旧音频 replay、半词续念与 B5 重连（2026-09-26）

QA@3 的 B5/C2 录音和事件日志表明，问题不是 steer 文案本身：本地切断朗读后，`DownlinkController` 仍按普通对话执行 `boundary=replay`，补播了 420–1280 ms 已静音的旧音频；同时真实事件顺序是“被打断朗读的 own final → 用户 final → 新回答 final”，旧实现会在 own final 之前处理 abandoned fence，导致 fence 被提前清掉或余下提示占住 pending，下一条回答又能带回旧尾巴。B5 的余下提示因此超时并强制重连。

本轮只改朗读块：

- `CodexProofSpeaker.interrupt()` 返回这次是否切断可放弃的 readback；`CodexVoiceBackend` 仅对这类切断调用 `bargeIn({ replayBuffered: false })`。普通对话仍保留原来的 resume/replay。
- 先让被打断块的 own final 消费 owed-final 队列，再让 abandoned fence 处理下一条回答；按已念前缀去掉旧尾巴和半词。余下提示自己的等价 final 可以正常结算，不会被 fence 吞掉。
- developer steer 带上已念前缀，明确禁止补完截断的半词。B5/C2 fixture 按录音里的真实事件顺序投递，并把余下提示走完；断言干净回答、无旧音频 replay、无强制重连。

**红→绿**：补上真实的 own-final/用户-final/answer-final 顺序后，B5 会留下旧朗读尾巴且提示超时，C2 会把「了终面」带进回答；修复后 fixture 两项都只保留干净回答，余下提示完成，`conversation.reconnect` 未调用。

**最终合并头的本机定向验证（代码头 `434955dbd`；之后只追加本节和 milestone）**：

- 7 个直接消费者逐文件运行：`codex-room-webrtc` 28/28、`codex-speak` 57/57、`downlink-controller` 16/16、`speech-overrun` 24/24、`codex-readback-replay` 2/2、`codex-room` 13/13、`codex-transport` 28/28，共 168/168。
- voice-codex `vitest related`（5 个改动 TS 文件）选择同 7 个文件，168/168 通过；`typecheck` 通过；`pnpm --filter "flywheel-voice-codex..." build` 通过。
- 与 `origin/main@b0da16c38` 的唯一冲突是 `voice-session-routes.ts` 相邻 import；保留 FLY-2885 的 context error details 和 main 的 Lead interrupt routes。两个直接路由文件各 23/23 通过，`pnpm --filter "flywheel-teamlead..." build` 通过。该中心文件的 `vitest related` 选到 111 文件，1348/1349；唯一失败 `lead-lease-self-check` 随即按具体文件重跑 6/6 通过，判定为并发负载偶发，不以整包重跑掩盖。
- Biome 对 5 个 voice-codex 改动文件和冲突文件检查通过；`git diff --check` 对本轮代码范围通过。
- 仓库级 `pnpm lint` 仍 exit 1：唯一 error 在无关的 `doc/engineer/research/new/FLY-1547-e2e/e2e-mailbox.mjs`（unused import/variable）；另有 25 条无关 warning。本轮不改这些文件。exact-head 全量 CI 仍由 QA 请求，本实现节点未请求 full CI。

### QA@3 代码评审 R1 的修复（`44c9acccf`）

Codex R1 提出 1 个 HIGH，成立：`OpusDownlink` 原先只在队列中仍有 `replay` 包时豁免积压裁剪。C2 的 64 个 replay 包与服务端新回答都按 20 ms 节拍一进一出；最后一个 replay 包一取走，队列里仍有 64 个随后到达的新回答包，下一次 push 会立即把它们裁到 3 个，丢掉约 1 s 的新语音。

修复只在 downlink 队列中保留一位 replay debt：见到 replay 后持续豁免裁剪，直到播放或跳过静音把队列真正降到 25 包阈值以下；随后恢复普通实时积压裁剪。停止和重开流都会清掉 debt。

- 红：64 个 replay 包与 64 个实时新包同速交替，旧实现最终只剩 3 个新包并记录一次 trim。
- 绿：同一序列保留全部 64 个新包、零 trim；再播放到 23 包并追加 3 包，普通 trim 重新生效，证明豁免不会永久关闭保护。
- 显式消费者逐文件：`opus-downlink` 10/10、`downlink-controller` 16/16、`codex-room-webrtc` 28/28、`codex-readback-replay` 2/2、`discord-room` 16/16，共 72/72。
- `vitest related`（`OpusDownlink.ts` 与其测试）8 个文件 114/114；voice-codex typecheck、受影响包及依赖构建、两处改动文件 Biome、`git diff --check` 均通过。
- 仓库级 `pnpm lint` 仍只因同一无关 FLY-1547 文件的 unused import/variable 而失败；本轮未改该文件。评审的 MEDIUM/LOW advisories 不阻塞此门，本轮按锁定范围未顺带改动。
