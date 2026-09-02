# Production-Grade Barge-In for a Discord Voice Assistant Using OpenAI Realtime

## Executive assessment

As of **September 2, 2026**, the production pattern is no longer “pick the best VAD and let it cancel speech.” Mature voice-agent systems increasingly split barge-in into at least two decisions:

1. **Did something speech-like start?** This must be extremely fast and is usually handled by a local VAD or specialized acoustic model.
2. **Did the user actually intend to take the turn?** This is where backchannels, breaths, coughs, self-talk, echo, and ambient voices must be rejected.
3. **Should the interrupted assistant utterance be abandoned or resumed?** This is a conversation-state decision, not a VAD decision.

That separation is visible across LiveKit, Pipecat, Vapi, Deepgram, and Retell. LiveKit now explicitly distinguishes raw VAD from an adaptive interruption model trained to separate genuine barge-ins from acknowledgments such as “uh-huh,” “okay,” and “right”; Pipecat separates VAD-generated speech events from user-turn-start strategies and offers Krisp’s dedicated interruption-prediction model; Vapi exposes separate VAD-duration, word-count, and acknowledgment-phrase controls; and Deepgram’s browser SDK separates local Silero VAD from an immediately interruptible playback queue. citeturn15search0turn17search0turn17search1turn18search3turn23search6

For your specific goal—**audible assistant stop in under roughly 300 ms without breath/noise constantly destroying responses**—the strongest architecture is therefore a **reversible two-stage interruption path**:

> **Discord Opus → decode/jitter-buffer → local neural VAD → immediately pause/duck local assistant playback → acoustic/partial-ASR intent confirmation → either resume playback or commit `response.cancel` + `conversation.item.truncate`.**

The crucial engineering choice is that the first-stage event should **stop what the user hears locally without immediately destroying the OpenAI response**. That buys perhaps 100–250 ms for a stronger interruption decision while still making the assistant feel as though it yielded instantly. This mirrors the logic behind LiveKit's false-interruption recovery, Pipecat's separation of VAD and turn-start strategies, and Vapi's explicit tradeoff between 50–100 ms VAD interruption and slower 200–500 ms transcription-based interruption. citeturn15search2turn17search1turn18search3

OpenAI's native `semantic_vad` is useful, but **it should not be treated as a backchannel-aware barge-in classifier**. OpenAI documents semantic VAD as a semantic **end-of-user-turn** classifier—deciding whether the user's utterance is complete and how long to wait—not as a classifier for whether overlapping “yeah,” “uh-huh,” or breathing should cancel an assistant response. With VAD interruption enabled, OpenAI documents interruption as beginning when user speech is detected. No current OpenAI documentation says semantic VAD distinguishes an intentional interruption from a backchannel at speech onset. citeturn13search0turn13search2

The practical ranking for your use case is:

| Strategy | Audible stop | Breath/noise rejection | Backchannel awareness | Reversible false interrupt | Best role |
|---|---:|---:|---:|---:|---|
| OpenAI `server_vad` alone | Fast-ish, network-dependent | Moderate/tunable | Low | Poor if auto-cancel enabled | Simple baseline |
| OpenAI `semantic_vad` alone | Similar onset behavior | Not documented as better at onset | **Not documented for barge-in intent** | Poor if auto-cancel enabled | End-of-turn quality |
| WebRTC VAD locally | Excellent | Weak–moderate | None | Yes, if used only to pause | Ultra-cheap first gate |
| Silero VAD locally | Excellent | Stronger | None | Yes | Recommended fast acoustic gate |
| TEN/Krisp-class neural VAD | Excellent | Strong | None by ordinary VAD alone | Yes | Alternative fast gate |
| Transcript word/phrase gating | 200–500 ms class | Very strong once transcript exists | Moderate | Yes | Confirmation layer |
| Specialized interruption model | Fast | Strong | **Strongest documented approach** | Yes | Best second-stage classifier |
| General LLM on partial transcript | Usually too late for primary stop | Strong | Potentially excellent | Yes | Resume/abandon confirmation |

The key conclusion from current production systems is that **a generic LLM is generally not placed in the hot path that makes audio stop**. Specialized acoustic interruption models or VAD trigger the immediate reaction; transcript semantics are then useful for validating, recovering, or committing the interruption. citeturn15search0turn17search0turn18search3

