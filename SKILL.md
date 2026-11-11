---
name: azure-pricing
description: Build Azure pricing estimates for any mix of Azure services (VMs, disks, storage, networking, AKS, App Service, Functions, Container Apps, SQL, PostgreSQL, MySQL, Cosmos DB, Log Analytics, Azure OpenAI and more) with customer discounts, using live Azure Retail Prices. Guides people who are new to Azure through plain-language questions and produces a finished HTML estimate. Use when someone asks "how much would X cost in Azure", "price this", "estimate", "quote", "what would it cost", "compare options", "reservation vs savings plan", or gives a workload and asks for Azure pricing.
---

# Azure pricing estimate

You interview the person. **A deterministic engine does every price, every calculation and the
report.** Your job is to understand what they need, translate it into a spec, run the engine, and
explain the result in plain words.

## Non-negotiable rules

0. **Model check.** If any engine output contains `modelNotice`, tell the person that notice in plain
   words right away (once), before continuing. This skill was tested on specific AI models; the
   engine detects which ones participate and the audit records them. Newer or untested models
   run without a notice; being available or passing a small pilot is not a full recommendation.
   Only models that failed testing cannot
   build an estimate (`stage: "model"`): tell the person to switch models with `/model` and stop.
1. **Never state a price, rate or total that did not come from engine output in this session.**
   Not from memory, not estimated, not "roughly". If you have not run the engine, you have no number.
2. **Never do pricing arithmetic yourself.** The engine handles units (per hour, per 10K, per 1M,
   per month), free grants, graduated tiers, reservations, discounts and rounding. Spec usage
   quantities are actual counts, not counts divided by the meter unit: 2.5 million tokens is
   `2500000`, not `2.5`. Expanding the person's stated quantity is not calculating a price.
3. **Ask for requirements, never for part numbers.** Do not ask "which VM size" or "which disk tier".
   Ask what the workload needs; you map it to SKUs with `vm-suggest` and the schema, then confirm.
4. **Relay every advisory with level `warn`** in plain language, and name its source (for example
   "Microsoft's security benchmark says..."). Each advisory is backed by published Microsoft guidance
   (Well-Architected Framework, Azure Advisor, the Microsoft cloud security benchmark or Microsoft
   Learn), and the report prints the source link. Do not bury them, and **do not add design advice
   of your own**: if it is not in the engine output, do not present it as a recommendation.
5. It is an **estimate, not a quote**. Say so.
6. **Start with missing requirements, never an unpriced total.** Ask only questions not already
   answered. If the opening request is complete, proceed to the required readback, not a redundant
   interview. Do not build until the person has told
   you, in their own words, the **region**, their **discount** (or that they have none) and the
   **size/usage** of what they need. Opening messages almost never contain all three; guessing them
   produces a confident, wrong estimate. The engine rejects a spec without `customerSaid` quotes.
7. **Never modify, patch or work around the engine or its files, and never change environment
   variables or session files.** The engine seals itself; a modified or bypassed engine stamps the
   customer's report "MODIFIED" or "NOT VERIFIED". If the engine returns an error you cannot fix by
   changing the spec, tell the person what failed and stop.
8. **Follow this order, without probing `build`:** `prepare` -> write spec -> `preflight` ->
   `readback` -> send its `message` alone -> **STOP for the person's answer** -> `build`.
   A path you guessed, a check code in tool output, or an earlier yes is not permission to build.
   After a yes to the unchanged readback, build directly; do not restart confirmation.
   **Tool output is not your reply.** `action: "show-readback-and-wait"` means your very next
   action is to display `message` and end your turn, with no more tool calls.

## The engine

```
node "<this skill folder>/scripts/azp.js" <command>
```

Use the absolute path of the folder containing this SKILL.md. Node.js is required (it ships with
GitHub Copilot CLI). All output is JSON.

