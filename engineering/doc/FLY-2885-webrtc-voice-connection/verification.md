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