## OpenAI Realtime native turn detection and cancellation

OpenAI Realtime currently exposes two automatic turn-detection modes: `server_vad` and `semantic_vad`. VAD is enabled by default in speech-to-speech sessions. Both produce `input_audio_buffer.speech_started` and `input_audio_buffer.speech_stopped`, and both are configured under `session.audio.input.turn_detection`. citeturn13search0

**`server_vad`** is conventional server-side speech/silence segmentation. Its documented tuning knobs are:

| Option | Meaning for barge-in |
|---|---|
| `threshold` | Speech activation threshold, 0–1. Raising it can suppress quiet noise but also makes soft interruptions easier to miss. |
| `prefix_padding_ms` | Keeps audio preceding detected speech; useful for ASR/model context, not primarily an interruption-latency control. |
| `silence_duration_ms` | Determines how much silence ends the user turn. Lower values improve *end-of-turn* latency, not necessarily initial barge-in detection. |
| `create_response` | Whether a completed detected turn automatically creates a response. |
| `interrupt_response` | Whether incoming detected speech automatically interrupts an assistant response. |

OpenAI's example uses threshold `0.5`, 300 ms prefix padding, 500 ms silence, `create_response:true`, and `interrupt_response:true`. citeturn13search0

That distinction between **start latency** and **end latency** matters. Tweaking `silence_duration_ms` from 500 ms to 200 ms can make the model answer sooner after the user finishes, but it does not directly solve your complaint that a breath immediately cancels the assistant: cancellation begins at speech-start detection, while `silence_duration_ms` controls speech-stop. OpenAI publishes no current median or p95 numeric latency for `input_audio_buffer.speech_started`, so claims such as “OpenAI native barge-in is 100 ms” would not be supported by the official documentation. citeturn13search0turn13search2

**`semantic_vad`** instead scores whether the user's utterance appears semantically complete. OpenAI gives the example that a trailing “ummm…” receives a longer timeout, while a clearly complete statement can end without waiting as long. The `eagerness` setting is `low`, `medium`, `high`, or `auto`; `auto` currently corresponds to medium. Low eagerness gives the user more time, while high eagerness chunks and responds sooner. citeturn13search0

That is valuable for one kind of interruption problem: the **assistant interrupting the user because they paused mid-thought**. It is not documented as solving the opposite problem: **the user making a non-interruptive noise while the assistant is speaking**. The documentation says semantic VAD makes the model less likely to interrupt a user or prematurely chunk the user's transcript; it does not state that it classifies overlapping user speech as “backchannel versus takeover.” citeturn13search0

Consequently, I would **not** rely on semantic VAD to distinguish:

> “yeah” meaning *I’m listening, continue*

from

> “yeah, but that's not what I meant” meaning *stop, I’m taking the floor*.

A standalone “yeah” is also semantically a complete utterance, so even conceptually semantic completeness is not equivalent to interruption intent. This is an inference from the documented semantics rather than a documented OpenAI guarantee. citeturn13search0

**WebSocket interruption handling is especially important for your Discord architecture.** With VAD interruption enabled, OpenAI says that when user speech starts, the server automatically cancels an in-progress response and emits a cancelled-response event. Unlike WebRTC/SIP, however, the Realtime server does not know how much audio your WebSocket application has actually played. Your application must immediately stop its own output queue, measure the amount that reached the Discord listener, and issue:

```json
{
  "type": "conversation.item.truncate",
  "item_id": "item_1234",
  "content_index": 0,
  "audio_end_ms": 1500
}
```

That removes the unplayed tail from conversational state. OpenAI explicitly notes that the realtime model cannot precisely align arbitrary transcript text to that audio cut, so truncation removes the corresponding unplayed transcript but does not yield a precise text-at-the-cut transcript. citeturn13search2

For custom barge-in logic, one of the most useful current Realtime capabilities is that **you do not have to let VAD make destructive control decisions**. OpenAI documents that you can keep VAD active while setting both:

```json
"interrupt_response": false,
"create_response": false
```

You then retain VAD events but manually decide when to issue `response.create` or cancel a response. Alternatively, `turn_detection:null` disables server turn detection completely, after which your application explicitly commits audio and creates responses. citeturn14view2turn13search2

