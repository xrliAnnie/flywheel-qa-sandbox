# 「念出来」判据第二版的检查。⛔ 判据在跑之前冻结(decisions.md),这里只执行不解释。
import json, wave, os, datetime, numpy as np, sys
LAB = os.environ["HOME"] + "/.fly1911"; run = sys.argv[1] if len(sys.argv) > 1 else "sp2"
ev = []
for ln in open(f"{LAB}/{run}-bridge.out"):
    try: o = json.loads(ln)
    except Exception: continue
    if o.get("dir") in ("PLAN", "ANSWER", "SPEAK", "STREAM-END", "TX"):
        ev.append((datetime.datetime.fromisoformat(o["t"].replace("Z","+00:00")).timestamp()*1000, o["dir"], o.get("obj", {})))
m = json.load(open(f"{LAB}/{run}-asker-manifest.json")); t0 = m["recStartAt"]
w = wave.open(f"{LAB}/{run}-asker-room.wav"); sr, ch = w.getframerate(), w.getnchannels()
a = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(float)
if ch == 2: a = a.reshape(-1, 2).mean(axis=1)
rel = lambda ms: (ms - t0) / 1000
n10 = int(sr*0.1); r10 = np.sqrt((a[:len(a)//n10*n10].reshape(-1, n10) ** 2).mean(axis=1))
floor = np.percentile(r10, 10)
lvl = lambda t: r10[int(t/0.1)] if 0 <= int(t/0.1) < len(r10) else 0
def first_sound_after(t, thr):
    i = int(t/0.1)
    while i < len(r10):
        if r10[i] > thr and (r10[i:i+20] > thr).sum() >= 15: return i*0.1
        i += 1
    return None
askdone = (m["askDoneAt"] - t0) / 1000
plans   = [rel(x[0]) for x in ev if x[1] == "PLAN"]
starts  = [rel(x[0]) for x in ev if x[1] == "SPEAK" and x[2].get("state") == "start"]
stops   = [rel(x[0]) for x in ev if x[1] == "SPEAK" and x[2].get("state") == "stop"]
answer  = next((rel(x[0]) for x in ev if x[1] == "ANSWER"), None)
users   = [x for x in ev if x[1] == "TX" and x[2].get("role") == "user"]
thr = max(floor*4, np.percentile(r10, 95)*0.08, 40)
print(f"  录音本底(10 百分位) {floor:.0f}   判声门限 {thr:.0f}   她问完 {askdone:.1f}s")
print(f"  PLAN {['%.1f'%p for p in plans]}   开始念 {['%.1f'%s for s in starts]}   停 {['%.1f'%s for s in stops]}   ANSWER {answer:.1f}" if answer else "")
# ①
ans_sound = first_sound_after(answer + 0.2, thr) if answer else None
g = (ans_sound - askdone) if ans_sound else None
print(f"  ① 她问完 → 房里答案的声音:{g:.1f}s   判据 19.3-26.4 ⇒ {'✅' if g and 19.3<=g<=26.4 else '❌'}" if g else "  ① ❌ 答案之后没找到声音")
# ②
if starts:
    s0 = starts[0]; snd = first_sound_after(s0 - 0.1, thr)
    lag = (snd - s0) if snd else None
    # ⚠️ 不能一遇到低谷就收尾 —— 念一句话里本来就有停顿(这一句实测有 22 处)。
    #    上一版就是在第一个停顿处截断,把 17 秒的预告量成了 3.3 秒。
    dur = 0
    if snd:
        i = int(snd/0.1); last = i
        while i < len(r10):
            if r10[i] > thr*0.5: last = i
            elif (i - last) * 0.1 > 1.2: break     # 连续静 1.2 秒才算说完
            i += 1
        dur = last*0.1 - snd
    print(f"  ② 合成完成 → 房里出声:{lag:.2f}s  持续 {dur:.1f}s   判据 ≤0.40s 且 ≥2s ⇒ {'✅' if lag is not None and lag<=0.40 and dur>=2 else '❌'}")
# ③
if len(starts) >= 2:
    sw = starts[1]
    win = [lvl(t) for t in np.arange(max(0,sw-0.5), sw+0.5, 0.1)]
    mn = min(win) if win else 0
    print(f"  ③ 切换点 {sw:.1f}s 前后 0.5s 的最小响度 {mn:.0f}   判据 ≥ 本底×5 = {floor*5:.0f} ⇒ {'✅' if mn>=floor*5 else '❌'}")
else: print("  ③ 这一场只有一次开始念,没有切换点 ⇒ 无法判(不算通过)")
# ④
# ④ 预告可能在答案之前就自己念完了 ⇒ 那也满足「答案到达时预告已停」
if ans_sound:
    if stops: print(f"  ④ 预告被切停在 {stops[0]:.1f}s,答案出声 {ans_sound:.1f}s ⇒ {'✅' if stops[0] <= ans_sound else '❌'}")
    elif starts:
        import re
        secs = next((float(x[2].get("秒",0)) for x in ev if x[1]=="SPEAK" and x[2].get("state")=="start"), 0)
        endn = starts[-1] + secs
        print(f"  ④ 预告自己念完于 {endn:.1f}s(没被切),答案出声 {ans_sound:.1f}s ⇒ {'✅' if endn <= ans_sound else '❌'}")
# ⑤
print(f"  ⑤ user 转写 {len(users)} 条 ⇒ {'✅' if len(users)==1 else '❌'}")
