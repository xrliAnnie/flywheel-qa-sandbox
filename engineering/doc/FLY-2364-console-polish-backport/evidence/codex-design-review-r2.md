# Design Review — plan.md (Round 2)

Date: 2026-09-05
Author: Codex
Status: APPROVED

## Summary

本轮以 HEAD `5b6499593fe55f58e71ebe0f4700f57d741e2382`、plan SHA-256 `bcde32c483d2ac745c1ad629fc0a85c0193dcff8941c58157f6d7eb1a7037688` 为准复核。Round 1 的五项问题均已形成可执行、可判伪的闭环；计划与当前渲染器、snapshot 合同、DAG 映射及测试 fixture 的实际结构一致，可以进入实现。

## What's Good (Keep)

- `run.sh` 把 build、旧 harness 身份核验与退出等待、新 harness readiness、fixture/html hash 绑定、ruler 执行和 trap 清理收进同一生命周期；RED、GREEN、生产证据隔离到不同 `OUT_DIR`，消除了陈旧 `dist` 和陈旧进程污染证据的风险。
- RED 不再只认“4 项失败”，而是精确比对 `{B6,D,A4,A3}`；self-check 还要求精确失败标记，并把连接失败、导航超时和 readiness 失败排除在合法否定臂之外，证据具备非空与正确归因能力。
- fixture 现在能确定地产生 8→2 的项目标题变化，同时覆盖中文节点名、三种模板形态、带/不带 `name` 的回环、dispatch hint、Runner、分组 Lead 与 C7/C8 flag 分类，和验收表逐项对应。
- A3 改为先画全部 path、再画全部标签，并用 DOM paint-order 断言加局部截图验证可读性；删除与预期白底遮线行为矛盾的几何不相交断言是正确修正。
- A4 的 DOM 测试明确区分持久化 model 拼写与 canonical select id，也补齐了多行数量关系及缺 hint 的展示行为，能够捕捉接错数据源的问题。
- 后端 `name` 是只读追加字段，前端对旧后端缺字段回退到 `loop.id`；后端先于前端、两边可独立回退，不需要 schema bump，迁移边界合理。
- C2 对新增 header 导致 `:first-child` 失效的双线问题有针对性 CSS，宽屏/窄屏各有行为证据，同时保持 Runner 卡 label 不受全局隐藏规则影响。
- A1、A5、C7 以及既有 A2/C8 都留在 evidence-only 栏，且 Flags 高度只如实报告，符合 Founder/Lead 已裁定的范围。

## Issues & Recommendations

1. **LOW — C4 尺子条目残留了已废弃的几何断言引用。** 第 127 行末尾仍写“几何采样断言见上”，但第 122–124 行已经明确取消几何不相交断言，改为 paint-order 加截图。实现时删掉这半句或改成“绘制顺序与截图断言见上”，避免执行者误加回已证明必红的检查；上文的规范性说明足够明确，因此不阻塞实施。

## Verdict

APPROVED — ready to implement
