# FLY-1609 开 D 臂:bare + ponytail — 运行手册

Issue: FLY-1609 (https://linear.app/geoforge3d/issue/FLY-1609/实验founder-直令-开-d-臂bare-ponytail代码极简-四臂分桶-归因-1458-分析脚本升级)
日期: 2026-08-03
基于: plan.md

## 上线时

1. 记录四臂代码实际生效的 UTC 时间,把它写入
   `engineering/doc/FLY-1458-abc-prompt-three-arm-analysis/README.md` 的
   `<FOUR_ARM_ROLLOUT_ISO>`;上线前历史只允许用于结构 smoke。
2. 抽查新的 design session:四臂 `skill_framework_mode` 都可出现,同 issue 后续
   session 保持 sticky。D 必须是 `bare-ponytail`;C 必须是 `bare`。
3. D 只有 `ponytail_condition LIKE 'on:%'` 才进入实验样本。readiness 失败时
   mode 仍是 D、condition 记 `unavailable:readiness:*`,session 继续按 bare 跑,
   但分析会排除。C control 只有 `off:%` 才纳入。
4. `noop_backend` / `fallback_superpowers` 没有机械执行所归属的实验臂,分析入口
   会按 `skill_framework_mode_via` 排除并逐行显示原因。

## Retry 语义

FLY-615 的 requested condition 在 retry 时冻结,现在由 FLY-1609 把既有 decoder
真正接入 runtime。这个合同对 A/B/C/D 一致:前驱的 `on:label` / `off:label` /
`on:project` 等 intent 不因 retry 前编辑 Linear label 而变化。要让新的标签意图
生效,应发起新的 session,不要用 retry 把同一次实验换条件。

只有 `unavailable:selector` / `unavailable:conflict` 会在 retry 重新解析 selector。
此时 Linear fresh fetch 成功才把标签视为 readable;无 API key 或 Linear 请求失败
会如实记 `unavailable:selector:label_unreadable`,本次不启用 ponytail。这个 fail-closed
结果可能暂时降低 D 的有效样本量,但不能把看不见的 `ponytail-off` 越权算成 D。

## 四臂比较

```bash
python3 engineering/doc/FLY-1458-abc-prompt-three-arm-analysis/scripts/design_compare.py \
  --since '<FOUR_ARM_ROLLOUT_ISO>'
```

脚本只读打开 StateStore。每个 duration / review 指标独立打印样本数;D 初期为空是
允许的,但须先核对 rollout epoch 格式与 D condition 分布,不能把错误空组当结论。
