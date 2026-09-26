---
issue: FLY-2885
phase: implement
phaseCursor: 3/14
updated: 2026-09-26T01:10:51.553Z
nextStep: "RESUME T3: transport v3 over leg (options.leg; start(signal):
  prepareOffer→thread/realtime/start{version:v3,transport:{type:webrtc,sdp}}→st\
  arted(v3)+thread/realtime/sdp→leg.acceptAnswer; startRequested getter;
  appendAudio writes 960-byte chunks to leg sync; outputAudio/delta ⇒
  fence+onCapabilityViolation 'webrtc_duplicate_audio'); conversation routes
  notifications per generation via RPC facade; test patch script at scratchpad
  t3_tests.py failed on the import block (codex-transport.test.ts imports
  differ) — re-derive. Then T8,T9,T4,T6,T5,T5b,T5c,T7, verify, review, PR"
chunks: []
pointers: {}
---

# FLY-2885 progress
**phase**: implement (3/14)
**next**: RESUME T3: transport v3 over leg (options.leg; start(signal): prepareOffer→thread/realtime/start{version:v3,transport:{type:webrtc,sdp}}→started(v3)+thread/realtime/sdp→leg.acceptAnswer; startRequested getter; appendAudio writes 960-byte chunks to leg sync; outputAudio/delta ⇒ fence+onCapabilityViolation 'webrtc_duplicate_audio'); conversation routes notifications per generation via RPC facade; test patch script at scratchpad t3_tests.py failed on the import block (codex-transport.test.ts imports differ) — re-derive. Then T8,T9,T4,T6,T5,T5b,T5c,T7, verify, review, PR
