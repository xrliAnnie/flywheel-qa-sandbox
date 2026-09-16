---
name: synthesize-research
description: Synthesize user research from interviews, surveys, and feedback into
  structured insights. Use when you have a pile of interview notes, survey responses,
  or support tickets to make sense of, need to extract themes and rank findings by
  frequency and impact, or want to turn raw feedback into roadmap recommendations.
---

Invocation input: <research topic or question>

<!-- PROVENANCE (vendored for FLY-880 — internal PM agent)
Source: anthropics/knowledge-work-plugins @ 6f13415be2a18d0fd9fa652e29a616cf7e3617a5
  upstream path: product-management/skills/synthesize-research/
License: Apache-2.0 — retained verbatim in the License appendix below
Local adaptation for FLY-2519: preserve the framework, inline referenced text and license;
route connector discovery through the current Codex capability inventory.
-->

# Synthesize Research

> Connector placeholders describe possible inputs. Use only the capabilities advertised in this Codex session; if a connector is unavailable, ask for the relevant research text or use the canonical manual fallback. Do not claim to have queried an unavailable source.

Synthesize user research from multiple sources into structured insights and recommendations.

## Usage

```
/synthesize-research $ARGUMENTS
```

## Workflow

### 1. Gather Research Inputs

Accept research from any combination of:
- **Pasted text**: Interview notes, transcripts, survey responses, feedback
- **Uploaded files**: Research documents, spreadsheets, recordings summaries
- **~~knowledge base** (if connected): Search for research documents, interview notes, survey results
- **~~user feedback** (if connected): Pull recent support tickets, feature requests, bug reports
- **~~product analytics** (if connected): Pull usage data, funnel metrics, behavioral data
- **~~meeting transcription** (if connected): Pull interview recordings, meeting summaries, and discussion notes

Ask the user what they have:
- What type of research? (interviews, surveys, usability tests, analytics, support tickets, sales call notes)
- How many sources / participants?
- Is there a specific question or hypothesis they are investigating?
- What decisions will this research inform?

### 2. Process the Research

For each source, extract:
- **Key observations**: What did users say, do, or experience?
- **Quotes**: Verbatim quotes that illustrate important points
- **Behaviors**: What users actually did (vs what they said they do)
- **Pain points**: Frustrations, workarounds, and unmet needs
- **Positive signals**: What works well, moments of delight
- **Context**: User segment, use case, experience level

### 3. Identify Themes and Patterns

Apply thematic analysis — see **Research Synthesis Methodology** below for detailed guidance on thematic analysis, affinity mapping, and triangulation techniques.

Group observations into themes, count frequency across participants, and assess impact severity. Note contradictions and surprises.

Create a priority matrix:
- **High frequency + High impact**: Top priority findings
- **Low frequency + High impact**: Important for specific segments
- **High frequency + Low impact**: Quality-of-life improvements
- **Low frequency + Low impact**: Note but deprioritize

### 4. Generate the Synthesis

Produce a structured research synthesis:

#### Research Overview
- Methodology: what types of research, how many participants/sources
- Research question(s): what we set out to learn
- Timeframe: when the research was conducted

#### Key Findings
For each major finding (aim for 5-8):
- **Finding statement**: One clear sentence describing the insight
- **Evidence**: Supporting quotes, data points, or observations (with source attribution)
- **Frequency**: How many participants/sources support this finding
- **Impact**: How significantly this affects the user experience or business
- **Confidence level**: High (strong evidence), Medium (suggestive), Low (early signal)

Order findings by priority (frequency x impact).

#### User Segments / Personas
If the research reveals distinct user segments:
- Segment name and description
- Key characteristics and behaviors
- Unique needs and pain points
- Size estimate if data is available

#### Opportunity Areas
Based on the findings, identify opportunity areas:
- What user needs are unmet or underserved
- Where do current solutions fall short
- What new capabilities would unlock value
- Prioritized by potential impact

#### Recommendations
Specific, actionable recommendations:
- What to build, change, or investigate further
- Tied back to specific findings
- Prioritized by impact and feasibility

#### Open Questions
What the research did not answer:
- Gaps in understanding
- Areas needing further investigation
- Suggested follow-up research methods

### 5. Review and Extend

After generating the synthesis:
- Ask if any findings need more detail or different framing
- Offer to generate specific artifacts: persona documents, opportunity maps, research presentations
- Offer to create follow-up research plans for open questions
- Offer to draft product implications (how findings should influence the roadmap)

## Research Synthesis Methodology

### Thematic Analysis
The core method for synthesizing qualitative research:

1. **Familiarization**: Read through all the data. Get a feel for the overall landscape before coding anything.
2. **Initial coding**: Go through the data systematically. Tag each observation, quote, or data point with descriptive codes. Be generous with codes — it is easier to merge than to split later.
3. **Theme development**: Group related codes into candidate themes. A theme captures something important about the data in relation to the research question.
4. **Theme review**: Check themes against the data. Does each theme have sufficient evidence? Are themes distinct from each other? Do they tell a coherent story?
5. **Theme refinement**: Define and name each theme clearly. Write a 1-2 sentence description of what each theme captures.
6. **Report**: Write up the themes as findings with supporting evidence.

### Affinity Mapping
A collaborative method for grouping observations:

1. **Capture observations**: Write each distinct observation, quote, or data point as a separate note
2. **Cluster**: Group related notes together based on similarity. Do not pre-define categories — let them emerge from the data.
3. **Label clusters**: Give each cluster a descriptive name that captures the common thread
4. **Organize clusters**: Arrange clusters into higher-level groups if patterns emerge
5. **Identify themes**: The clusters and their relationships reveal the key themes

**Tips for affinity mapping**:
- One observation per note. Do not combine multiple insights.
- Move notes between clusters freely. The first grouping is rarely the best.
- If a cluster gets too large, it probably contains multiple themes. Split it.
- Outliers are interesting. Do not force every observation into a cluster.
- The process of grouping is as valuable as the output. It builds shared understanding.

### Triangulation
Strengthen findings by combining multiple data sources:

- **Methodological triangulation**: Same question, different methods (interviews + survey + analytics)
- **Source triangulation**: Same method, different participants or segments
- **Temporal triangulation**: Same observation at different points in time

A finding supported by multiple sources and methods is much stronger than one supported by a single source. When sources disagree, that is interesting — it may reveal different user segments or contexts.

## Interview Note Analysis

### Extracting Insights from Interview Notes
For each interview, identify:

**Observations**: What did the participant describe doing, experiencing, or feeling?
- Distinguish between behaviors (what they do) and attitudes (what they think/feel)
- Note context: when, where, with whom, how often
- Flag workarounds — these are unmet needs in disguise

**Direct quotes**: Verbatim statements that powerfully illustrate a point
- Good quotes are specific and vivid, not generic
- Attribute to participant type, not name: "Enterprise admin, 200-person team" not "Sarah"
- A quote is evidence, not a finding. The finding is your interpretation of what the quote means.

**Behaviors vs stated preferences**: What people DO often differs from what they SAY they want
- Behavioral observations are stronger evidence than stated preferences
- If a participant says "I want feature X" but their workflow shows they never use similar features, note the contradiction
- Look for revealed preferences through actual behavior

**Signals of intensity**: How much does this matter to the participant?
- Emotional language: frustration, excitement, resignation
- Frequency: how often do they encounter this issue
- Workarounds: how much effort do they expend working around the problem
- Impact: what is the consequence when things go wrong

### Cross-Interview Analysis
After processing individual interviews:
- Look for patterns: which observations appear across multiple participants?
- Note frequency: how many participants mentioned each theme?
- Identify segments: do different types of users have different patterns?
- Surface contradictions: where do participants disagree? This often reveals meaningful segments.
- Find surprises: what challenged your prior assumptions?

## Survey Data Interpretation

### Quantitative Survey Analysis
- **Response rate**: How representative is the sample? Low response rates may introduce bias.
- **Distribution**: Look at the shape of responses, not just averages. A bimodal distribution (lots of 1s and 5s) tells a different story than a normal distribution (lots of 3s).
- **Segmentation**: Break down responses by user segment. Aggregates can mask important differences.
- **Statistical significance**: For small samples, be cautious about drawing conclusions from small differences.
- **Benchmark comparison**: How do scores compare to industry benchmarks or previous surveys?

### Open-Ended Survey Response Analysis
- Treat open-ended responses like mini interview notes
- Code each response with themes
- Count frequency of themes across responses
- Pull representative quotes for each theme
- Look for themes that appear in open-ended responses but not in structured questions — these are things you did not think to ask about

### Common Survey Analysis Mistakes
- Reporting averages without distributions. A 3.5 average could mean everyone is lukewarm or half love it and half hate it.
- Ignoring non-response bias. The people who did not respond may be systematically different.
- Over-interpreting small differences. A 0.1 point change in NPS is noise, not signal.
- Treating Likert scales as interval data. The difference between "Strongly Agree" and "Agree" is not necessarily the same as between "Agree" and "Neutral."
- Confusing correlation with causation in cross-tabulations.

## Combining Qualitative and Quantitative Insights

### The Qual-Quant Feedback Loop
- **Qualitative first**: Interviews and observation reveal WHAT is happening and WHY. They generate hypotheses.
- **Quantitative validation**: Surveys and analytics reveal HOW MUCH and HOW MANY. They test hypotheses at scale.
- **Qualitative deep-dive**: Return to qualitative methods to understand unexpected quantitative findings.

