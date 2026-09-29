# FLY-3043 QA 沙箱相关测试说明 — 探索
Issue: FLY-3043 (https://linear.app/geoforge3d/issue/FLY-3043/qa-sbx-fly-3024-b535a6f9-per-issue-529-without-a-d)
日期: 2026-09-29
基于: 无

## 目标

在 `packages/claude-runner/agents/codex-runner-contract.md` 的末尾添加且仅添加 issue 指定的英文 Sandbox note，说明 runner 只运行与改动相关的测试。

## 锁定范围

- 如果目标文件不存在，则创建该文件；如果存在，则保留原内容，只调整末尾所需行。
- 目标说明的完整字面值必须在仓库中恰好出现一次，并且是目标文件最后一行。
- 不修改运行时行为、测试代码、`CLAUDE.md` 或其他 runner contract。
- 按实现节点流程完成设计审查、针对性验证、代码审查、提交、推送和根仓库 PR。

## 验收证据

- 精确文本搜索证明目标说明仅在目标文件预期位置出现。
- 文件尾部检查证明该说明是最后一行。
- `git diff --check` 和仓库 lint 证明文档改动无格式问题。
- 有效代码审查通过，并由 QA 在后续节点正常验证。
