# FLY-2662 原生 peer 可选构建 RED — 调研
Issue: FLY-2662 (https://linear.app/geoforge3d/issue/FLY-2662/land收尾死结-已合入的卡收尾永远停在半路thread-不归档linear-不-doneworktree-不清window)
日期: 2026-09-17
基于: plan.md

命令：`pnpm --filter flywheel-teamlead exec vitest run src/bridge/__tests__/reclose-peer-native.test.ts`

基线失败：Vitest 无法解析 `../reclose-peer-native.js`，suite 1 failed、tests 0；这证明 loader 与可选构建单元尚不存在。首次尝试因 checkout 尚未安装依赖而只得到 `vitest not found`，执行 `pnpm install --frozen-lockfile` 后才采集上述产品 RED。

最小实现后：3 tests passed；Darwin 本机从已有 Node headers 与 clang++ 构建并加载 exact `darwin-arm64` Node-API 模块。`FLYWHEEL_RECLOSE_PEER_NATIVE_FORCE_FAIL=1 pnpm -r build` exit 0，日志明确 `peer_adapter_unavailable: native_build_failed: forced failure injection`，随后 teamlead 与 voice-codex 均 `Done`。失败产物的 runtime loader 返回 typed `peer_adapter_unavailable`；恢复普通 build 后 exact host module 再次生成并加载。单包首次 build 的 sibling dist 缺失不是 native 失败，按 monorepo 基线先完成了 `pnpm -r build`。