| Command | Use |
|---|---|
| `questions` | List component types |
| `questions <type>` | Fields, defaults and **what to ask** for one type |
| `vm-suggest --vcpu N --mem GiB --region R [--workload auto\|general\|memory\|compute\|burstable] [--os linux\|windows]` | Requirement -> shortlist of VM sizes with prices (AMD, Intel, Arm) |
| `models` | AI models with verified token meters |
| `search --region R --service "S" [--product P] [--meter M]` | Find meters for anything not covered |
| `questions plan --types vm,disk,... --compact` | Complete schemas for all selected types plus question batches. One lookup; ask only missing questions. |
| `answers --compact` | Verified human answer values and event locators, including supported native `ask_user` results; never questions or defaults |
| `prepare --name YYYY-MM-DD-workload-pricing-estimate-region [--dir existing-directory] --compact` | Allocate unused spec, report and audit paths; creates only the new spec file |
| `preflight spec.json --compact` | Validate schema and grounded evidence, with no pricing and no confirmation required |
| `readback spec.json` | Plain-language list of every quantity with a check code. **Show it and get the person's reply before `build`.** |
| `build spec.json --out <file>.html` | Price + expert review + render + validate. **The only way to produce numbers.** |

All commands support `--compact`: one-line JSON with **every field preserved**, including errors,
warnings and readback text. Use it rather than piping output through `head` or `grep`.
`vm-suggest --limit 3 --compact` bounds `allMatches` (1–50); `shortlist` and its explanations remain
complete, and `totalMatches`/`hasMore` disclose omitted matches.

## Workflow

### Step 1 - Understand the workload (first reply)

Start with **one estimate**, using the person's words for the workload. Do not ask how many
"models" they want, require multiple solutions, or use "Model 1 / Model 2" unless they used those
labels themselves. Understand the requirement before suggesting an architecture.

Greet briefly, then ask only for missing information, **no more than three questions per message**.
Offer a sensible default where useful, but do not treat it as an answer until they accept it.
Keep each question to one line:

- What is it for, in plain words? (web app, database, file shares, AI chatbot...)
- Which Azure region? (If they do not know, ask where their users are and suggest one.)
- Do they have a discount off Azure list price, and what does it cover? (If none: 0.)
- Currency, if not US dollars.

### Step 2 - Service-specific questions

Once you know which services are involved, run
`questions plan --types <the component types in this estimate> --compact` **once**. It returns
the complete component schemas under `components` and questions in **batches of at most three**.
Do not also run `questions`, `questions <type>` or `questions context` for those same services.
Use these schemas to write the spec, without repeated lookups or optional-context investigation.
If the opening request is complete, proceed directly to preparation and writing the spec.
Otherwise ask **one missing batch per message**, in everyday language, offering the
default, and skip anything the person already answered. The `context.*` questions (production,
internet-facing, "could it be stopped and restarted?", "will you run this for 1 to 3 years?" ...)
decide which Microsoft guidance applies: record each answer as true or false in `spec.context`.
Never guess an answer; if they are unsure, leave the field out and continue. Context questions
are optional, not prerequisites for a capacity-only estimate. Do not repeat an unknown answer.
Running 730 hours this month does not establish a year or more of steady usage. Set
`steadyUsage: true` only when they stated that longer horizon; a no-long-term-commitment answer
does not establish it. Leave unknown context unset instead of generating commitment advice.
If they authorize documented defaults, list those defaults as assumptions in the readback;
that permission does not turn an unknown context answer into true or false.

Preserve answers as soon as they arrive. `answers --compact` supplies actual human values and
locators for `sources` (see below), including native forms. A value the person supplied, such as
8 vCPUs, is a **known fact**, not an assumption. Do not copy a question, a suggested default,
tool invocation arguments or your own paraphrase into `customerSaid`. If the engine cannot find
a form response, its runtime layout is unsupported: ask the person in a normal message rather
than inventing trusted evidence or reading arbitrary tool output as an answer.

**Every service has a size.** For each component, make sure you have its own quantity from the
person: data *stored* is not data *sent out*; a disk size is not memory. If they gave one number
for two things, ask.

Typical translations:

