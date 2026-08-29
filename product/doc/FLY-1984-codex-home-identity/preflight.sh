#!/bin/bash
# FLY-1984 founder 页发布前自检 —— 发布【之前】跑,不是发布之后回头看。
#
# 为什么存在:本单里两个渲染缺陷都是我"渲染后回头看"才发现的,而其中一个
# (b{display:block} 切断句子)是我两版前修过、在新组件上又犯了一遍的。
# Lead 的判据:把已知会复发的缺陷并进发布前清单,让它变成"必跑的一行",
# 而不是"我记得要 grep 一下"。—— 把拦截点从记性挪到结构上。
#
# 用法:  ./preflight.sh <本地 html>            发布前
#        ./preflight.sh <本地 html> <hosted-url>  发布后再跑一次(多查托管侧三项)
set -u
F="${1:?usage: preflight.sh <html> [hosted-url]}"
U="${2:-}"
fail=0
chk(){ # chk <名称> <实测> <期望>
  if [ "$2" = "$3" ]; then printf "  ✅ %-34s %s\n" "$1" "$2"
  else printf "  ❌ %-34s 实测 %s,应为 %s\n" "$1" "$2" "$3"; fail=1; fi
}

echo "── 本地文件 $F ──"
chk "nonce 占位符存在"        "$(grep -c '__CSP_NONCE__' "$F")" "1"
chk "无 nonce 的 script"      "$(grep -o '<script[^>]*>' "$F" | grep -vc 'nonce=')" "0"
chk "内联 on* handler"        "$(grep -Eo 'on(click|input|change|load|mouse[a-z]*)=' "$F" | wc -l | tr -d ' ')" "0"
chk "外部资源(src/@import)"   "$(grep -Eo 'src="http|@import|url\(http' "$F" | wc -l | tr -d ' ')" "0"
# ↓ 本单实际复发过的缺陷,不是通用规则 —— 每复发一次就往这里加一行
chk "b{display:block 切断句子" "$(grep -c 'b{display:block' "$F")" "0"
n=$(grep -c 'textarea data-s=' "$F")
[ "$n" -ge 1 ] && printf "  ✅ %-34s %s 个就地留言框\n" "每节留言框" "$n" \
                || { printf "  ❌ 没有就地留言框\n"; fail=1; }
chk "汇总标记恰好一处"        "$(grep -c '【页面意见汇总】FLY-1984' "$F")" "1"
echo "  ℹ️  小节标签(会出现在她复制出来的文本里):"
grep -o 'data-s="[^"]*"' "$F" | sed 's/data-s="/     /;s/"$//'

if [ -n "$U" ]; then
  echo "── 托管页 $U ──"
  T=$(mktemp)
  code=$(curl -s -o "$T" -w '%{http_code}' "$U")
  chk "HTTP"                    "$code" "200"
  chk "__CSP_NONCE__ 残留"      "$(grep -c '__CSP_NONCE__' "$T")" "0"
  chk "托管侧无 nonce 的 script" "$(grep -o '<script[^>]*>' "$T" | grep -vc 'nonce=')" "0"
  rm -f "$T"
fi

echo
[ "$fail" = 0 ] && echo "全过 ✅" || echo "有未过项 ❌ —— 不要发布/不要投卡"
exit $fail
