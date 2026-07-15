# FLY-1062 PR2 公共薄壳 — 实施增量设计

Issue: FLY-1062 (URL 不可得,只写 issue 号)
日期: 2026-07-10
基于: plan.md §P3(已 Codex-approved 的公共薄壳 + key 换 payload 设计)

> **PR 拆分(Tadashi 定,全挂 1062 同分支)**:PR1(打包地基,已 merge 5c6c14f0)→ **PR2 = 本增量:客户「一条 npm install」公开薄壳** → PR3 = 真 key 服务 + 托管端点 → PR4 = 发布 CI/CD。**PR2 端点一律用 stub HTTP 测**,真 gated 端点/key 生命周期归 PR3。**PR2 merge 不关单**;1062 关单 = 全套 + 干净机器真机验收。
> **红线继承 PR1/1023**:key 绝不进 argv/history/journal/日志/npm 输出;pack 前无源码泄漏;诚实话术(黑话红线);Annie 生产 byte-compat(薄壳是**新增独立包**,不碰任何现有运行件)。

## 0. PR2 交付边界(vs P3 全量)

P3 全量 = 薄壳 + update seam + 续传。PR2 落**全部薄壳客户逻辑**,端点 stub:

| P3 子项 | PR2 | 说明 |
|---|---|---|
| 公共薄壳包 bin(装链路 + 二次直 exec) | ✅ | 核心 |
| 隐藏 TTY 收 key + 0600 .env 复用 + env 双开关 | ✅ | 安全红线 |
| 凭 key 换 payload(Authorization header)+ sha256 | ✅ | 端点 stub |
| npm install --prefix + 兼容镜像 + 原子翻 current + exec onboard | ✅ | 复用 PR1 的 create-compat-mirror.sh |
| license set 换发 + 401 rotation | ✅ | |
| flywheel update seam(比对版本→装→翻→回滚) | ✅ | 端点 stub;重启走 supervisor seam(PR1 已落) |
| 续传 journal 版本键 + key 零进 journal | ✅ | |
| **真 gated 端点 / key 服务端 / 托管** | ❌ → PR3 | |
| **薄壳 npm publish / payload 上传 CI** | ❌ → PR4 | |

## 1. 包布局

`packages/onboard-shell/`(monorepo 内开发,独立版本、独立 `npm publish`):
- `package.json`:name = `@flywheel/onboard`(公共 scoped;实名 PR4 定),`bin: { "flywheel-onboard": "bin/flywheel-onboard.js" }`,**零 workspace 依赖 / 零 flywheel-\* 依赖**(纯 Node 内置 + 一个极薄 tar/sha 能力——用 `node:crypto` 做 sha256、用系统 `tar`/`npm` 做解包安装,不引第三方),`version` 独立起 `0.1.0`,`files: ["bin"]`;
- `bin/flywheel-onboard.js`:~百行 ESM 入口,三子命令(默认装 / `license set` / `update`);
- `lib/*.mjs`:拆分逻辑(key 读取、端点客户端、安装编排、原子 symlink)便于单测;
- `__tests__/`:hermetic bash E2E(temp-HOME + stub HTTP 端点 + stub npm)+ node 单测。

## 2. 客户流程(默认命令)

```
flywheel-onboard
 ├─ 已装且完整(current symlink → 完整 PKG_ROOT + 哨兵 + 版本)? → exec current/scripts/flywheel-onboard.sh(不重装、不问 key)
 └─ 否 →
     1. 取 key:① 已存 0600 ~/.flywheel/.env 的 FLYWHEEL_LICENSE_KEY → 复用
              ② 隐藏 TTY 读(关 echo)
              ③ env 注入仅当 FLYWHEEL_ALLOW_LICENSE_KEY_ENV=1(测试/CI 双开关,不进客户文档)
     2. GET <endpoint>/manifest  (Authorization: Bearer <key>)   → {latest, versions:[{ver, sha256}]}
     3. GET <endpoint>/payload/<latest>  (Authorization)          → tarball(临时目录)
     4. sha256 校验(node:crypto)不符 → 诚实话术 + 删临时 + 退出(零半成品)
     5. npm install --prefix ~/.flywheel/runtime/versions/<ver> <tarball>
     6. bash <PKG_ROOT>/scripts/packaged/create-compat-mirror.sh <PKG_ROOT>   (PR1 已落)
     7. 冒烟位:PKG_ROOT 有 .flywheel-prebuilt + 版本一致 + dist/run-bridge.js
     8. 原子翻 ~/.flywheel/runtime/current → PKG_ROOT(tmp symlink + rename)
     9. 新读的 key → 原子 0600 写 ~/.flywheel/.env(已存则不动)
    10. exec current/scripts/flywheel-onboard.sh(FO_ROOT 天然命中,clone 分支不触发)
```

