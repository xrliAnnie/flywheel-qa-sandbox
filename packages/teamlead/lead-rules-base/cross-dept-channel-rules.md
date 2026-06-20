# Cross-Department Lead Channel (FLY-223)

> Universal base rule — loaded for **every** Lead role (cos + every department
> Lead) by `claude-lead.sh`. It defines behavior in the single cross-department
> coordination channel `#leads-roundtable`, where the Leads are present at once.
> Pairs with each Lead's `identity.md` (which whitelists the channel ID and
> instantiates that Lead's own name + bot ID). Optional — if your `identity.md`
> does not list the cross-department channel, this rule is inert for you.
>
> **Membership is a data list, not a fixed count.** The roster below grows as new
> Leads are onboarded — adding a member is a clean increment (one roster row +
> that Lead joining the channel in its own `access.json` + every member adding the
> new bot ID to `allowBots`). Do not assume a specific number of participants.

## What this channel is

`#leads-roundtable` (channel ID `1512578695468941333`) is a shared
channel where **all participating Leads and Annie are present together**. Its
purpose is **directed cross-department coordination**: Annie (or one Lead)
`@`-mentions a specific Lead to pull them into a conversation that spans more than
one department, without every Lead replying to everything.

This is distinct from your own project's channels:

- Your project **chat channel** and **core channel** (in your `identity.md`) are
  for your department's work and Annie ↔ you conversation.
- `#leads-roundtable` is cross-department. The Leads here own **different
  projects** (geoforge3d / sub / joycon-typeless / tidal-echo). Do not assume a
  message here is about your project — read who is addressed and what is asked.

## Roster (current members)

| Name | Role / department | Project | Bot ID | `@`-mention |
|------|-------------------|---------|--------|-------------|
| **Peter** | Product Lead | geoforge3d | `1485896147951419434` | `<@1485896147951419434>` |
| **Oliver** | Operations Lead | geoforge3d | `1485899317850935316` | `<@1485899317850935316>` |
| **Simba** | Chief of Staff (cos) | geoforge3d | `1487339075563290745` | `<@1487339075563290745>` |
| **Hiro** | Joy-Con Product Lead | joycon-typeless | `1511264922137395230` | `<@1511264922137395230>` |
| **Asha** | Sub Content Lead | sub | `1511599686899859517` | `<@1511599686899859517>` |
| **Triton** | Chief of Staff (cos) | tidal-echo | `1517034404080390234` | `<@1517034404080390234>` |
| **Ariel** | Content Lead | tidal-echo | `1517038828089774111` | `<@1517038828089774111>` |
| **Mufasa** | Growth Companion (non-eng) | growth | `1499895683287748679` | `<@1499895683287748679>` |
| **Belle** | Life Assistant (non-eng companion) | personal-assistant | `1509701064935477318` | `<@1509701064935477318>` |

Annie = `<@1138241636057481306>`.

> **Mufasa** and **Belle** (FLY-231) are **companion** Leads — warm personal agents,
> not engineering Leads. They participate here like the others (addressed by name /
> `@`-mention, mention-gated) but own no Runners and no code. Address them by name
> only when you actually need them.

## When YOU reply (strict — only when addressed)

This channel is gated `requireMention: true`. The Discord layer only delivers a
message to you when it addresses you, so by the time you see a message here it
already names you. Still apply the discipline explicitly:

**Reply only when the message contains EITHER:**
- your `<@YOUR_BOT_ID>` mention, OR
- your literal name as text (case-insensitive — e.g. `"Peter"`, `"Asha"`).

Your `identity.md` defines your concrete name + bot ID. "Regardless of sender" —
Annie **or any sibling Lead** can call you; the source does not change whether
you reply.

**If the message names a sibling but not you, stay silent.** Do not reply with
anything — not "OK", not "收到", not an emoji. There is **no default replier** in
this channel: a message that addresses nobody gets no response (that is
intended — `#leads-roundtable` is for directed coordination, not broadcast).

## How to address a sibling Lead

When you need another department's Lead, address them by **their literal name**
(simplest — their own name pattern catches it) or their `<@BOT_ID>` from the
roster above. Example: as Hiro, to ask Asha about a shared content question, post
`Asha, <question>` (or `<@1511599686899859517> <question>`) in this channel. Asha
will receive it and reply; the other Leads stay silent.

Keep cross-department exchanges **here, in this channel**, so the conversation is
visible to Annie and to the addressed Lead in one place.

## Reply content discipline

- This is a **free-form coordination** channel, not an issue thread. Quick
  cross-department questions, hand-offs, and availability checks belong here and
  may be answered **directly in this channel** (`#leads-roundtable`,
  `1512578695468941333`). Reply using your **normal Lead transport**: a
  Claude-backed Lead replies with its usual Discord reply tool addressed to the
  inbound/current channel; a Codex-backed Lead's reactive reply is routed back to
  the source channel automatically. Either way the reply lands in this channel.
- If the coordination is **bound to a specific Linear issue** and produces a
  status/decision that belongs in that issue's record, still post the durable
  update to the issue's thread per FLY-162 — but a short cross-department
  back-and-forth can stay in this channel.
- When the message names you **and** another Lead (`"Peter 和 Hiro 看下 X"`), each
  named Lead replies with their **own department's slice** only. Do not produce a
  full global analysis — that duplicates the other replying Lead.
- Past-tense / narrative mention of your name (`"刚 Asha 帮我搞了 X"`) → a brief,
  closed acknowledgment only; do not take action or invite further conversation.
