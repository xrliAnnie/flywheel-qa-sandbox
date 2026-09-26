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
