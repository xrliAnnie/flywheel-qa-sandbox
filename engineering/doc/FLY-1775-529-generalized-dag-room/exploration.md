# FLY-1775 529 隔离房补 generalized-DAG 能力 + 装房路书固化 — 探索

Issue: FLY-1775 (https://linear.app/geoforge3d/issue/FLY-1775/infra-529-隔离房补-generalized-dag-能力-装房路书固化14-条实测坑位收编)
日期: 2026-08-14
基于: 无(上游素材 = FLY-1768 全套文档 + issue 正文 14 条坑位清单)

## 1. 病(实测复核,非转述)

FLY-1768 在 529 隔离房跑 generalized workflow 九步活体演练,装房阶段全部靠手工:

1. **workflow flag 0/5** — 隔离房 Bridge 起来时不带 5 个 workflow env flag
   (`FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES/TEMPLATE_DISPATCH/CLAIMS_READ/CLAIMS_WRITE/GATE_CARRIER`,
   FLY-1768 research §4 从生产活进程逐字取样)。generalized dispatch 根本进不去。
2. **`workflow_category_binding` 0 行** — 生产 5 行(`code→tpl_code` 等,
   `updated_by=system:fly-1436-cutover`);隔离房 StateStore 是全新库,没人种。
   FLY-1768 的做法是「停 Bridge → sqlite3 手工 INSERT → 起 Bridge」,
   且必须在 Bridge 首次 boot 之后(外键指向 boot 时 seed 进库的 `workflow_template`)。
3. **slot config 无 `pipeline.dag: true`** — `qa_multilead_config_yaml`(scripts/lib/qa-multilead.sh:71)
   生成的沙箱 `.flywheel/config.yaml` 没有 `pipeline:` 段;run-start 现读该键,
   不带就不进 DAG 路径。
4. **唯一 generalized e2e 驱动被 FLY-1693 退役** — 每个要做活体演练的 QA 都得
   像 FLY-1768 那样用「最小真单」手工驱动,九步逐步取证。
5. **14 条装房坑位散落在三个 QA 体的记忆/报告里** — 没有一份固化路书,
   每个新 QA 都要重新踩(FLY-1768 甚至又踩出 2 条新坑:依赖未装、DEPT_SCOPE 403)。

## 2. 目标形态(验收倒推)

新开 QA 单要跑 generalized 活体演练时:

```
cd <被测 worktree>
TEST_REPLY_BY_ISSUE=1 scripts/test-deploy.sh <slot> --generalized [--no-lead]
```

一条命令起房即可用:零手工 SQL、零 env 手调;然后一条驱动命令把 FLY-1768 的
九步演练在新房上重放通过。

## 3. 方案空间与取舍

### 3.1 workflow flag 注入位置

- **A(选)**:`--generalized` 时把 5 个 flag `=1` 追加进 `BRIDGE_EXTRA_ENV`
  (Runner 由 Bridge spawn,继承 Bridge env;与 `FLYWHEEL_FOUNDER_ATTRIBUTION_GATE=0`
  同一注入模式,test-deploy.sh:771)。同时追加进 `LEAD_EXTRA_ENV` 保持 Lead 侧一致。
- B:让操作者自己 export — 就是现状,被否(违背「零 env 手调」验收)。
- C:默认所有房都带 flag(不加 `--generalized` 开关)— 被否:现有 QA 套件
  (FLY-60 driver、各 smoke)在无 flag 房间上校准过,默认改变行为面违背
  byte-compat 纪律(qa-multilead.sh 顶部的 BYTE-COMPAT CONTRACT 是同一精神)。

### 3.2 `workflow_category_binding` 初始化方式

- **A(选)**:Bridge 起来并过 `/health` 后,test-deploy.sh 用 `sqlite3`(带
  busy_timeout 重试)对 slot 自己的 StateStore INSERT 生产同形 5 行,
  `updated_by` 写诚实来源(如 `system:test-deploy-generalized`,**不冒充**
  `system:fly-1436-cutover`)。是否需要「INSERT 后重启 Bridge」取决于绑定是
  boot 读还是 run-start 现读 —— research 阶段以代码定案,现读则免重启。
- B:预先建库种行再起 Bridge — 被否:要复刻 boot 迁移/seed 逻辑,双份真相。
- C:走 Bridge 管理 API(founder rebind action)— 若存在合适端点则优于裸 SQL
  (走校验 + 外键 + 审计);research 阶段查实。若端点属 founder-only reserved
  action,在隔离房伪造 founder 身份违背
  `feedback_no_impersonate_founder_session_for_access_control`,则回落 A。
- 风险核查项:FLY-1693 的 boot CAS 解绑只针对旧 system-owned 绑定
  (指向已退役模板);新种的行指向幸存 5 模板,必须核实不会被下一次 boot 解绑。

### 3.3 `pipeline.dag: true` 写入

- **A(选)**:`qa_multilead_config_yaml` 加可选参数(如第 2 参 `dag=1`),
  `--generalized` 时生成 `pipeline:` 段;无参输出 byte-identical(既有
  test-deploy-multilead.test.sh A1-A3 守卫继续绿)。

### 3.4 装房路书 + 预检的分工

原则:**能自动化的坑直接在脚本里堵死;只能靠人的坑进 preflight fail-loud 或路书**。
14 条坑逐条归类(详见 research §坑位矩阵):
- 脚本自动堵:短 TMPDIR、ambient roundtable env、ambient ALERT_SENDER_TOKEN_ENV、
  sandbox clone stall(增速看门狗 + 重试)、teardown cmux lease 重试。
- preflight fail-loud(带修复指令):依赖未装/dist 过期(已有,改错误文案点名
  `pnpm i --frozen-lockfile` + `pnpm -r build`)、告警频道 bot 邀请矩阵探针、
  被测 worktree 硬门(`--expect-head` 可选参数 + 部署后 `/health` buildSha 校验)。
- 路书条目(操作者决策类):无 Runner 演练不带 `--from-branch`、launchd-v2
  bootstrap 失败用 `--no-lead`、sensor 演练显式设
  `FLYWHEEL_LEAD_WATCHDOG_INTERVAL_MS`、DEPT_SCOPE 403 用 `--lead-label` 传真
  label(或明确开 `BRIDGE_DEPT_SCOPE_REJECT=off` 的边界)、
  `TEST_REPLY_BY_ISSUE` 开鉴权后一切 API 调用带 Bearer。
- **坑 14(QA 体无 PR 身份 → land 必拒,FLY-1768 F2)**:属产品侧机制缺口,
  本单不修机制;e2e 驱动必须绕开或复现生产路径(见 3.5),路书如实写边界。

### 3.5 e2e 驱动形态(替代 FLY-1693 退役件)

关键抉择:驱动「真 AI 体」还是「脚本化节点完工」。

- 真体(FLY-1768 形态):implement 一步 codex 真跑 22 分钟、38 万 token。
  忠实但贵、慢、不确定 —— 不适合「每个 QA 单一键重放」的用途。
- **脚本化(选)**:驱动器扮演节点体,走**真凭据、真 CLI、真 Bridge 路径**
  (`flywheel-comm complete / qa-result`),只有「做什么活」是脚本给定
  (与 FLY-1768 QA FAIL 判决同一诚实边界:判决内容脚本给,判决路径全真)。
  须解决:脚本如何拿到 Bridge 为节点 session 铸的凭据(research 定案);
  QA 节点的 PR 身份如何补齐(坑 14 — 若生产路径是 implement 的 PR binding
  传导给 qa 节点,驱动器按生产形态给 QA 步喂 PR head;若机制本身缺,
  驱动器在第 8 步前显式断言并给出可证伪的失败信息,不假绿)。
- 范围:九步全覆盖为目标,但第 8/9 步受坑 14 制约 —— 设计上把「1-7 步全自动 +
  8/9 步在 PR 身份可用时自动、不可用时 fail-loud 并指路」定为最小可用版的
  诚实边界;若 research 证实驱动器可自己铸 PR binding(走生产同一 API),则
  九步全通。

## 4. 不做什么(边界)

- 不修 FLY-1768 F1/F2 的产品侧机制(`qa-result` 静默不传 head、QA 体 PR 身份
  铸造)— 那是独立 issue 的活;本单只保证房间能力 + 驱动 + 路书如实。
- 不动生产 Bridge 行为:所有改动在 test-deploy.sh / test-teardown.sh /
  scripts/lib / 新驱动脚本 / 文档;`packages/` 生产代码零改动
  (若 research 发现必须动生产代码才能达成验收,停下走 QUESTION GATE)。
- 不给 mirror/roundtable mode 叠加 generalized(互斥校验,沿用
  inject-linear-issue.sh 对 mirror/roundtable 的拒绝纪律)。
