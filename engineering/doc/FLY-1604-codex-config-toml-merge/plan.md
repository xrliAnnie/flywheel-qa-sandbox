# FLY-1604 Codex config.toml TOML-aware 合并 — 实施计划

Issue: FLY-1604 (https://linear.app/geoforge3d/issue/FLY-1604/阻塞p0-codex-implement-节点全部起不来-rendercodexhomeconfig-撞上-codex-自己写的-shell)
日期: 2026-08-02
基于: research.md

## 0. 一句话

给 `renderCodexHomeConfig` 加一条 TOML-aware 合并路径：base 已有 `[shell_environment_policy.set]` 时，把 GH_TOKEN 以 sentinel 包裹的**无表头键行**插到该表头紧后（Codex 三键逐字不动）；`smol-toml` parse 结果是**语义权威**（regex 只做字面锚点定位）；结构验证全程用**占位 token**（真 token 绝不进 parser / 异常文本）；不可安全合并的形态 fail loud（固定脱敏消息）；无冲突路径字节不变。skills 守卫同步细化，同名 skill 重叠 fail loud。

## 1. 目标 / 非目标

**目标**
1. 用当前真实全局 config（含 Codex 自写三键）渲染 → 产物合法 TOML，GH_TOKEN 与 Codex 三键同表共存 → Codex implement 节点恢复起飞。
2. 幂等 / scrub 语义零改动（复用现有 sentinel strip）。
3. 不可合并形态仍 fail loud；异常消息**绝不携带** token、base 或产物源码片段（parser raw message 不外传）。
4. 无冲突路径（当前全部测试 fixture 走的路径）**字节不变**。

**非目标**
- 不做全文件 parse+stringify round-trip（丢注释/重排，违反 "base preserved verbatim"）。
- 不触碰全局 `~/.codex/config.toml` 本身（Codex 的三键不删不改）。
- 不改 `provisionCodexHome` 的调用形状与 `CodexTmuxAdapter`。
- 不在本单验证 Codex 对重复 skill name 的 resolution 语义（重叠一律 fail loud，见 §3.3）。

## 2. 改动清单

| 文件 | 改动 |
|---|---|
| `packages/claude-runner/package.json` | dependencies 加 `"smol-toml": "^1.6.1"`（与 teamlead 对齐；1.6.1 同时导出 import/require，claude-runner 为 ESM，用 named import） |
| `pnpm-lock.yaml` | `packages/claude-runner` importer 新增 smol-toml 引用（`pnpm install` 生成，勿手编） |
| `packages/claude-runner/src/codex-home.ts` | `renderCodexHomeConfig` 内部：守卫段（:439-467）替换为 §3 决策树 + 模块内 helper；`MANAGED_*` sentinel、`stripManagedBlock`/`stripManagedSkillsBlock`、其余导出不动 |
| `packages/claude-runner/test/codex-home.test.ts` | 冲突形态测试改写 + 新增合并/验证/脱敏测试（§5） |

## 3. 算法

### 3.1 基础件（模块内）

```ts
// 占位 token：结构验证阶段代替真 token 进入候选文本与 parser。
// 真 token 已由 TOKEN_RE (^[A-Za-z0-9_-]{1,255}$) 约束 —— 与占位符在 TOML
// basic string 中的词法行为完全一致，占位版 parse 通过 ⟺ 真值版 parse 通过。
const TOKEN_PLACEHOLDER = "__FLYWHEEL_GH_TOKEN_PLACEHOLDER__";

// 字面 set 表头锚点（容忍空白 + 行尾注释）— 仅用于定位插入点，不做冲突判定
const SEP_SET_HEADER_RE =
  /^[ \t]*\[[ \t]*shell_environment_policy[ \t]*\.[ \t]*set[ \t]*\][ \t]*(?:#.*)?$/gm;

// 脱敏 parse 包装：任何 parse 失败只抛固定分类消息（stage 标识 base/merged），
// 绝不拼接 parser 的 raw message、行号上下文、base 或产物内容。
function parseTomlSanitized(text: string, stage: "base" | "rendered"): Table;
```

`renderCodexHomeConfig` 边界新增防御性校验：`ghToken` 存在但不匹配 `TOKEN_RE` → 立即 throw（脱敏消息）。（`provisionCodexHome` 已校验；render 是导出函数，独立调用也不许把任意字符串写进 TOML。）

### 3.2 GH_TOKEN 路径（`ghToken` 存在时，对 strip 后的 `base`）

**parse 是语义权威**；旧的宽检测 regex 不再充当冲突判定（root-aware 缺陷：`[other]` 表下的相对键 `shell_environment_policy.foo = "x"` 会被行级 regex 误判为根命名空间）。

```
parsedBase = parseTomlSanitized(base, "base")
sep = parsedBase["shell_environment_policy"]
sepSet = (sep 是 plain table) ? sep["set"] : undefined

case A — sepSet 是 plain table（真实事故形态）:
  if ("GH_TOKEN" in sepSet) → throw（固定消息："GH_TOKEN already present…refusing to overwrite"）
  anchors = base.match(SEP_SET_HEADER_RE)
  if (anchors?.length !== 1) → throw（固定消息：set 表存在但无唯一字面表头 —— quoted/dotted/inline 定义，不可手术）
  → 【手术】在该表头行紧后插入（占位 token）：
      MANAGED_BEGIN
      GH_TOKEN = "__FLYWHEEL_GH_TOKEN_PLACEHOLDER__"
      MANAGED_END

case B — sep 存在但 sepSet 不是 plain table:
  if (sepSet !== undefined) → throw（set 被定义为非表值）
  → 走 case C（sep 是父表/兄弟子表等形态，能否追加由候选 parse 决定）

case C — 其余（含 sep 不存在、sep 只有 [shell_environment_policy] 父表、
          只有 [shell_environment_policy.exclude] 兄弟子表、其他表下的相对同名键）:
  → 【追加】现状完整 sentinel block（含表头，占位 token）
    （父表后开子表、兄弟子表并列、根表追加均为合法 TOML —— 由 3.4 的候选
     parse 最终裁决；inline 表 immutable 等非法形态在 3.4 fail loud）
```

### 3.3 skills 路径（`skillDisableNames` 非空时）

```
parsedBase = parseTomlSanitized(base, "base")   // 与 3.2 共享一次 parse（memoize）
cfg = (parsedBase["skills"] 是 plain table) ? skills["config"] : undefined
if (parsedBase["skills"] !== undefined 且不是 plain table) → throw（skills 被定义为非表值）
if (cfg !== undefined):
  if (!Array.isArray(cfg)) → throw（[skills.config] 单表，不能变数组）
  baseNames = cfg 各元素的 name（非字符串跳过）
  if (baseNames ∩ skillDisableNames ≠ ∅) → throw
     // Codex 对重复 name 取 first/last/报错的语义未验证 —— 不赌。enabled 已是
     // false 也同样拒绝：宁可 fail loud 也不写一个"效果未定义"的配置。
→ 【追加】现状 `[[skills.config]]` sentinel block（array-of-tables 追加元素，
   实测合法）；inline/dotted 等不可扩展形态由 3.4 候选 parse fail loud
```

### 3.4 产物验证（凡注入了内容就跑；确定性 builder，占位 token 只进 parser）

注入路径封装为**确定性 builder** `buildRendered(tokenValue)`：从**原始 base** 出发、按 §3.2/§3.3 选定的路径（手术 or 追加）生成完整文本，token 值仅出现在 managed `GH_TOKEN = "…"` 一行。两次调用只有该行不同 —— **绝不对完整文本做全局替换**（R2-HIGH-1：base 的普通值/注释/Codex 键完全可能恰好包含占位字符串，全局 split/join 会在验证之后改写这些字节，把凭据扩散到非 managed 位置并破坏 base-verbatim）。

```
candidate = buildRendered(TOKEN_PLACEHOLDER)
parsedOut = parseTomlSanitized(candidate, "rendered")   // 失败 → 固定脱敏消息，不写盘
if (ghToken 注入):
  assert parsedOut.shell_environment_policy.set.GH_TOKEN === TOKEN_PLACEHOLDER
  assert isDeepStrictEqual(                              // node:util — 深比较
    omit(parsedOut.shell_environment_policy.set, "GH_TOKEN"),
    parsedBase.shell_environment_policy?.set ?? {})      // base 原有键值逐个保全
if (skills 注入):
  assert 每个 disableName 在 parsedOut.skills.config 中恰有一个 { name, enabled: false }
  assert parsedOut.skills.config.length === (base 原有条数) + (注入条数)
验证通过后 → return buildRendered(ghToken)               // 真 token 从不进入 parser；
                                                        // base 字节零替换（builder 确定性保证
                                                        // 与 candidate 仅 managed 一行之差）
```

说明：
- 候选 parse 让 **TOML parser 裁决可合并性**，覆盖旧守卫的潜伏洞 —— quoted 表头（`["shell_environment_policy".set]`）旧代码宽检测不命中、直接 append 出重复表坏文件；现在产物 parse 失败 → fail loud 在写盘前。
- 纯透传路径（无 token 无 skills）不 parse、不新增失败面。
- 行为收紧点（明示）：base 非法 TOML 且有注入内容时，旧代码可能拼出坏产物写盘、Codex 启动才挂；新代码在 provision 处提前 fail loud —— 故障更早、归因更清晰。

### 3.5 幂等 / scrub 推演（由测试锁死）

- **幂等**：render(render(x))。第二次 render 先 `stripManagedBlock` —— 现有 regex `\n*BEGIN[\s\S]*?END\n?` → `\n` 对无表头键行块同样剥净，base 复原为"表头行 + Codex 键行"逐字原样 → 重新手术 → 输出稳定。
- **scrub**：merge 产物再 render（无 token）→ strip 后 base 逐字复原 → 输出 `${base}\n`，凭据无残留。

## 4. 错误消息合同（脱敏）

- 统一前缀 `renderCodexHomeConfig:` 保留；每个 throw 点用**固定字符串**描述命中的形态类别。
- **绝不**拼接：传入的 ghToken、parser 的 raw `message`/行号上下文、base 或产物的任何源码片段。（`smol-toml` parse error 自带出错行与相邻行 —— 相邻行可能正是 `GH_TOKEN = "<live>"`；这是 R1-HIGH-1 的泄漏面，占位 token + 消息脱敏双保险。）
- 移除已失真的 "the seeded global config changed unexpectedly" 措辞。

## 5. 测试计划（TDD：先 RED）

新 fixture `SEP_CONFLICT_CONFIG`：镜像真实全局 config 形态 —— 若干无关 section + 逐字的

```toml
[shell_environment_policy.set]
BROWSER_USE_AVAILABLE_BACKENDS = "chrome,iab"
NODE_REPL_TRUSTED_BROWSER_CLIENT_SHA256S = "41e1151f…,6d25aa76…"
NODE_REPL_TRUSTED_CODE_PATHS = "/Users/xiaorongli/.codex"
```

| # | 测试 | 断言 | 旧代码下 |
|---|---|---|---|
| T1 | 真实形态合并 | 产物 parse 成功；`set` 含 4 键且 Codex 三键值深比较不变；Codex 三行在产物中**逐字存在**；GH_TOKEN 行夹在 sentinel 对之间且位于表头后；产物含**真实** token（占位符不残留） | **RED**（throw） |
| T2 | 合并路径幂等 | render(render) 稳定；`GH_TOKEN` 恰 1 次；sentinel 恰 1 对 | **RED** |
| T3 | 合并路径 scrub | merge 产物无 token 重渲染 → 字节 === `${SEP_CONFLICT_CONFIG.trimEnd()}\n` | **RED** |
| T4 | base 已有 GH_TOKEN | throw /refusing to overwrite/ | throw（信息变） |
| T5 | 根 dotted / inline 形态 | 仍 throw（case A 锚点≠1 或候选 parse 失败） | 不变 |
| T6 | quoted 表头 `["shell_environment_policy".set]` | throw（case A 锚点数 0） | **RED**（旧代码静默产坏文件！） |
| T7 | 父表 `[shell_environment_policy]` only | 追加成功；产物 parse：`inherit` 保留 + GH_TOKEN 注入 | **RED**（throw） |
| T8 | 兄弟子表 `[shell_environment_policy.exclude]` only；root dotted sibling `shell_environment_policy.exclude.FOO = "x"` | 追加成功（R1-HIGH-2 root-aware：旧宽检测误拒；两形态各一 fixture，候选 parse 裁决） | **RED**（throw） |
| T9 | 其他表下相对同名键（`[other]` 内 `shell_environment_policy.foo = "x"`） | 追加成功（相对键非根命名空间） | **RED**（throw） |
| T10 | base 非法 TOML + token | throw；消息含分类不含源码 | **RED**（静默产坏文件） |
| T11 | **脱敏**：T4/T5/T6/T10 各 throw 场景 | error.message **不含** ghToken、不含 base/产物源码片段（用高熵假 token 断言） | **RED**（新合同） |
| T12 | set 内含**非 primitive 值**的 fixture（TOML array 或 datetime 键） | 深比较保全通过 —— 两次 parse 引用不等而 isDeepStrictEqual 为 true，锁死不得回退浅比较（R2-LOW-3） | **RED** |
| T12b | **占位符碰撞**：base 的 set 值、无关字段、注释均含 `__FLYWHEEL_GH_TOKEN_PLACEHOLDER__` 字面量 | 这些字节在最终产物中**逐字保留**；仅 managed `GH_TOKEN` 行取传入真值（不做"输出不含占位符"全局断言 —— 合法 base 可含它）（R2-HIGH-1） | **RED**（新合同） |
| T13 | skills：base 有 `[[skills.config]]`（无重叠） | 追加成功；数组 = base 条目 + 注入条目 | **RED**（throw） |
| T14 | skills：base 有 `[skills]` 表；`[skills.other]` 子表；`[other]` 内相对 `skills.foo = "x"` | 追加成功（三形态 fixture，对称锁死 skills 侧 root-aware，防残留旧 dotted regex）（R2-MED-2） | **RED**（throw） |
| T15 | skills：同名重叠（base enabled=true 与 enabled=false 各一 fixture） | throw（不赌 Codex 重复 name 语义） | **RED**（新合同） |
| T16 | skills：`[skills.config]` 单表 / inline / dotted | 仍 throw | 不变 |
| T17 | 无冲突字节不变 | 现有 :183 测试**不改一字**继续绿 | 回归锚 |
| T18 | 现有幂等/scrub/无 token 测试 | 不改一字继续绿 | 回归锚 |

改写：现测试 :135 的 5 形态数组拆开 —— `[shell_environment_policy.set]`、`[ shell_environment_policy ]` 挪进 T1/T7 断言成功；dotted/inline 留在 T5 断言 throw。:189 skills 同理拆。

**变异判据（issue 验收 3）**：把 §3.2/3.3 决策树退回"宽检测命中即 throw"（原守卫）→ T1、T2、T3、T7、T8、T9、T13、T14 **必然红**。实现完成后实际执行一次该变异并记录结果。

## 6. 验收（对照 issue；两段制）

**第一段 — PR 前（implement 节点执行，不碰生产）**
1. 用当前真实 `~/.codex/config.toml` + **假 token** 跑一次性脚本：`renderCodexHomeConfig(base, "fake_token_for_acceptance")` → smol-toml parse 产物 + 断言 4 键共存（fixture T1 同形态；此步是对真机文件的最终对照）。
2. 全仓门禁：`pnpm lint` + `pnpm -r build` + `pnpm test:packages:run`。
3. 变异判据执行并记录（§5）。

**第二段 — post-merge ship（founder 批准后，按 FLY-270 self-ship 纪律）**
`CodexTmuxAdapter` 在 Bridge 进程内加载 dist —— git pull 不够，需 merge → build → **重启 Bridge**（detached handoff，绝不 inline 重启），并核实进程加载的 dist 来自合入后的 main（SHA 对照）。随后重试一个走 DAG 三段式的单（FLY-1602/FLY-1603 implement 是现成验收场），确认 session 进 running、tmux pane 存在、无 renderCodexHomeConfig 报错。失败回滚 = revert PR + 再重启（单文件逻辑改动，无状态迁移）。
**授权边界**：merge 与生产重启均为 founder-gated；implement runner 不得把 feature-branch dist 部署到生产。

## 7. 风险与回滚

- **smol-toml 与 Codex（Rust TOML parser）的兼容差**：两者都是 TOML 1.0；只 parse 不 stringify，新增内容仅一行基本语法 `KEY = "value"` —— 差异面趋近于零。
- **占位/真值两次构建的等价性**：builder 对 token 值是确定性的，占位符与 TOKEN_RE 约束的真 token 在 basic string 中词法等价 ⇒ 占位版 parse 通过 ⟺ 真值版 parse 通过；T12b 锁死 base 中既有占位字面量不被触碰。
- **Codex 并发写全局 config 读到半写状态**：parse 失败 → fail loud（脱敏消息）→ session failed 可重试，与现状故障模式一致。
- **回滚**：revert PR 即回到现状（fail loud 全阻塞），无状态迁移。

## 8. 交付物

- 代码 + 测试 PR（branch `flywheel-FLY-1604`，base `main`；含 `pnpm-lock.yaml`）
- 本 doc 文件夹随 PR 合入
- 全仓门禁：`pnpm lint` + `pnpm -r build` + `pnpm test:packages:run`
