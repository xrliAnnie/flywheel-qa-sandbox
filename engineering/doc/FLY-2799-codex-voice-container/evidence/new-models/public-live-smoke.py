import asyncio,json,os,pathlib,time,base64,hashlib,wave,urllib.request
from websockets.asyncio.client import connect
ROOT=pathlib.Path("/tmp/fly2799-probe");key=os.environ["OPENAI_API_KEY"];out=open(ROOT/"public-live-smoke.jsonl","w");chunks=[]
def log(d,m):
 def safe(v):
  if isinstance(v,dict):return {k:({"base64Length":len(x),"sha256":hashlib.sha256(base64.b64decode(x)).hexdigest()} if k in ["audio","delta"] and isinstance(x,str) and len(x)>300 else safe(x)) for k,x in v.items()}
  if isinstance(v,list):return [safe(x) for x in v]
  return v.replace(key,"[REDACTED]") if isinstance(v,str) else v
 r={"at":time.time(),"monotonicMs":round(time.monotonic()*1000,3),"direction":d,"message":safe(m)}
 out.write(json.dumps(r,ensure_ascii=False)+"\n");out.flush();print(json.dumps(r,ensure_ascii=False),flush=True)
async def main():
 req=urllib.request.Request("https://api.openai.com/v1/models",headers={"Authorization":"Bearer "+key})
 with urllib.request.urlopen(req,timeout=20) as r:
  data=json.load(r)
 log("models",sorted(x["id"] for x in data["data"] if x["id"] in ["gpt-live-1","gpt-realtime-2","gpt-realtime-2.1","gpt-realtime-2.1-mini"]))
 async with connect("wss://api.openai.com/v1/live/sessions",additional_headers={"Authorization":"Bearer "+key},open_timeout=20,max_size=4*1024*1024) as ws:
  async def send(m):log("send",m);await ws.send(json.dumps(m))
  async def receive(seconds):
   end=time.monotonic()+seconds
   while time.monotonic()<end:
    try:m=json.loads(await asyncio.wait_for(ws.recv(),end-time.monotonic()))
    except asyncio.TimeoutError:return None
    log("recv",m)
    if m.get("type")=="session.output_audio.delta":chunks.append(base64.b64decode(m["delta"]))
    if m.get("type") in ["session.started","session.closed","error"]:return m
  await send({"type":"session.start","event_id":"fly2799-start","session":{"model":"gpt-live-1","instructions":"You are a brief voice test assistant. Say short requested test phrases. For a request to check the probe status, delegate it to the client backend. Do not claim an action has run before its result arrives.","audio":{"format":{"type":"audio/pcm","rate":24000},"output":{"voice":"marin"}},"delegation":{"type":"client"}}})
  m=await receive(15)
  if not m or m.get("type")!="session.started":log("outcome",{"status":"startup_failed"});return
  await send({"type":"session.commentary.append","event_id":"fly2799-speak","delegation_id":None,"content":"The purple lantern is ready."})
  # Continuous input clock: feed external 3.8s fixture then silence paced at 100ms.
  async def feed():
   data=(ROOT/"fixture.pcm").read_bytes()+bytes(24000*2*20)
   begin=time.monotonic()
   for i in range(0,len(data),4800):
    await send({"type":"session.input_audio.append","audio":base64.b64encode(data[i:i+4800]).decode()})
    await asyncio.sleep(max(0,begin+(i+4800)/48000-time.monotonic()))
  feeder=asyncio.create_task(feed())
  await receive(24);await feeder
  await send({"type":"session.close","event_id":"fly2799-close"})
  result=await receive(15);log("finalization",{"closed":bool(result and result.get("type")=="session.closed")})
try:asyncio.run(main())
except Exception as e:log("exception",{"type":type(e).__name__,"message":str(e)})
finally:
 if chunks:
  with wave.open(str(ROOT/"public-live-smoke.wav"),"wb") as w:w.setnchannels(1);w.setsampwidth(2);w.setframerate(24000);w.writeframes(b"".join(chunks))
 log("audioSummary",{"chunks":len(chunks),"pcmBytes":sum(map(len,chunks))});out.close()
