# FLY-2606 不重启配置操作指南 — 实施计划
Issue: FLY-2606 (https://linear.app/geoforge3d/issue/FLY-2606/热生效-founder-2026-09-16-0038z改模板effort-要等重启才生效本来就有问题-工作流模板从仓库种子发布到)
日期: 2026-09-15
基于: plan.md

> 这是实现后的目标操作合同；当前设计文档不证明下列新命令已安装。实施/QA必须填入精确 head 的真实收据后，才能把此页作为生产操作已验证指南。生产改动由 Lead 在 founder 放行时执行。

## 改模板不重启

1. 确认连接的是目标 Bridge。测试时使用隔离实例的 state root/port，不能发布生产 tpl_simple_code。
2. 读 `/api/workflow/templates/tpl_simple_code`（兼容别名 `/api/workflow-templates/tpl_simple_code`），保留当前 revision、digest及想恢复的manifest。准备完整 JSON 文件，只改本次需要的节点参数。
3. 运行下列命令（`$FLYWHEEL_COMM_CLI` 是当前部署注入的 CLI）：

```bash
node "$FLYWHEEL_COMM_CLI" workflow-template publish --template tpl_simple_code --from file --file /tmp/template-candidate.json --reason "调整 implement 思考力度"
```

`--from seed` 发布当前部署编译出的seed；修改开发checkout的seed不会自动改变部署内容。无重启试验应使用 `--from file` 传入已审查的候选。

4. 保存CLI在apply前显示的operationId/requestDigest。成功回执应包含前后revision/digest、actor、reason、committedAt。立即GET核对，再起一个隔离simple_code run，核snapshot与实际implement dispatch。原有run也要核对后续implement保持原参数，不能只看快照未变。
5. 若存在 active 或 held（暂停待恢复）的历史未锁定run，命令返回 `active_run_not_pinned`：等待其结束或由Lead单独治理，不能绕过。CAS冲突必须重新检查变化，再以新的操作发布，不能自动覆盖。
6. 丢响应先查 `workflow-template status --operation-id UUID`；不要生成新的operation重复发布。

回滚：

```bash
node "$FLYWHEEL_COMM_CLI" workflow-template rollback --template tpl_simple_code --revision 3 --reason "隔离验收回滚"
```

把3换成已核验的目标历史revision。回滚生成新版本，可能因旧模型已失效而拒绝；不能直接回写DB指针。Bridge下一次正常重启应保留人工版。这个能力本身的首次部署仍走独立updater。

## 改 Lead effort/model 不重启

本单支持 **Codex常驻Lead**。Claude backend在新热配置入口返回unsupported，旧流程保持明确的restart标签，不宣称热生效。Fleet 管理页接入同一热配置服务后显示 next-turn；服务不可用时只读，不退回重启路径。

```bash
node "$FLYWHEEL_COMM_CLI" lead-config set --project raya --lead raya --effort high --reason "调整下一轮思考力度"
node "$FLYWHEEL_COMM_CLI" lead-config status --operation-id UUID
```

model可用同一命令的 `--model` 修改，但必须与当前backend兼容，且新窗口足够；不跨provider、不改权限/凭据/身份。不接受任意值或静默降档。原生应用前还会检查同一线程最近一次 tokenUsage 的 last.totalTokens、modelContextWindow 和配置固定窗口；累计 total 用量不参与容量比较。缺少有效原生窗口证据或目标模型容量不足时返回 context_window_incompatible，不修改原生设置；若注册表已提交，状态保留 pending_runtime，不能称为 applied。effort 单独修改不需要模型容量切换。Codex 模型容量须由 operator 根据厂商文档填写到 ~/.flywheel/models.json 的 models[].contextWindowTokens 后才允许模型热切换；本 issue 不修改生产 models.json，测试夹具数值不能作为生产依据。

结果分三层：

| 状态 | 意味着什么 | 能否宣称下一轮使用新值 |
|---|---|---|
| registry_committed / pending_runtime | 注册表已保存，进程尚无匹配应用回执 | 不能；exit=2时继续用operationId查，不重启 |
| applied | 同carrier/thread收到匹配settings应用通知 | 后续新turn应使用；这是运行期应用完成点 |
| observed | 实际turn参数与本操作一致 | 可以，保留turnId及model/effort来源证据 |
| drifted | 会话已被另一次操作改变；旧applied/observed仅是历史证据 | 不能；核对实际值，再显式set建立新代际 |
| unsupported / conflict / unavailable | 当前不支持、基线已变或来源不可验证 | 不能；先处理明确原因 |

开始于applied之前的turn可继续用旧值，不中断它。验收必须捕获stable PID、carrier、thread、goal，依次验证router、手动TUI和自动goal续轮；启动env、plist或日志“请求已发”不能作为实际生效证据。

model/effort编辑不改变summary assignment和v1 identity，原summary收据应保持原字节。新命令使用同一projects写锁与CAS，避免裸改、重新签收据或恢复整份文件覆盖并发变更。手工改文件可能被reconcile检测，但没有同步应用完成点；本指南要求受管命令。

回滚用 `lead-config rollback --operation-id OLD_UUID --reason "恢复上一配置"`，生成新操作，只在目标仍匹配OLD的postimage时恢复其旧字段；他人后续修改会使它拒绝。离线/timeout仍返回pending；没有自动restart兜底。

热配置能力安装后，Codex启动与重连始终从已验证registry读取model/effort，覆盖旧manifest/plist加载环境中的这两项；身份、凭据与上下文窗口检查仍严格保留。不需要手工改plist或重启来完成本次配置更新。旧版代码尚未具备这个规则时，新命令必须拒绝写入；回退旧代码前先完成启动carrier兼容核验。

若在TUI手动改变会话设置，status显示drifted，不自动把选择改回；旧操作的observed只证明过去那一轮。确认目标后显式运行set（可填相同值）建立新代际，或按实际选择写回registry。

## 发布前后的职责

实现者交付代码、单测、精确head CI；QA在隔离副本验证模板发布/回滚、Lead更新/回滚各一次和所有turn生产者。设计阶段只提供方案与评审，不动生产、不重启、不声称实际功能已可用。首次功能部署按独立updater窗口；以后配置操作通过上述热路径。

## 外部注册表修改的观测边界

Bridge 周期核对合法的 model/effort 外部修改。已有操作记录作为持久基线；从未受管的 Lead 首次读取只建立基线，不推断启动前的编辑历史。检测到变化后，在共用 cfglock 下重新核对完整文件 SHA、身份、summary 收据和模型注册表版本，生成 external_registry_change 操作并经相同运行时准入应用。审计明确 editorVerified=false，不能据此认定是谁修改了文件。此过程不重写或重新格式化 projects.json，也不修改 summary 收据。删除 model/effort 无可靠原生默认值时不会被自动采纳；非法来源保留 unavailable。
