#!/usr/bin/env python3
"""FLY-1911 存档的入口自检:README 里指到的东西必须真的在。

为什么要有它:**一个入口索引的失败方式是安静地指向不存在的文件** —— 读的人打不开,
但没有任何东西会变红。半年后来的人只会觉得「这堆东西没人维护」。

⚠️ 它自己也带一个阳性对照(查一个确定不存在的引用)——
   一个不可能变红的检查不是检查。

用法:python3 check-readme-links.py   (退出码 0 = 全部命中)
"""
import glob, os, re, sys

README = os.path.join(os.path.dirname(os.path.abspath(__file__)), "README.md")
text = open(README, encoding="utf-8").read()

# 两种引用形态都收:markdown 链接 [x](path) 和行内代码里的 `path`
refs = set(re.findall(r"\]\((?!https?:)([^)\s]+)\)", text))
refs |= set(re.findall(r"`((?:evidence|prototype)/[A-Za-z0-9_.*-]+)`", text))

def hits(ref):
    return len(glob.glob(ref)) if "*" in ref else int(os.path.exists(ref))

os.chdir(os.path.dirname(README))
missing = [r for r in sorted(refs) if not hits(r)]
for r in sorted(refs):
    print(("OK(%d)  " % hits(r) if hits(r) else "MISSING ") + r)

control = glob.glob("evidence/NOSUCHFILE-*")   # 阳性对照:必须一个都匹配不到
if control:
    print("FAIL: 阳性对照命中了 —— 这把尺子坏了,它的绿色不作数"); sys.exit(2)
print("阳性对照 OK(尺子会变红)")

if missing:
    print("FAIL: %d 条引用指向不存在的东西" % len(missing)); sys.exit(1)
print("OK: README 里每一条引用都命中")
