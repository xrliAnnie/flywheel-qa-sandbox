---
name: writing-prds
description: Help users write effective PRDs. Use when someone is documenting product requirements, preparing specs for engineering, writing feature briefs, or defining what to build for their team.
---

<!-- PROVENANCE (vendored for FLY-880 — internal PM agent)
Source: RefoundAI/lenny-skills @ 280a57aa42fed3b6f35f51f0d9e71013b4c8ae74
  upstream path: skills/writing-prds/
License: MIT — retained verbatim in the License appendix below
Local adaptation for FLY-2519: preserve the framework, inline referenced text and license;
route connector discovery through the current Codex capability inventory.
-->

# Writing PRDs

Help the user write effective product requirements documents using frameworks and insights from 11 product leaders.

## How to Help

When the user asks for help with PRDs:

1. **Start with the why** - Ask about the problem being solved and why it matters now, before features
2. **Define success upfront** - Help them articulate how they'll know the feature succeeded
3. **Choose the right format** - Discuss whether they need a traditional doc, a prototype, or executable evals
4. **Keep it actionable** - Ensure the document leads to clear team action, not just documentation

## Core Principles

### Lead with problem and context
Maggie Crowley: "The most important section is the first part - what is the background and context? What is the problem, why does it matter, and why does it matter now?" Center the team on the 'why' and the urgency before discussing solutions.

### The PR/FAQ forces clarity
Bill Carr: "Whenever we're devising a new product, we start by writing a press release describing it in a way that speaks to the customer. The idea better jump off the page." Use the PR to describe customer, problem, and solution in factual, data-rich language.

### Demos before memos in AI age
Aparna Chennapragada: "If you're not prototyping and building to see what you want to build, you're doing it wrong. Prompt sets are the new PRDs." For AI features, include functional prototypes and prompt sets as core requirements.

### Evals as living PRDs
Hamel Husain & Shreya Shankar: "This is the purest sense of what a product requirements document should be - this eval judge that's telling you exactly what it should be, and it's automatic and running constantly." Translate product requirements into executable evaluations for AI products.

### Keep it lightweight for action
Eric Simons: "We tend to keep them pretty light. I like to have the minimal amount of context that ensures everyone's on the same page and that key outcomes will be present when we get there." Focus on key outcomes rather than exhaustive details that developers ignore.

### PRDs demonstrate craft
Vikrama Dhiman: "Is your PRD quality good enough? Are you writing drafts that go to care teams, marketing teams? You must have impact through the artifacts you work on." High-quality PRDs demonstrate professional craft and create clarity at scale.

### AI can scaffold the basics
Claire Vo: "I had used ChatGPT to come up with a very serviceable PRD spec for this very technical product." Use AI to scaffold basics like user stories and out-of-scope items, then focus on high-level strategy and narrative.

### Live PRDs reduce ambiguity
Guillermo Rauch: "The product management team is now actually building the product. We've specced out in v0, think of it as a live PRD. The amount of detail - we're all saying 'just ship it.'" Interactive, animated prototypes reduce ambiguity and speed up approval.

### Include the 'Why Now'
Justify the timing of this investment against other opportunities. If you can't explain why this matters now versus later, the priority is questionable.

## Questions to Help Users

- "What problem is this solving, and why does it matter now?"
- "How will you know if this feature was successful - what metric moves?"
- "Who is the customer, and what does their life look like after this ships?"
- "What is explicitly out of scope to prevent scope creep?"
- "Could you build a quick prototype instead of writing more documentation?"
- "What are the key decisions that still need to be made?"

## Common Mistakes to Flag

- **Starting with the solution** - The document should lead with the problem and context
- **No success criteria** - Every PRD needs a clear definition of how you'll measure success
- **Exhaustive detail** - Lightweight PRDs focused on outcomes are more likely to be read and used
- **Static when prototypes work better** - For AI and UI work, live prototypes communicate more than prose
- **Missing the 'Why Now'** - Without urgency justification, priorities will be questioned

## Deep Dive

For all 14 insights from 11 guests, see the Guest Insights appendix below

## Related Skills