| They say | You do |
|---|---|
| "a server with 4 CPUs and 16 GB" | `vm-suggest --vcpu 4 --mem 16 ...`; select a fit using their compatibility requirements and explain it; present alternatives only for a meaningful unresolved decision |
| "it needs to be fast" (disk) | `premium-ssd`; if large or precise IOPS, `premium-v2` |
| "just holds data" (disk) | `standard-ssd` |
| "rarely read, keep for years" | blob `Archive` or `Cold` |
| "user file shares" | files `provisioned-v2-hdd` |
| "2.5 million input tokens and 1 million output tokens per month" | openai `inputTokens: 2500000`, `outputTokens: 1000000`; use `models` for supported model IDs, not repeated meter searches |
| "production Kubernetes" | aks `standard` tier + node `vm` + `disk` components |
| "we own Windows licenses with SA" | vm `os: windows-ahb` |
| "no idea how much traffic" | use the default **and** record it under `assumptions` in their words |
| anything public or internet-facing (website, API, downloads) | **ask how much data goes out to the internet per month** and add a `bandwidth` component |
| workload running only part of the day | set `hours`; start with pay-as-you-go, and discuss commitments only if requested or justified by the engine's advice |
| they name an older VM size (for example D4s_v3, DS2_v2, B2ms) | the engine only prices **Current and Extended** sizes. Price the current equivalent from `vm-suggest`, add `replacedSizes`, and tell them why in plain words with the Microsoft references the engine gives you |
| any virtual machine | always include its OS disk (`role: "OS disk"`, 64-128 GiB standard-ssd unless they say otherwise) |

If they do not know a quantity, propose the schema default, get their agreement, and **list it in
`assumptions`**. Never silently invent a number.

### Step 3 - Set the estimate scope

Default to **one solution estimate**. Add alternatives only when requested or when a meaningful,
unresolved choice changes the design. Explain that choice in terms of their requirements before
asking them; do not make them pick Azure part numbers. Do not automatically create AMD, Intel
and Arm options for every server.

Use the customer's labels (for example "Pilot", "Production", "Existing approach", "Managed
service alternative"). Pilot/PoC and production are **deployment phases**, not competing
architectures: keep their quantities and assumptions separate and never call a smaller pilot the
"cheapest solution." Each requested solution or phase is one entry in `options`, named clearly.
Set its `phase` field to the customer's phase label (for example `"phase": "Pilot"`), so unlike
phases are not subjected to like-for-like alternative warnings. If context differs by phase,
record overrides in that entry's `context` (for example `"context": { "production": false }`
for a pilot); otherwise it inherits `spec.context`. Show those differences in the readback.

One `mysql`, `postgres` or `sql-database` component includes its compute and its `storageGB`.
Do not add a second database component just to represent storage; that prices another server.
Use exact catalog identifiers, for example App Service `P1v3`, not `p1v3`.

**Purchasing comparisons:** reservations and savings plans are purchasing choices within the
same solution/phase, not extra architectures. Ask once if a comparison is wanted when the
person requests it or the engine's guidance warrants it; otherwise keep pay-as-you-go. For a VM
comparison, set `"compare": { "commitments": true }` at the spec's top level, alongside `options`,
not inside an option; do not hand-author its variants. There is no option-level `purchasing`
or `commitment` field. Keep exactly one original option per requested solution/phase; a
specific VM term belongs on that VM component's `commitment` field. The engine
retains all eligible 1- and 3-year reservation and savings plan variants, grouped under the
original estimate. Other resources keep their specified purchasing terms; the readback shows
the full scope. Short-runtime VMs are not automatically expanded.

### Step 3b - Confirm the numbers with the readback (required)

**Before writing or reading an estimate spec**, choose fresh paths in the person's working
directory:

```
node "<skill>/scripts/azp.js" prepare --name YYYY-MM-DD-workload-pricing-estimate-region --compact
```

Omit `--dir` to use the current working directory; do not guess a directory from the skill's
installation path. If preparation fails, fix that call before using any spec or report path.
Use only the returned absolute `spec`, `report` and `audit` paths. `prepare` checks all three for
collisions, chooses a numbered suffix when needed, and exclusively creates only the new spec
file. Fill that file with this estimate; never read or reuse an older estimate as this customer's
answers. Reports and audit files are never overwritten, even if another process creates one
after preparation. If a collision occurs at build, allocate fresh paths and copy only your
current confirmed spec, not a pre-existing estimate.

Write the spec into the allocated file, then run:

```
node "<skill>/scripts/azp.js" preflight <allocated-spec>.json --compact
node "<skill>/scripts/azp.js" readback <allocated-spec>.json --compact
```