For your project, that is preferable to native auto-interrupt. Otherwise the instant OpenAI considers a breath to be speech, it has already destroyed the response before your stronger classifier can say “false alarm.”

OpenAI's own push-to-talk guidance also indirectly validates this tradeoff: its documentation says application-controlled turn-taking can avoid VAD failures and feel snappy because the application is not waiting for VAD timeouts. citeturn13search2

A good OpenAI configuration for an externally arbitrated barge-in system is therefore conceptually:

```json
{
  "type": "session.update",
  "session": {
    "type": "realtime",
    "audio": {
      "input": {
        "format": {
          "type": "audio/pcm",
          "rate": 24000
        },
        "turn_detection": {
          "type": "semantic_vad",
          "eagerness": "medium",
          "interrupt_response": false,
          "create_response": false
        }
      }
    }
  }
}
```

The current Realtime documentation uses 24 kHz PCM in its WebSocket/session examples. This configuration lets OpenAI's semantic detector remain useful for **user-turn completion**, while taking the dangerous “stop the assistant now” decision away from it. citeturn14view2turn13search1

## Local neural VADs and acoustic gating

Your current energy/density heuristic is operating on exactly the wrong abstraction for noisy conversational audio: energy can tell you that something happened, but not whether it looked like human speech. Breath, chair movement, microphone bumps, keyboard noise, fan modulation, and compressed background sounds can all exceed an RMS/energy threshold.

A local speech-trained VAD does not completely eliminate those errors, but the available benchmark evidence strongly favors it over simpler detectors.

**Silero VAD** is the strongest open local default in this class. Its model is small—roughly 2 MB for the JIT artifact—and the maintainers report processing a 30+ ms chunk in under one millisecond on a single CPU thread; ONNX can be faster. Silero accepts 8 kHz or 16 kHz audio, so your decoded Discord stream should be downsampled to 16 kHz for this branch. citeturn8view0turn9view1

The maintainers' 2026 multi-domain benchmark is unusually useful for this problem because it includes meeting audio, overlapping conversational speech, noisy speech, ESC-50 environmental sounds, and private noise recordings. On their roughly 31.25 ms segment test, the reported ROC-AUC figures were approximately:

| Detector | Multi-domain ROC AUC | Multi-domain accuracy |
|---|---:|---:|
| WebRTC VAD | 0.73 | 0.74 |
| TEN VAD | 0.93 | 0.87 |
| Silero v5 | 0.96 | 0.91 |
| Silero v6 | **0.97** | **0.92** |

On a particularly stringent “entire pure-noise clip must never contain ≥100 ms of predicted speech” metric, Silero's reported ESC-50/private-noise accuracies were roughly `0.87/0.71` for v6, versus `0.42/0.47` for TEN and `0.00/0.15` for WebRTC. These are **Silero-maintained benchmarks rather than independent third-party results**, so the ranking deserves validation on your Discord corpus, but the magnitude illustrates why WebRTC-VAD-or-energy-only systems tend to be brittle around real-world noise. citeturn9view0

Those numbers also show an important limitation: **even Silero v6 is not “noise proof.”** In the private-noise test, a material fraction of noise clips still generated at least 100 ms of detected speech. And none of these published aggregate tests should be interpreted as a breath-specific false-positive benchmark. Human breathing is unusually difficult because it is produced by the same acoustic pathway and can resemble unvoiced phonemes. citeturn9view0

The practical latency is excellent. Silero's benchmark uses approximately 31.25 ms chunks and reports sub-millisecond compute on modern CPUs. A three-frame confirmation rule would therefore have an intrinsic evidence window around 94 ms plus decode/resampling and scheduling overhead. That makes **roughly 100–150 ms local audible pause** realistic as an engineering target, though that estimate is a pipeline calculation, not a Silero latency SLA. citeturn9view1

**WebRTC VAD** remains attractive when CPU cost and operational simplicity matter more than difficult-noise accuracy. Its native interface accepts 8, 16, 32, and 48 kHz audio in 10, 20, or 30 ms frames, so it can run directly on decoded Discord PCM at 48 kHz without a resampler. It exposes aggressiveness modes 0 through 3; higher modes are more restrictive about declaring speech, reducing some false positives at the cost of more missed speech. citeturn11search0turn11search2

