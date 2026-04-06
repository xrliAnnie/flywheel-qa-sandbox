# Module 5: Multi-Lead Coordination

**Source**: Product Spec SS5 + SS2.1
**Scope**: Multi-Lead architecture
**Related components**: Simba (CoS), Peter (Product), Oliver (Ops), Core Room channel

## Prerequisites

- [ ] **Simba (CoS Lead)** running — tmux session `simba-lead`
- [ ] **Peter (Product Lead)** running — tmux session `peter-lead`
- [ ] **Oliver (Ops Lead)** running — tmux session `oliver-lead`
- [ ] **Core Room** channel — all 3 Leads subscribed
- [ ] **access.json** — each Lead has Core Room channel in their config

## Test Steps

### M1: Core Room Default Response - Annie Unaddressed -> Simba Responds

**Status**: Needs 3 Leads

| # | Step | Notes |
|---|------|-------|
| 1 | Annie posts in Core Room (no @ mention): "What's the update today?" | spec SS2.1: unaddressed -> Simba responds |
| 2 | Wait 10-30s for Lead response | Observe which Lead replies |

**Verify (Discord - Core Room)**:
- [ ] **Simba** responds (NOT Peter or Oliver)
- [ ] Response style: natural language conversation (spec SS3.4)
- [ ] Response is substantive (actual status update, not just "let me check")

### M2: Named Response - Annie @Peter -> Peter Responds

**Status**: Needs 3 Leads

| # | Step | Notes |
|---|------|-------|
| 1 | Annie posts in Core Room: "@Peter how's FLY-XX going?" | spec SS2.1: named -> named Lead responds |
| 2 | Wait 10-30s for Lead response | |

**Verify (Discord - Core Room)**:
- [ ] **Peter** responds (NOT Simba)
- [ ] Response addresses the specific question asked
- [ ] Other Leads do NOT respond to this message

### M3: Cross-Department Coordination

**Status**: Needs 3 Leads

| # | Step | Notes |
|---|------|-------|
| 1 | Trigger scenario where Peter needs Oliver's help | e.g., Peter's Runner needs ops config |
| 2 | Observe Peter's message in Core Room | Should @ Oliver directly |
| 3 | Wait for Oliver's response | |

**Verify (Discord - Core Room)**:
- [ ] Peter @mentions Oliver for coordination
- [ ] Oliver receives and responds to the mention
- [ ] Leads coordinate autonomously without Annie's intervention (spec SS5.1)