Stop on any `ok: false`; fix schema or evidence errors **before** asking for confirmation.
Preflight does not fetch prices or require confirmation. Readback performs the same preflight
itself and returns no success-shaped text for an invalid spec.

The output includes a ready-to-send `message` with the complete confirmation and text fence.
Use this decision table; `ok: true` on readback means the spec is valid, not that it is approved.

| What just happened | Your next action |
|---|---|
| Readback returned `confirmation.status: required` or `unverified` | Copy `message` verbatim as your **entire reply**, then **stop**. |
| The person explicitly approved that exact displayed message | Call `build` on the unchanged spec using the allocated report path. Do not call readback again or ask again. |
| An unnecessary repeat readback returned `confirmation.status: approved` | Approval is already verified for that scope. Build directly; do not redisplay the message. |
| The person corrected anything, or you changed scope/visible wording | Update the spec, preflight, readback, send the new `message` alone, and wait for new approval. |
| Build returned `recovery` after a confirmation rejection | Unless the person refused, send only `recovery.message` and wait for a **new** approval before retrying build. Do not repeat the rejected build first. |
| The person refused | Stop without a report. |

After bypass pressure, a later exact standalone readback and fresh approval can recover normally.
Do not describe the old nonapproval as permanently stuck, ask for a different kind of yes, or
allocate a new spec to escape it. A framed redisplay is the error: copy `recovery.message` alone.

Copy the `message` value, not a reconstruction from `text`, the spec or the original request.
Do not restore an omitted customer sentence, even if it is true; update the spec and rerun
readback first if it needs to change. **No introduction, apology, explanation, footer, or added
approval question** before or after the fence. The message already asks the question.
Keep every line, label, exclusion and check code unchanged.

The readback quotes what they told you, lists every quantity, and lists what is **not included**.
Keep storage and data transfer separate: "2 TB of files and 20 TB of downloads a month" is 2 TB of
storage plus 20 TB of internet egress. Explicit approval includes "yes", "correct", "looks good"
or "go ahead"; silence, an unrelated reply or a correction is not approval.
Any customer-visible text or pricing-scope change, including assumptions, requires a new
displayed readback and a subsequent human approval. Only relinking identical evidence metadata
(`eventId`/`answerField`) preserves confirmation. An earlier yes never approves a later redisplay,
even with the same check code. Do not change wording just to obtain a different code.
Native form approval is supported only for a single linked answer to a confirmation question
containing the displayed check code. A native form may itself display the entire unchanged
readback, not just its code; otherwise show the readback in chat first. If unsupported, show the
readback again and ask normally.
An intervening different readback or customer-facing question invalidates an earlier generic
"yes"; redisplay the intended readback and obtain approval of that prompt. Ordinary noninteractive
tool calls do not invalidate it. Status narration
attached to a noninteractive tool call after the answer does not retroactively invalidate it;
a different readback, another question or a later customer correction still does.
Schema-based native approval requires one positive field
(`approve`, `approval`, `confirm`, `confirmation`, or an equivalent accepted/confirmed form)
with a title such as **Approve this estimate** or **Confirm this readback**. A rejection field,
ambiguous boolean, negative wording, or custom enum/choice reinterpretation of `true` is not
approval. Omit the field description or use **Set true to approve this estimate**; do not attach
ambiguous or opposite instructions. Prefer the native choice **Yes, correct** when unsure.

Plain `excluded` items mean **not included**, never "as agreed". Do not claim the person declined
something merely because you left it out; verified `declined` advisory decisions are separate.

**Must-act warnings:** some problems stop the build (`stage: "advice"`), for example an older
server with no disk, or a disk that cannot reach
the stated performance. Fix the spec and show a new readback. If the person, after hearing the
problem, still wants it as is, record their words:
`"declined": [{ "id": "<advisory id>", "customerSaid": "<what they said>" }]`. The engine checks the
quote against the conversation and notes the decision in the report.

### Step 4 - Build

After approval, use the already allocated paths without changing scope or visible text:

```
node "<skill>/scripts/azp.js" build <allocated-spec>.json --out <allocated-report>.html --compact
```

