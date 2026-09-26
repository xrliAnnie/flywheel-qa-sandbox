import asyncio,json,os,pathlib,time,base64,hashlib,wave,struct,math,sys
from websockets.asyncio.client import connect
ROOT=pathlib.Path("/tmp/fly2799-probe");key=os.environ["OPENAI_API_KEY"];kind=sys.argv[1];live=kind=="live";model="gpt-live-1" if live else "gpt-realtime-2.1"
label="duplex-"+kind;logfile=open(ROOT/(label+".jsonl"),"w");phase="startup";chunks={};speech=asyncio.Event();tool_seen=asyncio.Event();started=asyncio.Event();closed=asyncio.Event();response_done=asyncio.Event();ws=None;queue=asyncio.Queue();halt=False;events=[];call_args={};eid=0

def log(d,m):
 def safe(v):
  if isinstance(v,dict):
   out={}
   for k,x in v.items():
    if k in ["audio","delta"] and isinstance(x,str) and len(x)>300:
     b=base64.b64decode(x);s=struct.unpack("<"+"h"*(len(b)//2),b)
     out[k]={"bytes":len(b),"sha256":hashlib.sha256(b).hexdigest(),"rms":round(math.sqrt(sum(i*i for i in s)/len(s)),2) if s else 0}
    else:out[k]=safe(x)
   return out
  if isinstance(v,list):return [safe(x) for x in v]
  return v.replace(key,"[REDACTED]") if isinstance(v,str) else v
 r={"at":time.time(),"monotonicMs":round(time.monotonic()*1000,3),"phase":phase,"direction":d,"message":safe(m)};events.append(r);logfile.write(json.dumps(r,ensure_ascii=False)+"\n");logfile.flush()
async def send(m):
 global eid
 eid+=1;m.setdefault("event_id","fly2799-"+str(eid));log("send",m);await ws.send(json.dumps(m))
async def speak(text):
 if live:await send({"type":"session.commentary.append","delegation_id":None,"content":text})
 else:
  await send({"type":"conversation.item.create","item":{"type":"message","role":"user","content":[{"type":"input_text","text":"Say exactly: "+text}]}})
  await send({"type":"response.create"})
async def reader():
 async for raw in ws:
  m=json.loads(raw);t=m.get("type");log("recv",m)
  if t in ["session.started","session.updated"]:started.set()
  if t=="session.closed":closed.set()
  if t=="response.done":response_done.set()
  if t in ["session.output_audio.delta","response.output_audio.delta"]:
   b=base64.b64decode(m["delta"]);chunks.setdefault(phase,[]).append(b);samples=struct.unpack("<"+"h"*(len(b)//2),b)
   if samples and math.sqrt(sum(x*x for x in samples)/len(samples))>200:speech.set()
  if live and t=="session.delegation.created":
   tool_seen.set();di=m["delegation"]["id"]
   # Harmless local test backend. No Lead, filesystem, network, or business action.
   result={"probe_status":"blue","executed":"local_pure_fixture"};log("toolReceipt",{"delegationId":di,"result":result})
   await send({"type":"session.commentary.append","delegation_id":di,"content":"The local probe status is blue."})
  if not live and t=="response.function_call_arguments.done":
   args=json.loads(m.get("arguments") or "{}");cid=m["call_id"];name=m.get("name")
   if name!="get_probe_status" or args!={}:log("toolRejected",{"name":name,"args":args});continue
   tool_seen.set();result={"probe_status":"blue","executed":"local_pure_fixture"};log("toolReceipt",{"callId":cid,"name":name,"result":result})
   await send({"type":"conversation.item.create","item":{"type":"function_call_output","call_id":cid,"output":json.dumps(result)}})
   await send({"type":"response.create"})
async def feeder():
 index=0;begin=time.monotonic();fixture=None;offset=0
 while not halt:
  if fixture is None:
   try:fixture=queue.get_nowait();offset=0;log("inputFixtureStart",{"bytes":len(fixture),"sha256":hashlib.sha256(fixture).hexdigest()})
   except asyncio.QueueEmpty:pass
  if fixture is not None:
   b=fixture[offset:offset+4800];offset+=len(b)
   if offset>=len(fixture):log("inputFixtureEnd",{"bytes":len(fixture)});fixture=None
  else:b=bytes(4800)
  await send({"type":"session.input_audio.append" if live else "input_audio_buffer.append","audio":base64.b64encode(b).decode()})
  index+=1;await asyncio.sleep(max(0,begin+index*0.1-time.monotonic()))
async def timeout_event(event,seconds):
 try:await asyncio.wait_for(event.wait(),seconds);return True
 except asyncio.TimeoutError:return False
async def main():
 global ws,phase,halt
 url="wss://api.openai.com/v1/live/sessions" if live else "wss://api.openai.com/v1/realtime?model="+model
 async with connect(url,additional_headers={"Authorization":"Bearer "+key},open_timeout=20,max_size=4*1024*1024) as socket:
  ws=socket;receiver=asyncio.create_task(reader());feed=None
  try:
   instructions="You are a voice capability test. Speak English. Read provided phrases aloud. If the user interrupts, stop the old speech and answer the new request. For checking probe status, use the test backend and speak the returned status. Never pretend an operation ran; no business actions are available."
   if live:
    await send({"type":"session.start","session":{"model":model,"instructions":instructions,"audio":{"format":{"type":"audio/pcm","rate":24000},"output":{"voice":"marin"}},"delegation":{"type":"client"}}})
   else:
    await send({"type":"session.update","session":{"type":"realtime","model":model,"instructions":instructions,"audio":{"input":{"format":{"type":"audio/pcm","rate":24000},"transcription":{"model":"gpt-4o-mini-transcribe"},"turn_detection":{"type":"server_vad","threshold":0.5,"prefix_padding_ms":300,"silence_duration_ms":500,"create_response":True,"interrupt_response":True}},"output":{"format":{"type":"audio/pcm","rate":24000},"voice":"marin"}},"tools":[{"type":"function","name":"get_probe_status","description":"Return the harmless test probe status. Call for every probe status request.","parameters":{"type":"object","properties":{},"additionalProperties":False}}],"tool_choice":"auto","output_modalities":["audio"]}})
   if not await timeout_event(started,15):log("outcome",{"startup":"timeout"});return
   feed=asyncio.create_task(feeder())
   phase="firstSpeech";speech.clear();await speak("The purple lantern is ready.");await timeout_event(speech,15);await asyncio.sleep(6)
   phase="interruption";speech.clear();response_done.clear()
   await speak("Here is a long counting exercise. One, two, three, four, five, six, seven, eight, nine, ten. Eleven, twelve, thirteen, fourteen, fifteen, sixteen, seventeen, eighteen, nineteen, twenty. Twenty one, twenty two, twenty three, twenty four, twenty five, twenty six, twenty seven, twenty eight, twenty nine, thirty.")
   if await timeout_event(speech,15):
    await asyncio.sleep(.5);log("bargeTrigger",{"reason":"first non-silent output + 500ms"});await queue.put((ROOT/"fixture.pcm").read_bytes())
   else:log("bargeNotRun",{"reason":"no non-silent output"})
   await asyncio.sleep(16)
   phase="tool";tool_seen.clear();speech.clear()
   if live:
    await send({"type":"session.instructions.append","delegation_id":None,"content":"For the next spoken request, first ask the client backend to check probe status. Do not answer it directly. Once the client returns the status, say the status aloud."})
    await asyncio.sleep(1);await queue.put((ROOT/"fixture.pcm").read_bytes())
   else:
    await send({"type":"conversation.item.create","item":{"type":"message","role":"user","content":[{"type":"input_text","text":"Please use get_probe_status to check the probe status and tell me its result."}]}});await send({"type":"response.create"})
   got=await timeout_event(tool_seen,20);log("toolOutcome",{"callObservedAndLocalResultSubmitted":got});await asyncio.sleep(10)
   phase="close";halt=True
   if feed:await feed
   if live:
    await send({"type":"session.close"});log("finalization",{"sessionClosed":await timeout_event(closed,15)})
   else:log("finalization",{"method":"websocket_close","sessionClosedEventNotInRealtime":True})
  finally:
   halt=True
   if feed:feed.cancel();await asyncio.gather(feed,return_exceptions=True)
   await ws.close();receiver.cancel();await asyncio.gather(receiver,return_exceptions=True)
try:asyncio.run(asyncio.wait_for(main(),120))
except Exception as e:log("exception",{"type":type(e).__name__,"message":str(e)})
finally:
 for labelphase,c in chunks.items():
  data=b"".join(c);p=ROOT/(label+"-"+labelphase+".wav")
  with wave.open(str(p),"wb") as w:w.setnchannels(1);w.setsampwidth(2);w.setframerate(24000);w.writeframes(data)
  log("artifact",{"phase":labelphase,"path":p.name,"pcmBytes":len(data),"sha256":hashlib.sha256(p.read_bytes()).hexdigest()})
 logfile.close()
