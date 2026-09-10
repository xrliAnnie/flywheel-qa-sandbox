# FLY-2460 Codex 准入蒸馏通道 — 529 验收路书
Issue: FLY-2460 (https://linear.app/geoforge3d/issue/FLY-2460/2355b3-codex-自蒸馏从不触发runner-家里模型拿不到原生-memory-工具memory-stage1-后台任务从不跑)
日期: 2026-09-09
基于: plan.md; implementation-addendum.md; research.md; exploration.md

本路书由 QA 节点执行；撰写路书、实现完成、聚焦测试通过均不证明 E1–E6 真机通过，尤其不证明 E4。验收以 pinned plan §7 和 Lead question b24705c1 为准。**E7：无自然人口，本单不证明 legacy → seed。** 不制造旧家、不触发旧家、不回填、不把 keyed 同家复用写成 retire → archive → seed 成功。

## 1. 房间、字节和零生产写入边界

QA 先领取自己的 529 slot 和测试 issue。以下占位变量必须换成 QA 自己持有的实际值；不要直接启动本文中的任务。所有实验只能用该 slot 新建的 `agents/<project>/implement` keyed 家，T1 前它必须不存在。若已存在，领取新的隔离项目/slot；不要清空任何家来伪造从零开始。

```bash
export QA_SLOT='<owned-positive-integer>'
export QA_HEAD='<full-reviewed-commit-sha>'
export QA_SLOT_ROOT="/tmp/flywheel-test-slot-${QA_SLOT}"
export QA_EVIDENCE="/tmp/fly2460-evidence-${QA_SLOT}"
umask 077
mkdir -p "$QA_EVIDENCE"
test "$(git rev-parse HEAD)" = "$QA_HEAD"
pnpm --filter flywheel-claude-runner build
find packages/claude-runner/dist -type f -exec shasum -a 256 {} + > "$QA_EVIDENCE/runner-dist.sha256"
bash scripts/test-deploy.sh "$QA_SLOT" --generalized --codex-runner --no-lead --expect-head "$QA_HEAD"
```

保存部署回执与 room-info 的**非秘密**字段 `buildSha/projectName/agentId/runnerMode/bridgeUrl/hostRepo/flywheelRepo`。从实际 `bridge-launch.json`、daemon argv、runner 日志核对加载的 claude-runner dist 路径，再对实际路径计算 SHA256 与上面的清单逐项比对。`--expect-head` 不能代替 claude-runner dist 字节验证。记录 Codex 版本；根因依据为 0.153.2，其他版本须重新核对 schema/守卫，不能沿用旧结论。

`test-deploy.sh` 把 `FLYWHEEL_CODEX_HOMES_ROOT` 指到 `${QA_SLOT_ROOT}/state/codex-homes`。从 provision/daemon 证据取得实际 `QA_CODEX_HOME`；不要猜路径后直接跑 Codex。下面的采集器逐次检查 canonical path，只允许 slot 内该项目的 implement 家。确认配置未从 FLY-2359 seed 导入已有正文，首次 state DB 也没有历史线程；否则 E1 起点不合格。不要读 token 文件到终端、打印整份 launch-spec 或公开完整 prompt/rollout。

生产旧家零写入：不对生产家运行任何 Codex 命令、不修改 config/DB/mtime、不复制旧家作为本轮样本、不调用 retire/seed/backfill。保存实验命令、canonical home 与进程 home 证据。若另采生产只读元数据用于旁证，生产 runner 的自然写入可能使前后 hash 不同，不能据此归因实验写入，也不能用 hash 相同证明全部零写入。

## 2. 只读取证器（E1/E2/E3/E4）

每次调用前设 `QA_LABEL=t1-before|t1-after|t2-before|t2-after|t3-after|off-before|off-after`；`QA_PROJECT` 必须来自房间回执，`QA_CODEX_HOME` 必须来自真实 daemon。把下面脚本保存到 `$QA_EVIDENCE/collect.py`，每个检查点执行 `python3 "$QA_EVIDENCE/collect.py" > "$QA_EVIDENCE/$QA_LABEL.json"`。无 DB 记 missing，不创建 DB；查询失败应中止该检查点，不能解释为零行。只读连接保留 WAL 可见性，不用 `immutable=1`，不复制孤立主 DB，也不做 checkpoint。

```python
import json, os, sqlite3, time
from pathlib import Path

slot = Path(os.environ['QA_SLOT_ROOT']).resolve(strict=True)
home = Path(os.environ['QA_CODEX_HOME']).resolve(strict=True)
expected = (slot / 'state/codex-homes/agents' /
            os.environ['QA_PROJECT'] / 'implement').resolve()
assert home == expected and slot in home.parents, 'refuse non-slot/keyed home'

def read_db(name, queries):
    path = home / name
    if not path.exists():
        return {'missing': True}
    assert path.resolve().parent == home and not path.is_symlink()
    db = sqlite3.connect(path.as_uri() + '?mode=ro', uri=True, timeout=2)
    db.row_factory = sqlite3.Row
    try:
        db.execute('PRAGMA query_only=ON')
        db.execute('BEGIN')
        return {key: [dict(row) for row in db.execute(sql)]
                for key, sql in queries.items()}
    finally:
        db.close()

out = {'capturedAtMs': int(time.time()*1000), 'home': str(home)}
out['state'] = read_db('state_5.sqlite', {
    'threads': '''SELECT id,source,memory_mode,updated_at_ms,archived,
      length(preview) AS previewLength,tokens_used FROM threads ORDER BY id'''
})
out['memories'] = read_db('memories_1.sqlite', {
    'jobs': '''SELECT kind,job_key,status,worker_id,input_watermark,
      last_success_watermark,started_at,finished_at FROM jobs
      ORDER BY kind,job_key''',
    'outputs': '''SELECT thread_id,source_updated_at,rollout_slug,
      length(raw_memory) AS rawLength,length(rollout_summary) AS summaryLength,
      selected_for_phase2,selected_for_phase2_source_updated_at,
      instr(raw_memory,'No raw memories yet') AS rawTemplate,
      instr(rollout_summary,'No consolidated rollout memories yet') AS summaryTemplate
      FROM stage1_outputs ORDER BY thread_id'''
})
print(json.dumps(out, ensure_ascii=False, indent=2))
```

先用 `sqlite3 -readonly "$QA_CODEX_HOME/memories_1.sqlite" '.schema jobs'` 核对 `started_at/finished_at` 等实际列名及时间单位；若版本 schema 不匹配，保留 schema 差异并修正采集器后重采，不掩盖错误。单 DB 查询一致，两库不是原子快照；若后台正在变化，保留多次快照及采集时间，不能拼成同一瞬间。

回执另保存为 `t1.receipt.json`、`t2.receipt.json` 等，原路径是 `$QA_CODEX_HOME/.flywheel-memory-distill/<executionId>.json`。用 executionId→runner 根 thread→触发 thread 的实际映射做连接，**不能把触发线程当 T1 根线程**。检查文件是普通文件、权限 0600、version/executionId/home 匹配；回执不应包含正文、prompt 或凭据。不要把别的 worker 的 done 行算给本次通道。

```bash
# QA_T1_THREAD 来自 T1 runner 的 onThreadReady/持久映射，不从字符串猜测。
jq -e --arg t1 "$QA_T1_THREAD" '
  (.status == "readable_ready" or .status == "stage1_done") and
  (.expectedButUnclaimed == []) and
  any(.claimed[]; .threadId == $t1 and .after == "done_with_output"
      and .output.present == true)
' "$QA_EVIDENCE/t2.receipt.json"
jq -e --arg t1 "$QA_T1_THREAD" --slurpfile r "$QA_EVIDENCE/t2.receipt.json" '
  any(.memories.jobs[]; .kind == "memory_stage1" and .job_key == $t1
      and .status == "done" and .worker_id == $r[0].triggerThreadId) and
  any(.memories.outputs[]; .thread_id == $t1 and .rawLength > 0
      and .summaryLength > 0 and .rawTemplate == 0 and .summaryTemplate == 0)
' "$QA_EVIDENCE/t2-after.json"
```

另逐条核对全部 hints：每个 job 必须是本 worker、done，有非空 raw/summary 且 `source_updated_at >= input_watermark`。若 `readable_ready`，还必须本 worker phase2 done，全部 hints 的 `selected_for_phase2=1` 且选择水位等于输出水位。SQL done 本身不证明有输出，phase2 done 本身不证明 T1 入选。E3 还需在私有证据里人工查看 T1 正文、确认描述真实任务结论、slug 含 T1 issue 关键词；长度/排除模板只是必要条件。

## 3. 两段式真实任务排程

任务入口沿用房间正常 generalized workflow，使用该房间 `/api/runs/start` 和 slot 自己的身份/认证；请求形状见 `buildGeneralizedStartRequest`（`scripts/lib/qa-generalized-e2e-lib.mjs`）。QA 按自己的授权推进必要设计门到真实 Codex implement。不要直接运行完整 `qa-529-generalized-e2e.mjs --real` 来替代本路书：该 driver 含其他生命周期/PR 步骤，不是本单限定验收。不要手工调用底层触发器替代生产 adapter 路径。

| 时点 | 动作和证据 |
|---|---|
| T1 | 新 keyed 家，真实实现一个有价值的小任务，形成可复用的具体规则/失败修复经验和独有 issue 关键词。正常完成并保留根线程映射、首轮及完成回执。E1：准入回执 `skipped:no_candidates`，T1 后无 memory_stage1；允许 phase2 对空输入 bootstrap。 |
| 冷却 | T1 完成后不向该家派发其他任务。按 DB 最后 `updated_at_ms` 重新计算 ≥1h，并保持 ≤10d。不得改时钟、回写 DB 或伪造更新时间。若 T1 phase2 bootstrap 成功，记其实际 `finished_at`。 |
| T2 优先排程 | 为一次覆盖 E2–E4，选择 `max(T1 最后更新时间+1h, 本家最后 phase2 成功+6h)+余量`，建议余量 2min。派同 project/implement 的第二个真实任务；证明确实复用同家，且不是 resume 同根线程。 |
| T2 首轮 | prompt 只给 T1 主题，不给 slug、关键词答案或原任务正文。要求第一条可见回复先说已知规则和来源；在读文件/搜索工具调用前抓取回复。记录实际收到的全部 prompt，排除隐藏重贴答案。然后正常完成有意义的 T2 任务，以便必要时成为 T3 候选。 |
| T2 结果 | 按 §2 查 E2/E3。只有 receipt=`readable_ready`、T1 选择水位正确、MEMORY.md 存在且含 T1 非模板教训、首轮准确回忆并自述来自 prior-run memory才能记 E4 PASS。`stage1_done` 只证明摘要落库，T2 E4 记未证明。 |
| T3 fallback | T2 仅 `stage1_done` 时，等待 `max(T2 最后更新时间+1h, 本家最新 phase2 成功+6h)+余量` 再派真实 T3。T2 必须有未蒸馏的合格非空根线程，否则 hook 会 `no_candidates`，不能仅等 6h 后凭空强制 phase2。T3 自己的 receipt、worker phase2 和 T1 入选水位都要核对，首轮按同样无答案 prompt 取证。 |

若 T3 仍 partial/timeout/未入选/无输出/限额不足，如实保留失败或待证，不反复无预算派发、不降低限额守卫。T1 已被前次蒸馏，因此 T3 的 hints 通常含 T2 而不含 T1；T3 `readable_ready` 并不能单独证明 T1 这次入选，需单独查 T1 输出选择水位与首轮正文。

attempt 2 更正（Lead 12:5xZ 裁定）：Codex 0.153.2 的 `codex debug prompt-input` 不能判定记忆可读性。QA A/B 三次导出均为 33815 字符且零命中，但移除触发线程的 baseInstructions 覆盖后，phase2 done、T1 selected_for_phase2=1、MEMORY.md 4162B，下一次真实执行首轮完整复述教训并说明来自 prior-run memory。因此 E4 以本 worker phase2 done、T1 选择水位正确、MEMORY.md 存在且含 T1 非模板教训，以及无答案注入的模型首轮回执共同判定；debug 零命中不判 FAIL。

attempt 2 必须使用切号后的 canonical Codex 正式号；保持隔离 CODEX_HOME，不创建或使用 slot 内凭据副本，不动生产 codex-homes。homeKind=legacy 是 attempt 1 QA harness 假象，不要求返工重查。

沿用 attempt 1 的三条限制：全 DAG 未走；school 凭据副本随 teardown 删除；判据 7 使用进程内治理函数。它们是历史证据的限制，不是 attempt 2 创建凭据副本或替代治理 CLI 的许可。其余判据 2–8 引用 attempt 1 证据，明确出处，不声称本轮重跑。

## 4. E5 阴性和 RED 变异

使用另一个干净 slot 项目完成与 T1 等价的真实任务，自然冷却到 ≥1h 且 <6h，尚无 stage1 输出时跑 off 组。这样默认原生 ≥6h 闲置规则不会与 off 判据混淆。若排到 ≥6h，正常 runner 自己也可能触发原生任务；不能把这些后台行误判成 admission hook 调用。

按 Lead 对 question `d2b3af31-0299-4cfb-a916-be8486d51509` 的回复，使用 governed SQLite flag `codex_memory_distill`；原 raw env 开关已从实施合同删除，不能再改 shell env、launch-spec 或 cycle Bridge 来做 E5。flag 默认 ON，registry scope=`project`；查值优先项目行，再 `*` 行，最后默认值。CLI 的 `feature-flags set` **内部先 stage，再带 confirmToken apply**；`feature-flags apply` 是同义命令，不存在独立 `feature-flags stage` 子命令。每次 set/clear 都必须给 reason。

先从自己的 `${QA_SLOT_ROOT}/room-info.json` 导出并核验实际 endpoint；必须显式 `--bridge-url`，CLI 否则可能默认命中生产 `localhost:9876`。不要运行 `feature-flags report` 当只读查询，该命令会 publish/deliver。用 slot DB 的只读 SELECT 查询行，不能直接 UPDATE 绕过审计。

```bash
export QA_ROOM_INFO="$QA_SLOT_ROOT/room-info.json"
export QA_BRIDGE_URL="$(jq -er '.bridgeUrl' "$QA_ROOM_INFO")"
export QA_PROJECT="$(jq -er '.projectName' "$QA_ROOM_INFO")"
python3 - <<'PY'
import json, os
from pathlib import Path
from urllib.parse import urlsplit
root = Path(os.environ['QA_SLOT_ROOT']).resolve(strict=True)
room = json.loads(Path(os.environ['QA_ROOM_INFO']).read_text())
url = urlsplit(os.environ['QA_BRIDGE_URL'])
assert room['slot'] == int(os.environ['QA_SLOT']) and room['generalized'] is True
assert url.scheme == 'http' and url.hostname in ('localhost','127.0.0.1','::1')
assert url.port == room['port'] and url.port != 9876
assert room['projectName'] == os.environ['QA_PROJECT']
assert Path(room['dbPath']).resolve(strict=True) == root / 'teamlead.db'
assert Path(room['flywheelRepo']).resolve(strict=True) == Path.cwd().resolve()
PY
node packages/flywheel-comm/dist/index.js feature-flags set \
  --name codex_memory_distill --to off --project "$QA_PROJECT" \
  --reason 'FLY-2460 E5 owned 529 slot negative control' \
  --bridge-url "$QA_BRIDGE_URL" > "$QA_EVIDENCE/off.flag-apply.json"
sqlite3 -readonly "$QA_SLOT_ROOT/teamlead.db" \
  "SELECT flag_name,scope,has_override,raw_value,last_effective,revision FROM flag_values WHERE flag_name='codex_memory_distill' ORDER BY scope;" \
  > "$QA_EVIDENCE/off.flag-rows.txt"
```

确认 apply 成功且该 project raw=`0`、effective=`false`，保存审计/版本回执；失败即停，不用 SQL 修复。CLI 接受 `--to on|off`，store 编码是字符串 `1|0`，不是 `on|off`。作用时机为 **adapter 构造时读一次**：off 后派发创建新 adapter 的真实 T2，记录其构造发生在 apply 后；已有 adapter/正在跑的任务不会热切换，resume 原 adapter 不合格。不需要服务重启。

off T2：新 executionId 无该 ID 回执、无额外触发 thread/RPC、没有本通道 worker 的 jobs、runner 首轮照常。对比 before/after threads/jobs，证明没有触发 worker；检查全家 jobs 为空不能替代 worker 归因。关掉的是本通道，原生 Codex 后台功能并未关闭。验证既有 adapter 仍保留构造时值、新 adapter 使用新值，避免误报热更新。

在本轮先验证无该项目 override 的前提下，用下面命令清除本轮行，恢复继承；已有 override 则事前记录并按原值 governed set 恢复，不能盲目 clear。清除后核对继承的 `*` 行或默认 ON，再建新 adapter 做恢复检查。标准全局默认也支持 `--project '*'`，但 E5 优先单项目覆盖，避免影响同房其他项目；作用域矩阵用隔离 store 测试证明 `*` off + 项目 on、clear→继承。dependency 注入 `enabled=false` 仍保留测试/调用方控制，不能代替 live CLI 阴性。

```bash
node packages/flywheel-comm/dist/index.js feature-flags clear \
  --name codex_memory_distill --project "$QA_PROJECT" \
  --reason 'FLY-2460 E5 restore original inherited policy' \
  --bridge-url "$QA_BRIDGE_URL" > "$QA_EVIDENCE/restored.flag-apply.json"
```

RED 变异在 QA 独立临时 checkout 执行：把**真实 adapter→runGoal 接线**中的 enabled hook 注入改为缺失，先记录源 diff，build 并保存实际加载 dist SHA256，运行断言 hook 在 runner 首轮前发生的接线测试，必须看到预期 RED；恢复源、重新 build、哈希确认字节恢复、同一测试 GREEN。只改测试/fake 返回值、未 build 的源码或未加载的 dist 均不算变异证据。保留完整命令、退出码、失败断言，不能把无关导入错误算 RED。若另做真机 mutation，必须独立冷却样本、预算登记和相同真实入口；不要改在用 checkout/生产字节。

## 5. E6 成本、延迟与预算

```bash
jq -e '
  .cost.wallMs >= 0 and .cost.wallMs <= 300000 and
  .cost.triggerThreadTotalTokens.availability == "exact" and
  (.cost.triggerThreadTotalTokens.value | type == "number" and . >= 0 and floor == .)
' "$QA_EVIDENCE/t2.receipt.json"
jq '{executionId,status,phase2,cost,startedAt,finishedAt}' \
  "$QA_EVIDENCE/t2.receipt.json" > "$QA_EVIDENCE/t2.cost.json"
```

若配置了非默认 waitBudgetMs，用实际值替代 300000。将触发线程 `threads.tokens_used` 与 receipt 整数比对；unavailable 如实失败 E6，不能填零。rolloutBytes 是输入体积代理，phase2Tokens 未落 DB 的值仍为 unavailable，均不可当精确 token 或金额。列出实验全部真实任务数、各通道 wallMs/trigger tokens、T1/T2/T3 模型成本可用性，避免把等待 6h 记成模型运行 6h。

记录同一时钟的 dispatch、hook entry/exit、runner thread-ready、首次模型 turn-start 时间。对照组基础调度时间应可比；E6 要求开组与关组派发到首轮延迟差为 `wallMs ±5s`。若排队/模型首 token 抖动破坏比较，保留原始时间并记未证明，不用单个 wallMs 代替对照。goal timeout 锚点另外由运行时测试和实际限额/事件证明：hook 耗时加回，首次 active/waiting 上限与基线一致，restart 不再次加回、不重置锚点；不要为验证预算而 kill 生产 daemon。

## 6. 最终证据表与收尾

按 E1–E7 各填 PASS/FAIL/未证明，并附具体 home、executionId、threadId、workerId、UTC、exact SHA、artifact 路径、命令退出码。E4 报告究竟由 T2 还是 T3 证明；若只有 stage1_done，明确“落库成功，首轮可读尚未证明”。E7 固定“无自然人口，本单不证明；未回填、未做受控旧家触发”。

全仓 `pnpm lint`、`pnpm -r build`、`pnpm test:packages:run`、新增 shell 测试及 exact-head code review 属于另外的实施交接证据；不能代替本路书的 529 验收。Lead 批准临时排除 GUI-only 测试，记录具体排除集，不能把排除后的结果称为未修改全 gate。不要运行 `**/tmux-viewer.macos.test.ts`。所有 Vitest 调用串行，使用 `--pool=forks --poolOptions.forks.maxForks=1 --poolOptions.forks.minForks=1`；若包脚本未透传这些参数，先解决入口参数，不能无约束并发运行。完成取证后按 QA 房间的既有 owner/teardown 协议收尾，不触碰生产服务，不自行 dispatch QA successor、merge 或部署。

## 7. Review 补充：积压超过 8 条时的成本边界

本节按 Lead response `633d9903-4650-4a6f-8507-7874df6a4b63` 增补，批量上限统一为 2（上文和 pinned plan 的旧值 8 由此替换）。默认 ON 和 300 秒绝对截止保持不变。

在独立的 529 家中先完成至少 9 条真实交互任务，关闭本通道并按 E5 治理入口操作；等这些任务自然满足 1h..10d 条件。不改 DB 时间戳、不复制生产家、不注入伪造输出。原生后台可能自行消耗候选，所以在开启前用只读查询核对实际合格积压确实大于 8；未达到则记录前置条件未满足，不冒充 PASS。该场景使用独立家，不污染 E1 的空家前提。

通过受管 CLI 开启后构造新 adapter，执行一条真实任务，保留首轮时间、trigger thread/start 配置、回执和本 worker 的 job 行。断言 hints ≤2、`memories.max_rollouts_per_startup ≤2`、本次 worker 的 stage1 claim ≤2，wallMs≤300000；报告实际 token 与准入延迟。对 timeout/partial 如实记录，不以降低批量保证一定可读，也不外推全量积压总成本。后续任务不得被测试路书自动循环派发以排空积压。

测试收尾恢复本 slot 的原 flag 设置。所有操作显式绑定 529 bridge-url；不动生产旧家。只读 WAL 查询可能创建 `-shm`，这是 SQLite 协调文件，不是修改 Codex 表。
