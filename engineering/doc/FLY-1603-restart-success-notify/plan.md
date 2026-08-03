# FLY-1603 全量重启结束通知 — 实施计划

Issue: FLY-1603 (https://linear.app/geoforge3d/issue/FLY-1603/基建-全量重启成功后不通知-founder-她不知道什么时候能-expect-舰队上线)
日期: 2026-08-02
基于: research.md(v6,折入 Codex design review R1×7 + R2×6 + R3×4 + resume authority review R1/R2 全部意见)

## 0. 一句话

在 `restart-services.sh` 的 `deploy_and_verify()` 尾部收口一个「结束播报点」:凡是**代码已部署**的结束(全净或 degraded),都向 #flywheel-notify(`1521630422918758472`)发一条内容完整、措辞诚实的结束通知;degraded 的 alerts 消息补上失败名单;异常中止由 EXIT finalizer 走既有 alerts 路径补终局,主频道零改动。

## 1. Scope

**做:**
1. 全净结束 → notify 频道 `✅ 完成` 通知:sha 从→到、Lead N/M、Bridge 健康+一次实测延迟、总耗时。Lead N/M 明确按本脚本**实际证明的进程级口径**表达为「重启成功(新本体已起、model 一致)」,不虚称已证明 Discord 可达。
2. degraded 结束(代码已部署但有 Lead failed/skipped/波次失败)→ notify 频道 `⚠️ 结束 — degraded` 通知,如实分账,**整条消息不出现「完成」字样**;alerts 侧 `deploy_degraded` 保留,body 聚合列出 failed+skipped 名单(或波次失败原因)。
3. 同一份数字同步写进 restart 日志;验收测试把 payload 与**独立生产证据**比对(起始日志、deployed-sha 推进日志、Lead status JSON/逐 Lead 日志、测试时钟),不做同一字符串自比较。
4. `set -e` 意外退出或 INT/TERM 若已发 ⏳/🔄 但尚未登记终局,EXIT finalizer 发一次 alerts 终止结果:set-e/SIGTERM 经既有 `alert_severe`,操作员 SIGINT 经既有 `alert_warning`;已由 rollback/abort 路径报告的失败不重复发。
5. 测试满足变异判据:删掉通知调用 → 测试红。

**不做(与 issue 一致):**
- 不改 🔄 开始通知、不改 `deploy_failed` @-mention、不动 `lead-alert.sh` 投递机制、完全失败(rollback/abort/异常中止)路径不新增 notify 消息、主频道(`1516209714097291335`)零新增。
- 不做 P95;按 scope 最低要求做一次实测延迟。

## 2. 变更清单

| 文件 | 变更 |
|------|------|
| `scripts/lib/restart-notify.sh` | **新增**,可 source 的纯函数库(FLY-1507 模式,Bash 3.2-safe) |
| `scripts/restart-services.sh` | 以 `${FLYWHEEL_DIR}/scripts/lib/restart-notify.sh` 绝对 repo 路径 source 新库;记开始时间;`do_restart_all_leads` 暴露 total+名单+波次错误;`deploy_and_verify` 尾部收口播报;degraded alerts body 聚合名单;EXIT finalizer 补异常终局 |
| `scripts/test-restart-services.sh` | lib 单测 + BO 黑盒断言(成功/degraded/组合/频道隔离/变异判据/独立证据比对/EXIT finalizer);并把 Test 27/28 的机器合同 literal 更新为三字段形态 |
| `scripts/__tests__/restart-notify-routine.test.sh` | **必改**(R1#1):Case-4 `routine_sites` 数组逐字锁着旧 `✅ …完成` 调用行——把该条目替换为新收口调用形态 `notify_routine "$completion_msg"`,⏳/🔄 两条保持逐字;注释补政策边界:routine **end-state** 通知(含 degraded ⚠️ 渲染内容)允许走 notify_routine,真正的 alert(⚠️/🚨 字面量调用点)仍禁——既有 `grep 'notify_routine "(⚠️\|🚨)'` 哨兵不变且继续通过(新调用点无字面 emoji) |

**不改(哨兵对照面)**:`notify_routine`/`alert_warning`/`alert_severe`/`fire_meta_alert` 函数本体、🔄 开始消息逐字、`write_leads_restart_status` schema、`scripts/__tests__/restart-services-notify.test.sh`(抽取的是函数定义,不受影响,但纳入本地验证门)。

## 3. 详细设计

### 3.1 新库 `scripts/lib/restart-notify.sh`

纯函数、`rn_` 前缀、零副作用(探测函数除外)、任何输入下**绝不非零退出**;要求产出文本的函数绝不输出空串(R1#6)。所有外部 numeric 参数在进入任何 `(( ))` 前先用 `^[0-9]+$` 校验;非法值降级为 warning/unknown 口径,绝不让 `set -u` 把调用 shell 杀掉:

```bash
# rn_format_duration <seconds>   → "17m03s" / "45s";非法输入 → "unknown"
#
# rn_parse_count <field> <machine_line>
#   → 严格从单行 `field:<非负整数>` 字段取值;缺失/多行/格式异常 → "invalid",恒 rc=0
#
# rn_normalize_lead_names <expected_count> <captured_csv>
#   → expected=0 时输出空;条数匹配时输出 names;不匹配时输出
#     "名单记录不完整(见日志)"并附已捕获 partial names;恒 rc=0
#
# rn_probe_bridge_health <bridge_url>
#   → stdout 恰一行 "ok<TAB><整数ms>" 或 "fail<TAB>-"
#   算法(R1#5 + R2#3,body/timing 分离、单一清理出口、零残留):
#     body_tmp=$(mktemp …) || { echo "fail<TAB>-"; return 0; }
#     t=$(LC_ALL=C curl -sf --max-time 5 -o "$body_tmp" -w '%{time_total}' "$url/health") 成立
#     且 jq -e '.ok == true' < "$body_tmp" 成立
#     且 t 先过数字校验([[ "$t" =~ ^[0-9]+([.][0-9]+)?$ ]])
#     才 ms=$(LC_ALL=C awk -v t="$t" 'BEGIN{printf "%.0f", t*1000}')(R2#3:
#       变量必须 -v 传入,裸 t*1000 输出 0;curl 与 awk 两端均 LC_ALL=C 防小数点 locale)
#     所有分支(curl 非零/非法 JSON/.ok!=true/timing 非数字/awk 失败)汇入同一
#     清理出口:无条件 rm -f "$body_tmp" → 输出 "fail<TAB>-" 或 "ok<TAB>ms",
#     恒 rc=0;sourceable 函数不装全局 trap,清理只靠这一个出口
#
# rn_render_completion_message \
#     <old_sha> <new_sha> <reason> <total> <failed_count> <skipped_count> \
#     <failed_names> <skipped_names> <lead_result_state> <lead_result_detail> \
#     <bridge_state> <bridge_ms> <duration_str>
#   lead_result_state=known|wave_not_run|unreadable;任何分支输出非空多行消息
#   Bash 3.2 要求函数开头把 13 个位置参数逐一绑定成命名 local;第 10-13 项必须用
#   `${10}`…`${13}`,后续逻辑不再直接访问位置参数。
```

渲染规则(锁死措辞,测试逐条断言):

- **全净且 bridge ok**(**total>0**、failed=0、skipped=0、lead_result_state=known、bridge_state=ok —— R3#1:`total>0` 是 ✅ 的必要条件,与 no-candidates 分支互斥,分支顺序无关):

```
✅ Flywheel 全量重启完成 (reason=<reason>)
版本: `<old7>` → `<new7>`
Lead: <N>/<M> 重启成功(新本体已起、model 一致;未单独探测 Discord 可达性)
Bridge: healthy (/health 实测 <ms>ms)
总耗时: <duration>
```

- **degraded**(failed>0 或 skipped>0 或 lead_result_state!=known):首行 `⚠️ Flywheel 全量重启结束 — degraded (reason=…)`;Lead 行分账,末行 `详情见 #flywheel-alerts`;**整条不得含「完成」与 ✅**:
  - 常规:`Lead: <M> 个里 <N> 个成功、<X> 个失败: <failed_names>[、<Y> 个跳过(无 manifest): <skipped_names>]`,N = M − failed − skipped;
  - **波次未执行**(`lead_result_state=wave_not_run`,只来自 convergence/mktemp/inventory 三个 producer 早退):`Lead: 重启波次未执行(<detail>),Lead 总数未知`;sidecar 丢失时 detail=`原因记录失败,见部署日志`,不出现空括号;
  - **结果不可读**(`lead_result_state=unreadable`,producer 已运行但 stdout 合同解析失败):`Lead: 重启结果无法读取(统计合同解析失败),请查部署日志`;**绝不写「波次未执行」,也不伪造某个 Lead 失败**。
- **bridge 探测 fail**(不论 Lead 结果):首行降为 ⚠️(全净时:`⚠️ Flywheel 全量重启结束 — Bridge 复测异常 (reason=…)`),Bridge 行写 `Bridge: ⚠️ /health 结束时刻探测失败`(R1#4:措辞避开「完成」,不与 degraded 负向断言自相矛盾)。
- **no-candidates**(R2#2,合法路径:inventory 成功但为空,`restart-services.sh:1387-1391` 只 WARNING、零失败):`total=0 且 failed=0 且 skipped=0 且 lead_result_state=known` → 首行 ⚠️ 结束、Lead 行 `Lead: 未发现可重启候选(0)`,全文无「完成」—— **绝不渲染 `✅ 0/0 重启成功`**。
- **名单规范化与缺失降级**(R2#4+R3#3):join 前按 bucket 分别核对 sidecar 行数与计数 —— `failed` 行数 ≠ failed_count 或 `skipped` 行数 ≠ skipped_count(全空或部分写失败)→ 该 bucket 渲染 `名单记录不完整(见日志)`(已捕获的 partial names 附在其后),**绝不把不完整名单冒充完整名单、绝不渲染空列表**;规范化结果由完成消息与聚合 alert **共用**(同一份规范化输出,两处不各自拼装)。
- **first-run**(R1#7,`$DEPLOYED_SHA` 为空是合法路径,`restart-services.sh:586-590`):old 段渲染 `(首次部署)`,不出现空反引号。
- 首行状态、sha、N/M(或波次失败/无候选说明)、耗时四要素在任何形态下必须齐全。

### 3.2 `restart-services.sh` 改动

1. **计时**:`SCRIPT_START_EPOCH=$(date +%s)` 固定放在文件头 `set -euo pipefail` **紧后面**,早于 env load、plugin 检测、project scan、idle wait;总耗时就是 founder 从触发脚本到终局的 wall-clock,不从文件尾「Main」注释处起算。
2. **名单文件**:仿 `PROJECT_SHA_UPDATES_FILE` 先例,顶层先声明两个 sidecar 路径为空,取得 restart lock 并安装 EXIT trap 后才 `mktemp` 分配(实施期 code review 补强:lock contention 早退不得遗留 temp);纳入 EXIT trap 清理。行格式 `failed\t<key>` / `skipped\t<key>` / `wave_error\t<原因>`。**sidecar 写入合同**(R2#4):所有 append 一律 guarded(`{ printf … >> "$FILE"; } 2>/dev/null || true`)——`do_restart_all_leads` 在 command substitution 里执行,Bash 3.2 的 errexit 语境不可依赖;记录失败绝不中断机器合同输出,只导致完成消息按「名单缺失降级」规则如实说明。
3. **`do_restart_all_leads`**:
   - 新增 `eligible` 计数(candidate_count 减 `skip-test`);
   - `restart` 分类下的**manifest 在 inventory 后变得缺失/不可读**与 `restart_lead` 非零两支都追加 `failed\t$key`;`config-drift`、`probe-error` → 追加 `failed\t$key`;`manifestless` → `skipped\t$key`;
   - **三个早退分支**(convergence `:1315-1328`、mktemp `:1334-1338`、inventory `:1340-1350`)输出 `skipped:0 failed:1 total:0` 并追加 `wave_error\t<convergence 失败|候选清单分配失败|清单收敛失败>`(R1#2);
   - 正常路径 stdout 扩为 `skipped:N failed:M total:K`;名单绝不进 stdout(`failed_keys:` 会踩 `failed:` 贪婪匹配)。消费侧不再用 non-match 仍 rc=0 的贪婪 sed 假定成功,统一走 `rn_parse_count`;用独立 `lead_counts_known=true|false` 表达统计可信度。任一字段缺失/多行/非法即设 `lead_counts_known=false`、`lead_result_state=unreadable`,渲染「结果无法读取」而非谎称波次未执行,不可能误走 ✅。未知时保留 plugin marker;现有 status schema 只有 numeric counts、无法诚实表达 unknown,所以**不覆盖旧 status 文件**并写 ERROR log,绝不拿 `0`/`1` 伪造计数。
4. **`deploy_and_verify` 尾部收口**(替换 `:1590-1607` 三分支的播报部分):
   - 数据采集全部**先赋默认值再 guarded 覆盖**(R1#6):`bridge_state=fail; bridge_ms=-; duration_str=unknown; total=0; failed_names=""; …`;三项计数经 `rn_parse_count` 逐项 regex 复核后才进入 arithmetic/render,探测/解析失败保持诚实降级,不触发 `set -euo pipefail`;顺序锁死为 **先做 completion Bridge probe,再读取结束 epoch 计算 duration**,使总耗时包含实测延迟,测试 clock shim 不依赖额外调用顺序;
   - `completion_msg=$(rn_render_completion_message … 2>/dev/null) || completion_msg=""`;为空时用**最小诚实 fallback**:`⚠️ Flywheel 全量重启结束 (reason=…) — 播报组装失败,数字见部署日志。版本: <old> → <new>` + `log ERROR` + `fire_meta_alert completion_render_failed`;**绝不发送空消息、绝不静默丢失**;
   - `log "$completion_msg"`(同数字进日志)→ `notify_routine "$completion_msg"`;
   - **degraded tail alert 聚合**(R1#4):现结构 failed>0 先 return,failed+skipped 并存时 tail alert 丢 skipped 名单。仍只保留**一个现有 tail alert 位点**(不新增 tail 消息数),body 按非零 bucket 同时列出 `失败: <names>` 与 `跳过(无 manifest): <names>`;`wave_not_run` 列 `波次错误: <detail>`,`unreadable` 列 `结果错误: 统计合同解析失败`;现有 per-candidate alerts 原样保留(不改已验证行为),因此部分名字会同时出现在 per-candidate 诊断与 deploy-level summary,这是有意的 summary 层重复而非新增 alert 风暴;测试锁定每个 run 仍只有一个 tail summary;
   - **实施期 Lead 澄清(2026-08-02)**:completion Bridge probe 失败、或 `total=0` 未发现任何 Lead 候选,语义上同属 degraded,必须进入上述同一个 alerts tail 位点;与 Lead failed/skipped 并存时仍合并为整场唯一 summary,不得多发第二条,Core 仍零消息。§3.2.4 原枚举未写这两支是枚举缺口,不是有意排除;
   - **plugin marker 谓词精确保持**(R1#3,现状是 `leads_failed == 0 → rm -f PLUGIN_RESTART_PENDING`,含 skipped-only 也清,`:1590-1604` 顺序决定的,不是「全净才清」):只在 `lead_counts_known=true` 时按 `(( leads_failed == 0 )) && rm -f "$PLUGIN_RESTART_PENDING"`;统计不可读时保留 marker,绝不让默认 0 误清;
   - `lead_counts_known=true` 时 `write_leads_restart_status`、`return 0` 语义不动;false 时因既有 schema 无 unknown 表达而跳过 status write、保留旧文件并记 ERROR,以 sidecar/log/终局通知承载未知状态。
5. **终局 finalizer**(恢复 founder 更正后明确保留的 exactly-one 终局纪律):
   - 顶层状态 `RESTART_NOTICE_STARTED=false`、`RESTART_TERMINAL_REPORTED=false`、`RESTART_EXIT_SIGNAL=""`;在 ⏳/🔄 任一 routine progress notice 前置 started=true。
   - **只在 parent shell terminal 点登记**,明确枚举:deploy port-stuck parent branch;rollback 的 no-known-good / dirty / rollback-port-stuck / rollback-result-unreadable / rollback-leads-failed / update-rolled-back / update-and-rollback-failed 七个结果;成功/degraded tail 在 notify + tail alert 尝试完成后登记。`bp_fail_loud`、`do_restart_all_leads` 内 per-Lead/per-candidate alerts 都在 command-substitution subshell,不得在那里改 flag;restart-status-write/plugin/idle-timeout 等 continue 型告警也不得登记。
   - 现有 trap 改为 `trap 'restart_on_exit "$?"' EXIT`;handler 第一行 `trap - EXIT INT TERM` 防递归,把传入 rc 保存为 local 后立即 `set +e`。若 started=true 且 terminal=false,**先发终局再 cleanup**:SIGINT 用 `alert_warning restart-cancelled-by-operator`(不 @ founder,正文「操作员取消,状态未知」);SIGTERM 或普通异常 rc 用 `alert_severe restart-aborted-unexpectedly`(含 7 位 from→to SHA、reason、截至退出总耗时、原 rc,明确「异常终止,状态未知,见部署日志」)。最后 `rmdir`/两个 `rm -f` 每一项均 `|| true`,显式 `exit "$original_rc"`;cleanup 失败绝不能跳过通知或改写 rc。
   - `trap 'RESTART_EXIT_SIGNAL=INT; exit 130' INT`、`trap 'RESTART_EXIT_SIGNAL=TERM; exit 143' TERM` 只标来源并交给 EXIT 单次收口。finalizer 不发 notify、不触主频道;正常成功/degraded、已报告 rollback/abort 都因 terminal=true 不重复发。
6. **rollback 路径兼容**:`rollback_and_restart` 不发 notify;它用 `rn_parse_count failed` 读取扩展合同。非法时不伪造「1 个 Lead 未恢复」,改走独立 severe terminal `rollback-lead-result-unreadable`(正文「回滚后的 Lead 结果无法读取,恢复状态未知」,@-mention 是保守 fail-close),并登记 terminal=true。新 `total:`/sidecar 对其余 rollback 行为透明。

## 4. 测试计划(TDD,先红后绿)

### A. lib 单测(source 真库,零拷贝;落 `scripts/test-restart-services.sh`)

1. `rn_format_duration`:`45→"45s"`、`1023→"17m03s"`、非法→`"unknown"`。
2. `rn_parse_count`:三字段正常行逐项取值;缺字段、重复字段、多行/stdout 污染、负数/非数字均返回 `invalid` 且 rc=0。Test 27/28 的 literal 同步改为 `skipped:N failed:M total:K`,真实执行新增字段与旧解析兼容性。
3. `rn_probe_bridge_health`(R1#5+R2#3,fake curl/jq 注入 PATH):ok(body/timing 分离正确、ms 取整非零——抓 awk 变量未传的 `0ms` 回归)、`.ok=false`→fail、非法 JSON→fail、curl 非零→fail、**timing 非数字→fail**、comma-decimal locale 仍因 curl 自身 `LC_ALL=C` 输出点号;所有分支 rc=0、恰一行输出、**调用后无残留 temp file**(断言探测前后 mktemp 目录差集为空)。
4. 渲染-全净:含 ✅、两个 sha、`7/7 重启成功`、进程级证据边界、`实测 …ms`、`总耗时`;**不含「全部上线」**。
5. 渲染-degraded(failed+skipped 组合):含 ⚠️、`7 个里 4 个成功、2 个失败: a, b、1 个跳过(无 manifest): c`、`详情见 #flywheel-alerts`;**不含** ✅ 与「完成」。
6. 渲染-波次失败(`lead_result_state=wave_not_run`):含 `重启波次未执行`、`Lead 总数未知`;**无负数、无空名单、无「完成」**。另测 `lead_result_state=unreadable`:只写 `重启结果无法读取`,绝不出现「波次未执行」或伪造失败数。
7. 渲染-bridge fail:首行 ⚠️ + `结束时刻探测失败`;同时全净字段仍齐。
8. 渲染-first-run:old 段为 `(首次部署)`,无空反引号。
9. 渲染防御:在独立 `set -u` shell 中传入带空格/冒号/负数/空值的非法 numeric 参数,仍输出非空、rc=0、父 shell 不退出。
10. **渲染-三重组合**(R2#5,failed+skipped+bridge-fail 同时):degraded 首行 + 两个名单 bucket 都在 + `结束时刻探测失败` 行 + 全文无「完成」无 ✅。
11. **渲染-no-candidates**(R2#2):total=0 全零 → ⚠️ + `未发现可重启候选(0)`,无「完成」。
12. **渲染-名单规范化**(R2#4+R3#3,四个子例):(a) failed=2、failed 行 0 条 → `名单记录不完整(见日志)`;(b) failed=2、failed 行仅 1 条(partial)→ `名单记录不完整(见日志)` + 已捕获的那 1 个 key,不冒充完整;(c) skipped=1、skipped 行 0 条 → skipped bucket 同样降级,不渲染空列表;(d) total=0/failed=1 但 wave_error sidecar 丢失 → `原因记录失败,见部署日志`,不出现 `()`。聚合 alert 走同一份规范化输出(断言两处文本一致)。

### B. BO 黑盒(真跑脚本;夹具升级为可执行合同,R1#5)

前置夹具改造:
- **拷贝清单补 `scripts/lib/restart-notify.sh`**(R2#6:BO 只拷贝列出的 lib,`test-restart-services.sh:1381-1385`——漏拷则 BO 在 source 时直接崩);
- `bo_run` 的 notify env 从硬置空改为**可参数化**(默认保持空以不动既有用例;新用例传 fake token + fake 频道 id);
- curl shim v2:按 argv 区分 —— 含 `/health` 的 GET 输出 `{"ok":true,…}` 且在 `-w` 在场时按真 curl 语义把 timing 写到 stdout(`-o` 在场时 body 落文件);含 `discord.com/api` 的 POST 记录完整 URL+payload 到 `curl.calls`。completion probe 到达时由 shim 把测试 epoch 文件从固定 T0 改为固定 T1;
- date shim 只对 `date +%s` 返回 epoch 文件当前值,其他三类调用(`date '+%Y…'`、`date -u +%Y%m%d…`、`date -u +%Y-%m…`)全部原样委托 `/bin/date`;它不按调用次数递增,耗时 oracle 不受日志行数影响;
- BO_FLYWHEEL fake repo 植入**录参版 `scripts/lead-alert.sh`**(记录 argv+body 到 calls 文件)。

用例(结束消息按首行 ✅/`⚠️ Flywheel 全量重启结束` 特征从 POST 流里**筛选**——R2#1:🔄 开始通知保留,正常 run 的 routine POST 恰两条):
12. 成功 run(notify env 配好、fake `date` 提供独立确定性时钟)→ **恰两条 routine POST**:一条 🔄 start(逐字不变)+ 一条 ✅ end;end payload 的 old/new sha 分别对照独立 `Starting full restart` 与 `deployed-sha updated` 日志,N/M 对照 candidate fixture + `leads-restart-status.json`,耗时对照 fake clock 差值,不是与 `log "$completion_msg"` 自比较。**变异判据落点:删收口调用 → 只剩 start、无 end,本条红。**
13. degraded run(复用 `FAKE_LEAD_SESSION_DEAD=1` 先例,:1637)→ end POST 含 ⚠️ + 失败 lead key、无 ✅ 无「完成」;lead-alert 录参的 deploy-level tail body 含同一 key,且该 run 只有一个 tail summary(现有 per-candidate 诊断另计,调用数不因本单增加);**marker 哨兵**:failed run 后 `plugin-restart-pending` 保留(R1#3)。
14. skipped-only run → marker 被清除(R1#3 反向哨兵);聚合 alert 录参 body 含跳过名单。
15. **wave-error producer 双证**(R2#4):(a) convergence-fail —— BO 植入 `exit 1` 版 `converge-flywheel-bin.sh`;(b) inventory-fail —— 写坏 `BO_HOME/.flywheel/projects.json`。两例分别断言:stdout 机器合同仍可解析、end POST 与聚合 alert 含非空波次原因、marker 保留、无负数/无空名单/无「完成」。
16. **no-candidates producer**(R2#2+R3#1):真造出 M=0 —— 同时移除 manifest **与** `com.flywheel.lead.flywheel-eng.plist`(BO fixture `:1491-1501`),并把 launch state 置为 proven-unloaded、legacy process source 为空(`bo_run` 每次会重置 state 为 loaded,`:1503-1507`,本例需覆盖该重置);断言走的是 no-candidates 渲染(`未发现可重启候选(0)`,⚠️ 非 ✅)而**不是** manifestless→skipped-only;用例结束后恢复 fixture。
17. 计数来源(R1#7):fixture 含 1 个生产 Lead + 1 个 `skip-test` 测试槽 candidate → M 不含 skip-test。
18. 频道隔离:上述 run 中 shim 录到的 Discord POST 目标恰为 fake notify 频道;显式断言 core 主频道 id `1516209714097291335` 与真 notify/alerts 频道 id 零出现(BO 内全是 fake id,真频道 id 出现即为硬编码泄漏)。alerts 频道**真实路由**不由 BO 假 lead-alert 证明,由既有 `qa-fly1081-notify-identity.test.sh`(驱动真 lead-alert.sh)持续覆盖 —— 组合引用,不重复建设。
19. best-effort 合同(R1#6+R2#6+R3#2,**两个子例、两种不同预期,绝不混用**):
    (a) **completion-probe fail**:argv-aware/stateful curl shim —— 让 `:1528-1555` 的强制 health gate 正常通过(否则 deploy 直接 rollback、按 scope 本就无 end notify),只让带 `-o`/`-w` 的结束时刻 probe 失败 → 断言 deploy rc=0、end POST 为 `Bridge 复测异常`/`结束时刻探测失败` 形态(这是 renderer 的正常分支,**不是** fallback);
    (b) **renderer fail**:把 BO_FLYWHEEL 里 copied 的 `restart-notify.sh` 渲染函数替换为 `return 1`(用例后恢复,不向生产代码加故障注入 seam)→ 断言 deploy rc 不变、end POST 为非空 fallback(含「播报组装失败」),绝无空 POST。
20. **终局 finalizer**:(a) start 后注入一个未被预期分支处理的非零退出 → 恰一次 severe `restart-aborted-unexpectedly`、原 rc 保留、无 end notify、无 core POST;(b)让 lock `rmdir` 与 temp `rm` 各自失败,terminal alert 仍先发且 rc 仍是原值;(c)SIGINT 只发一次 warning `restart-cancelled-by-operator` 且 rc=130、无 founder mention,SIGTERM 只发一次 severe 且 rc=143;(d)现有 port-abort 与六个 rollback 终局在 parent shell 登记 → finalizer 不发第二条;特测 `bp_fail_loud` 子 shell flag 不传播时由 parent port-abort 正确登记;(e)⏳ idle notice 后异常退出也 started=true 并收口一次。
21. 哨兵:🔄 开始消息逐字不变;`deploy_failed` 路径(既有用例)不新增 notify POST。

### C. 既有哨兵测试更新(R1#1)

22. `scripts/__tests__/restart-notify-routine.test.sh` Case-4:`routine_sites` 的 ✅ 条目 → 新收口调用形态;⏳/🔄 逐字保留;⚠️/🚨 字面量 grep 哨兵不动(新调用点无字面 emoji,继续通过);注释写明「routine end-state 通知允许走 notify_routine;alert 语义仍必须走 alert_warning/alert_severe」。

### D. 全仓门

`pnpm lint` + `pnpm -r build` + `pnpm test:packages:run` + `bash scripts/test-restart-services.sh` + **FLY-1081 全组**:`bash scripts/__tests__/restart-notify-routine.test.sh && bash scripts/__tests__/restart-services-notify.test.sh && bash scripts/__tests__/update-flywheel-queue.test.sh && bash scripts/__tests__/simba-grep-zero.test.sh && bash scripts/__tests__/qa-fly1081-notify-identity.test.sh`(ci.yml:444-459 同款)。

## 5. 部署与验收

- 纯 shell(`scripts/` + `scripts/lib/` + `scripts/__tests__/`),不碰 Bridge runtime:**merge 后生产 `git pull` 即生效**,下一次 restart 运行的就是新脚本;无需为本单重启 Bridge。
- 行为面验收(implement/QA 节点执行):
  1. 跑一次成功 restart → notify 频道收到完成通知,Lead 数/sha/耗时与 `/tmp/flywheel-restart-*.log` **逐字段一致**;
  2. 跑一次 degraded restart → alerts 消息明确列失败名单,notify 消息为 ⚠️ 且全文不称「完成」;
  3. 主频道零新增消息(显式核对);
  4. 变异判据:临时注释收口调用 → 测试 B12 必红(QA 亲证后还原)。

## 6. 风险与回滚

| 风险 | 处置 |
|------|------|
| 新增探测/渲染代码在 `set -e` 下挂掉 deploy | 默认值先行 + guarded 覆盖 + 库函数恒 rc=0;B19 真跑守护退出码 |
| founder 通知静默丢失(比挂掉 deploy 更隐蔽) | 渲染失败 → 非空诚实 fallback + meta-alert;B19(b) 断言非空 |
| stdout 合同污染导致算术/`set -u` 中止或误判 ✅ | `rn_parse_count` 严格单行字段解析 + renderer numeric regex 预校验;非法合同 fail-closed 为 `unreadable` 状态;A2/A8 与 BO parse-error 双证 |
| EXIT handler 自己被 `set -e`/cleanup 错误杀掉 | handler 入场撤 trap + `set +e`;终局先于 cleanup;每个 cleanup `|| true`;原 rc 显式入参/显式退出;B20(b) 故障注入 |
| 操作员 Ctrl-C 造成 founder severe 误报 | SIGINT 单独 warning 且不 mention;SIGTERM/未知异常才 severe;B20(c) 双向锁定 |
| 既有 CI 哨兵打红 | Case-4 更新纳入变更清单(§2);FLY-1081 全组进本地门(§4D) |
| plugin retry 语义漂移 | marker 谓词显式 `failed==0 → clear` + B13/B14 双向哨兵 |
| 通知刷屏 | 每次已发 ⏳/🔄 的 run 恰一个 terminal outcome **decision**:成功/degraded 各一个 notify end;失败走既有 alerts;异常仅在尚无 parent-shell terminal 记录时 finalizer 一次。degraded 的 per-candidate 诊断 + 一个 deploy-level tail summary 数量与现状一致,不新增第二个 summary |
| 回滚 | 单 PR、纯 shell,revert 即回到现状;不涉及数据/schema |

## 7. 与前一版设计的关系(供 implement 节点与 Tadashi 知悉)

分支上另有第一版 design(`engineering/doc/FLY-1603-restart-founder-notify/`,初稿落点为 founder 主频道,经 founder 纠正后留有 `design-correction.md`)。**本 plan 为权威版**(基于重写后的 issue 文本、当前 main、昨夜真实日志的全新审计 + Codex 4 轮 APPROVED);前版文件夹已加 SUPERSEDED.md 指针,保留作历史。

两版一个实质分歧:**degraded 结束时 notify 频道发不发**。前版读法 = degraded 只进 alerts;本版读法 = notify 也收一条 ⚠️ 结束通知(不含「完成」,指路 alerts)—— 依据是重写后 issue Scope 第 1 条的括号原文「degraded 时如实写『M 个里 N 个成功、X 个失败』,不许只报成功数」,该要求描述的正是完成通知本体。若 Tadashi/founder 裁决取前版读法,只需删收口点的 degraded→notify_routine 一支,其余设计不受影响。

前版更正记录明确保留的 **EXIT finalizer / terminal outcome 不静默** 已折回本版 §3.2.5,不再列 follow-up。仍留两项显式 follow-up 候选(不折入本单):
1. **消息 2000 字符预算纪律**(Discord 上限;本版按现役 15 个非 test manifest 估算最坏 degraded 消息 <900 字符,有余量,故不建机制);
2. **/health 5 次采样取中位数**(本版按 issue 最低要求做单次实测)。
