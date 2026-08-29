# FLY-977 修 main 上 biome lint red — 实施计划

Issue: FLY-977 (https://linear.app/geoforge3d/issue/FLY-977/修-ci-biome-lint-red-on-main-fly-968-spike-文件-格式化修好不排除)
日期: 2026-07-07
基于: research.md

## 目标

`pnpm lint`（`biome check`）退 0 → CI 回绿。真正格式化 / 修好 spike `.mjs`，**不**排除、不抑制、不改规则、不删文件、不碰生产代码。全仓实测确认（研究 §1b）：**20 个 error 全在 `engineering/spike/FLY-968-voice-bakeoff/`**；FLY-960 spike 无 error（1 warning + 1 info，按 Lead「一起修」纳入）；`packages/**` / `scripts/**` 只有 pre-existing warning/info、0 error、不动。

## 改动范围

**A. `engineering/spike/FLY-968-voice-bakeoff/`（20 个 error）** — 8 个 `.mjs`：
s2-openai-text-out.mjs, s2b-edge-tts-firstbyte.mjs, s3-openai-basics.mjs, s4-gemini-multisession.mjs, s4a-gemini-voice-sweep.mjs, s4b-voice-judge.mjs, s4c-feed-comparison.mjs, s5-elevenlabs-agent.mjs。

**B. `engineering/spike/FLY-960-dave-stt/`（0 error，顺手清 2 条）** — `probe-join.mjs`（未用 import）+ `login-smoke.mjs`（useTemplate）。

**不动**：`biome.json`、`.github/`、`package.json`、`packages/**`（生产/测试代码）、`scripts/**`（qa-fly-863 等 pre-existing warning）。

## TDD 说明

本任务无「实现代码」可写测试。**验证 gate = lint 命令本身**（`pnpm lint` 退 0）。等价于 RED（当前 20 error）→ GREEN（修完 0 error）。无需新增 vitest。

## 步骤（Implement 阶段执行，本设计阶段不写代码）

### Step 1 — 手改 6 处 `noAssignInExpressions`（非自动可修）
把每处 Promise executor 的表达式体改成语句体（行为等价，见 research §3）：

- `s3-openai-basics.mjs:72` `(r) => (done = r)` → `(r) => { done = r; }`
- `s3-openai-basics.mjs:110` `(r) => (callDone = r)` → `(r) => { callDone = r; }`
- `s3-openai-basics.mjs:112` `(r) => (finalDone = r)` → `(r) => { finalDone = r; }`
- `s4-gemini-multisession.mjs:189` `(r) => (s.turnDone = r)` → `(r) => { s.turnDone = r; }`
- `s4a-gemini-voice-sweep.mjs:29` `(r) => (done = r)` → `(r) => { done = r; }`
- `s4c-feed-comparison.mjs:94` `(r) => (st.turnDone = r)` → `(r) => { st.turnDone = r; }`

> 行号以修改时 `pnpm exec biome check <folder>` 的实时输出为准（若上游有变动）。

### Step 2 — 手改 FLY-968 的 2 处 warning（正在动的文件，一并清干净）
- `s2-openai-text-out.mjs:9` 删未用的 `statSync`：`import { readFileSync, writeFileSync } from "node:fs";`
- `s4c-feed-comparison.mjs:132` 去掉未用绑定、**保留** `await` 副作用：`await pushAudio(readFileSync("ref/u5-16k.pcm"));`

### Step 3 — 手改 FLY-960 的 2 条（Lead「一起修」）
两条都**不能** `--write` 安全自动修（biome 2.1.4 把 `useTemplate` 标为 **Unsafe fix**、`noUnusedImports` 也归 unsafe），故手改（实测确认，见 research §5b）：

- `probe-join.mjs:4` 删未用的 `VoiceConnectionStatus`（`joinVoiceChannel` 在 line 46 有用，保留）：
  `import { joinVoiceChannel } from "@discordjs/voice";`
- `login-smoke.mjs:14` `useTemplate`：把模板串里的字符串拼接 `" [" + [...].join(",") + "]"` 改成嵌套模板串（行为等价，产出同一字符串）：
  ```js
  `LOGIN_OK tag=${client.user.tag} id=${client.user.id} guilds=${guilds.size}${guilds.size ? ` [${[...guilds.values()].map((g) => g.id).join(",")}]` : ""}`
  ```

### Step 4 — 安全自动修（格式化 + import 排序）
从 repo root 跑，scope 到两个 spike 文件夹（**不加 `--unsafe`**，不 repo-wide）：
```
pnpm exec biome check --write engineering/spike/FLY-968-voice-bakeoff/ engineering/spike/FLY-960-dave-stt/
```
清掉 8 formatter + 6 organizeImports（FLY-968），并把 Step 1–3 的手改结果统一格式化。（useTemplate / 未用 import 已在 Step 1–3 手改完，此处 `--write` 不依赖 unsafe。）

### Step 5 — 验证 CI green
```
pnpm lint
```
断言：退出码 0、`Found 0 errors`。严格验收：两个 spike 文件夹 **0 diagnostics（0 error / 0 warning / 0 info）** —— 用 `pnpm exec biome check engineering/spike/FLY-968-voice-bakeoff/ engineering/spike/FLY-960-dave-stt/ --reporter=summary` 确认输出为「No fixes applied」且无 violations。`packages/**` / `scripts/**` 的 pre-existing warning 保持不变、不 gate CI（预期不变）。

## 验收

- [ ] `pnpm lint` 退 0（CI 同款命令）；
- [ ] `engineering/spike/FLY-968-voice-bakeoff/` + `engineering/spike/FLY-960-dave-stt/` 均 **0 diagnostics（0 error / 0 warning / 0 info）**；
- [ ] `biome.json` / `.github/` / 生产代码 diff 为空（`git diff --stat` 只含两个 spike 文件夹的 `.mjs`）；
- [ ] 无文件删除、无 `// biome-ignore`、无规则改动。

## 回滚

改动只限 spike `.mjs` 的格式化 / 语法整形；若任何异常，`git checkout engineering/spike/` 即完全还原。零生产影响。

## 时序 / 交付

- 三段式 pipeline 同一分支：Design（本阶段，写文档）→ Implement（执行上述 4 步 + PR）→ QA。
- 优先级：高（挡着往 main 合的人 + Voice 批次）。
