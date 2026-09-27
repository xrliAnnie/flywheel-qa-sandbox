# Voice pipeline fixtures

`true-speech.wav` is the FLY-2178/FLY-2249 deterministic positive control from
the archived real-room QA material:

- source: `~/.flywheel/raya/qa/FLY-2031/rounds/bot-experience-20260831-r22-fly2178/audio/true-speech.wav`
- format: PCM signed 16-bit little-endian, 48 kHz, stereo
- SHA-256: `3e81e4d594a4395a4b693fae3244f37dccf42e892d99b4b2da12e57667588e04`

The fixture is copied byte-for-byte. It is not a substitute for the C7.5
founder-microphone calibration corpus.

## fly2884-uplink-levels.json

FLY-2885 T6 fixture. Per-20 ms uplink frame levels (RMS of the mono mix, dBFS,
0.1 dB) copied from the FLY-2884 prototype evidence on branch
`flywheel-FLY-2884` (`evidence/s4` and `evidence/s7` `frames-bridge.json.gz`):
`farVoice` is the 60 s far-away-voice run of s4 (peak −34.1 dBFS, one false
trigger in 2884); `founderSentences` are the founder's seven real sentences of
s7 (softest peak −26.2 dBFS). No audio is stored, only levels.
