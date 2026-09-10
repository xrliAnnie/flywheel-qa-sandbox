# FLY-2389 私有下载与保留期 — 验收记录
Issue: FLY-2389 (https://linear.app/geoforge3d/issue/FLY-2389/1143b2-r2-payload-托管-端点私有-bucket-验-key-薄端点entitlement-分级-presigned-get)
日期: 2026-09-09
基于: plan.md、review-advisories.md、implementation.md

本文件区分实现证据与独立 QA/真实激活证据。没有读取生产凭据、没有真实 Cloudflare/R2 写入、没有 workflow dispatch、merge 或 deploy。

## 确定性实现证据

| 计划要求 | 实际证据 | 当前边界 |
|---|---|---|
| P1 两档 presigned GET | handler-customer 正向302 + presign真实库固定向量；customer clean/internal beta分别允许 | 真实R2字节链待QA |
| P2 隐藏/无权/吊销 | 同字节401/404；signer调用数断言 | 无生产key探测 |
| P3 改签名/方法/过期 | 固定独立SigV4向量及GET-only/TTL输入约束 | 真R2篡改、HEAD/list/过期拒绝待QA，未宣称通过 |
| P4 时间锚点 | auth/head/sign三处卡顿；历史20秒；截止取整 | 注入时钟，非平台下载截断测试 |
| P5 负向配置/数据 | 缺配置503、损坏manifest503、HEAD size/hash/缺对象404、编码路径404；五个调用点显式模式 | Worker dry-run证明打包，不是部署 |
| P6 吊销/隔离窗口 | 真实发链接后revoke/quarantine均停止mint；signer调用数不增加；链接最多60秒 | 真实已发URL到期行为待QA |
| K1 key写入不变量 | handler-admin：同tuple零写、变档/复活409、并发创建后revoke获胜、重复revoke零写、坏记录拒绝 | 不新增数据库/迁移 |
| K2 rotation故障 | 真实CLI+loopback：新签失败不revoke，旧revoke失败非零、一次新签与单独恢复说明；服务端错误不透出 | 虚构凭据 |
| L1 current不按年龄删 | current一年后可读；cleanup保留两条current；原生JSON无完整对象TTL | 真R2私有性/native读回待QA |
| L2 14/28天 | 共享RETENTION_WINDOW_MS；生命周期服务端expire guard；14/28天前1ms/等于/后1ms的读侧断言 | 不改生产时钟 |
| L3 回指/服务端钟 | 既有A→B→A→C、quarantine与客户端伪造时间；新到期回指边界拒绝 | 按Lead明确裁定 |
| L4 CAS/重试 | 既有stale CAS、tombstone vs引用；失败DELETE保留对象/标记，下一次重放成功；FsBucket重启安装 | 本地确定性交错 |
| L5 PUT收尾 | 实际prepare/commit在PUT落字节后响应前完成；current保留；无引用/已tombstone不在PUT内删 | 唯一物理删除仍由barrier守护 |
| A1 cleanup-only | endpoint正反矩阵、重复hash503、两token CLI拒绝、专用apply和ops重放 | 清理不拥有live reservation的abandon权限 |
| A2 配置/负向突变 | parsed YAML/JSON main/env/skip/并发/secret/nativeTTL；运行workflow JS的private/config/secret-stdin夹具 | 外部API与子进程替身默认拒绝，零真实调用 |
| E1 B1联合本地链 | 既有customer-e2e 8/8，B1 pipeline42/42，promote-controls4/4，双origin客户端2/2 | 新增同链真实B1 client reserve/upload/readback/prepare/commit→双origin302→真实shell hash；不替代真实R2联合验收 |

## 精确门禁与评审

- 局部结果及RED失败原因逐项记录在 implementation.md。
- `pnpm lint` exit 0（14 个既有 warning）；首次 `pnpm -r build` 因本地缺已声明依赖失败，`pnpm install --frozen-lockfile` 后完整 build exit 0。
- 首轮 `pnpm test:packages:run` exit 1：comm 四个既有 CLI 用例 5000ms 超时，另有 onTaskUpdate 超时；两个失败文件单独重跑 62/62 exit 0。降低 package/Vitest 并发的完整重跑仍 exit 1：comm 2190 passed / 2 skipped；claude-runner 1224 passed / 2 skipped，另有 onTaskUpdate 超时。无本地 full-green；其余六包另行补跑。Lead question `7272fc03-c4ad-481f-9f4a-0a651af6cd1e` 已确认按此披露并以 exact-head CI 14/14 判定完整门禁，不改无关 Vitest/tests。
- 本单无新增 `scripts/__tests__/*.test.sh`；修改的 key-cleanup/workflows-structure 和相关 B1/contract 脚本必须全部通过。新增端点 `.test.mjs` 被既有 CI glob 包含。
- codex:rescue companion 在创建 thread 前失败：sandbox_apply Operation not permitted，helper exit 71；无 rescue verdict。Lead question `41996fff-2eed-44cb-8677-27e7bab16218` 明确确认 Bridge exact-head request-review 为本 runtime 代码门禁，不重试 rescue。正式 review、PR exact-head CI、needs_review receipt 尚未完成。

## 交给独立 QA 的真实 R2 清单

只在授权隔离 Worker/private bucket 执行，不能切换生产 current 为测试版本。每项保存脱敏实际输出与对应 SHA/部署ID/运行URL；未执行必须保留未执行标记。

1. 记录代码SHA、Worker deployment id、隔离bucket身份；r2.dev disabled、custom domains无公开入口、无公开缓存绕行；原生rules完整读回与reviewed JSON一致。R2签名credential为bucket限定Object Read only。
2. 运行真实B1发布脚本构建beta与clean，记录releaseId/version/sourceCommit/sha256/size、manifest ETag与CAS结果。未commit staging不可下；提交失败旧pointer仍可下。
3. internal/customer两枚测试key通过端点取302和真实R2字节，hash与manifest一致；customer beta、无key、改query/path/对象、换方法HEAD/PUT/list、过期URL均拒绝。只保存状态/断言/hash，不存key或signed URL。
4. 旧对象无cache metadata也必须实际返回 `Cache-Control: private, no-store`；明确记录header读回。若平台不支持override，不能把本地假响应当满足。
5. 发URL后revoke/quarantine：新URL拒绝，旧链接过60秒拒绝；直接无签名R2 URL不可下载。已经开始的传输不是召回测试对象。
6. 使用真实壳（本地packed壳需明确未npm发布）取得同字节，零仓库访问；隔离R2验证guarded DELETE/失败重扫，14/28天使用注入时钟夹具。
7. 一次cleanup workflow的真实apply成功，记录run URL和未删current断言；skip不是成功。收尾吊销测试key/token，只删除本次拥有的隔离资源。

## 限制与回退

完整validator随append-only历史增长，尚无应用规模/CPU SLA；Lead要求记录并另跟进，不在本单引入另一索引/存储。未知原生rules的predeploy完整diff由runbook要求，执行器也对不匹配fail closed。真实R2缓存响应行为留QA。回退仅程序/调度，不回滚manifest/tombstones或复活key；临时stream回退必须保留C1安全修复，不能当B2完成证据。

## 最终本地收据（2026-09-10）

余下六包补跑 exit 1：edge-worker 1318、gemini-agent 157、voice-headphone 54、voice-bridge 649、voice-codex 122 个断言通过；teamlead 926 files / 12452 passed / 7 skipped，但 onTaskUpdate RPC timeout 为 unhandled error。无本次改动断言失败，不主张本地 full-green。Lead 已收到补跑报告，按已确认的 exact-head Bridge review + CI 14/14 路线继续。原文收据存 progress.md 与 PR。
