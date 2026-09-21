# FLY-2753 本机定向测试守则 — 调研
Issue: FLY-2753 (https://linear.app/geoforge3d/issue/FLY-2753/守则吞吐-实现qa-守则要求每具-runner-交卷前本机跑全量-pnpm-testpackagesrun-十几具同时跑每具-1-2)
日期: 2026-09-18
基于: exploration.md

## 当前事实

### 三份实际守则

- `.flywheel/agents/nodes/implement.md` 的 work loop 第 6 步要求本机 `pnpm lint`、全仓 build、`pnpm test:packages:run`，并接受 `PACKAGE_GATE_RECEIPT` / `onTaskUpdate` 例外与未到达包补跑。
- `.flywheel/agents/nodes/qa.md` 的 work loop 第 3 步同样把 `pnpm test:packages:run` 当成本机验证入口，并复制同一套 package receipt 例外。
- `.flywheel/agents/nodes/engineer.md` 的 self-verify 第 5 步以 “FULL REPO” 明示同一要求。

三处是本单唯一要改的手册业务段。历史 engineering docs 里的旧命令属于当时交付记录，不是活守则，不在本单改写范围。

### canonical protocol 与投影边界

- `packages/teamlead/phase-protocols/implement.md`、`qa.md` 是运行时 canonical phase protocol，只承载跨项目平台职责。
- `scripts/sync-phase-protocols.mjs` 把 canonical block 投影到 `.flywheel/agents/nodes/`；implement 与 qa 各只投影到同名 node，generic 另有七个投影。脚本先校验全部目标，再写入，`--check` 对漂移 fail closed。
- teamlead 的 `prebuild` 首步就是 `node ../../scripts/sync-phase-protocols.mjs --check`。
- `engineering/doc/FLY-2533-snapshot-phase-protocol/protocol-extraction.md` 明确把 implement 的 pnpm 验证留在 domain 层；canonical 不是 Flywheel 专属本机命令的归属。
- `scripts/__tests__/fly2533-phase-protocol-assets.test.sh` 已覆盖 canonical 资产与投影机制，本单不改它，只运行 sync `--check`。

因此，新本地验证合同只进入三份 domain 手册；canonical 与 managed blocks 不变。同步要求通过 `sync-phase-protocols.mjs --check` 证明全部九个 projection 仍与 canonical 一致。

### 锁定旧合同的直接测试消费者

- `scripts/__tests__/package-gate.test.mjs` 遍历 implement/qa/engineer，正向断言 `PACKAGE_GATE_RECEIPT`、`onTaskUpdate` 等旧例外；它应改成新合同的正负断言，作为 RED/GREEN 主测试。
- `scripts/__tests__/fly2121-node-contract-and-setup.test.sh` 正向要求 implement 出现 `pnpm -r build` 与 `pnpm test:packages:run`，需同步改成 affected-package build 与 no-local-full-suite 断言。
- `packages/edge-worker/src/__tests__/Blueprint.generalized-workflow.test.ts` 通过 `fixtures/fly2533-phase-baseline.json` 逐行锁定 implement/qa domain，并限制 prompt 增长。新 domain 文本会超过旧 implement anchor 剩余的个位数字符余量，因此必须把 implement/qa 两个 per-node baseline 明确 re-pin 到新 domain，记录旧→新 prompt/文本增长，不能静默抬预算。

## 新合同的精确含义

1. `pnpm lint` 继续全仓运行。
2. build/typecheck 只跑改动影响到的 workspace package。build 用 `pnpm --filter "<pkg>..." build` 覆盖包本身及其依赖；若改动导出 API/type，再以 `pnpm --filter "...<pkg>" typecheck` 覆盖下游。
3. 定向测试必须包含：
   - 改动文件所在包内直接覆盖改动行为的测试；
   - 其他包或脚本中直接依赖这些改动的测试文件；以完整相对路径、文件名、父目录路径三种 needle 跑 `git grep -lF`，明确无关的命中可排除但必须逐条写理由；TypeScript 源码再在所属包运行 `vitest related <changed-files> --run`；
   - 每个新增 `scripts/__tests__/*.test.sh`。
4. 本机不再要求 `pnpm test:packages:run`，也不再需要 `PACKAGE_GATE_RECEIPT`、`onTaskUpdate` 宽免或补跑“未到达包”。
5. 全量包套件由 frozen-head full-mode exact-head CI 唯一负责；只有 full 汇总 `CI OK` 可称全量证据，scoped `CI Scope OK` 不可。implement/engineer 修复当前 HEAD 实际运行 job 的红；QA 遇红则判 FAIL 并交回作者。
6. 本条显式覆盖 skill/template 的默认 `pnpm test`、`pnpm -r test`、`pnpm -r build` 全量命令，避免另一注入源把已删除的本机全量门带回来。

## 本单的影响面与定向验证

改动落在三份 node markdown、两个脚本合同测试、一个 edge-worker baseline fixture 与 DOC-FLOW 文档。直接验证集合为：

- RED/GREEN：`node --test scripts/__tests__/package-gate.test.mjs` 与 `bash scripts/__tests__/fly2121-node-contract-and-setup.test.sh`；
- 投影：`node scripts/sync-phase-protocols.mjs --check`；
- domain/prompt：先 build edge-worker dependencies，再运行 `pnpm --filter flywheel-edge-worker exec vitest run src/__tests__/Blueprint.generalized-workflow.test.ts -t FLY-2533`；
- 静态验收：三份守则 grep 不含本机 `pnpm test:packages:run` / `PACKAGE_GATE_RECEIPT`，且都含定向选取规则、exact-head CI 全量责任与 job-red 处理规则；
- 全仓格式：`pnpm lint`；
- 受影响包：`pnpm --filter "flywheel-edge-worker..." build`（包本身加依赖）与 `pnpm --filter flywheel-edge-worker typecheck`。

本单没有新增 `scripts/__tests__/*.test.sh`，只修改既有一份，因此只运行该相关 shell test；不本机运行全量 package suite。普通 implement PR 的 scoped CI 只处理实际运行 job；full-suite 证据由 QA 在 frozen HEAD 上通过 `ci-full ensure` 获得。

## 风险与限制

- 三个角色对 build/test/full-CI 的核心规则一致，但 red-job 动作按权限不同：implement/engineer 修复，QA 判 FAIL 并交回作者。测试遍历三份文件检查共同语义，再单验角色动作。
- 不能把 “CI Scope OK” 当全量证明；现有 implement/qa phase protocol 对 `ci-full ensure` 的职责边界保持不变。
- 不修改 `.github/workflows/ci.yml`、`scripts/package-gate.mjs` 或历史文档；本单改变的是 runner 的本机职责，不是 CI 执行内容。
- `.flywheel/agents/nodes/general.md` 仍用旧的 full-repo 摘要，但本单验收明确只锁 implement/qa/engineer；改 general 还需扩大 FLY-2533 generic fixture，按“不要顺手改别的条款”保留为已知限制。
