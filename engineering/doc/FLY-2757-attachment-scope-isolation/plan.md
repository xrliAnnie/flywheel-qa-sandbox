# FLY-2757 附件逐项判定 — 实施计划
Issue: FLY-2757 (https://linear.app/geoforge3d/issue/FLY-2757/附件范围-同批次里一个无类型超大附件会把合法附件一起否掉拒绝原因给错了范围应逐个附件独立判定fly-2638-复审)
日期: 2026-09-24
基于: research.md

## 1. 目标与锁定范围

修正 FLY-2638 下载原语的校验范围：同一 Discord 消息中的每个附件独立判定，坏附件的 type/size 结论不得阻断合法 sibling；坏附件仍返回属于自己的显式原因。

只改：

- `packages/teamlead/src/lead-capabilities/discord-attachments.ts`
- `packages/teamlead/src/lead-capabilities/__tests__/discord-attachments.test.ts`

不改 receipt/carrier/channel 授权、Bridge/MCP API、附件 envelope、大小上限、超时、CDN allowlist、Raya persona/仓库/生产进程，也不处理 FLY-2638 其余三个 advisory。

## 2. TDD 实施步骤

### Task A — RED：实际同批次回归

在 `discord-attachments.test.ts` 增加一个同批用例：Discord metadata response 同时带合法 PNG 与坏附件。测试分别读取两者：

- 合法 PNG 返回精确 bytes 与 `image/png`；
- 无类型目标返回 `unsupported_type`；
- 超大目标返回 `too_large`；
- 坏目标在策略拒绝后不访问 CDN。

先只写测试并运行：

```sh
pnpm --filter flywheel-teamlead exec vitest run src/lead-capabilities/__tests__/discord-attachments.test.ts
```

预期新增测试因整组 `inboundAttachmentSchema` parse 返回 `invalid_metadata` 而失败；确认不是 fixture、语法或依赖错误。

### Task B — GREEN：目标附件独立解析

最小修改 `discord-attachments.ts`：

1. 消息 schema 仍严格校验 message/channel snowflake、附件数组最多 10 项，并要求每项是对象；不再提前校验每个 sibling 的 type/size/URL。
2. 按 raw `id` 精确查找目标；0 项 `not_found`，多项 `invalid_metadata`。
3. 只把唯一目标交给既有 `inboundAttachmentSchema.parse`；解析失败保持 `invalid_metadata`。
4. 沿用之后全部 MIME、期望 size/type、limit、URL 和内容校验。

再次运行 Task A 命令，确认新增用例和既有测试全绿。

### Task C — 阴性对照与相关面验证

在隔离 scratch copy 中把目标选择恢复成整组严格 schema，再运行新增同批用例，必须观察红；恢复当前实现后重跑绿。scratch 不写当前 worktree。

按本节点本地验证合同：

```sh
git grep -lF 'packages/teamlead/src/lead-capabilities/discord-attachments.ts'
git grep -lF 'discord-attachments.js'
git grep -lF 'lead-capabilities' packages/teamlead/src
pnpm --filter flywheel-teamlead exec vitest run <保留的直接相关测试文件>
pnpm --filter flywheel-teamlead exec vitest related src/lead-capabilities/discord-attachments.ts src/lead-capabilities/__tests__/discord-attachments.test.ts --run
pnpm lint
pnpm --filter "flywheel-teamlead..." build
pnpm --filter "...flywheel-teamlead" typecheck
git diff --check
```

记录 consumer sweep 命中与排除理由；不跑本地全包 suite，不把 `CI Scope OK` 当 full CI，不在 implement 节点请求 full CI。

## 3. Review、PR 与交接

1. 实现和验证完成后提交/push 当前 feature branch。
2. 通过注入的 `review_code` gate + `request-review --type code` 获取当前 head 的有效 reviewVerdict；CHANGES_REQUESTED 只修阻塞 finding 并重新走新 review。
3. 开 PR；PR body 明确列出 RED/GREEN、阴性对照、focused/related/lint/build/typecheck 证据与未跑 full CI 的边界。
4. 新建 `engineering/doc/milestones/FLY-2757.md` 作为 literal last commit，push 后确认 PR head。
5. 报告 Lead，并以 `complete --route needs_review --pr <number>` 交接；不 dispatch QA、不 merge、不 deploy。

## 4. 验收矩阵

| 判据 | 权威证据 |
|---|---|
| 坏 sibling 不影响合法图片 | 同批真实 metadata + 合法 PNG bytes 的自动化测试 |
| 坏附件有自己的 reason | 同一用例分别请求坏 ID，得到 `unsupported_type` / `too_large` |
| 判尺可咬回归 | scratch 恢复整组严格校验后新增用例红 |
| 既有安全边界未放宽 | 既有 `discord-attachments.test.ts` 与相关 Bridge/MCP tests 绿 |
| 本地实现可构建 | lint、affected build、dependent typecheck、diff check 绿 |

## 5. 风险与回滚

唯一行为风险是消息级 parser 对非目标 sibling 放宽。通过“attachments 最多 10 项且每项仍为对象”、message/channel 严格校验、目标严格 schema 解析控制范围；未被请求的 sibling 不进入 URL 或网络访问路径。

回滚只需恢复消息 schema 的整组严格解析，但这会重新引入 FLY-2757；新增回归测试会变红并阻止该回滚静默发生。
