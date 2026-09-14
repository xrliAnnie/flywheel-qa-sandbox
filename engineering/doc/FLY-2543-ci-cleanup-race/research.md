# FLY-2543 CI 清理竞态 — 调研
Issue: FLY-2543 (https://linear.app/geoforge3d/issue/FLY-2543/flake-ci-classifytestsh-收尾-rm-竞态git-directory-not-empty让-shell3-在-1440)
日期: 2026-09-14
基于: exploration.md

仓库审计：第 7 行 EXIT trap 直接 rm；第 16 行初始化唯一仓库，后续 git 均使用该仓。选择 Git 原生本仓配置 gc.auto=0、maintenance.auto=false，从源头避免自动后台维护。清理使用 rm || printf warning >&2，由 Bash EXIT trap 保留进入 trap 的状态。无需进程扫描、kill 或重试框架。

验证用外部 rm 故障注入模拟 ENOTEMPTY；与自然复现明确区分。还应验证 setup/断言失败的非零状态不会被 warning 吞掉。

同形处置：仅断言全绿且唯一失败是退出 rm 竞态时一次 rerun，保留红回执，以 CI 结果为准；不推广到其它失败。
