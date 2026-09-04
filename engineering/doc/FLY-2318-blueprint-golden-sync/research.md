# FLY-2318 Blueprint golden 同步 — 调研
Issue: FLY-2318 (https://linear.app/geoforge3d/issue/FLY-2318/main-%E7%BA%A2%E7%B4%A7%E6%80%A5-1067-%E4%B8%8E-1056-%E8%AF%AD%E4%B9%89%E5%90%88%E5%B9%B6%E5%86%B2%E7%AA%81blueprint-%E6%8F%90%E7%A4%BA%E8%AF%8D%E6%94%B9%E5%8A%A8%E6%9C%AA%E5%90%8C%E6%AD%A5%E5%88%B0-fly-2147-%E6%96%B0%E5%A2%9E%E7%9A%84-golden5-%E6%9D%A1)
日期: 2026-09-03
基于: exploration.md

## 1. 可重复的当前失败

依赖闭包构建后运行：

```bash
pnpm --filter flywheel-edge-worker exec vitest run \
  src/__tests__/Blueprint.fly1188-codex-prompt.test.ts \
  src/__tests__/Blueprint.fly2147-runner-memory.test.ts
```

结果固定为 `5 failed | 34 passed`。五个 failure diff 仅包含同一条 FLY-2222 inbox-pending 规则；没有
第二处字符差异。这把故障定位到 expected fixture 漂移，而非 runner-memory 生产装配或路径归一化。

## 2. “新提示词正确”的独立判据

不能以当前 Blueprint 输出本身证明当前 Blueprint 输出。以下三类证据相互独立：

### 2.1 已批准的 FLY-2222 语义

`engineering/doc/FLY-2222-inbox-verdict-hygiene/plan.md` Task 4 明确要求：所有有 Lead 的 Claude/Codex
runner 都应理解 pending 摘要不是空 inbox，并对摘要列出的每个 question id 走既有 `check` 权威路径；
无 Lead 时不得注入。该计划同时锁定不改变 response 消费、delivery、lease 或空 inbox 合同。

`packages/edge-worker/src/__tests__/Blueprint.fly1188-codex-prompt.test.ts` 的三条 FLY-2222 语义测试在
当前失败运行中全部通过：Claude 正向、Codex 正向、no-lead 阴性。这证明新增句的存在条件与动作语义
符合批准计划，而不只是在做 snapshot 自更新。

### 2.2 下游 CLI 行为确实需要这条动作规则

`flywheel-comm inbox` 在 live response 存在时打印真实 question id，但不消费 response 正文；runner
仍须执行 `check <question-id>` 才能取得权威回答。聚焦运行 DB、command、CLI 三个套件得到
`162 passed`，其中覆盖：

- QUEUED/LEASED pending snapshot；
- response 连续两次 inbox 后仍未被消费；
- CLI 输出 `Pending question response: run flywheel-comm check <id>.`；
- ACKED 后真空输出仍逐字节等于 `No instructions.`。

因此新增提示词不是任意文案：它正好连接 inbox 的新摘要与既有 `check` 消费合同。

### 2.3 提交与 snapshot 来源

`7e1c93cf7`（#1067 / FLY-2222）在 `Blueprint.ts` 的 `ctx.leadId` 分支加入完整规则，并在同一提交：

- 新增上述三条语义断言；
- 只给既存 `Blueprint.fly1188-codex-prompt.test.ts.snap` 增加同一句；
- 没有改动本单两份 fixture。

现有 snapshot 第 39 行与 `Blueprint.ts` 拼出的完整句逐字相同（机器路径归一化为 `<COMM_CLI>`）。这份
snapshot 是 #1067 主动更新的预期产物，而不是本修复从失败输出反推的新判据。

## 3. stale golden 的来源与复用关系

Git 历史显示两份 fixture 都只由 `eb88645b7`（#1056 / FLY-2147，20:29:49 -0700）创建；#1067
于 20:58:31 -0700 合入时对二者 diff 为空。

| fixture | 角色 | 失败数 |
|---|---|---:|
| `fly1188-prompt-before-fly2147.txt` | FLY-2147 插段前完整 prompt；off 模式完整 prompt | 2 |
| `fly2147-prompt-golden-unsupported-backend.txt` | off/shared/unsupported 三条未触碰路径的完整 prompt | 3 |

FLY-2147 的批准计划把它们定义为“改前捕获的完整 prompt”与“逐字相同的尺子”。这里的“改前”只能是
相对于 FLY-2147 runner-memory 行为，不代表冻结并否定后来已批准的全局 FLY-2222 prompt 行为。两个
并行语义合入后，正确合并结果是保留 FLY-2147 的差分/未触碰守卫，同时把共同基线推进到 FLY-2222。

## 4. 精确修改形状

两份文件都只在现有 `Your Lead may send you instructions...` 行之后、`LEAD REPORT-BACK` 空行之前插入
完整规则：

- `fly1188-prompt-before-fly2147.txt` 已经是机器归一化 fixture，使用 `node <COMM_CLI>`；
- `fly2147-prompt-golden-unsupported-backend.txt` 保存原始 FLY-2147 worktree 路径，使用
  `node /Users/xiaorongli/Dev/flywheel-FLY-2147/packages/flywheel-comm/dist/index.js`；现有
  `normalizeMachinePaths` 会在比较时把双方归一化。

不更新 snapshot（#1067 已正确更新），不修改 `.test.ts`、`Blueprint.ts` 或任何生产代码。

## 5. 判别力验证

修复后的绿灯不足以证明 golden 仍是有效守卫。变异阳照必须对两份 fixture 同时应用逆补丁，只删本次
新增的两行，再运行同一聚焦命令；预期且只允许五条原失败重新出现。随后恢复修复、再次得到 39/39
通过，并用 `git diff` 确认测试源和生产源始终未改。