**端点来源**:`FLYWHEEL_ONBOARD_ENDPOINT`(默认 = 真托管 URL 常量,PR3/PR4 填;测试注入 stub HTTP)。key 只走 `Authorization` header,绝不进 URL/日志。

## 3. 子命令

- `license set` = 隐藏读新 key → 打一次 manifest 端点校验 → 原子 0600 覆写 `.env` → 续正常装流程(rotation 不被二次运行快路挡死,Codex R4#1);
- `update` = 用已存 key 拉 manifest 比对 current 版本 → 新版本则下载+校验+`npm install --prefix versions/<newver>`+镜像+冒烟 → 原子翻 current(保留旧 1 个作回滚)→ 重启已安置服务(supervisor seam,PR1 已落 restart-packaged-services.sh)→ health,失败自动翻回旧 current。

## 4. 安全红线(测试机械保证)

1. **key 零泄漏**:secret-scan 断言 key 不进 argv(`ps` 看不到)/ history / journal / 日志 / npm stdout / 诚实话术;持久化后子进程 env 无 `FLYWHEEL_LICENSE_KEY`;
2. **env 注入双开关**:无 `FLYWHEEL_ALLOW_LICENSE_KEY_ENV=1` 时 env 里的 key 被拒;
3. **零半成品**:错 key(401)/ 吊销 / sha256 不符 / 网络失败 → 具体诚实话术 + 版本目录零残留 + current 不动;
4. **原子性**:current symlink 翻转 = tmp-symlink + rename;中断注入后 current 恒指向完整版本;
5. **续传**:装 v(N+1) 后重跑,v(N) 期 journal cursor 原样续;version 进 journal 非敏感键,key 绝不进 journal。

## 5. 测试计划(TDD,hermetic)

- `onboard-shell-install.test.sh`:空 runtime 首装全链(key 隐藏读→header 换 payload→sha256→install→镜像→翻 current→exec)+ 二次直 exec 不重问 key。**RED 起点**。
- `onboard-shell-negatives.test.sh`:错 key / 吊销 401 / 篡改 tarball(sha 不符)/ 网络失败 → 诚实话术 + 零半成品。
- `onboard-shell-rotation.test.sh`:`license set` 原子覆写 + 续流程;update 途中 401 隐藏读换 key 后成功;全程零半成品。
- `onboard-shell-update.test.sh`:update 比对→装→翻→回滚;health 失败自动回滚;续传 journal 绿。
- `onboard-shell-secret.test.sh`:key 零泄漏矩阵 + env 双开关拒绝。
- node 单测:sha256 校验、原子 symlink、manifest 解析、诚实话术文案。
- CI:接进 `.github/workflows/ci.yml`。

stub 基建:`__tests__/stub-endpoint.mjs`(node http:manifest/payload/401/吊销 四形态)+ stub `npm`(记录 install,把 tarball 解到 prefix)。

## 6. 进度(session progress writer 被 awaiting_review 拒,暂记此处)

- [ ] 块1 install.test RED→GREEN(核心装链路 + 二次直 exec)
- [ ] 块2 negatives
- [ ] 块3 rotation + license set
- [ ] 块4 update seam
- [ ] 块5 secret + env 双开关 + CI 接线
- [ ] Codex review → 独立 QA → approve gate
