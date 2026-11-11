<p align="center">
  <img src="icon.svg" alt="azure-pricing-skill logo" width="128" height="128">
</p>

# azure-pricing-skill

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js >= 18](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org/)

> **Ask "how much would this cost in Azure?" and get a finished, itemized estimate.** Your AI
> agent asks a few plain-language questions; a deterministic pricing engine pulls live Azure
> retail prices, applies your discount, checks the design against published Microsoft guidance,
> and hands you one self-contained HTML estimate.

`azure-pricing-skill` is an **agent skill** for GitHub Copilot (and other agents that read skills
from `.github/skills/` or `~/.copilot/skills/`). It is built for people who are new to Azure: they
describe what they need, not SKU names, and the skill does the rest.

## Contents

| | Section | |
|---|---------|---|
| 🚀 | [Quick start](#quick-start) | Install + first estimate in two steps |
| 📦 | [Installation](#installation) | Prerequisites and 5 install options |
| 💬 | [How it works](#how-it-works) | What the conversation looks like |
| 🤖 | [Which AI model to use](#which-ai-model-to-use) | Recommended, workable and blocked models |
| ✅ | [Why you can trust the numbers](#why-you-can-trust-the-numbers) | Engine math, readback, verified answers |
| 📚 | [Advice backed by Microsoft guidance](#advice-backed-by-microsoft-guidance) | 97 cited rules |
| 🖥️ | [VM sizes: Current and Extended only](#vm-sizes-current-and-extended-only) | End of Life sizes are never priced |
| 🧩 | [Coverage](#coverage) | 21 services in depth, any other service via the generic meter |
| ⚠️ | [Limits](#limits) | What it is and is not |
| 🛠️ | [CLI reference](#cli-reference) | Setup commands |
| ⚙️ | [Advanced](#advanced-running-the-engine-directly) | Running the engine directly |
| 🧪 | [Testing](#testing) | How it was tested |
| 📁 | [Repository structure](#repository-structure) | File tree |
| 🔒 | [Privacy & data](#privacy--data) | What it reads and sends |
| 📄 | [License](#license) | MIT |

---

## Quick start

**1. Add the skill** (one command, runs straight from GitHub):

```bash
npx github:chrislittle/azure-pricing-skill init --global
```

> The `npx` commands in this README are identical in **bash**, **zsh**, and **PowerShell**.

**2. Ask your agent.** Newer and untested models work without a warning; only the explicitly
blocked models cannot build (see [Which AI model to use](#which-ai-model-to-use)):

> **You:** *"How much would a Red Hat server with 64 GB of RAM and 2 TB of storage cost in East US 2?
> We get 16% off list."*
>
> **Agent:** *…asks a couple of questions, shows you the numbers to confirm, prices it…* →
> hands you **one tabbed HTML estimate**. A single solution is normal; alternatives are included
> only when requested or needed to resolve a real design choice.

---

## Installation

### Prerequisites

- **[Node.js 18+](https://nodejs.org/)**, the only requirement (it ships with GitHub Copilot CLI).
  Check with `node --version`.
- **Internet access to `prices.azure.com`.** No Azure sign-in, subscription or API key is needed.
- **An AI agent** that reads skills from `.github/skills/` or `~/.copilot/skills/` (for example
  GitHub Copilot CLI).

`init` checks these for you.

### Option A: Global install (recommended)

Available in every folder you work in:

```bash
npx github:chrislittle/azure-pricing-skill init --global      # -> ~/.copilot/skills/azure-pricing
```

### Option B: Project install

Adds the skill to the **current** repo under `.github/skills/azure-pricing`. **cd into your repo first:**

```bash
cd my-repo
npx github:chrislittle/azure-pricing-skill init
```

### Option C: Explicit path

```bash
npx github:chrislittle/azure-pricing-skill init --dir /any/path/azure-pricing
```

### Option D: Global command via npm

```bash
npm install -g github:chrislittle/azure-pricing-skill

azure-pricing-skill init --global
azure-pricing-skill status
azure-pricing-skill --version
```

### Option E: Manual install (offline / no npx)

Copy the repo into your agent's skills folder.

**bash / zsh (macOS, Linux):**

```bash
git clone https://github.com/chrislittle/azure-pricing-skill.git
mkdir -p ~/.copilot/skills/azure-pricing
cp -r azure-pricing-skill/{SKILL.md,MANIFEST.json,scripts,catalog,assets} ~/.copilot/skills/azure-pricing/
```

**PowerShell (Windows):**

```powershell
git clone https://github.com/chrislittle/azure-pricing-skill.git
$dest = "$env:USERPROFILE\.copilot\skills\azure-pricing"
New-Item -ItemType Directory -Force -Path $dest | Out-Null
foreach ($i in 'SKILL.md','MANIFEST.json','scripts','catalog','assets') { Copy-Item "azure-pricing-skill\$i" $dest -Recurse -Force }
```

### Verify

```bash
npx github:chrislittle/azure-pricing-skill status     # install locations, versions, prerequisite check
```

---

## How it works

You never write a spec or run a command. In conversation:

1. Say what you want to price, in your own words.
2. Answer only missing requirements, at most three questions at a time: region, discount, size
   and usage, and whether it is production, internet-facing, and so on. No Azure part numbers
   required, and no "how many models?" question.
3. **Check the readback.** Before anything is priced, the engine preflights the spec and grounded
   answers. The agent shows every quantity in plain words, next to what you told it, plus what is
   *not included*, and waits for explicit approval. Corrections need a new readback and approval.
4. Get one self-contained HTML estimate with a navy header and blue accents: a **Summary**
   comparison first, a detail tab per requested solution or deployment phase, and **Assumptions**
   for discount rules, scope, next steps and sourced guidance. Warnings stay visible outside the
   tabs; printing includes every tab. Keyboard navigation and direct links work too, and all
   content remains readable without JavaScript.

Start with one estimate. If you ask for a pilot and production, they remain separate deployment
phases, not competitors ranked by price. If you ask for alternatives, use your own labels.
Reservation and savings-plan comparisons sit **within** the same estimate, not as new
architectures. The existing VM comparison includes all eligible 1- and 3-year terms.

Detail tables have five customer-facing columns: service/description, quantity, unit, monthly
list and monthly your price. Resource counts are separated from hours where explicit component
facts support that display; usage meters keep their actual quantities and units. The companion
`.estimate.json` retains exact meter quantities, rate units and unit prices for audit.

A real exchange from testing (shortened):

> **Customer:** *Please price a Standard_D4s_v3 Linux VM in Central US — that's what we use today.*
>
> **Agent:** *…questions about region, discount, disk and usage, then a readback…*
>
> **Agent:** **Why not D4s_v3:** Microsoft lists Dv3/Dsv3 as End of Life. New subscriptions can't
> deploy them and you can't get more quota; existing quota can keep running until Nov 15, 2029.
> This estimate uses current 4 vCPU / 16 GiB sizes instead. *(links to the three Microsoft Learn
> lifecycle pages)*
>
> | Option | List / mo | Your price / mo |
> |---|---:|---:|
> | Arm Standard_D4ps_v6 | $124.94 | **$104.95** (lowest) |
> | AMD Standard_D4as_v7 | $142.46 | $119.66 |
> | Intel Standard_D4s_v5 | $168.01 | $141.12 |

## Which AI model to use

The prices always come from the engine, but the conversation (asking the right questions, reading
back the numbers, explaining warnings) depends on the model. **New models work without a warning;
availability is not a test result.** Version 1.4 tracks a 22-model current roster, including preview
models and a separately labeled internal-only entry, in [`catalog/models.json`](catalog/models.json).

**Final-candidate matrix, 11 November 2026: 379 of 380 conversations passed (99.7%).**
All 19 models ran the same 20 cases on sealed runtime `63f498d70187cbea`; **18 passed all 20**.
GPT-6.1 Sol, Claude Sonnet 5.5, Gemini 4 Argon and Gemini 3.8 Flash are fully passing choices
for this bounded workflow. The
[complete results](tests/models/release-matrix-results.json) and
[case review](tests/models/release-matrix-review.json) preserve the sole failure.

| Latest passes / 20 | Models |
|---|---|
| **20** | GPT-6.1 Sol, GPT-6.1 Terra, GPT-6 Sol, GPT-6 Luna, GPT-5.6 Sol, GPT-5.6 Sol Fast (internal only), GPT-5.6 Terra, GPT-5.6 Luna, GPT-5.3-Codex, Claude Sonnet 5.5, Claude Sonnet 5, Claude Haiku 5.5, Gemini 4 Argon, Gemini 3.8 Flash, MAI-Code-2-Flash (preview), MAI-Code-1.1-Flash, Grok 4.7, Grok 4.6 |
| 19 | Claude Haiku 4.5 |

All **360 produced reports passed every existing check**, all 19 refused approvals stopped
without artifacts, and no premature build attempt occurred. All six preceding full-run failures
passed. The remaining flag is a different Haiku 4.5 RHEL scope error: it supplied plain Linux plus
a hand-authored generic license meter instead of the supported RHEL VM recipe. Scope checking
stopped that trial before approval or report creation. **Haiku 4.5 is not one of the fully passing
recommended choices; this is not an all-green certification.** No failure was retried or waived.
The runner's nonzero exit records that genuine failure, not an incomplete matrix.

The separate
[native approval-to-report check](tests/models/release-native-smoke.json) passed on this runtime,
including an independent check of the corrected Windows license-discount totals.
The completed scores below are preserved historical evidence from earlier runtimes.

**Earlier targeted remediation, 11 November 2026: all six flagged pairs and 16 controls passed
(22/22)** on runtime `c5a3ea7b9f856aad`. All 18 reports followed explicit approval and passed the
existing checks; four refusals stopped without artifacts. No premature build or confirmation
rejection occurred. Recovered spec/source-input errors remain recorded. The changes improve
recovery diagnostics, reject misplaced purchasing fields, supply a copyable list/customer totals
summary, and consolidate schema lookups. Both previously timed-out Grok cases finished within
the unchanged four-minute limit; model-side stalls can still recur.
The [paired result](tests/models/workflow-remediation-followup-results.json),
[selected sample](tests/models/workflow-remediation-results.json) and
[review](tests/models/workflow-remediation-review.json) remain separate from the complete matrices.
This sample does not recertify every model or fix all free-form narrative/context errors.

**Preceding complete matrix, 11 November 2026: 374 of 380 conversations passed (98.4%).** All 19
models ran the same 20 cases on one unchanged revised skill and test driver. **Fifteen models passed
all 20 cases.** This result belongs to runtime `5a098d6dc023fddb`, not the final candidate.

The run produced **357 reports**, of which **355 passed every check**, plus 19 correctly stopped
refused-approval conversations. All 357 reports passed the existing artifact checks. Two
conversations with valid reports still failed: Haiku 4.5 omitted the list total from its final
chat, and MAI-Code-1.1-Flash attempted build before displaying the readback or obtaining approval.
The engine rejected that early call; its eventual report followed exact confirmation and approval.
Four flags produced no report: Sonnet 5 got stuck in confirmation recovery, Haiku 4.5 supplied
the wrong purchasing-comparison scope, and two Grok 4.7 cases timed out at the unchanged four-minute
limit. No successful unapproved report build was observed. The
[preceding evidence](tests/models/confirmation-matrix-results.json) and
[case review](tests/models/confirmation-matrix-review.json) retain every outcome.

The [previous full run](tests/models/reliability-matrix-results.json) on 10 November passed
**376/380**, with four flags and 16 fully passing models. The new full run passed three of those
four flagged pairs, but MAI's premature attempt recurred and five previously passing pairs were
flagged. That score was two passes lower; those historical limitations are not waived.
The [previous review](tests/models/reliability-matrix-review.json) remains unchanged.

**Preceding confirmation follow-up, 11 November 2026:** runtime `5a098d6dc023fddb` passed all four flagged
pairs and 12 controls (**16/16**), including three refusals, three corrections and three
approval-pressure cases. All 13 reports followed explicit approval; no premature build attempt
or confirmation rejection was recorded. The [paired comparison](tests/models/confirmation-followup-results.json),
[complete selected sample](tests/models/confirmation-targeted-results.json) and
[review](tests/models/confirmation-followup-review.json) preserve this separately. This is not a
replacement full matrix or a guarantee against future failures, as the subsequent full run shows.
Narrative quality also remained imperfect in that sample: Haiku labeled a known Windows license
requirement as an assumption.

The [pre-reliability full run](tests/models/final-matrix-review.json) recorded 369/380 passes.
After the changes, **all 11 previously failing cases passed the targeted sample**, along with
**all 13 passing controls**, including seven refused approvals. The [paired follow-up](tests/models/reliability-followup-results.json)
and [review](tests/models/reliability-followup-review.json) preserve that separate 24-case sample.
The 10 November full run passed 10 of the original 11 failures, while three different previously
passing cases were flagged. The driver, cases, grading and limits are unchanged; approval
requirements were not relaxed. Results are not combined into a synthetic 380/380 score.

These are **bounded-workflow results, not unrestricted-shell certification** or independent
pricing-oracle checks of every report. A passing model can still fail on another run; narrative
advice is not fully semantically assessed. No additional models are blocked automatically.
MAI-Code-2.x1 and the two HydraFusion previews remain excluded and untested.

**Historical pricing caveat:** the final-candidate review found and fixed a Windows/RHEL
license-exclusion defect that the earlier workflow artifact checks did not detect. Those checks
confirmed engine arithmetic and relayed totals, not independent correctness of every price.
For the canonical Windows case, list remains **$538.96/month**, but the correct discounted
price is **$495.71**, not the earlier **$535.89**. Historical scores and reports remain unchanged;
the [independent pricing review](tests/oracle/license-discount-review.json) records the correction.

Earlier evidence remains available: the [initial 340-case matrix](tests/models/matrix-results.json)
and [checker review](tests/models/matrix-review.json) recorded 257 reviewed passes and 83 flags;
the [targeted follow-up](tests/models/approval-followup-review.json) resolved 79 of those flags;
the [separate Gemini run](tests/models/gemini-review.json) passed 40/40. Those sampled results
are historical, not scores to combine or substitute for the latest full run. The
[initial two-case pilot](tests/models/pilot-results.json) is also retained.

**Historical ratings, 1 October 2026** (not re-certified for 1.4):

| | Models |
|---|---|
| **Recommended** | GPT-5.5, Claude Sonnet 5, Grok 4.5, GPT-5.4-mini |
| Works, less consistent | GPT-5-mini, Claude Haiku 4.5 |
| **Blocked** | Gemini 3.5 Flash: in testing it repeatedly worked around the skill's safeguards, including forging the conversation record. The skill refuses to build an estimate with it. |

"Auto" resolves to the actual responding model. The engine records every detected participant in
the audit and uses the least-tested status for the estimate, so an older acceptable model cannot
hide a newer untested participant. A blocked model anywhere in the session remains blocked;
switch models and start a fresh session. Unknown future models stay usable without a warning.
Those audit status labels refer to the historical rating groups; current bounded-workflow
scores are reported separately above.

## Why you can trust the numbers

- **The model never does the math.** The engine computes every price from live
  [Azure Retail Prices API](https://learn.microsoft.com/rest/api/cost-management/retail-prices/azure-retail-prices)
  data: units (per hour, per 10K, per 1M), free grants, graduated tiers, reservations and savings
  plans, licenses, discounts and rounding. The model cannot write a number into the estimate.
- **Readback before pricing.** In Copilot, the engine will not build until the person has seen the
  readback for the exact scope and visible wording and explicitly approved it. Changes to
  assumptions or displayed text require a new readback and subsequent approval; evidence-only
  relinking does not.
- **Verified answers.** The region, discount and requirements on the estimate must match what the
  person actually typed; the engine checks the conversation record. Optional field-level `sources`
  also preserve supported linked native `ask_user` answers. Questions, defaults and arbitrary tool
  output are not human evidence; unsupported layouts fail verification rather than inventing it.
  Customer-supplied values are reported separately from assumptions.
- **Fresh files.** `prepare` allocates collision-free paths before the spec is written or read;
  build refuses to overwrite an existing report or audit. Plain exclusions say "not included",
  not "as agreed".
- **Itemization that adds up.** List and your price side by side; every line rounded, totals are the
  sum of the lines. Exact meter quantities and full unit-price precision remain in the companion
  audit file rather than cluttering the five-column customer table.
- **Stamped.** Every estimate states whether the answers were verified, the engine fingerprint, and
  the AI model used.

## Advice backed by Microsoft guidance

Every warning and note in an estimate comes from [`catalog/rules.json`](catalog/rules.json), and
every rule cites published Microsoft guidance with a verbatim quote: the
[Azure Well-Architected Framework](https://learn.microsoft.com/azure/well-architected/), the
[Microsoft cloud security benchmark](https://learn.microsoft.com/security/benchmark/azure/),
Microsoft Learn product documentation and Azure pricing pages. The source link prints next to each
warning in the estimate.

- **97 rules**, built from a review of **1,442** published recommendations (every design checklist
  item and configuration recommendation in the Well-Architected service guide for each priced
  service, the Cost Optimization checklist, the Azure Advisor recommendation references and the
  relevant security benchmark controls). Recommendations that need a running system, or that do
  not affect an estimate, are not rules.
- **No citation, no rule.** The engine refuses to load a rule without a complete citation.
- **Checked live.** `node scripts/azp.js check-citations` fetches every cited page and confirms the
  quoted sentence is still there.
- **Fits the workload.** Reliability guidance (zone redundancy, high availability, multiple
  instances) applies only when the person says the workload is production or must survive a
  datacenter failure, so a dev/test estimate is not buried in warnings.

## VM sizes: Current and Extended only

The engine prices only VM size series in Microsoft's **Current** or **Extended**
[lifecycle stages](https://learn.microsoft.com/azure/virtual-machines/sizes/lifecycle/lifecycle-overview),
which Microsoft describes as fully supported. Every series on the
[End of Life list](https://learn.microsoft.com/azure/virtual-machines/sizes/lifecycle/end-of-life-sizes-list)
or already retired (for example Dv3, Dsv3, Ev3, Esv3, Dv2, B-series v1, F/Fsv2, Av2, Lsv2) is refused.
If someone asks for one, the agent explains why, quoting Microsoft (new subscriptions can't deploy
the series, more quota can't be requested, existing quota still works, Dv3/Dsv3/Ev3/Esv3 retire on
November 15, 2029), and prices the current equivalent instead.

## Coverage

The engine prices Azure services in two tiers.

**Tier 1, dedicated recipes (deep coverage).** These services have their own interview questions,
correct units, graduated tiers and free grants, cited Microsoft advice, and prices checked against an
independent oracle:

VMs (Linux, Windows, Windows with Azure Hybrid Benefit, Red Hat, SUSE; pay-as-you-go, 1- and 3-year
reservations, 1- and 3-year savings plans), managed disks (Standard HDD, Standard SSD, Premium SSD,
Premium SSD v2), public IPs, internet egress, Standard Load Balancer, Application Gateway v2, AKS,
App Service, Azure Functions (Consumption, Flex Consumption), Container Apps, Azure SQL Database,
SQL Managed Instance, PostgreSQL and MySQL flexible server, Cosmos DB, Blob storage, Azure Files,
Log Analytics and Azure OpenAI models.

**Tier 2, generic meter (any other service).** Anything else in the Azure Retail Prices API, for
example Key Vault, Azure Backup, Redis, Event Hubs, Azure Bastion, VPN Gateway, Azure Firewall,
Data Factory or AI Search, can be priced: the agent finds the exact meter with `azp search` and the
engine prices it live and adds it to the itemization. This tier is weaker than tier 1: the agent has
to choose the right meter and quantity, there are no service-specific questions or advice, and these
prices are not covered by the oracle tests. The estimate labels these lines as priced from a generic
meter.

**Roadmap:** the goal is tier 1 coverage in line with the
[Azure Pricing Calculator](https://azure.microsoft.com/pricing/calculator/), adding dedicated
recipes service by service.

Prices are available in any currency the Retail Prices API supports.

## Limits

- **An estimate, not a quote.** It applies one discount percentage (optionally excluding licenses);
  real agreements can differ by service.
- **Not modeled:** support plans, Marketplace software, Data Zone or provisioned AI deployments,
  ExpressRoute, VPN gateways, Azure Firewall and Backup (these can be priced through the generic
  meter component).
- **The readback is only as good as the person reading it.** It shows every number; it cannot make
  someone check them.
- **Local safeguards are tamper-evident, not tamper-proof.** The skill runs on your machine, so a
  model with shell access can, in principle, work around its checks. That is why the model is
  detected and stamped, and why some models are blocked.

## CLI reference

The bundled CLI is only for **setup**; you never use it to make estimates.

| Command | What it does |
|---------|--------------|
| `init [--global\|--dir <path>] [--force]` | Install the skill |
| `update` | Re-install the latest over existing installs (project and global) |
| `status` | Show install locations, versions and prerequisite check |
| `doctor` | Check Node.js and access to `prices.azure.com` |
| `uninstall [--global\|--dir <path>]` | Remove an install |
| `--version` | Print version |

Run any of them as `npx github:chrislittle/azure-pricing-skill <command>`.

### Updating

```bash
npx github:chrislittle/azure-pricing-skill update
```

### Uninstalling

```bash
npx github:chrislittle/azure-pricing-skill uninstall --global   # global
npx github:chrislittle/azure-pricing-skill uninstall            # project
```

---

## Advanced: running the engine directly

You almost never need this; the agent runs it for you. The engine is a plain Node script with zero
dependencies, and every command prints JSON:

```bash
node scripts/azp.js questions                        # component types
node scripts/azp.js questions plan --types vm,disk   # the interview, three questions at a time
node scripts/azp.js vm-suggest --vcpu 4 --mem 16 --region eastus2 --limit 3 --compact
node scripts/azp.js answers --compact                # verified human answer values/locators
node scripts/azp.js prepare --name 2026-11-09-app-pricing-estimate-eastus2 --compact
# Fill the newly allocated spec path, then use those returned paths:
node scripts/azp.js preflight <allocated-spec>.json --compact  # no pricing or confirmation
node scripts/azp.js readback <allocated-spec>.json --compact   # display text, wait for approval
node scripts/azp.js build <allocated-spec>.json --out <allocated-report>.html --compact
node scripts/azp.js rules                            # every rule with its Microsoft source
node scripts/azp.js check-citations                  # verify every quote against the live page
```

`--compact` minifies JSON without dropping fields, errors, advisories or readback text. VM
`--limit` (1–50) bounds only `allMatches`, with `totalMatches`/`hasMore`; it never trims the complete
processor shortlist or explanations. Do not pipe structured output through `head`/`grep`.
Use build's engine-generated `facts` for the final narrative rather than inventing assumptions.
See `SKILL.md` for field-level `sources`, accepted native evidence and confirmation rules.

The spec format and the full interview are documented in [`SKILL.md`](SKILL.md).

## Testing

```bash
npm test                     # offline models/workflow/session/installer, reports, invariance, rules, oracle last
npm run test:workflow         # deterministic fixtures: evidence, preflight, confirmation, files, CLI
npm run test:report           # focused rendering, purchasing lineage and readback tests
npm run check-citations      # every citation fetched and its quote found
```

For real-model trials, install the development dependencies with `npm install`. The pinned Copilot
SDK requires Node.js ^20.19.0 or >=22.12.0 and authenticated Copilot access; the shipped skill still
requires only Node.js 18+ and has no runtime dependencies. The runner uses an existing token from
`COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, or `GITHUB_TOKEN`, otherwise `gh auth token`, in memory only.
It does not copy your personal Copilot configuration or credentials into the test home.

```bash
npm run test:models -- --list                           # live catalog discovery only; no model inference
npm run test:models -- --list-cases                     # show the 20 cases; no authentication or inference
npm run test:models -- --models gpt-6.1-sol,claude-sonnet-5.5 --jobs 4
npm run test:models -- --models gpt-6.1-sol --scenarios blob-correction --timeout 240
npm run test:models -- --all --jobs 4                   # all 20 cases on every available roster model
npm run test:models -- --all --jobs 4 --resume "<run-directory>"
npm run test:models -- --cases-from failed-pairs.json --jobs 4
npm run test:models -- --models gemini-4-argon,gemini-3.8-flash --try-unlisted --jobs 4
```

Trials consume AI credits: 20 conversations per selected model unless `--scenarios` limits them.
They run sequentially by default; `--jobs 1..8` controls concurrency. Each conversation has a
four-minute deadline by default and at most eight customer turns. There is no implicit full-matrix
run. `--all` includes
preview and internal-only targets; their labels remain in the results. Each case gets a fresh
session, copied sealed runtime, and workspace. Raw transcripts, session logs, reports, audit files,
and incremental results stay under ignored `.cache/model-tests/`. Resume preserves completed cases,
including failures; it never silently reruns or overwrites them. A changed runner, scenario set or
skill cannot be resumed into the same result set. Failures, timeouts and requested
unavailable models return a failing exit status. Missing models are never silently substituted.
For a targeted rerun, `--cases-from` reads a nonempty JSON array such as
`[{"model":"gpt-6.1-sol","scenario":"blob-correction"}]`; it cannot be combined with `--models`,
`--all` or `--scenarios`. Duplicate or unknown case selections fail explicitly. The result records
the exact planned pairs, including prior selections on resume, rather than pretending every
selected model was asked to run all 20 cases.
The first SDK catalog discovery exposed 17 of the 22 targets; Gemini 4 Argon, Gemini 3.8 Flash,
MAI-Code-2.x1 and both HydraFusion variants were absent from that authenticated SDK catalog.
Availability can differ from the interactive picker and is rechecked on every run; MAI-Code-2.x1's
ID remains unset until discovery can resolve its actual display name. Later explicit Gemini
requests succeeded, and both Gemini models completed the suite; the initial discovery list is
not an access verdict.

For a known model ID confirmed in an interactive session but absent from discovery,
`--try-unlisted` permits a direct attempt with explicit `--models` or `--cases-from` selection.
It does not override an explicitly disabled catalog entry, resolve unknown IDs, or apply to
`--all`. Discovery and inference use separate isolated runtime processes in this mode: catalog
discovery was observed to cache a shorter model list than direct session creation accepts.
The backend must accept the requested model, and every trial must independently confirm that
exact model in its persisted conversation log; a greeting or successful session creation alone
is not a pricing-test pass. Per-session tool restrictions and isolated homes remain unchanged.
The development `write_spec` adapter takes `file` and a JSON-encoded `spec` string. This avoids
malformed nested component payloads observed with Gemini's open-object tool schema; the adapter
decodes the string without altering scope and explicitly rejects malformed JSON. The unmodified
engine still performs all spec, evidence and approval validation.

Readback output now includes a ready-to-send fenced `message`, so the assistant need not
reconstruct the confirmation. A confirmation-related build rejection provides the same message
under `recovery`; it still requires a new human approval and cannot reuse an earlier yes.
Readback also reports `confirmation.status`: `approved` only when the conversation already
contains the exact displayed scope and subsequent approval, otherwise `required` or `unverified`.
An unnecessary repeat lookup can therefore direct the agent to build instead of starting another
confirmation loop. Build independently rechecks approval; a readback tool result alone never
grants it. The skill uses an explicit prepare/write/preflight/display/wait/build sequence and
requires customer names to come from the person, not a sample company name.
Field-level source validation recognizes sentence punctuation and explicit million/billion
quantities while preserving human event linkage and exact native-answer checks. OpenAI usage
fields require actual token counts, with an additional check for unambiguous single-model scale
mistakes in quoted requirements. These changes do not relax confirmation or grading.

The expanded suite covers Linux/Windows/RHEL VM sizing and licensing, PostgreSQL, SQL Database,
MySQL, Blob capacity versus internet transfer, Azure Files, Cosmos DB, App Service instance counts,
Container Apps request totals, log retention, AI token units, all five VM purchasing choices,
pilot/production phases, EUR pricing, customer corrections, missing inputs, refused approval and
pressure to bypass confirmation. Scopes are matched by customer requirements, not component order
or a single hard-coded VM SKU. Priced audit scopes must match too.

Grading checks final scope, an unchanged displayed readback followed by approval, correction
handling, actual model identity, verified customer answers, runtime integrity, complete pricing,
engine math/HTML checks and relayed totals. The refusal case must stop without creating a report;
trying to build before approval fails even if the engine prevents it. Link checks are deliberately skipped.
It is not a full assessment of narrative quality, advisory explanation or shell-level safeguard
compliance. Passing these cases is evidence for this bounded workflow, not unrestricted-shell
certification. The [discovery investigation](tests/models/discovery.json) records the unresolved
preview targets and the separately resolved Gemini catalog discrepancy.
The [normal CLI smoke check](tests/models/native-cli-smoke.json) additionally exercised
GPT-6.1 Sol customer correction and Gemini 4 Argon refusal/fresh approval using native tools and
real report builds on the prior runtime. It used prompt/resume with scripted replies, not manual
terminal UI or native form testing, and remains separate from the SDK matrix. A revised-runtime
[native confirmation check](tests/models/reliability-native-smoke.json) verified Sonnet 5.5's exact
initial message and no unapproved report; its approval-to-report continuation could not obtain
tool permission and remains historical incomplete evidence. With fresh permission on 11 November,
a [new native check](tests/models/confirmation-native-smoke.json) on that preceding sealed runtime completed
Sonnet 5.5's exact Azure Files readback, explicit approval and one report build. Answers were
verified, the copied engine remained intact, and all four default URL checks passed. The launcher
first needed its native file-tool names corrected, and a malformed edit recovered; both errors
are preserved. This is scripted native prompt/resume evidence, not manual UI or native-form
certification, and does not erase the earlier incomplete check.
The final candidate now has a [new native Windows check](tests/models/release-native-smoke.json)
on runtime `63f498d70187cbea`: exact standalone readback, no artifacts before approval, one
subsequently approved build, verified answers, intact runtime, both correctly relayed totals and
two default URL checks. A malformed edit and a denied read/schema-inspection command were
recorded; the denied command was not granted broader permission. The model continued with its
already permitted native tools. The independent Windows price check agrees at $538.96 list and
$495.71 customer price. This is scripted native prompt/resume evidence, not manual UI or native
form certification. The final candidate's separate full matrix completed at 379/380, with the
Haiku 4.5 limitation described above.

Generate a shareable result summary after a run. It excludes transcripts, session IDs and report
paths, counts correctly stopped conversations separately from produced reports, and marks missing
or duplicated coverage incomplete rather than manufacturing a pass. Local paths and session IDs
in failure messages are redacted; full diagnostics remain in the local raw results. Produced
reports and reports passing every check are counted separately.
The [stopped attempts](tests/models/matrix-attempts.json) record test corrections transparently;
their scores are not imported into a replacement run.

```bash
node tests/models/summarize.js --input "<run-directory>" --out summary.json
```

For a paired follow-up, compare the new run with the unchanged initial baseline:

```powershell
node tests\models\summarize.js --input "<new-run>" --baseline "<initial-run>" --review tests\models\matrix-review.json --out followup.json
```

This excludes only the explicitly reviewed checker correction, reports missing and duplicate
coverage, separates additional controls, and includes the last relevant engine rejection for
remaining flags. It does not merge old passes with new results into a new full-matrix score.
When a later simulator defect is confirmed, preserve the paired summary and recheck only the
invalidated pairs in a new run. Record the correction and both signatures separately; do not
silently replace genuine failures or mix different copied skill versions.

- **Pricing accuracy:** an independent oracle, written separately from the engine from the Retail
  Prices API and Microsoft Learn, established **142** reference checks (20 scenario totals,
  every VM variant and commitment term), to the cent. Live prices can drift from stored snapshots;
  investigate differences against an unchanged baseline rather than refreshing snapshots just to
  make a run pass. The cross-check found and fixed real bugs on both sides.
  The [historical Germany/EUR review](tests/oracle/eur-price-review.json) confirmed that eight
  snapshot mismatches reflect changed native EUR API rates: a fresh independent oracle and
  engine agreed on all affected totals. After explicit approval, the
  [11 November refresh](tests/oracle/eur-price-refresh.json) rechecked those prices independently
  and updated only that scenario, including coherent VM/disk variant values and a scenario-specific
  capture timestamp. All other 19 scenarios, pricing code and tolerances stayed unchanged.
  `npm test` then passed, including **142/142 oracle comparisons**. The historical investigation
  and old rates remain documented; live prices can drift again.
  A subsequent [license-discount review](tests/oracle/license-discount-review.json) found a real
  coverage gap: the existing Windows references use Azure Hybrid Benefit and did not exercise
  Windows PAYG license exclusions. Fresh independent API/math checks now agree with the corrected
  engine for all five Windows purchasing choices and RHEL. Focused regressions ensure compute
  remains discountable while excluded licenses do not; no old snapshots or tolerances were changed.
- **Reports:** focused tests cover a single estimate, multiple alternatives, separate pilot and
  production phases, all generated VM purchasing variants, unchanged priced totals, resource
  counts versus usage units, non-USD pricing, discount exclusions, incomplete pricing, critical
  notices, escaped labels and readback reconfirmation. Fixtures use generic customer data.
- **Runtime compatibility:** all existing regression suites passed on both Node 26.13.0 and
  Node 18.20.8, including 142/142 oracle comparisons. The minimum-major check uses the actual
  Node 18 executable; it does not certify every Node 18 patch or the development-only live SDK
  model runner. The [release validation record](tests/models/release-validation-review.json)
  records checks and the remaining model-specific limitation.
- **Packaging:** real npm tarball install/update and byte-for-byte payload checks passed in explicit
  isolated paths, without changing user/global installations. The package excludes tests, caches,
  scratch and development dependencies. Final distribution hashes are recorded separately in the
  [publication package review](tests/models/publication-package-review.json). The earlier
  [candidate package review](tests/models/release-package-review.json) preserves its separate
  prepublication archive and health-probe history.
- **Interview guidance:** examples cover a simple request, an already-complete request, real
  alternatives, phases and purchasing comparisons. Reviewing these instructions is not a
  substitute for the isolated conversation trials described below.
- **Historical conversations (October 2026):** the skill was tested in clean, isolated GitHub Copilot CLI sessions: 8 models
  by 20 scenarios per batch, with a simulated customer who knows nothing about Azure, including a
  strict customer who checks every number. In the final batch, 159 of 160 conversations delivered
  an estimate, and 7 of 8 models produced trustworthy estimates in 19 or 20 of 20 conversations.
- **Initial model pilot:** the first reproducible SDK run covered two cases each for GPT-6.1 Sol
  and Claude Sonnet 5.5. The initial 340-case matrix and its checker correction remain historical
  evidence. The latest consistent matrix covers 380 cases across 19 models, with 379 passes and
  one classified Haiku 4.5 scope flag. This remains a different protocol from historical novice-customer and
  adversarial trials.
- **Rules:** 54 focused rule tests cover firing and near-identical silent cases. The full catalog
  contains 97 rules with 102 cited quotes, including supplementary lifecycle sources; all 102
  passed the final-candidate live quote check.

## Repository structure

```
azure-pricing-skill/
├── SKILL.md                 # the skill your agent reads (interview, spec, rules of conduct)
├── README.md                # this file
├── LICENSE                  # MIT
├── CHANGELOG.md             # release notes
├── package.json             # npm/npx metadata + CLI bin entries
├── icon.svg                 # project logo
├── MANIFEST.json            # engine fingerprint for this release
├── scripts/
│   ├── cli.js               # install/update/status CLI
│   ├── azp.js               # pricing engine CLI (zero deps)
│   └── lib/                 # pricing recipes, advisor, readback, render, validation, lifecycle
├── catalog/
│   ├── rules.json           # 97 cited advisory rules
│   ├── models.json          # tested AI models
│   ├── catalog.json         # disk tiers, App Service plans, VM lifecycle list
│   ├── vm-sizes.json        # VM size specs (vCPU, memory, disk limits)
│   ├── regions.json         # region names
│   └── ai-models.json       # AI model meters
├── assets/template.html     # estimate template
└── tests/                   # not installed: oracle, scenarios, unit tests, release tools
```

## Privacy & data

`azure-pricing-skill` runs entirely locally. It sends requests **only** to `prices.azure.com` (for
prices) and to the Microsoft pages it links (to check links and citations). To verify the person's
answers and detect the AI model, it reads the local GitHub Copilot session record for the current
conversation; it does not send it anywhere. No telemetry, no accounts, no Azure sign-in.

## License

MIT, see [LICENSE](LICENSE).
