# FLY-1356 skill_framework_mode — 操作手册(开启/kill/退出/评测)

Issue: FLY-1356 (URL 不可得,只写 issue 号)
日期: 2026-07-20
基于: plan.md

> 本手册给 ops(Tadashi / infra bot / Annie)。三臂:A=`superpowers`(现状,默认)/
> B=`matt`(mattpocock/skills 冻结子集)/ C=`bare`(裸奔)。flag =
> `FLYWHEEL_SKILL_FRAMEWORK_MODE`(env,call_time 读,direct-toggle,不重启)。
> **任何默认模式切换(含开 `split`)只认 Annie 明示(plan v2.2②)。**

## 0. 前置(开 `split` 之前必须全绿)

1. **FLY-1335 已 merge 且生产 Bridge 已带其 config**(labelsMatch 空标签 bug —
   不修则未匹配 issue 静默流向 Superpowers 耦合的 shipped generic,污染 B/C 臂)。
2. **`scripts/setup-matt-skills.sh` 已在生产机跑过且探针绿**:
   `claude plugin details matt-skills@matt-skills` exit 0。
   注意:脚本会把 settings.json 的 `matt-skills@matt-skills` **无条件钉 false**
   (`claude plugin install` 会自动写 true —— 真机实测,脚本每次重跑都重新钉 OFF)。
   探针负结果不缓存 ⇒ 装完即生效,无需重启 Bridge。
3. **workflow 模板 flag 保持 OFF**(generalized-workflow 评测期不进臂,纪律项)。
4. `scripts/qa-fly-1356-mode-visibility.sh` 4/4 PASS(阳性对照 + bare 无注入 +
   matt 无 Superpowers 注入 + matt catalog 可见)。

## 1. 开启 split(生产分流)

Console(Fleet 控制台 flag 面板下拉)或 CLI:

```
flywheel-comm feature-flags apply --name skill_framework_mode --to split
```

- 生效 = **下一次 dispatch**(call_time 读,秒级,不重启 Bridge)。
- 分桶 = `sha256(issueIdentifier) % 3`,首次 admission 定桶;之后同 issue 一律
  走 sessions 里的 sticky stamp(retry / 三段式 successor / auto-QA 全继承,
  identifier 源不稳也不会分裂)。

## 2. Kill(秒级钉回 A,不重启)

```
flywheel-comm feature-flags apply --name skill_framework_mode --to superpowers
```

- enum kill 写的是**显式值**(`FLYWHEEL_SKILL_FRAMEWORK_MODE=superpowers` 留在
  .env 里作审计痕迹,不删键)。
- 下一次 dispatch 起全部解析为 A(via=`forced`);successor 带旧 override 撞上
  kill 不报错、照常 spawn 为 A(resolver total 语义,R1#1)。
- **诚实边界:存量 in-flight B/C session 不追改**(spawn 时的插件状态持续到该
  session 结束)。要清场用现有 close-runner 流程逐个关。

## 3. 项目退出(Lead 即时杠杆)

项目 `.flywheel/config.yaml` 加:

```yaml
skill_framework:
  split: false
```

- **即时生效**(每次解析新读该文件,不重启);该项目在 split 下钉 A,
  via 记 `project_opt_out`。
- config 读失败/写坏 = fail-closed:项目钉 A + console.warn(绝不静默进臂)。

## 4. 529 排雷用法(阶段一)

- 隔离 Bridge 的 env 置 `FLYWHEEL_SKILL_FRAMEWORK_MODE=split`
  (529 房照常必设 `FLYWHEEL_DELIVERY_SECRET_PATH` 等隔离 env)。
- 强臂:`POST /api/runs/start` body 带 `skillFrameworkMode: "matt"|"bare"|"superpowers"`
  (flag ≠ split 时该参数 400 —— kill 优先;非法值 400)。
- override 粘性 = 一次强臂全程有效(session 行 via=`override`,phase successor /
  retry / rescue 自动续传;auto-QA 继承父臂)。

## 5. 归因查询(评测 join key)

sessions 两列:`skill_framework_mode`(实际生效臂,探针回落后)+
`skill_framework_mode_via`(default/forced/hash/sticky/override/inherited/
project_opt_out/fallback_superpowers/noop_backend)。样例 SQL(直查
`~/.flywheel/teamlead.db`,不建新 API):

```sql
-- 分臂总览(排除机制 no-op 与非首采行 —— R1#3/#7:naive GROUP BY 不许混层)
SELECT skill_framework_mode AS arm, COUNT(*) AS runs
FROM sessions
WHERE skill_framework_mode IS NOT NULL
  AND skill_framework_mode_via NOT IN ('noop_backend')      -- codex/agy/kimi 机制 no-op
  AND (session_role IS NULL OR session_role != 'qa')         -- QA 行是 inherited,不重复计臂
GROUP BY arm;

-- 评测卫生(Bar-Raiser LOW-7):首行 via='fallback_superpowers' 的 issue
-- 是「想进 B 没进成」——sticky 会让它永远留在 A,计入 A 臂会稀释对比;
-- 正式评测把这些 issue 整个排除(按 issue_id 先查首行 via 再过滤)。

-- 单臂明细(按 adapter_type / session_role / via 分层看)
SELECT issue_identifier, session_role, adapter_type,
       skill_framework_mode, skill_framework_mode_via, status
FROM sessions
WHERE skill_framework_mode IS NOT NULL
ORDER BY started_at DESC LIMIT 50;
```

四观测量(plan v2.2①,数据源已现成):完成率(盲评 rubric,分母同批 issue)、
token(session usage 四类分记)、纪律违规(事件轨迹 + git 提交序)、
**返工轮数**(FLY-616 `reworkRounds` = auto_qa_record fail 计数,`sqlite-reader.ts:100`,
独立呈报 —— 不并进 token、不折进完成率)。四观测量数据呈 Annie。

## 6. 已知边界

- **休眠 EdgeWorker webhook 通道**(`EdgeWorker.ts:971` 直接 `new ClaudeRunner`,
  不经 Blueprint;生产 Bridge 无消费者)在本治理之外 —— 该通道若复活需补接
  skill-framework 解析(R1#6)。
- 非 claude-tmux 后端(codex/agy/kimi):mode/via 照记(via=`noop_backend`),
  插件与 prompt 变体机制上 no-op;评测分析按 `adapter_type` 分层。
- Lead session / Bridge / CLI 不读本 flag —— 只作用 Runner spawn 路径。
- generalized-workflow(pipeline.dag 模板)路径不做 prompt 变体(模板评测期
  OFF;开旗属 FLY-1299 之后)。