- Writing Specs & Designs
- Working Backwards
- Stakeholder Alignment
- Shipping Products


---

## Guest Insights appendix

# Writing PRDs - All Guest Insights

*11 guests, 14 mentions*

---

## Aparna Chennapragada
*Aparna Chennapragada*

> "In this day and age, if you're not prototyping and building to see what you want to build, I think you're doing it wrong. I call it the prompt sets of the new PRDs. I really insist on folks saying if you're building new projects, new features of course come with prototypes and prompt sets."

**Insight:** Traditional written requirements are being replaced by functional prototypes and prompt sets as the primary way to define and communicate product ideas.

**Tactical advice:**
- Use 'demos before memos' to accelerate the product building loop
- Include prompt sets as a core requirement for new AI features
- Prioritize high-bandwidth prototyping to visualize ideas before writing documentation

*Timestamp: 00:22:59*


## Bill Carr
*Bill Carr*

> "Whenever we're devising a new product or feature, we're going to start by writing a press release describing the feature and describing it in a way that speaks to the customer and to some degree the external press and world where the idea is, in my description of this, it better jump off the page of something like, wow, as a customer I will really need this."

**Insight:** The PR/FAQ process forces clarity on the customer benefit before any development begins.

**Tactical advice:**
- Write a mock press release (PR) and a list of frequently asked questions (FAQ) before building
- Use the PR to describe the customer, the problem, and the solution in factual, data-rich language
- Include a hypothetical launch date to signal the project's complexity

*Timestamp: 00:41:31*

---

> "What I work first is to say, okay, for your product development process, let's start by using this method as the method to decide what am I going to go build? And oh, by the way, to use it as a method to sort between a lot of different choices of what you might build."

**Insight:** PR/FAQs should be used as a filtering mechanism (a funnel) to select the best ideas from many options.

**Tactical advice:**
- Create a 'product funnel' where many PR/FAQs are written but only the best are funded
- Iterate on documents through 'concentric circles' of review, starting with a small group and expanding

*Timestamp: 00:42:17*


## Claire Vo
*Claire Vo*

> "I had used ChatGPT and a prompt to come up with a very serviceable PRD spec for this very technical product... I eventually ran into the monetization and access wall that is the GPT Store right now. And so... I thought, this is easy. We're just going to stand up a standalone app."

**Insight:** AI can drastically accelerate the drafting of product requirements, allowing PMs to focus on high-level strategy and narrative.

**Tactical advice:**
- Use AI to scaffold the basics of user stories and out-of-scope items
- Include a 'narrative' section in PRDs to pitch the product's value
- Customize AI prompts to learn from your specific company context and role

*Timestamp: 00:54:45*


## Dan Shipper
*Dan Shipper*

> "In a Claude Code world, where you're not coding a lot, you end up spending a lot of time essentially typing PRDs... you could spend a little bit of time being like... I'm going to write a prompt that can take my rambling thoughts and then turn that into a PRD."

**Insight:** In an AI-driven development environment, the primary engineering task shifts from writing code to crafting high-quality PRDs.

**Tactical advice:**
- Automate the PRD writing process by using a prompt that structures voice-to-text or rough notes into a formal document

*Timestamp: 00:41:44*


## Eli Schwartz
*Eli Schwartz*

> "In the second month, we're going to build out a PRD for engineers to start working on. In the third month, they're going to start working, and they're going to ship this."

**Insight:** SEO initiatives should follow standard product development cycles, including the creation of PRDs for engineering teams.

**Tactical advice:**
- Translate SEO requirements into a standard PRD format that engineers can execute against

*Timestamp: 00:52:49*


## Eric Simons
*Eric Simons*

> "Unless there's something that's very sophisticated that we're working on, we tend to keep them pretty light. I like to just have the minimal amount of context possible, that just ensures everyone's on the same page and that the key outcomes for whatever feature that we're working on, are going to be present when we get there."

**Insight:** Lightweight PRDs focused on key outcomes are more effective than 'beefy' documents that developers might ignore.