For a Discord bot that sees breaths/noise today, though, WebRTC VAD would be my fallback rather than my first choice. Silero's own multi-domain test suggests that WebRTC is very good at inexpensive speech/silence gating but substantially weaker when the actual distinction is **speech versus heterogeneous noise**. citeturn9view0

**TEN VAD** sits between WebRTC and Silero conceptually: it is a tiny streaming neural VAD intended for real-time deployment. TEN's documentation describes a library on the order of a few hundred kilobytes and very low real-time factor on a desktop Ryzen CPU. Its own material claims stronger speech/noise discrimination than traditional VADs, while Silero's cross-benchmark puts TEN below Silero v6 but well above WebRTC on the multi-domain set. Because each vendor has incentives around its own test suite, your decision between TEN and Silero should ultimately be made against recorded Discord traffic rather than headline benchmarks. citeturn10search6turn10search12turn9view0

A particularly relevant “other” option is **Krisp VIVA**. Pipecat exposes a Krisp VAD that supports 8–48 kHz, but more importantly Krisp has a separate **Interruption Prediction** model. This is a crucial architectural distinction: VAD answers “is the user vocalizing?” while IP answers “does this overlapping vocalization appear to be a genuine interruption or something like ‘uh-huh’/‘yeah’?” Pipecat's integration invokes the interruption model after VAD and can fall back to a transcription-based turn-start strategy. citeturn17search0

That separation is more likely to solve your actual problem than another round of hand-written amplitude rules.

For a home-grown system, I would run the local VAD continuously but use it as a **proposal mechanism**, not as the final conversation-state authority. A sensible starting implementation is:

```text
Discord PCM48
    │
    ├──► local VAD branch
    │      └─ resample mono 16 kHz → Silero
    │
    ├──► ASR / semantic branch
    │
    └──► OpenAI branch
           └─ mono PCM 24 kHz
```

At VAD start, require a short hysteresis window—for example, multiple positive neural frames rather than one frame—then stop/duck local assistant playback. Continue accumulating audio while an interruption classifier or partial transcript decides whether the event is genuine. The precise threshold should be calibrated from your own breath/noise corpus rather than copied from another product.

Pipecat's current documentation independently recommends this kind of local-first architecture: its speech-input guide says local VAD can be roughly 150–200 ms faster than remote VAD services, uses Silero by default, and treats raw VAD frames as inputs into higher-level user-turn strategies rather than final turn decisions. citeturn17search4

## Intent-aware interruption handling and production patterns

This is where the state of the art has moved most significantly.

**LiveKit** now has one of the clearest publicly documented production architectures. Its adaptive interruption model operates **after VAD** and analyzes streaming overlapping audio to distinguish a real interruption attempt from a non-interruptive acknowledgment or incidental sound. LiveKit explicitly uses “uh-huh,” “okay,” and “right” as backchannel examples, and its documentation includes audio comparisons where ordinary VAD interrupts the agent on a short acknowledgment but the adaptive system does not. citeturn15search0

Critically, LiveKit says this model uses the **audio itself rather than waiting for a transcript**, specifically because that is faster than transcript-based interruption classification. Its documentation says the model adds “minimal latency,” although it does not publish a numerical median or p95, so it would be inappropriate to assign it an exact millisecond number. citeturn15search0

LiveKit then has a second recovery mechanism. Its current defaults include a false-interruption timeout of about 2 seconds and `resume_false_interruption=true`, allowing the agent to resume if a putative interruption produces no real transcript. It also exposes minimum interruption duration and minimum-word thresholds. citeturn15search2

This leads to an important insight for your design:

> **“Stop talking” and “commit the interruption” do not have to happen at the same instant.**

LiveKit's framework can suspend/interrupt output quickly and later determine that the event was false. Your custom OpenAI WebSocket implementation can implement an even faster version by making the first action purely a local playout pause.

There is one caveat for directly copying LiveKit: its documented adaptive-interruption feature has availability conditions and does not simply become the automatic hot-path classifier when using every speech-to-speech realtime LLM configuration. LiveKit's separate turn-detection machinery can work with realtime models, but the docs recommend disabling the realtime provider's built-in turn detection when an external detector owns turn boundaries, to avoid competing controllers. citeturn6view2