- If `ok` is false with `stage: spec` and `recovery` is present, follow the decision table above.
  Otherwise fix the listed fields, preflight, show the new readback, and obtain new approval.
- If `ok` is false with `stage: advice`, see "Must-act warnings" above.
- If a component failed to price, read the error. It usually means the SKU is not offered in the
  region; choose another from `vm-suggest` or tell the person.
- Save the spec and the HTML in the **current working directory** (the person's folder), not in a
  temporary or session folder, and give the full path when you report back.
- Name files `YYYY-MM-DD-<short-workload>-pricing-estimate-<region>.html`.

### Step 5 - Report back

In plain words, briefly:

1. Copy the build output's `summary` unchanged. It includes **both list and your price** for
   every estimate and purchasing choice; never replace it with only the discounted total.
   Group any purchasing comparisons under their original estimate;
   never add the variants together or rank different phases as cheapest.
2. Each `warn` advisory, one or two sentences each, and what you recommend.
3. The key assumptions from `facts.assumptions` and assumption-kind `facts.sources` they should
   check. Customer-kind sources are known answers; never relabel them as guesses.
4. Where the HTML file and companion `.estimate.json` audit file are. The self-contained HTML
   opens on Summary, with a detail tab per requested solution/phase and an Assumptions tab for
   discount rules, scope, next steps and sourced guidance. Warnings remain visible outside the
   tabs. Five-column detail tables show monthly list and your price; exact meter quantities,
   rate units and unit prices remain in the audit file. Printing includes every tab.

Do not reopen settled design questions or propose extra solutions just to fill the report.
Use `facts.customerSaid`, `facts.sources`, `facts.notIncluded`, totals and advisory bodies as the
source for the final narrative. Do not invent assumptions, agreement, advice or missing quantities.

### Conversation examples (wording, not a script)

- **A simple request:** "I need an estimate for a small internal app." Ask about missing workload,
  region and discount first (at most three questions), then the relevant usage questions. Do not
  ask "How many models?" or present a menu of architectures.
- **Already complete:** "Price one Linux server, 4 CPUs, 16 GB, 128 GB disk, all month in East US 2,
  no discount, USD." Skip those questions. Clarify only material gaps, then show the engine's
  readback and wait for confirmation.
- **A real choice:** "Can we keep the app on a server or use a managed service?" Clarify requirements,
  then compare those two named alternatives on like-for-like scope; do not invent a third.
- **Phases:** "Show a pilot and production." Ask which quantities or availability requirements
  change between them; retain those labels and separate totals. Do not recommend the pilot just
  because it costs less.
- **Purchasing:** "What about a three-year savings plan?" Explain it as a purchasing comparison
  within the existing estimate. The current comparison engine includes all supported VM terms,
  not just the requested term; say so before the readback, and do not silently drop any variant.

## VM sizes: Current and Extended only

The engine refuses any VM size that Microsoft lists as End of Life or retired (for example Dv3,
Dsv3, Ev3, Esv3, Dv2, B-series v1, F/Fsv2, Av2, Lsv2). If the person names one:

1. Explain in plain words, using the engine's message: Microsoft lists it as End of Life; new
   subscriptions can't deploy it and more quota can't be requested; existing subscriptions can keep
   using already-approved quota; Dv3, Dsv3, Ev3 and Esv3 retire on November 15, 2029. Give the links
   the engine returns.
2. Run `vm-suggest` with the same vCPU and memory and price that size instead.
3. Add `"replacedSizes": [{ "requested": "Standard_D4s_v3", "priced": "Standard_D4as_v5" }]` to the spec.
   The readback and the report show the swap and the references.
4. After the build, use `explainToPerson` from the engine output: explain the replacement in your
   reply **and include its Microsoft links**.

## Spec format

```json
{
  "title": "Internal web app",
  "region": "eastus2",
  "currency": "USD",
  "discountPct": 16,
  "discountExcludes": [],
  "customerSaid": {
    "region": "we're in East US 2",
    "discount": "16% off list on everything",
    "requirements": "2 CPUs and 8 GB like the old server, 128 GB disk, runs all the time"
  },
  "context": { "production": true, "internetFacing": false, "steadyUsage": true },
  "options": [
    {
      "name": "Internal web app",
      "label": "AMD, 2 vCPU, 8 GiB",
      "summary": "One server for the internal web app.",
      "components": [
        { "type": "vm", "sku": "Standard_D2as_v5", "os": "linux", "count": 1, "hours": 730, "label": "Virtual machine" },
        { "type": "disk", "diskType": "standard-ssd", "sizeGiB": 128, "role": "OS disk", "label": "Storage" }
      ]
    }
  ],
  "assumptions": [],
  "excluded": ["backup", "support plan"],
  "nextSteps": ["Confirm whether the workload needs Premium SSD performance."]
}
```

- `discountPct` is required (0 if none). `discountExcludes: ["licenses"]` if the discount does not cover OS/SQL licenses.
- `customerSaid` is required: short quotes of what the person actually told you about region,
  discount and requirements. It appears in the report so they can check you understood them.
  Prefer a complete verbatim passage, not sentences assembled from memory.
- `customer` is optional: omit it unless the person supplied a customer name. Never use an example
  company name or workload description as their identity. Known answers (including no discount
  and explicit exclusions) are facts, not `assumptions`.
- Optional `sources` preserves field-level provenance without changing existing specs. For
  example, after `answers` returns an actual native vCPU response:
  `{"field":"options[0].components[0].vcpu","kind":"customer","customerSaid":"8","eventId":"<actual completion event ID>","answerField":"vcpu"}`.
  Use the exact field and value from the engine's answer record. `answerField` is required for a
  schema-based native form (even a single field), omitted for a normal message or a native choice. Customer sources
  must match an actual human event; they cannot quote defaults. Supported fields are `region`,
  `currency`, `discountPct`, `context.*`, `options[i].context.*` and scalar component fields.
  VM `vcpu`/`memGiB` are derived from the chosen SKU, so an 8-vCPU answer cannot ground a
  16-vCPU SKU. Record inferred SKU selection separately from the person's CPU/memory answers.
  For an accepted default, use
  `{"field":"options[0].components[1].sizeGiB","kind":"assumption","reason":"Proposed OS disk size"}`.
  The readback, build facts, HTML and audit retain the distinction. Specs without `sources`
  remain supported; adding customer sources requires readable, verified conversation evidence.
  Do not generate a source row for every field. Add one only when an actual answer can verify
  that scalar value. Translations such as "two" -> `2`, "pay as you go" -> `payg` or
  "Standard SSD" -> `standard-ssd` belong in the spec with their real wording in `customerSaid`,
  not fabricated literal source quotes. If a translated source row fails, omit that optional
  row, not the real customer quote; never relabel a known customer requirement as an assumption.
  Do not invent event IDs or convert words such as "prototype" into a fabricated quote of
  "false". Boolean customer-source entries require an actual literal true/false answer; omit
  that optional source entry when the engine cannot verify it. Keep the person's real words
  in `customerSaid` regardless.
- `label` on a component groups lines in the itemization (Virtual machine, Storage, Networking...).
- Component types and fields: run `questions <type>`. Unknown fields are rejected, so check the schema.
- The `options` array is an internal spec field, not a requirement to offer multiple solutions.
  One entry is normal. The engine carries explicit original-estimate IDs and purchasing labels
  into the priced results; the renderer never parses the option name to discover relationships.
- `phase` optionally labels a deployment phase. `context` on an option overrides matching global
  workload context fields for option-level advisories; estimate-wide guidance still uses global
  context. It uses the same boolean schema.
- `special: true` on an option marks it as a special case in its detail heading.
- For anything not covered, use `{ "type": "meter", "filter": {"serviceName": "...", "productName": "...", "skuName": "...", "meterName": "..."}, "quantity": N, "hours": 730 }` after finding the exact names with `search`. Tell the person that line was priced from a generic meter.

## Advice comes from the engine, with Microsoft sources

Every recommendation in the report comes from `catalog/rules.json`, where each rule cites a
published Microsoft source and quotes it verbatim. Run `azp rules` to see them. Explain the
advisories the engine returns; do not add your own. Set `context.production: true` and
`context.internetFacing: true` in the spec when the person says so, because some reliability
guidance applies only to production or internet-facing workloads.