**Tactical advice:**
- Keep PRDs minimal to ensure they are actually read and understood
- Focus on defining the 'key outcomes' rather than every minute detail

*Timestamp: 00:47:01*


## Hamel Husain & Shreya Shankar
*Hamel Husain & Shreya Shankar*

> "This is the purest sense of what a product requirements document should be, is this eval judge that's telling you exactly what it should be, and it's automatic and running constantly."

**Insight:** In AI development, executable evaluations are replacing static PRDs as the definitive source of product requirements.

**Tactical advice:**
- Translate product requirements into specific LLM-as-a-judge prompts
- Use evals to define non-negotiable product behaviors

*Timestamp: 01:00:56*

---

> "You're never going to know what the failure modes are going to be upfront... PRDs are a great abstraction for thinking about this. It's not the end all, be all. It's going to change."

**Insight:** AI product requirements must be flexible and derived from real-world data rather than just hypothetical planning.

**Tactical advice:**
- Update product requirements based on discovered failure modes in production data
- Treat the PRD as a living document that evolves with evaluation results

*Timestamp: 01:02:28*


## Guillermo Rauch
*Guillermo Rauch*

> "The product management team is fascinating, because now they're actually building the product. So last night I saw how we've specced out in v0, think of it as like a live PRD, we've specced out how the new functionality for deploying a v0 to Vercel is going to work. The amount of detail that was contained in that v0, I mean, we're all just saying, 'Well, just ship it. There's nothing else to discuss.' It was animated, it was interactive."

**Insight:** AI tools are transforming PRDs from static documents into interactive, animated prototypes that reduce ambiguity and speed up approval.

**Tactical advice:**
- Use AI builders to create 'live PRDs' that demonstrate error states, success states, and animations.
- Move from descriptive text to interactive artifacts to gain stakeholder alignment.

*Timestamp: 00:34:15*


## Maggie Crowley
*Maggie Crowley*

> "The most important section in my opinion in the document is the first part, which is like what is the background and context? What is the problem, why does it matter and why does it matter now?"

**Insight:** A successful PRD centers the team on the 'why' and the specific urgency of the problem before discussing solutions.

**Tactical advice:**
- Include a 'Why now' section to justify timing against other opportunities
- Keep a running log of decisions and trade-offs within the document
- Use the document as a 'home base' for all related research and artifacts

*Timestamp: 00:49:52*


## Mike Krieger
*Mike Krieger*

> "Can Claude be a partner in figuring out what to build? What the market size is if you want to approach it that way? What the user needs are if you look at a different way? ... Models can do that today."

**Insight:** AI can now act as a collaborative partner in the early stages of product planning, from market analysis to user need definition.

**Tactical advice:**
- Use LLMs to synthesize user feedback from multiple channels (Discord, X, forums) into actionable product insights.
- Leverage AI to generate initial PRD drafts and market size estimates to speed up the 'upstream' planning process.

*Timestamp: 00:19:02*


## Vikrama Dhiman
*Vikrama Dhiman*

> "Is your PRD quality good enough? Are you writing that the draft notes that go and circulate to the care teams, to the marketing teams and so on? ... You must have that impact to impact through the artifacts that you work on."

**Insight:** The quality of written artifacts like PRDs is a primary way to demonstrate your 'impact on impact' and professional craft.

**Tactical advice:**
- Ensure PRDs are high-quality and circulate them to cross-functional teams like care and marketing
- Don't neglect the 'IC roots' of document creation even as you move into leadership

*Timestamp: 00:15:43*

---

> "Can you show me your last PRD? Can you show me the last product note that you sent? Can you show me the product strategy doc that you have or collaborated on? Can you show me the brief that you sent to the design team on the problems and the ranking of those problems? Usually, you'll find something or the other missing."

**Insight:** Career stalls are often linked to a lack of high-quality, tangible product artifacts.

**Tactical advice:**
- Audit your recent artifacts (PRDs, strategy docs, design briefs) for quality and completeness
- Ensure Jira storyboards are descriptive and not just empty titles

*Timestamp: 00:18:31*




---

## License appendix

MIT License

Copyright (c) 2025 Refound AI

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