LiveKit also documents a real failure mode of its own adaptive model: around the beginning/end boundaries of an assistant turn, a real short interruption can resemble a backchannel. Its default `backchannel_boundary` introduces cooldown behavior around those boundaries. That is strong evidence that **backchannel classification is contextual, not merely lexical**. citeturn15search0

**Pipecat** reaches a similar architecture through modular turn-start strategies. Its default VAD-based start strategy is explicitly described as the most responsive; a `TranscriptionUserTurnStartStrategy` can instead trigger on interim partial transcription; and `MinWordsUserTurnStartStrategy` can require a number of words **only while the bot is speaking**, preventing a single “okay” or “yeah” from necessarily interrupting the bot. citeturn17search1

Its Krisp integration goes further. `KrispVivaIPUserTurnStartStrategy` invokes a dedicated interruption-prediction model after VAD and outputs a probability of genuine interruption versus backchannel. Pipecat's example uses a `0.5` threshold plus transcription fallback. citeturn17search0

There is also valuable real-world evidence from Pipecat's public issue tracker. In July 2026, an engineer operating production Telnyx phone agents reported that, across **153 calls**, 34% contained a response aborted by a false turn start, and 6.5% deteriorated into a loop in their deployment. Their issue specifically sought access to the Krisp interruption-prediction strategy as the intended remedy. This is an anecdotal customer report, not a controlled benchmark, but it is unusually concrete evidence that “ordinary VAD = interruption” can become a serious production failure mode. citeturn16search2

**Vapi** provides useful latency numbers for the VAD-versus-transcript tradeoff. Its current voice-pipeline documentation says `numWords=0` uses VAD, with approximately **50–100 ms** detection, while waiting for transcription is typically **200–500 ms**. The default/recommended VAD interruption duration is around `voiceSeconds:0.2`; Vapi explicitly notes that this mode is responsive but can trigger on “um,” “uh,” throat clearing, and background noise. citeturn18search3

Vapi therefore supports the opposite strategy: require two or three transcribed words before interruption and supply explicit `acknowledgementPhrases` such as:

```text
okay
right
uh-huh
yeah
mm-hmm
got it
```

Its own speech-configuration guide recommends two to three words in use cases where brief acknowledgments should not stop the assistant. citeturn18search0turn18search3

This is a very good **confirmation** strategy, but not the ideal immediate-stop strategy. A genuine user saying “No!” or “Wait!” should be able to stop the bot well before two or three words arrive.

**Retell** exposes an `interruption_sensitivity` control from 0 to 1, where lower sensitivity requires more speech/more words and zero disables interruptions. It also exposes agent-side backchannel controls. However, its public API documentation does not disclose enough about the interruption classifier itself to conclude whether it is an acoustic model, transcript model, LLM, or ensemble. Retell's engineering material describes proprietary turn-taking that considers prosody, syntax, semantics, interruptions, and fillers, but that should be treated as a vendor architecture description rather than an independently reproducible algorithm. citeturn19search0turn19search5

**Deepgram** likewise increasingly handles turn structure inside its speech stack rather than by bolting a general LLM classifier onto a raw VAD. Flux exposes semantic end-of-turn confidence, `EagerEndOfTurn`, `TurnResumed`, and `EndOfTurn`; Deepgram currently advertises roughly 260 ms end-of-turn detection for Flux and explicitly recommends canceling speculative LLM work on `TurnResumed`. Those are end-of-turn mechanisms, but they illustrate the same reversible-decision pattern. citeturn23search5turn23search3

For actual barge-in, Deepgram's production telephony example listens for `UserStartedSpeaking` and sends Twilio a `clear` operation immediately to flush queued audio. Its browser SDK similarly maintains an interruptible player and calls `player.interrupt()` on the user-start event. citeturn20search4turn20search7turn23search6

The most interesting conclusion from all of these systems is what **is not** common: I found little current primary-source evidence that major production frameworks put an ordinary general-purpose LLM call between VAD and “stop speaker output now.”

The disclosed hot paths instead look like:

```text
LiveKit:    VAD → specialized acoustic interruption model
Pipecat:    VAD → specialized IP / transcript strategy
Vapi:       VAD duration OR partial transcript word/phrase gate
Deepgram:   speech/turn model → immediate playback flush
Retell:     proprietary turn-taking system
```

