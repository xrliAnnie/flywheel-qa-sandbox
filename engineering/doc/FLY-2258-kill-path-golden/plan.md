# FLY-2258 kill-path golden 对账 — 实施计划
Issue: FLY-2258 (https://linear.app/geoforge3d/issue/FLY-2258/hotfix-main-红-kill-path-inventory-golden-漏-fly-2240-的-4-条-qa-only)
日期: 2026-09-01
基于: research.md

## 目标

在 `e3554c812` 基线上将 kill-path golden fixture 与现有 deterministic scanner 的
556 条结果重新对齐，恢复 main CI，同时证明唯一产品/实现文件变化是 fixture，且变化
仅为四条 `qa-only` entry。

## 锁定范围

允许的实现文件：

- `packages/claude-runner/test/fixtures/kill-path-inventory.json`

禁止修改：

- `packages/claude-runner/test/kill-path-inventory.ts` 扫描/分类逻辑；
- FLY-2211 与 FLY-2240 的任何生产代码或测试行为；
- 其他 fixture、CI 配置、依赖或格式规则。

DOC-FLOW 规定的 exploration/research/plan/progress 与最终 milestone 是流程元数据，
不计入上述实现文件白名单；除这些强制文档外，不增加其他文件。

## TDD seam

已确认 seam 是现有公开函数 `scanKillPathInventory()` 与已提交 golden fixture 的完全相等
断言。现有测试已提供独立失败 oracle，所以不新增测试文件。

## 实施步骤

### 1. RED（已完成）

运行：

```sh
pnpm --filter flywheel-claude-runner exec vitest run test/kill-path-inventory.test.ts
```

要求失败原因为 scanner 556 对 fixture 552，diff 只显示 issue 点名的四条。

### 2. GREEN：确定性重生 fixture

用 `tsx` 导入现有 `scanKillPathInventory()`，将完整返回值以仓库既有 JSON 格式
（tab 缩进 + 尾随换行）机械写回唯一允许的 fixture。不得手工改分类或排序。

立即复跑目标测试，要求 1/1 PASS。

### 3. Delta guard

相对 `e3554c812` 中的 fixture 做可执行比较，必须同时满足：

- before=552，after=556；
- additions=4，deletions=0；
- 四条 additions 的 `classification` 均为 `qa-only`；
- `classification !== "qa-only"` 的有序数组 before/after 完全相等；
- `git diff --name-only e3554c812 -- packages scripts` 只列出目标 fixture。

任一断言失败都停止，不通过扩大 scanner 或分类范围来“修复”。

### 4. 完整验证

按实现节点合同执行：

```sh
pnpm lint
pnpm -r build
pnpm test:packages:run
```

另外枚举并执行每个新增/现有 `scripts/__tests__/*.test.sh`。因为本 hotfix 未新增 shell
测试，仍跑全量 shell suite 以满足节点合同。记录命令、退出码与失败归因。

### 5. Review 与交付

- 将实现与流程文档分批小提交，保持 progress ledger 最新。
- 通过 `codex:rescue` 对 main-base delta 做代码审查。
- 按注入协议注册 `review_code` gate；若有 blocking finding，修复后以新 head 新开一轮。
- 推送分支并创建 PR，不 merge、不请求 ship approval。
- 最后单独创建 `engineering/doc/milestones/FLY-2258.md`，确保它是 PR 的 literal last
  commit；随后报告 Lead，并 `complete --route needs_review --pr <NUMBER>`。

## 验收证据矩阵

| 要求 | 权威证据 |
|---|---|
| scanner == fixture | 目标 Vitest PASS |
| 四条均 qa-only | 独立 JSON delta guard 输出 |
| 非 qa-only 零变化 | 163 条有序数组逐字节比较 |
| 实现 diff 仅 fixture | `git diff --name-only e3554c812 -- packages scripts` |
| full CI 本地等价 gates 绿 | 三个固定 pnpm gates + 全量 shell tests 的退出码 |
| 审查通过 | `review_code` gate 的 `reviewVerdict=APPROVED` |
| PR 可交给独立 QA/Founder | GitHub PR、exact head、needs_review completion receipt |

## 风险与回滚

风险限于 fixture 漂移。若 scanner 运行出现除四条以外的 delta，回滚 fixture 重生并调查
工作树/基线；不修改 classifier。回滚本修复只需反转 fixture commit，不影响运行时行为。
