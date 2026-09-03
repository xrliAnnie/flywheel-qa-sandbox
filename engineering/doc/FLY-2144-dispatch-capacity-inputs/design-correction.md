# FLY-2144 派发容量输入 — 设计更正
Issue: FLY-2144 (https://linear.app/geoforge3d/issue/FLY-2144/2108e-派发判断的容量输入quota-机器内存当前值可读-附-dag-resolver-退役)
日期: 2026-09-02
基于: plan.md

根据 Lead 指令 `[lead-instruction 1f2d91e3-291c-43e9-afb9-d42833d0c7bd]`，保留已绑定 design-review blob 的 `plan.md` 不变，并在实施验收中新增 `bash scripts/__tests__/ci-structure.test.sh`：它与 B13/C6 的残留守卫、matrix coverage、package-onboard 和 FLY-2121 合同一起执行，专门锁定 `.github/workflows/ci.yml` 中 `script-tests-3` 的精确测试清单与顺序，防止新残留守卫只进 workflow 而没有同步结构契约。
