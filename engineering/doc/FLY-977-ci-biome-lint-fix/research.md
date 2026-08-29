# FLY-977 修 main 上 biome lint red — 调研

Issue: FLY-977 (https://linear.app/geoforge3d/issue/FLY-977/修-ci-biome-lint-red-on-main-fly-968-spike-文件-格式化修好不排除)
日期: 2026-07-07
基于: exploration.md

## 1. CI lint 命令与 biome 版本

- CI: `.github/workflows/ci.yml:62` → `run: pnpm lint`；`ship-on-comment.yml:126` 同。
- `package.json`: `"lint": "biome check"`（**无** `--error-on-warnings`）。
- biome 版本: **2.1.4**（`pnpm exec biome --version`）。
- `biome.json`: 关了 `noNonNullAssertion`/`noExplicitAny` 等几条；`formatter.formatWithErrors: true`；`vcs.useIgnoreFile: true`。**本 issue 不动此文件。**

结论：CI red 的充要条件 = 存在 **error** 级诊断。清零 error 即 green，warning 不 gate。

## 1b. 全仓 error 定位（Lead scope 修正 — 实测三验）

Lead 要求别只盯 FLY-968，跑全仓确认。用三种独立方法交叉验证「哪些文件有 **error**」：

1. `biome check --max-diagnostics=none --reporter=summary`（全仓）→ Found 20 errors；
2. `biome check --reporter=github` → 逐条 `::error` 按文件聚合 → **20 条全在 `engineering/spike/FLY-968-voice-bakeoff/`**（s3=5, s4a=3, s4=3, s5=2, s4c=2, s4b=2, s2=2, s2b=1）；
3. 全仓 github reporter 过滤掉 FLY-968 目录后 → `::error` grep **为空**（0 error）。

⇒ **CI red 的全部来源 = FLY-968-voice-bakeoff 的 20 个 error**。其余出现在诊断里的文件（FLY-960 spike、`packages/**` 测试、`scripts/qa-fly-863-*.mjs`）**全是 warning/info、0 error**。

### FLY-960-dave-stt（Lead 点名，实测）
0 error，2 条非 error：

| 文件 | 行 | 规则 | 级别 | 修法 |
|------|----|------|------|------|
| probe-join.mjs | 4 | `noUnusedImports` | warning | 删未用的 `VoiceConnectionStatus`（`joinVoiceChannel` 在 line 46 有用，保留） |
| login-smoke.mjs | 14 | `useTemplate` | info | 模板串里嵌了 `" [" + [...].join(",") + "]"` 字符串拼接 → 改成嵌套模板串（**手改**，见 §5b） |

按 Lead「一起修」纳入范围。

### 5b. FLY-960 两条都需手改（Codex design review R1 抓出）
初稿误以为 `login-smoke.mjs` 的 `useTemplate` 是 safe fix、`--write` 会自动清。**实测确认不是**：
- `biome lint login-smoke.mjs --reporter=json` 对该条给的 advice = 「**Unsafe fix**: Use a template literal」；
- `biome check --write --stdin-file-path login-smoke.mjs` 后 `" [" + ... + "]"` 拼接**仍在**（`--write` 只做 safe fix）。

⇒ `useTemplate` 与 `noUnusedImports` 都需手改（同 FLY-968 的未用 import 一样归 unsafe）。手改后 Step 4 的 `--write` 只负责格式化 + import 排序，不依赖 `--unsafe`。login-smoke 手改后的等价写法（产出同一字符串）：
```js
`LOGIN_OK tag=${client.user.tag} id=${client.user.id} guilds=${guilds.size}${guilds.size ? ` [${[...guilds.values()].map((g) => g.id).join(",")}]` : ""}`
```

### packages/** + scripts/**（out of scope）
`packages/agent-team-transport/.../AgentTeamTransportFactory.ts`、`packages/teamlead/**/*.test.ts`（4 个）、`packages/voice-core/**/headless-brain.test.ts`、`scripts/qa-fly-863-codex-hold-signal-e2e.mjs` —— 均 warning/info、0 error、pre-existing、属生产/测试代码。**不动**（scope discipline；不 gate CI）。

## 2. 20 个 error 的精确清单（真实 repo，`engineering/spike/FLY-968-voice-bakeoff/`）

### 2a. Formatter（8，自动修）
需重新格式化的 8 个文件：`s2-openai-text-out.mjs`、`s2b-edge-tts-firstbyte.mjs`、`s3-openai-basics.mjs`、`s4-gemini-multisession.mjs`、`s4a-gemini-voice-sweep.mjs`、`s4b-voice-judge.mjs`、`s4c-feed-comparison.mjs`、`s5-elevenlabs-agent.mjs`。

### 2b. `assist/source/organizeImports`（6，自动修）
import 未按 biome 规则排序，散在上述文件里。`biome check --write` 会自动排。

### 2c. `lint/suspicious/noAssignInExpressions`（6，**需手改**）
Promise executor 里用「表达式内赋值」捕获 resolver：

| 文件 | 行 | 现状 |
|------|----|------|
| s3-openai-basics.mjs | 72 | `const donePromise = new Promise((r) => (done = r));` |
| s3-openai-basics.mjs | 110 | `const callPromise = new Promise((r) => (callDone = r));` |
| s3-openai-basics.mjs | 112 | `const finalPromise = new Promise((r) => (finalDone = r));` |
| s4-gemini-multisession.mjs | 189 | `const done = new Promise((r) => (s.turnDone = r));` |
| s4a-gemini-voice-sweep.mjs | 29 | `const donePromise = new Promise((r) => (done = r));` |
| s4c-feed-comparison.mjs | 94 | `const done = new Promise((r) => (st.turnDone = r));` |

## 3. 手改法的行为等价性证明（核心）

`noAssignInExpressions` 不是 `--write` 安全可修（biome 不改赋值语义）。标准修法 = 把箭头函数从「表达式体」改成「语句体」：

```js
// 前
new Promise((r) => (done = r));
// 后
new Promise((r) => { done = r; });
```

**为什么行为等价**：`(r) => (done = r)` 的返回值是赋值表达式的值（即 `r`）；但 Promise 构造器（executor）**忽略** executor 函数的返回值 —— executor 的作用只是在被调用时把 `resolve` 存进外层变量。改成 `(r) => { done = r; }` 返回 `undefined`，对 Promise 解析行为**零影响**。`s.turnDone = r` / `st.turnDone = r`（写对象属性）同理。

⇒ 6 处手改是纯语法整形，不改运行时行为。这也正是 biome 官方对该 rule 的推荐重写。

## 4. 自动修边界（scratchpad 副本实测）

在 scratchpad 复制整个 spike 文件夹跑过：

1. 裸 `biome check --write <folder>`（安全修）→ 清掉 8 formatter + 6 organizeImports；**留下** 6 个 `noAssignInExpressions`（符合预期，非安全可修）。
2. 手改 6 处 `(r) => (X = r)` → `(r) => { X = r; }` 后再 `--write` → **0 error**，只剩 2 个 warning。
3. 那 2 个 warning（`noUnusedImports`、`noUnusedVariables`）biome 标 FIXABLE 但归为 **unsafe** 修（裸 `--write` 不动，要 `--write --unsafe` 才删）。

⇒ 不用 `--unsafe`（避免它顺手改到别处、或删掉有副作用的行）；这 2 个 warning 手改。

## 5. 2 个 spike warning（一并手改，属正在动的文件）

| 文件 | 行 | 现状 | 修法 |
|------|----|------|------|
| s2-openai-text-out.mjs | 9 | `import { readFileSync, writeFileSync, statSync } from "node:fs";`（`statSync` 未用） | 删 `statSync` |
| s4c-feed-comparison.mjs | 132 | `const end = await pushAudio(readFileSync("ref/u5-16k.pcm"));`（`end` 未用） | 改成 `await pushAudio(readFileSync("ref/u5-16k.pcm"));` —— **保留 `await` 副作用**，只去掉未用绑定 |

⚠️ s4c 有两个 `end`：line 93 `const end = now()`（另一函数作用域，与本 warning 无关，别动）；被 flag 的是 line 132。

## 6. 明确不做（scope discipline）

- **不动** 仓库其它地方的 ~15 个 pre-existing warning（`noStaticOnlyClass`、其它 `noUnusedImports`、`useTemplate`、`suppressions/unused`）—— 非 FLY-968 引入、不 gate CI、越界。
- **不改** `biome.json`（不加 ignore、不关规则）。
- **不删** 任何 spike 文件。
- **不用** `// biome-ignore` 抑制注释。
- **不 repo-wide `--unsafe`**（只 scope 到 spike 文件夹的安全 `--write`）。

## 7. 风险

- 极低。纯格式化 + 语法整形，无生产代码、无测试逻辑。spike `.mjs` 是一次性脚本、不进 build/test 图（`pnpm test` 不跑它们）。
- 唯一「行为」相关点 = §3 的 executor 重写，已证等价。
- 回归验证 = `pnpm lint` 退 0 即可。
