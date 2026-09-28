# FLY-2982 删除旧语音引擎 A — 实施记录
Issue: FLY-2982 (https://linear.app/geoforge3d/issue/FLY-2982/语音-删除旧语音引擎-abwebrtc-订阅-语音大脑成为唯一引擎写好马上合)
日期: 2026-09-28
基于: plan.md

`plan.md` 是设计闸门批准的版本,闸门回执绑定了它的 blob(`reviewedPlanBlobSha e86c608c…`),改它会让已通过的设计闸门失效,所以**实施期对计划的偏离一律记在本文件**,plan 保持原样。

## 偏离计划的地方

| # | 计划原文 | 实际做法 | 原因 |
|---|---|---|---|
| 1 | T6.3:`OPENAI_API_KEY` 在语音路径的剩余出现逐条列表进 `evidence/openai-key-residue.txt`,「该清单是 PR 证据,不进 `residue-check.sh`」 | `residue-check.sh` 增加第二路扫描:`OPENAI_API_KEY\|openAiApiKey`,范围 = 语音路径 `KEY_SCOPE`(voice-codex、voice-core、voice-bridge、teamlead `bridge/voice-*` 及其测试、voice wrapper/configure/lib/qa 脚本、`fly2655`/`fly2799` 启动器、`test-deploy.sh`、语音脚本测试)。每处命中必须被逐行白名单放行;新增类别 `scrub`(`config.ts`、wrapper)、`bridge-env-hygiene`(`test-deploy.sh`、fly2655 测试)、`fixture-placeholder`(`install-voice-launchd.test.mjs`),`negative-test` 扩到 codex-container / fly2655 / fly2799 测试;每类限定文件。自测新增「往 QA 房启动器注入 `OPENAI_API_KEY: input.openAiApiKey` 必须失败」 | Bridge Codex 代码闸门(gpt-5.6-sol xhigh)R1 MEDIUM:只列清单不进门,A 的 key 转发行复活时残留检查仍是绿的;另外计划只看 `OPENAI_API_KEY`,漏了 QA 载体属性名 `openAiApiKey`。新自测在修复前是红的(exit 0),修复后 exit 1 |
| 2 | T6.3 清单范围只列 `OPENAI_API_KEY` | `evidence/openai-key-residue.txt` 与门同口径:两个 token、同一 `KEY_SCOPE`,17 处全部归类 | Codex 闸门 R2 LOW |
| 3 | T6.1 `residue-check.sh` 用 `git grep … \|\| true` 的形态(计划未写,初版实现如此) | 只接受 `git grep` 退出码 0/1,其余返回 2;自测新增「扫描非仓库目录必须报错」 | `codex:rescue` R1 MEDIUM:扫描失败会被当成零命中 |
| 4 | §5 本机测试写了 `pnpm --filter flywheel-voice-codex exec vitest run`(全包) | 改为 `vitest related <改动源文件> --run` + 按导入图补跑的具体文件 | `local-test-policy/v1` 禁止本机全包;全量只认 PR 精确头 CI |
| 5 | §5 teamlead 只列 5 个测试文件 | 另跑 `ProjectConfig.test.ts`、`StateStore.voice-schedule`、`voice-session-preflight`、旗标存储/路由消费者、child-process census;`StateStore.ts`/`ProjectConfig.ts`/`realtime-voices.ts` 不跑 `vitest related`(反向导入闭包 343–622 个测试文件,等于全包) | 同上;排除理由见 `evidence/local-verification.md` |
| 6 | T1.2「删 `RealtimeFrontend` 分支」未规定写法 | `cli.ts` 里原 `if (config.backendId === "codex-realtime") { … }` 的约 110 行 B 装配改成带注释的裸块 `{ … }`,不改缩进;`createFrontend` 与 `finalize` 正常去缩进 | 减少与 FLY-2886 在该块内 5 处改动的冲突(biome 强制规范缩进,不能留旧缩进);合并指南已写进 PR |
| 7 | T5.8 未提 lockfile 之外的变化 | `pnpm install --lockfile-only --offline` 顺带把 `@mistralai/mistralai` 的 `ws` 从 8.19.0 重解析到 8.21.1,已手工还原并用 `--frozen-lockfile --offline` 校验 | 计划要求 lockfile diff 只在 voice-codex importer |

## 列出、未删(CLAUDE.md 死代码规则)

- `engineering/spike/FLY-968-voice-bakeoff/package.json` / `package-lock.json` 的 `ws` 依赖:删掉 A 原型脚本后,同目录剩余脚本不再用它。
- `packages/teamlead/src/lead-backends/codex/codex-lead-runtime.ts` 的 `voiceProfile.openAiApiKey`:B 在 FLY-2885 之前的 API-key 模式,零调用者,不是引擎 A。
