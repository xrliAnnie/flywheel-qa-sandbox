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