### Integration Strategies
- Use quantitative data to prioritize qualitative findings. A theme from interviews is more important if usage data shows it affects many users.
- Use qualitative data to explain quantitative anomalies. A drop in retention is a number; interviews reveal it is because of a confusing onboarding change.
- Present combined evidence: "47% of surveyed users report difficulty with X (survey), and interviews reveal this is because Y (qualitative finding)."

### When Sources Disagree
- Quantitative and qualitative sources may tell different stories. This is signal, not error.
- Check if the disagreement is due to different populations being measured
- Check if stated preferences (survey) differ from actual behavior (analytics)
- Check if the quantitative question captured what you think it captured
- Report the disagreement honestly and investigate further rather than choosing one source

## Persona Development from Research

### Building Evidence-Based Personas
Personas should emerge from research data, not imagination:

1. **Identify behavioral patterns**: Look for clusters of similar behaviors, goals, and contexts across participants
2. **Define distinguishing variables**: What dimensions differentiate one cluster from another? (e.g., company size, technical skill, usage frequency, primary use case)
3. **Create persona profiles**: For each behavioral cluster:
   - Name and brief description
   - Key behaviors and goals
   - Pain points and needs
   - Context (role, company, tools used)
   - Representative quotes
4. **Validate with data**: Can you size each persona segment using quantitative data?

### Persona Template
```
[Persona Name] — [One-line description]

Who they are:
- Role, company type/size, experience level
- How they found/started using the product

What they are trying to accomplish:
- Primary goals and jobs to be done
- How they measure success

How they use the product:
- Frequency and depth of usage
- Key workflows and features used
- Tools they use alongside this product

Key pain points:
- Top 3 frustrations or unmet needs
- Workarounds they have developed

What they value:
- What matters most in a solution
- What would make them switch or churn

Representative quotes:
- 2-3 verbatim quotes that capture this persona's perspective
```

### Common Persona Mistakes
- Demographic personas: defining by age/gender/location instead of behavior. Behavior predicts product needs better than demographics.
- Too many personas: 3-5 is the sweet spot. More than that and they are not actionable.
- Fictional personas: made up based on assumptions rather than research data.
- Static personas: never updated as the product and market evolve.
- Personas without implications: a persona that does not change any product decisions is not useful.

## Opportunity Sizing

### Estimating Opportunity Size
For each research finding or opportunity area, estimate:

- **Addressable users**: How many users could benefit from addressing this? Use product analytics, survey data, or market data to estimate.
- **Frequency**: How often do affected users encounter this issue? (Daily, weekly, monthly, one-time)
- **Severity**: How much does this issue impact users when it occurs? (Blocker, significant friction, minor annoyance)
- **Willingness to pay**: Would addressing this drive upgrades, retention, or new customer acquisition?

### Opportunity Scoring
Score opportunities on a simple matrix:

- **Impact**: (Users affected) x (Frequency) x (Severity) = impact score
- **Evidence strength**: How confident are we in the finding? (Multiple sources > single source, behavioral data > stated preferences)
- **Strategic alignment**: Does this opportunity align with company strategy and product vision?
- **Feasibility**: Can we realistically address this? (Technical feasibility, resource availability, time to impact)

### Presenting Opportunity Sizing
- Be transparent about assumptions and confidence levels
- Show the math: "Based on support ticket volume, approximately 2,000 users per month encounter this issue. Interview data suggests 60% of them consider it a significant blocker."
- Use ranges rather than false precision: "This affects 1,500-2,500 users monthly" not "This affects 2,137 users monthly"
- Compare opportunities against each other to create a relative ranking, not just absolute scores

## Output Format

Use clear headers and structured formatting. Each finding should stand on its own — a reader should be able to read any single finding and understand it without reading the rest.

## Tips

- Let the data speak. Do not force findings into a predetermined narrative.
- Distinguish between what users say and what they do. Behavioral data is stronger than stated preferences.
- Quotes are powerful evidence. Include them generously, with attribution to participant type (not name).
- Be explicit about confidence levels. A finding from 2 interviews is a hypothesis, not a conclusion.
- Contradictions in the data are interesting, not inconvenient. They often reveal distinct user segments.
- Recommendations should be specific enough to act on. "Improve onboarding" is not actionable. "Add a progress indicator to the setup flow" is.
- Resist the temptation to synthesize too many themes. 5-8 strong findings are better than 20 weak ones.


---

## License appendix


                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "[]"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

   Copyright [yyyy] [name of copyright owner]

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.


  Syntax-file, code seperations,code vault integeted with css definition.
Pre-recordec, pre-tested, elements to capture elements into Packeted-User-Relations to capture - [

pre-requisites, statements, recorded-cams
, cams-data
, data, input()

]
