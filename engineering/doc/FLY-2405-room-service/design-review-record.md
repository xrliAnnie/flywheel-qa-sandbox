# FLY-2405 起房服务 — 设计评审记录
Issue: FLY-2405 (https://linear.app/geoforge3d/issue/FLY-2405/载体起房服务-codex-runner-在沙箱里起不了-529-测试房launchctl-bootstrap-eio-看不到沙箱外进程)
日期: 2026-09-26
基于: plan.md

- 评审器:Codex companion,manifest 指定模型 `gpt-6-astra`,effort `xhigh`,同一线程 `01a0de3e-a749-7d73-a4fc-8a1178659cb1`。
- 轮次:R1 CHANGES REQUESTED(6 阻断 + 2 建议)→ R2 CHANGES REQUESTED(4 阻断 + 2 建议;R1 6 条中 5 条关闭、1 条部分)→ R3 **APPROVED**(0 阻断 + 2 建议)。
- 中途:第一次 R2 撞 Codex 额度(报 Lead,未切号未换模),Lead 15:31Z 恢复额度后原线程续跑。
- 范围追加:Lead 指令(Linear 评论 1ae93545)的「带告警值守的房」在 R2 并入(§10b / C7),R2 与 R3 都按新增内容审过。

## R3 建议项(批准后记录,不改已批准的 plan 正文;实现时落实)

1. **快照重试的完整包装器用例**:若 test-teardown 已删除 `SLOT_DIR`、包装器在写收据前退出,新 attempt 会先因必需库缺失落 `snapshot_failed`。恢复路径是 owner 带 `skip_snapshot=true + reason`;实现时在 `status` 里提示这一恢复方式,并可引用上一次已成功发布的快照目录。C3/C4 补完整包装器用例:旧证据保留、最终释放成功。**不**把普通房间的必需库缺失自动视为可跳过。
2. **旧 repair-token 旁路的混合配置回归**:`test-deploy.sh:1142` 读取的 `repairBotTokenEnv` 与 `:1167` 的显式注入分支也要受测试 bot 白名单约束;C7 增加「`dispatcherSlot` 合法、但遗留 `repairBotTokenEnv` 指向生产变量」组合测试,断言该值被拒绝/排除,不进入 Bridge 环境与网络预检。

## v2 增量评审(2026-09-26 重派:服务代跑 529 generalized e2e driver,§10c / C8)

- 评审器:Codex companion,manifest 指定模型 `gpt-6-astra`,effort `xhigh`,新线程 `01a0deb8-8881-7fd1-8734-b35ff978cf81`(范围仅 v2 增量,v1 正文不重审)。
- 轮次:R1 CHANGES REQUESTED(3 阻断 + 2 建议)→ R2 CHANGES REQUESTED(1 阻断:R1 #2 空 env 分支)→ R3 **APPROVED**(0 阻断、0 建议)。
- 关闭的问题:
  1. driver `timeout_ms` 是逐阶段预算,原「`timeout_ms + 5 min`」会误杀 ⇒ 改为独立服务安全上限 `phase_bound × timeout_ms + 15 min`,落库、重启不重置。
  2. strength-two 复跑配方表达不了 Codex runner 房 / 非 main fixture / reply 开关 ⇒ drill 只接受合同可完整表达的配置(含显式 `TEST_REPLY_BY_ISSUE=1`),服务用 `validateRerunSpecV1` 生成并返回 `rerun_spec`;Codex runner 房 drill 有意拒绝,扩展合同列 follow-up。
  3. 对外结果缺 `evidence_copy` ⇒ 补齐,只有 `ok` 才给 `evidence_copy_dir`。
  4. (建议)`room wait --operation` 绑定目标操作;(建议)C8 文件清单补 `qa-room-runtime.ts`、顺序统一、验收判据写实、HOME 探针改称已知故障守卫。
- 过程备注:首次调用 companion 时误把 `--help` 当任务发出一轮(问答型,无仓库写入,线程 `01a0deb7-41b6-…`,不计入评审轮次)。
