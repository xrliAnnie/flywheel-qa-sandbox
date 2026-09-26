from pathlib import Path
import json,math,struct,hashlib
root=Path("/tmp/fly2799-probe");summary={}
for kind in ["live","realtime"]:
 rows=[json.loads(l) for l in (root/("duplex-"+kind+".jsonl")).read_text().splitlines()]
 def found(pred):return next((r for r in rows if pred(r)),None)
 def typ(r):return r["message"].get("type") if isinstance(r["message"],dict) else None
 def dt(a,b):return round(b["monotonicMs"]-a["monotonicMs"],1) if a and b else None
 start=found(lambda r:r["direction"]=="send" and typ(r) in ["session.start","session.update"])
 ready=found(lambda r:r["direction"]=="recv" and typ(r) in ["session.started","session.updated"])
 command=found(lambda r:r["phase"]=="firstSpeech" and r["direction"]=="send" and typ(r) in ["session.commentary.append","response.create"])
 first=found(lambda r:r["phase"]=="firstSpeech" and r["direction"]=="recv" and typ(r) in ["session.output_audio.delta","response.output_audio.delta"] and r["message"]["delta"]["rms"]>200)
 input_start=found(lambda r:r["phase"]=="interruption" and r["direction"]=="inputFixtureStart")
 vad=found(lambda r:r["phase"]=="interruption" and typ(r)=="input_audio_buffer.speech_started")
 cancelled=found(lambda r:r["phase"]=="interruption" and typ(r)=="response.done" and r["message"]["response"]["status"]=="cancelled")
 first_input_text=found(lambda r:r["phase"]=="interruption" and typ(r) in ["session.input_transcript.delta","conversation.item.input_audio_transcription.completed"])
 answer=found(lambda r:r["phase"]=="interruption" and typ(r) in ["session.output_transcript.delta","response.output_audio_transcript.delta"] and "fly" in r["message"].get("delta","").lower())
 receipt=found(lambda r:r["direction"]=="toolReceipt")
 blue=found(lambda r:r["phase"]=="tool" and typ(r) in ["session.output_transcript.delta","response.output_audio_transcript.delta"] and "blue" in r["message"].get("delta","").lower())
 text={}
 for phase in ["firstSpeech","interruption","tool"]:
  for direction in ["input","output"]:
   deltas=[r["message"].get("delta","") for r in rows if r["phase"]==phase and typ(r)==("session."+direction+"_transcript.delta" if kind=="live" else "response.output_audio_transcript.delta" if direction=="output" else "__none__")]
   text[phase+"_"+direction]="".join(deltas)
 item={"sessionReadyMs":dt(start,ready),"firstNonSilentPcmFromSpeakCommandMs":dt(command,first),"bargeInputStartToServerVadMs":dt(input_start,vad),"bargeInputStartToCancellationMs":dt(input_start,cancelled),"bargeInputStartToInputTranscriptMs":dt(input_start,first_input_text),"bargeInputStartToReplacementAnswerTextMs":dt(input_start,answer),"toolResultToBlueTranscriptMs":dt(receipt,blue),"transcripts":text,"exceptions":[r for r in rows if r["direction"]=="exception"],"samples":1,"metricsLimit":"Host-observed single runs; no human playback, room jitter or end-to-end Lead mailbox measured. Text arrival metrics are not acoustic playout latency."}
 if kind=="live":
  intervals={direction:[(r["message"].get("start_ms"),r["message"].get("end_ms")) for r in rows if r["phase"]=="interruption" and typ(r)=="session."+direction+"_transcript.delta"] for direction in ["input","output"]}
  overlaps=[(max(a,c),min(b,d)) for a,b in intervals["input"] for c,d in intervals["output"] if min(b,d)>max(a,c)]
  item["simultaneousInputOutputTranscriptIntervalsMs"]=overlaps
 summary[kind]=item
for name in ["api-v2-gpt-realtime-2.1","api-v3-gpt-live-1"]:
 rows=[json.loads(l) for l in (root/(name+".jsonl")).read_text().splitlines()]
 summary[name]={"errors":[r["message"]["params"]["message"] for r in rows if isinstance(r["message"],dict) and r["message"].get("method")=="thread/realtime/error"],"started":[r["message"]["params"] for r in rows if isinstance(r["message"],dict) and r["message"].get("method")=="thread/realtime/started"],"exit":rows[-1]["message"]}
(root/"new-model-summary.json").write_text(json.dumps(summary,ensure_ascii=False,indent=2)+"\n");print(json.dumps(summary,ensure_ascii=False,indent=2))
