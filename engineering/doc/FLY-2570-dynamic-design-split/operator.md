# FLY-2570 动态设计分流 — 操作手册
Issue: FLY-2570 (https://linear.app/geoforge3d/issue/FLY-2570)
日期: 2026-09-15
基于: plan.md

## 查询、修改、回滚

在已部署本功能且完成 config build 的 checkout 中执行（需要 host 配置操作权限）：

```sh
node scripts/design-model-split.mjs show
node scripts/design-model-split.mjs set --codex-percent 75
node scripts/design-model-split.mjs set --codex-percent 0
node scripts/design-model-split.mjs set --codex-percent 37.125
node scripts/design-model-split.mjs set --codex-percent 75
```

0 是 Codex 断供时的设计段止血命令；100 是全 Codex。最后一条恢复 75，内容相同就恢复相同 ruleVersion。输出 sourcePath、codexPercent、fablePercent、ruleVersion。支持任意有限 0..100 小数，按稳定 issue hash 分桶，不承诺小样本严格等比。

默认文件为 `~/.flywheel/models.json`，`FLYWHEEL_MODELS_CONFIG` 覆盖默认，`--config /absolute/path/models.json` 优先级最高。仅影响本 host 的 code.eng_design；不是 project flag。下一次新 workflow admission 热读取，无须再发版/重启。已经冻结 assignment 的重试/重放继续旧模型；更新期间 admission 冲突时，在 set 完成后重试。implement/qa、跨 vendor 规则及 ship 权限不变。0% 不解决 implement 自身 Codex 配额不足。

缺失配置时 show 明确显示 registry v1 parity fallback；首次 set 创建当前 uid 的 0600 文件。已有文件必须同样为当前 uid 的普通 0600 文件，目标 symlink 拒绝；父目录别名归一到同一锁。

## 竞争与恢复

set 与 Fable sync 共用 `<canonical sourcePath>.lock`。Fable API/凭据读取在锁外；写入与验证/回滚在锁内，重新读取最新配置。锁等待预算 30 秒，每 50ms 重试（进程身份检查耗时另计）；失败明确说明预算耗尽、未更新和重试建议。Fable sync 返回 retained/authority_busy。

- 活 PID（包括不可检查者）不按年龄驱逐。不要手动删除活进程的锁。
- 死 PID holder 自动回收；可证明 PID 复用也自动回收。
- 进程在创建 holder 前退出留下的空目录，120 秒后自动回收。等待后重试原命令。
- missing-parent 会列出缺失路径；例如 `mkdir -m 700 /chosen/existing-parent/new-directory`，然后重试带该路径的 `--config` 命令。

## authority 损坏恢复

症状：show/set 报 JSON 或配置验证错误，新的 code admission 报 MODEL_SPLIT_CONFIG_INVALID。影响本 host 所有新的 code admission。set 不会覆盖损坏文件，也不会丢弃其他 bindings/tiers/custom models 后假装成功。**不要删除文件来“恢复默认”**，那会同时移除这些配置。

先确认 sourcePath（默认/环境/--config 的上述优先级），保留损坏 bytes，人工修复副本或使用已知正确备份。下面命令把已验证备份原子恢复到目标，并与其他写入者共用锁；参数必须明确替换成实际路径：

```sh
node --input-type=module - /absolute/path/models.json /absolute/path/known-good-models.json <<'JS'
import {readFileSync,writeFileSync,renameSync,rmSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {validateModelConfigDocument,withModelAuthorityLock} from './packages/config/dist/index.js';
const [target,backup]=process.argv.slice(2);
const bytes=readFileSync(backup,'utf8');
validateModelConfigDocument(JSON.parse(bytes));
await withModelAuthorityLock(target,async path=>{
 const id=randomUUID();
 writeFileSync(`${path}.corrupt.${id}`,readFileSync(path),{mode:0o600,flag:'wx'});
 const temp=`${path}.restore.${id}`;
 try {writeFileSync(temp,bytes,{mode:0o600,flag:'wx'});renameSync(temp,path);}
 finally {rmSync(temp,{force:true});}
});
JS
node scripts/design-model-split.mjs show --config /absolute/path/models.json
node scripts/design-model-split.mjs set --codex-percent 0 --config /absolute/path/models.json
```

有权限/mode 问题时先核实 owner，禁止不加判断地 chown 他人的 authority。修复副本应保持其他配置；由有权限的操作者恢复。

## 历史与部署边界

ruleVersion 标识语义配置而不是人工标签；percentage 输入的旧 version 字段被忽略。旧 v1 记录仍按 v1 查询。assignment 保存当时的阈值、bucket、映射与版本，历史统计不能套用今天的配置重算。

本实现只在 scratch 文件上验证，没有执行生产 set、部署或重启。首次软件能力上线仍需正常发布；上线之后的比例修改不再需要发布。

## 四口径按历史版本查询

`scripts/fly2403-design-model-comparison.sql` 的 `report_parameters.rule_version` 默认 NULL（保持旧报表全集与排除规则）。把该字段设为 show/历史收据提供的完整版本字符串，可限定 cohort；例如旧记录使用 `'fly2403-v1'`。此筛选依赖保存的 `design_model_arm_assigned.payload.basis.ruleVersion`，缺失版本不猜作 v1，多 execution 混版本或重复 assignment 的 run 不进入版本 cohort。

```sh
sqlite3 -readonly -header -csv /absolute/path/offline-snapshot.db < scripts/fly2403-design-model-comparison.sql
```

需要 live DB 副本时必须先用 `scripts/flywheel-snapshot-control.mjs runner` 的受管快照流程，禁止直接复制 live DB。四行分别报告设计评审轮次、QA 打回、founder 打回、设计耗时，每行都有独立 Astra/Fable N、窗口 N 和覆盖率。不要把 75% 配置当成实际样本比例或相等分母。

已接纳 start 的原 idempotencyKey 使用冻结的 assignment/snapshot 做重放，不会因比例改变（包括同一 arm 的阈值改变）重新分臂；当前 authority 损坏时也能确认已保存的 start。新的 key 仍必须通过当前配置校验。重试应保留原请求的 issue/调用者/选择参数；改用同一 key 携带不同请求仍拒绝。