LiveKit had a text-based open-weights turn detector in earlier generations, but its current documentation is moving toward specialized audio/turn models rather than generic text-LLM decisions in the timing-critical loop. citeturn6view2turn15search0

For your own partial-ASR classifier, the right use is therefore **not**:

```text
VAD → wait for ASR → call LLM → maybe stop assistant
```

because that spends the 200–500 ms transcription delay before the user's audible experience improves. Vapi's published latency ranges make that tradeoff explicit. citeturn18search3

Instead use:

```text
VAD / acoustic IP
      │
      ├── immediately PAUSE local playback
      │
      └── accumulate 100–300 ms more evidence
                 │
                 ├── acoustic interruption score
                 ├── partial ASR
                 └── tiny intent classifier / rules
                            │
                  ┌─────────┴─────────┐
                  │                   │
              genuine             false
                  │                   │
          cancel + truncate        resume
```

A tiny text classifier can then look at features such as whether there is a partial transcript at all, token count, lexical interruption markers (“wait,” “no,” “stop,” “actually”), known backchannels, whether the utterance continues beyond a few hundred milliseconds, and conversational context. A larger/faster LLM can be useful for ambiguous cases, but because exact current models and their latency depend heavily on deployment and provider, there is no defensible universal “model X = Y ms” number. The important budget is architectural: **the classifier can take 100–300 ms if audible playback has already been reversibly paused**.

## Discord-specific pipeline engineering

Discord makes this somewhat different from a PSTN voice agent.

Discord's current Voice API transports Opus over RTP; Discord specifies **48 kHz, two-channel Opus** for voice sent to the service. Opus itself supports frame durations of 2.5, 5, 10, 20, 40, and 60 ms, and packets may contain multiple frames up to 120 ms. Twenty milliseconds is common/default in Opus implementations, but you should not write barge-in logic that assumes every incoming Discord packet represents exactly 20 ms. citeturn22search0turn22search2turn22search33

For receiving, there is an additional operational caveat: Discord's public Voice API does not formally document bot audio receive to the same stability level as sending. The `@discordjs/voice` documentation explicitly warns that receive support is not documented by Discord and therefore is not guaranteed stable. citeturn22search7turn22search19

The clean signal topology is therefore:

```text
Discord RTP / encrypted Opus
        │
        ▼
decrypt + per-speaker jitter buffer
        │
        ▼
Opus decode → PCM48 stereo
        │
        ├────────► downmix → 16 kHz mono → Silero / interruption model
        │
        └────────► downmix → 24 kHz mono → OpenAI Realtime WS
```

For outbound assistant audio:

```text
OpenAI response.output_audio.delta
        │
        ▼
24 kHz PCM local queue
        │
        ├── played-duration accounting ──► truncate timestamp
        │
        ▼
resample 48 kHz + stereo → Opus → Discord
```

OpenAI's current examples use 24 kHz PCM input, while Discord's documented transport is 48 kHz Opus, so an explicit decode/resample stage is the safe interoperable approach. citeturn14view2turn22search0

**Do VAD per speaker, not after mixing the entire voice channel.** Discord is inherently multi-party; a third person laughing in the channel should not necessarily be interpreted as the active user interrupting your assistant. Keep a VAD/interruption state machine per Discord user/SSRC and apply an application policy—for example, only the current interlocutor, explicitly addressed users, or someone exceeding a stronger takeover threshold can interrupt. This is one advantage Discord gives you over a mixed telephone stream.

**Use a jitter buffer before making speech-state decisions.** RTP can arrive late or out of order, and larger Opus packets increase both encoding latency and the amount of speech lost when a packet disappears. RFC 6716 explicitly notes the latency/loss tradeoff of longer Opus frames. citeturn22search2

A very small jitter budget is preferable for barge-in—enough to reorder ordinary network variance without adding hundreds of milliseconds. Maintain VAD timing from decoded media timestamps, not wall-clock packet-arrival density.

That last point is particularly important because **Discord suppresses audio transmission during silence**. Discord's engineering documentation describes avoiding audio packets during silent periods for bandwidth/CPU savings. citeturn22search20

This creates a subtle trap for both your homemade density VAD and OpenAI `server_vad`: “no RTP packets arrived” is not equivalent to “the detector received 300 ms of zero-valued PCM.” If you forward only received speech packets into a server-side silence detector, the downstream detector may not observe a continuous silence interval in the way you expect.

