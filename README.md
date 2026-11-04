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
| 📚 | [Advice backed by Microsoft guidance](#advice-backed-by-microsoft-guidance) | 370 cited rules |
| 🖥️ | [VM sizes: Current and Extended only](#vm-sizes-current-and-extended-only) | End of Life sizes are never priced |
| 🧩 | [Coverage](#coverage) | 148 component types in depth (every sold calculator product), generic meter fallback |
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

**2. Pick a recommended model and ask.** In GitHub Copilot CLI, choose the model with `/model`
(see [Which AI model to use](#which-ai-model-to-use)), then:

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
3. **Check the readback.** Before anything is priced, the agent shows every quantity in plain words,
   next to what you told it, plus what is *not* included. Correct anything that is wrong.
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
back the numbers, explaining warnings) depends on the model. Tested on 1 October 2026:

| | Models |
|---|---|
| **Recommended** | GPT-5.5, Claude Sonnet 5, Grok 4.5, GPT-5.4-mini |
| Works, less consistent | GPT-5-mini, Claude Haiku 4.5 |
| **Blocked** | Gemini 3.5 Flash: in testing it repeatedly worked around the skill's safeguards, including forging the conversation record. The skill refuses to build an estimate with it. |

"Auto" can pick any model, including untested ones. The engine detects the model actually
answering, tells you if it is not recommended, and records it on every estimate. The list lives in
[`catalog/models.json`](catalog/models.json).

## Why you can trust the numbers

- **The model never does the math.** The engine computes every price from live
  [Azure Retail Prices API](https://learn.microsoft.com/rest/api/cost-management/retail-prices/azure-retail-prices)
  data: units (per hour, per 10K, per 1M), free grants, graduated tiers, reservations and savings
  plans, licenses, discounts and rounding. The model cannot write a number into the estimate.
- **Readback before pricing.** The engine will not build until the person has seen the readback for
  the exact spec being priced and replied to it. A change means a new readback.
- **Verified answers.** The region, discount and requirements on the estimate must match what the
  person actually typed; the engine checks the conversation record.
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

- **370 rules**. The first 97 were built from a review of **1,442** published recommendations (every design checklist
  item and configuration recommendation in the Well-Architected service guide for each priced
  service, the Cost Optimization checklist, the Azure Advisor recommendation references and the
  relevant security benchmark controls). Recommendations that need a running system, or that do
  not affect an estimate, are not rules. Each tier 1 service added its own rules from its Microsoft\n  pricing page and Learn documentation, in `catalog/rules/<type>.json`.
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

Every product in the [Azure Pricing Calculator](https://azure.microsoft.com/pricing/calculator/) that
is still sold has a **tier 1 recipe**: its own interview questions, correct units, graduated tiers
and free grants, cited Microsoft advice, and prices checked against an independent oracle. Run
`azp services` for the current list, or `azp services --find "words"` to find a type from plain words.

| Area | Tier 1 component types |
|------|------------------------|
| Compute | Azure Arc (charged capabilities), Azure Cloud Services (extended support), Azure Container Instances, Azure Dedicated Host, Azure Durable Task Scheduler, Azure Functions Premium plan (Elastic Premium), Azure Kubernetes Service Edge Essentials, Azure Spot Virtual Machines, Azure Stack Edge, Azure Virtual Desktop, Azure VMware Solution, Nutanix Cloud Clusters (NC2) on Azure, Virtual machine |
| Containers | AKS cluster management, Azure Container Apps (Dedicated plan, GPU and Dynamic Sessions), Azure Container Registry, Azure Kubernetes Service (AKS) Automatic, Azure Red Hat OpenShift, Container Apps (consumption) |
| Web, integration and messaging | App Service Environment (isolated App Service plans), App Service plan, Azure API Management, Azure App Configuration, Azure Data Manager for Energy, Azure Event Grid, Azure Event Hubs, Azure Fluid Relay, Azure Functions, Azure Logic Apps, Azure Maps, Azure Notification Hubs, Azure Service Bus, Azure SignalR Service, Azure Static Web Apps, Azure Web PubSub |
| Databases and analytics | Azure Analysis Services, Azure Cache for Redis, Azure Cosmos DB (NoSQL), Azure Cosmos DB for PostgreSQL cluster, Azure Data Explorer, Azure Data Factory, Azure Data Share, Azure Databricks, Azure DocumentDB, Azure HDInsight, Azure Health Data Services, Azure HorizonDB, Azure Managed Instance for Apache Cassandra, Azure Managed Redis, Azure SQL Database (DTU model, single databases), Azure SQL Database (vCore), Azure SQL Database elastic pool (vCore and eDTU), Azure SQL Managed Instance, Azure Stream Analytics, Azure Synapse Analytics, Microsoft Fabric, Microsoft Graph Data Connect, MySQL Flexible Server, PostgreSQL Flexible Server, Power BI Embedded |
| Storage | Azure Container Storage, Azure Data Box, Azure Data Lake Storage Gen2, Azure Elastic SAN, Azure File Sync, Azure Files, Azure Managed Lustre, Azure NetApp Files, Azure Queue Storage, Azure Storage Actions, Azure Storage Discovery, Azure Table Storage, Azure Ultra Disk, Blob storage, Managed disk, Managed disk snapshots, Page blobs and unmanaged disks (Azure Storage) |
| Networking | Advanced Container Networking Services (AKS), Application Gateway for Containers, Application Gateway v2, Azure Bastion, Azure Communications Gateway, Azure Content Delivery Network (Standard from Microsoft, classic), Azure DDoS Protection, Azure DNS, Azure ExpressRoute, Azure Firewall, Azure Firewall Manager, Azure Front Door (Standard and Premium), Azure Load Balancer: Gateway and cross-region (Global) tiers, Azure NAT Gateway, Azure Network Watcher, Azure Private Link, Azure Route Server, Azure Traffic Manager, Azure Virtual Network (peering and network add-ons), Azure Virtual Network Manager, Azure Virtual WAN, Azure VPN Gateway, Data transfer (inter-region, cross-zone, routing preference), Internet egress, Public IP, Public IP Prefix, Standard Load Balancer |
| AI | Azure AI Bot Service, Azure AI Search (Foundry IQ), Azure AI Video Indexer, Azure Content Understanding in Foundry Tools, Azure Document Intelligence, Azure OpenAI (Foundry Models), Azure OpenAI provisioned throughput (PTUs), Azure SRE Agent, Foundry Tools (Azure AI services: Language, Speech, Translator, Vision, Face, Content Safety), Healthcare agent service, Microsoft Planetary Computer Pro |
| Security and identity | Azure Artifact Signing (formerly Trusted Signing), Azure Cloud HSM, Azure confidential ledger, Azure Key Vault, Azure Virtual Enclaves, Extended Security Updates (ESU) enabled by Azure Arc, Microsoft Defender External Attack Surface Management, Microsoft Defender for Cloud (workload protection plans), Microsoft Defender ISOC (pay-as-you-go data ingestion), Microsoft Entra Domain Services, Microsoft Entra External ID, Microsoft Purview, Microsoft Security Copilot, Microsoft Sentinel |
| Monitoring and management | Application Insights (telemetry data and availability tests), Azure Automation, Azure Backup, Azure Chaos Studio, Azure Database Migration Service (classic), Azure Managed Grafana, Azure Monitor alert rules and notifications, Azure Monitor metrics (Prometheus, platform metrics, export), Azure Policy (charged parts only), Azure Site Recovery, Azure Update Manager, Log Analytics |
| Developer tools and DevOps | Azure App Testing (Load Testing and Playwright), Azure DevOps, GitHub Enterprise (billed through Azure) |
| IoT | Azure Digital Twins, Azure IoT Hub, Azure IoT Operations, Windows 10 IoT Core Services |

**Generic meter (fallback).** Anything in the Azure Retail Prices API that has no recipe can still be
priced with the `meter` component: the agent finds the exact meter with `azp search` and the engine
prices it live. This is weaker than tier 1 (no service-specific questions, advice or oracle tests),
and the estimate labels these lines as priced from a generic meter.

**Not priced (by design).** These calculator products are left out, with Microsoft's reason:

| Product | Reason | Microsoft source |
|---------|--------|------------------|
| Azure Active Directory B2C | Closed to new customers | [Source](https://learn.microsoft.com/azure/active-directory-b2c/faq) |
| Azure Advisor | No charge of its own | [Source](https://azure.microsoft.com/pricing/details/advisor/) |
| Azure Communication Services | Retiring, closed to new customers soon | [Source](https://learn.microsoft.com/azure/communication-services/acs-retirement-and-breaking-changes-guide) |
| Azure Database for MariaDB | Retired | [Source](https://learn.microsoft.com/lifecycle/announcements/azure-products-retirement-september-2025) |
| Azure Dedicated HSM | Closed to new customers | [Source](https://learn.microsoft.com/azure/dedicated-hsm/secure-dedicated-hsm) |
| Azure DevTest Labs | No charge of its own | [Source](https://azure.microsoft.com/pricing/details/devtest-lab/) |
| Azure IoT Central | Closed to new customers | [Source](https://learn.microsoft.com/azure/iot-central/core/iot-central-evolution) |
| Azure IoT Edge | No charge of its own | [Source](https://azure.microsoft.com/pricing/calculator/) |
| Azure Kubernetes Service on Azure Local | No charge of its own | [Source](https://learn.microsoft.com/azure/aks-hybrid-edge/aks-platforms-compare) |
| Azure Lab Services | Closed to new customers | [Source](https://learn.microsoft.com/azure/lab-services/retirement-guide) |
| Azure Lighthouse | No charge of its own | [Source](https://learn.microsoft.com/azure/lighthouse/overview) |
| Azure Managed Applications | Not sold through Azure meters | [Source](https://azure.microsoft.com/pricing/details/managed-applications/) |
| Azure Migrate | No charge of its own | [Source](https://learn.microsoft.com/azure/cost-management-billing/costs/overview-cost-management) |
| Azure Open Datasets | No charge of its own | [Source](https://azure.microsoft.com/pricing/details/open-datasets/) |
| Azure Resource Mover | No charge of its own | [Source](https://azure.microsoft.com/pricing/details/resource-mover/) |
| Azure Spring Apps | Closed to new customers | [Source](https://learn.microsoft.com/azure/spring-apps/basic-standard/retirement-announcement) |
| Azure SQL Edge | Retired | [Source](https://learn.microsoft.com/lifecycle/announcements/azure-products-retirement-september-2025) |
| Azure Time Series Insights | Retired | [Source](https://learn.microsoft.com/azure/time-series-insights/overview-what-is-tsi) |
| Batch | No charge of its own | [Source](https://learn.microsoft.com/azure/batch/batch-linux-nodes) |
| Cloud Shell | No charge of its own | [Source](https://azure.microsoft.com/pricing/details/cloud-shell/) |
| Data Catalog | Retired | [Source](https://learn.microsoft.com/azure/data-catalog/overview) |
| Machine Learning Studio (classic) | Retired | [Source](https://learn.microsoft.com/lifecycle/products/machine-learning-studio-classic) |
| Media Services | Retired | [Source](https://learn.microsoft.com/azure/media-services/latest/azure-media-services-retirement) |
| Microsoft Cost Management | No charge of its own | [Source](https://azure.microsoft.com/pricing/calculator/) |
| Microsoft Entra ID (formerly Azure AD) | Not sold through Azure meters | [Source](https://azure.microsoft.com/pricing/details/active-directory/) |
| Microsoft Genomics | Retired | [Source](https://learn.microsoft.com/lifecycle/products/microsoft-genomics) |
| Remote Rendering | Retired | [Source](https://learn.microsoft.com/windows/mixed-reality/develop/mixed-reality-cloud-services) |
| Scheduler | Retired | [Source](https://azure.microsoft.com/pricing/details/scheduler/) |
| StorSimple | Retired | [Source](https://learn.microsoft.com/azure/storsimple/storsimple-overview) |

**Lifecycle exceptions.** The engine prices only VM sizes in the Current or Extended lifecycle stage,
with three exceptions where the service itself sets the size. Each is priced with a cited note:

- **Azure Cloud Services (extended support):** every role size it offers is on the
  [End of Life list](https://learn.microsoft.com/azure/virtual-machines/sizes/lifecycle/end-of-life-sizes-list).
  Retired series (A v1, H v1) are refused. See [available sizes](https://learn.microsoft.com/azure/cloud-services-extended-support/available-sizes).
- **Azure-SSIS integration runtime (Synapse, Data Factory):** node sizes come from a
  [fixed Microsoft list](https://learn.microsoft.com/azure/data-factory/configure-azure-ssis-integration-runtime-performance)
  of v2 and v3 series. The engine picks the smallest v3 size that fits.
- **HDInsight:** ZooKeeper and ID Broker nodes are sized by the service at the
  [documented node size](https://learn.microsoft.com/azure/hdinsight/hdinsight-supported-node-configuration).
  Head and worker nodes follow the normal lifecycle rule.

Prices are available in any currency the Retail Prices API supports.
## Limits

- **An estimate, not a quote.** It applies one discount percentage (optionally excluding licenses);
  real agreements can differ by service.
- **Not modeled:** Azure support plans, Marketplace software, Microsoft 365 or Entra ID licenses,
  and the products listed under "Not priced" above. Commitment pre-purchase plans (for example
  Synapse or Databricks commit units) are noted in the estimate but not priced.
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
node scripts/azp.js vm-suggest --vcpu 4 --mem 16 --region eastus2
node scripts/azp.js readback spec.json               # plain-language check of every quantity
node scripts/azp.js build spec.json --out estimate.html
node scripts/azp.js rules                            # every rule with its Microsoft source
node scripts/azp.js check-citations                  # verify every quote against the live page
```

The spec format and the full interview are documented in [`SKILL.md`](SKILL.md).

## Testing

```bash
npm test                     # reports, oracle agreement, contracts, split invariance, rule tests
npm run test:report           # focused rendering, purchasing lineage and readback tests
npm run check-citations      # every citation fetched and its quote found
```

- **Pricing accuracy:** an independent oracle, written separately from the engine from the Retail
  Prices API and Microsoft Learn, established **142** reference checks (20 scenario totals,
  every VM variant and commitment term), to the cent. Live prices can drift from stored snapshots;
  investigate differences against an unchanged baseline rather than refreshing snapshots just to
  make a run pass. The cross-check found and fixed real bugs on both sides.
- **Reports:** focused tests cover a single estimate, multiple alternatives, separate pilot and
  production phases, all generated VM purchasing variants, unchanged priced totals, resource
  counts versus usage units, non-USD pricing, discount exclusions, incomplete pricing, critical
  notices, escaped labels and readback reconfirmation. Fixtures use generic customer data.
- **Interview guidance:** examples cover a simple request, an already-complete request, real
  alternatives, phases and purchasing comparisons. Reviewing these instructions is not a
  substitute for the isolated conversation trials described below.
- **Conversations:** the skill was tested in clean, isolated GitHub Copilot CLI sessions: 8 models
  by 20 scenarios per batch, with a simulated customer who knows nothing about Azure, including a
  strict customer who checks every number. In the final batch, 159 of 160 conversations delivered
  an estimate, and 7 of 8 models produced trustworthy estimates in 19 or 20 of 20 conversations.
- **Tier 1 services:** each service has its own independent oracle, written from the Retail Prices
  API, the pricing calculator and Microsoft Learn without reading the engine (**1,571** checks across
  regions, currencies including EUR, US Gov, free grants and refusal cases), plus contract tests for
  every type (**832** module and **337** built-in checks: required fields, unknown fields refused, text
  in number fields refused, readback). Every service passed an independent review that checked prices
  by hand against live sources.
- **Rules:** **318** rule tests: each rule has a test that must fire and a near-identical test that
  must stay silent.
- **Conversations (pending for tier 1):** the conversation results above are for the v1.0 services.
  The model matrix for the tier 1 services has not run yet.

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
│   ├── rules.json           # shared cited advisory rules
│   ├── rules/               # per-service cited rules (one file per type)
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
