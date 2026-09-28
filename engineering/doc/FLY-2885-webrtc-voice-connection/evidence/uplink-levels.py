import json,sys,statistics as st,math
d=json.load(open(sys.argv[1]))
up=[f for f in d['up'] if f.get('real')]
# group into runs separated by >3s gaps
runs=[];cur=[]
for f in up:
    if cur and f['t']-cur[-1]['t']>3000: runs.append(cur);cur=[]
    cur.append(f)
if cur: runs.append(cur)
def db(x): return 20*math.log10(max(x,1)/32768)
for i,r in enumerate(runs):
    v=sorted(x['rms'] for x in r)
    q=lambda p:v[min(len(v)-1,int(p*len(v)))]
    print(i,f"t={r[0]['t']/1000:.1f}-{r[-1]['t']/1000:.1f}s n={len(v)} p50={q(.5)}({db(q(.5)):.1f}dB) p90={q(.9)}({db(q(.9)):.1f}dB) p99={q(.99)}({db(q(.99)):.1f}dB) max={v[-1]}")
