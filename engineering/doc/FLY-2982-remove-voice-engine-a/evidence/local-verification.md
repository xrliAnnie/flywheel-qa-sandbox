# FLY-2982 删除旧语音引擎 A — 本机定向验证记录
Issue: FLY-2982 (https://linear.app/geoforge3d/issue/FLY-2982/语音-删除旧语音引擎-abwebrtc-订阅-语音大脑成为唯一引擎写好马上合)
日期: 2026-09-27
基于: plan.md

按 `local-test-policy/v1`:只跑相关测试,一个具体文件一次(或 `vitest related`),单 fork(`--pool=forks --poolOptions.forks.maxForks=1`)。**这些都不是全量证据**;全量只认 PR 精确头 CI。

## 选择过程

- 改动的 TypeScript:voice-codex `cli/config/daemon/projection/bridge-client/realtime.ts` → `vitest related`(选中 13 个文件);另按导入图(含 type-only 导入)补跑 `session / discord-room / codex-transport / codex-handoff-transcript / UplinkSpeechGate.preroll.smoke` 5 个具体文件(`session.test.ts` 改了夹具)。
- voice-core `types.ts` → `vitest related`(9 个文件)。
- teamlead `ProjectConfig.ts / StateStore.ts / realtime-voices.ts / voice-session-services.ts`:**不跑 `vitest related`**——四者都是枢纽(运行时反向导入闭包分别 343 / 622 / 343 / 108 个测试文件,等于全包)。改跑直接消费者 + 改动路径测试(下表),排除项:其余经 `ProjectConfig`/`StateStore` 间接导入的 Bridge 测试——改动只删一个类型字段、一个转移准入值和一行投影字段,它们不读这些值。
- config `truth.ts` → `vitest related`(18 个文件);`NON_FLAG_ALLOWLIST` 的跨包消费者(teamlead 4 个、flywheel-comm 1 个)逐个跑。
- 全路径发现:对每个改动文件 `git grep -lF <full path>`(排除文档)——`StateStore.ts` / `ProjectConfig.ts` 的路径消费者无一钉哈希或行号;`kill-path-inventory.json` 只登记 `fly2655-voice-room.mjs` 未改动的 kill 行。

## 结果

| 范围 | 命令(节选) | 结果 |
|---|---|---|
| voice-codex 构建 | `pnpm --filter "flywheel-voice-codex..." build` | 通过;`remove-retired-dist: removed 4 retired output path(s)` |
| voice-codex tsc | `pnpm --filter flywheel-voice-codex exec tsc --noEmit` | 0 |
| voice-codex related | `vitest related src/{cli,config,daemon,projection,bridge-client,realtime}.ts --run` | 13 files / 237 tests passed |
| voice-codex 补跑 | `vitest run src/__tests__/session.test.ts` 等 5 个 | 34 + 16 + 28 + 4 + 1 passed |
| voice-core tsc / related | `tsc --noEmit`;`vitest related src/types.ts --run` | 0;9 files / 69 passed |
| voice-bridge tsc | `pnpm --filter flywheel-voice-bridge exec tsc --noEmit` | 0 |
| teamlead tsc + build | `tsc --noEmit`;`pnpm --filter flywheel-teamlead build` | 0;通过(`dist/realtime-voices.d.ts` 无 v2 导出) |
| teamlead 直接消费者 | `huddle-config`(30)、`ProjectConfig`(176)、`voice-session-services`(24)、`voice-session-start`(18)、`voice-session-routes`(21)、`StateStore.voice-session`(23)、`StateStore.voice-schedule`(34)、`voice-session-preflight`(18) | 全部通过 |
| teamlead 旗标消费者 | `StateStore.flag-value-scope`(5)、`StateStore.flag-value-store`(12)、`flag-routes`(40)、`management-existing-writers`(17)、`bridge-child-process-census`(1) | 全部通过 |
| config related | `vitest related src/feature-flags/truth.ts --run` | 18 files / 333 passed(含 `flag-truth` 46、`feature-flags-drift` 14) |
| 旗标漂移负向对照 | 临时在 `fly2799-codex-container.mjs` 加回一处 `process.env.FLYWHEEL_VOICE_BACKEND` 读取 | `feature-flags-drift` 红(`FLYWHEEL_VOICE_BACKEND: register it …`),还原后绿 |
| flywheel-comm | `vitest run src/commands/__tests__/feature-flags.test.ts` | 15 passed |
| claude-runner | `vitest run test/kill-path-inventory.test.ts` | 5 passed |
| wrapper | `bash` 与 macOS `/bin/bash` 3.2 各跑 `scripts/__tests__/flywheel-voice-wrapper.test.sh` | 39/39 两次 |
| 脚本 node 测试 | `voice-host-configure`(23)、`fly2655-voice-room`(34)、`fly2799-codex-container`(4)、`remove-retired-dist`(9)、`install-voice-launchd`(9) | 全部通过 |
| 读取 wrapper/ProjectConfig 的脚本测试 | `qa-fly1501-brake-missing-alert`(49)、`restart-voice-on-demand`、`host-tmux-selection-s0-scope`(2)、`fly1680-v1-extinction`(7) | 全部通过 |
| 残留检查 | `residue-check.sh`;`residue-check.sh --self-test`(bash 与 `/bin/bash`) | 两路扫描(A 标识符全仓 + 语音路径上的 `OPENAI_API_KEY`/`openAiApiKey`,后者为 Codex 闸门 R1 要求)共 31 处命中,全部被 31 条逐行白名单放行,0 未放行;自测 8/8(含注入 `OPENAI_API_KEY: input.openAiApiKey` 必红、git 扫描失败按错误处理) |
| 旧产物 | `evidence/retired-dist.txt` | 同一检出:改前 `dist/realtime-transport.*` 4 个文件存在;改后构建删除,`dist/realtime.js` 只剩 `export {}` |
| lockfile | `pnpm install --lockfile-only --offline` 后 `pnpm install --frozen-lockfile --offline` | diff 只在 `importers['packages/voice-codex']`(-6 行);一处无关的 mistralai `ws` 重解析已手工还原并通过 frozen 校验 |
| lint | `pnpm lint` | 0 error;25 warning 均为原有,不在改动文件内 |

RED 先行:config(13 失败)、projection(2)、huddle-config N4、voice-session-services N5、StateStore N6、remove-retired-dist、wrapper(14 失败)、voice-host-configure N9、fly2655(2)都在实现前先红。