An appropriate bridge therefore restores a continuous media timeline after the jitter buffer—using silence/PLC where appropriate—rather than treating missing Discord packets as arbitrary gaps. The need to synthesize continuous silence for a silence-duration-based downstream detector is an engineering inference from Discord's silence suppression and OpenAI's documented silence-based `server_vad` behavior. citeturn22search20turn13search0

**Do not use Discord packet density itself as your barge-in feature.** Silence suppression, jitter, varying Opus packet duration, packet aggregation, and loss all contaminate density. This is likely one reason a density/energy heuristic behaves well in lab audio but deteriorates in real voice channels. citeturn22search2turn22search20

**Keep the Discord output buffer very shallow.** Once OpenAI has generated audio, every extra 100 ms buffered before Opus send is another 100 ms the bot continues speaking after your classifier fires. Deepgram's reference architecture handles barge-in by explicitly flushing the downstream telephony output buffer immediately; OpenAI similarly tells WebSocket clients to immediately stop their own playback queue on interruption. citeturn20search7turn13search2

For a <300 ms perceived stop target, I would budget approximately:

| Component | Engineering target |
|---|---:|
| Discord input/jitter buffering | 20–60 ms |
| Local neural VAD evidence | ~60–120 ms |
| VAD compute | <1–a few ms class |
| Local output-queue clear | <20 ms |
| **Perceived audible stop** | **~100–200 ms target** |
| Semantic confirmation | another ~100–300 ms, off the audible critical path |
| OpenAI cancellation/truncation | asynchronous after local stop |

Those are **design targets, not vendor SLAs**. The local VAD compute target is supported by Silero's measurements; the rest is a pipeline budget intended to keep the stop action below the requested 300 ms even when an OpenAI round trip is slower. citeturn8view0turn9view1

## Comparison matrix and recommended architecture

The following is the architecture I would ship for your Discord → OpenAI Realtime system.

| Layer | Recommended choice | Why | What not to do |
|---|---|---|---|
| Discord ingest | Per-user Opus decode + small jitter buffer | Preserves speaker identity and media timing | Mix everyone before VAD |
| Fast speech gate | **Silero v6 at 16 kHz**; evaluate TEN as challenger | Strong published noise robustness, tiny CPU cost | RMS/energy threshold as primary detector |
| Noise handling | Neural VAD plus optional denoise/voice isolation | Prevents garbage from reaching interruption state machine | Increase VAD sensitivity until breaths disappear |
| Immediate reaction | **Pause/duck Discord output locally** | Gets audible stop well below API round-trip latency | Wait for OpenAI `speech_started` before muting output |
| Backchannel decision | Specialized acoustic IP if available; otherwise partial-ASR + lexical/tiny classifier | Distinguishes “uh-huh” from sustained takeover | Treat every VAD start as irreversible cancel |
| OpenAI VAD | `semantic_vad` for turn completion, with auto interrupt disabled | Better semantic endpointing without owning barge-in | `interrupt_response:true` if you need false-trigger recovery |
| True interruption | `response.cancel` + exact played-time `conversation.item.truncate` | Keeps Realtime context consistent with what Discord heard | Cancel without truncation |
| False interruption | Resume locally buffered assistant audio | Gives natural recovery with almost no semantic damage | Regenerate entire answer after every breath |
| Ambiguous short utterance | Hold pause briefly; use partial ASR/acoustic evidence | Buys semantic evidence without talking over user | Keep speaking until LLM classification returns |
| End-of-user-turn | OpenAI semantic VAD or specialized turn model | Solves pauses/“umm…” separately from barge-in onset | Use same timeout logic for both start and end |
| Observability | Separate false-barge, missed-barge, stop latency, resume latency | Lets thresholds optimize the real UX objective | Track only “number of interruptions” |

The corresponding state machine should look roughly like this:

```text
ASSISTANT_SPEAKING
        │
        │ local neural VAD says speech likely
        ▼
SUSPECTED_BARGE
        │
        ├── immediately pause Discord playout
        │
        ├── DO NOT yet truncate OpenAI response
        │
        └── collect acoustic + partial-ASR evidence
                 │
       ┌─────────┴───────────┐
       │                     │
 TRUE INTERRUPTION       FALSE / BACKCHANNEL
       │                     │
       ▼                     ▼
 response.cancel          resume queued audio
 truncate at             keep OpenAI response
 actually-heard ms        alive
       │
       ▼
 USER_TURN
       │
 semantic/EOT detection
       ▼
 response.create
```

There is one implementation detail here that matters enormously: **while playout is paused, keep accepting a bounded amount of OpenAI output audio into a reversible buffer**. Do not let it grow without bound. A roughly 200–400 ms confirmation window is enough for your second-stage evidence; if the event is genuine, discard the buffered tail and cancel. If it was a breath or “mm-hmm,” resume the buffer. This makes the false interruption feel like a short conversational hesitation rather than forcing the model to reconstruct its answer.

If you instead send `response.cancel` on the first VAD-positive frame, you have crossed an irreversible boundary: the current generation is gone. A later “that was only a breath” result can only be repaired by creating a continuation response, which will be slower and may not reproduce the exact sentence/prosody. OpenAI's separation between response cancellation and client-side truncation is why delaying the destructive operation is useful. citeturn13search2

For **breath/noise suppression**, I would begin by replacing the existing energy/density start detector with Silero and collecting an evaluation set from actual Discord sessions. Include at minimum clean interruptions, quiet/soft interruptions, “wait/no/stop,” long backchannels, short “yeah/mm-hmm,” breathing into common gaming microphones, keyboard noise, cough/throat clear, another Discord participant speaking, packet loss, and music/game audio leaking into a microphone. Silero's published noise benchmark supports it as a strong baseline, but its own results also demonstrate why you still need an interruption layer above VAD. citeturn9view0

For **true backchannel handling**, the strongest available production evidence favors a specialized acoustic interruption model over waiting for a text LLM. LiveKit explicitly says acoustic classification is faster because it does not wait for transcription, and Pipecat's Krisp IP integration is purpose-built for “real interruption versus uh-huh/yeah.” citeturn15search0turn17search0

If you do not want to introduce a proprietary interruption model, a very workable second-best classifier is:

```text
true_barge =
    sustained_neural_speech
    AND (
        partial_words >= 2
        OR transcript starts with strong takeover marker
        OR speech_duration > takeover_duration
    )
    AND NOT (
        transcript is known backchannel
        AND utterance is short
        AND acoustic evidence is weak
    )
```

with special treatment for one-word high-intent tokens such as “wait,” “stop,” “no,” and “hold on.” Vapi's production configuration demonstrates both the utility and limitation of word-count/backchannel lists: two to three words suppress acknowledgments effectively, while VAD remains necessary when truly immediate interruption matters. citeturn18search0turn18search3

I would not make an expensive general LLM call mandatory before every cancellation. Instead, reserve semantic classification for **ambiguous cases after local audio is already paused**. In other words, give the LLM responsibility for *whether to resume or abandon*, not responsibility for *whether the user should still be forced to listen to the bot*.

Finally, measure the system using separate distributions:

**speech onset → local playout stopped**, **speech onset → true interruption committed**, **false-barge rate**, **missed-barge rate**, **backchannel rejection rate**, **breath/noise false-barge rate**, **false-interruption pause duration**, and **percentage of false interruptions that resume successfully**. Retell's 2026 engineering discussion similarly argues that the meaningful production metric is specifically the **false-barge rate**—assistant responses unnecessarily cut short by something such as a backchannel—not merely aggregate interruption count. citeturn19search3

The bottom-line recommendation is therefore:

> **Use Silero or a comparable neural VAD locally for a ~100 ms-class reversible playout pause; use a specialized acoustic interruption classifier when possible, otherwise partial ASR plus backchannel/intent classification; leave OpenAI `semantic_vad` responsible primarily for end-of-turn semantics, with `interrupt_response:false`; only after interruption intent is confirmed send `response.cancel` and truncate the assistant item at the exact Discord-heard audio duration.**

That design directly addresses all three objectives you listed: local stopping removes the network/API round trip from the perceived barge-in latency; neural/acoustic and semantic confirmation suppress breaths and backchannels; and delayed destructive cancellation makes **resume versus abandon** an explicit, recoverable decision rather than an accidental side effect of VAD. citeturn13search2turn15search0turn17search0turn18search3