# ORACLE_NOTES.md — Independent Azure pricing oracle

Ground-truth pricing for `tests/scenarios/scenarios.json`. Built **only** from the public
Azure Retail Prices API (`https://prices.azure.com/api/retail/prices`,
`api-version=2023-01-01-preview`, no auth) plus Microsoft Learn for billing semantics.
Nothing in this folder reads the system under test.

* `api.js` — paging fetch + de-dupe + `unitOfMeasure` → unit-size parsing + `round2`.
* `oracle.js` — one small, explicit, hand-written function per service.
* `run-oracle.js` — prices every scenario's canonical components (+ accept-list variants) → `oracle-results.json`.
* `spotcheck.js` — dumps the raw API rows used for the hand checks below.
* `explore.js` / `explore-batch.js` — ad-hoc meter discovery used while building this.

Run: `node tests\oracle\run-oracle.js` (≈3 min; verified passing).

The top-level `capturedAt` is the original snapshot date. A scenario's own `capturedAt`
overrides that date when only that scenario is independently refreshed. On 11 November 2026,
only `s17-eur-germany` was refreshed after fresh native-EUR oracle and isolated-engine queries
agreed on every affected total. All other scenarios remain unchanged. The before/after rates,
authorization and checks are in `eur-price-refresh.json`; `eur-price-review.json` preserves the
earlier investigation and its historical eight mismatches. No pricing code or tolerance changed.

The separate [license-discount review](license-discount-review.json) records a subsequently
discovered coverage gap: canonical Windows references use AHB, not Windows PAYG with license
discount exclusions. Fresh independent API/math checks agree with the corrected engine for all
five Windows purchasing choices and RHEL. Existing snapshots and tolerances were not changed.
Earlier model-workflow artifact passes were not independent pricing-oracle certification.

---

## 1. Global conventions

| Rule | Value |
|---|---|
| Hours per month | **730** |
| Days per month | **730 / 24 = 30.4167** (used only by Log Analytics) |
| Cost formula | `quantity / unitSize(unitOfMeasure) × retailPrice` |
| `unitOfMeasure` → unitSize | `1 Hour`→1, `1 GB`→1, `1 GB/Month`→1, `1 GiB/Hour`→1, `1/Month`→1 (already monthly), `1/Hour`→1, `1/Day`→1, `1 GB Second`→1, `10`→10, `100`→100, `1K`→1 000, `10K`→10 000, `1M`→1 000 000 |
| Tiered meters | Normalize quantity into **billing units first**, then walk `tierMinimumUnits` ascending; each band charges `min(qty, nextTierMin) − thisTierMin` units |
| De-duplication | Rows collapsed on `(meterId, tierMinimumUnits, retailPrice, type, skuId, unitOfMeasure)` **before** any math |
| Row filtering | Only `type == 'Consumption'` (never `DevTestConsumption`) unless explicitly pricing a reservation/savings plan |
| Rounding | Full-precision unit prices throughout; each **line** rounded to 2 dp; **total = sum of rounded lines** |
| Discount | Applied per line after the fact: `round2(line × (1 − d))`; discounted total = sum of rounded discounted lines |
| Currency | Queried natively (`currencyCode='EUR'` for s17). **No FX conversion anywhere.** |

`facts.discount` parsing: `"none"` / `"no discount"` / `"we don't have any discount"` → `0`;
otherwise the first `N%` found → `N/100`. (`"16% off list on everything"` → `0.16`,
`"16% off list, applies to reservations too"` → `0.16`.)

---

## 2. Meter selection, service by service — and why

### Virtual machines (`priceVm`)
Filter: `serviceName eq 'Virtual Machines' and armRegionName eq '<region>' and armSkuName eq '<sku>'`.

* **Linux / Windows-AHB / RHEL** → the **non-Windows** product (`Virtual Machines Dsv5 Series`).
  Azure Hybrid Benefit is literally "stop paying the Windows product meter", so AHB and plain
  Linux resolve to the identical meter. (<https://learn.microsoft.com/azure/virtual-machines/windows/hybrid-use-benefit-licensing>)
* **Windows (license included)** → the `... Windows` product (`Virtual Machines Dsv5 Series Windows`).
* **Excluded**: any row whose `skuName` or `meterName` contains `Spot` or `Low Priority`, and all
  `DevTestConsumption` rows.
* **Also excluded**: `productName` not starting with `Virtual Machines ` — the API returns
  `Dasv5 Series Cloud Services` rows under the same `armSkuName`, they do *not* contain "Windows",
  and they are ~2× the price. Pinning the product prefix prevents that trap.
* `skuName` formatting is **inconsistent across families** (`Standard_D4s_v5` vs `E8as v6`), so the
  size is pinned by `armSkuName` in the OData filter, never by string-matching `skuName`.

**Reservations**: `type == 'Reservation'` + `reservationTerm`. `retailPrice` is the **whole-term total
for one instance**, so monthly = `retailPrice / 12` (1 Year) or `/ 36` (3 Years).

**Savings plans**: the `savingsPlan[]` array on the Consumption row (only returned by
api-version `2023-01-01-preview`). `unitPrice` is the **effective hourly rate**, so monthly =
`unitPrice × hours × count`.

### RHEL license (`priceRhelLicense`) — s02
`serviceName eq 'Virtual Machines Licenses' and productName eq 'Red Hat Enterprise Linux' and armRegionName eq ''`
— the meter is **regionless** (`armRegionName` is the empty string).

Raw rows (verified 2026-09-30):

| skuName | meterName | uom | price |
|---|---|---|---|
| `1-4 vCPU VM` / `4 vCPU VM` | `4 vCPU VM License` | 1 Hour | **0.0576** |
| `5+ vCPU VM` / `8 vCPU VM` | `8 vCPU VM License` | 1 Hour | **0.1152** |
| `1-4 vCPU VM` | `1-4 vCPU VM Support` | 1 Hour | 0.03 |
| `1-4 vCPU VM` | `1-4 vCPU VM Support` | 1 Month | 20 |
| `5+ vCPU VM` | `5+ vCPU VM Support` | 1 Hour | 0.075 |
| `5+ vCPU VM` | `5+ vCPU VM Support` | 1 Month | 46.25 |

**Judgment call (important).** The true **PAYG** RHEL charge is the `<N> vCPU VM License` meter
**only**:
* 4 vCPU PAYG → **$0.0576/hr** (not 0.0576 + 0.03)
* 8 vCPU PAYG → **$0.1152/hr** (not 0.1152 + 0.075)

The `* vCPU VM Support` meters are the Red Hat **support subscription** sold for **BYOS / Cloud Access**
images. Learn is explicit that for on-demand (PAYG) images "Support cost is integrated into the
consumption cost of on-demand images"
(<https://learn.microsoft.com/troubleshoot/azure/cloud-services/support-linux-open-source-technology>,
<https://learn.microsoft.com/azure/virtual-machines/linux/azure-hybrid-benefit-linux>). Adding the
Support meter to a PAYG estimate double-charges. The per-vCPU rate is a clean $0.0144/vCPU-hour in
both bands, which corroborates that the License meter alone is the full PAYG software fee.

The License meter is selected by the exact `meterName` `"<vcpu> vCPU VM License"` and the `1 Hour`
unit of measure (there is also a `1 Month` Support variant that must not be picked up).

### Managed disks (`priceManagedDisk`)
`serviceName eq 'Storage'`, `productName` pinned per family (`P*` → `Premium SSD Managed Disks`,
`E*` → `Standard SSD Managed Disks`, `S*` → `Standard HDD Managed Disks`), `skuName eq '<tier> <LRS|ZRS>'`,
and `meterName` **exactly** `"<tier> <red> Disk"`.

Three traps deliberately avoided:
1. `productName 'Premium Page Blob'` carries identical `skuName`/`meterName`/price rows — pinning the
   managed-disk product avoids ambiguity.
2. `"<tier> <red> Disk Mount"` is the **shared-disk mount fee** (e.g. P30 LRS $8.081/mo) — excluded.
3. `"<tier> <red> Disk Operations"` is the Standard SSD/HDD **transaction** meter (`10K`, $0.002) — excluded.

`unitOfMeasure` is `1/Month`, i.e. the price is already the **flat monthly charge per disk**; it is
multiplied by disk count only, never by GiB and never by hours.

### Premium SSD v2 (`pricePremiumV2`) — s15
`productName eq 'Azure Premium SSD v2' and skuName eq 'Premium LRS'`. Three separate meters:

| meterName | uom | price | tierMinimumUnits |
|---|---|---|---|
| `Premium LRS Provisioned Capacity` | 1 GiB/Hour | 0.00011 | 0 |
| `Premium LRS Provisioned IOPS` | 1/Hour | 0 | 0 |
| `Premium LRS Provisioned IOPS` | 1/Hour | 0.000007 | **3000** |
| `Premium LRS Provisioned Throughput (MBps)` | 1/Hour | 0 | 0 |
| `Premium LRS Provisioned Throughput (MBps)` | 1/Hour | 0.000055 | **125** |

The free baseline is therefore **expressed directly in the API** as a $0 band, and the tier walk
applies it automatically — I did not hard-code it. Verified against
<https://learn.microsoft.com/azure/virtual-machines/disks-types>: *"every disk … you get 3,000 IOPS
and 125 MB/s free"* and *"3,000 IOPS and 125 MB/sec on throughput that is included in the capacity
pricing"*. The IOPS/throughput bands are banded on the **provisioned value**, then multiplied by 730 h.

### Public IP (`pricePublicIp`) — s04
`serviceName eq 'Virtual Network' and productName eq 'IP Addresses' and skuName eq 'Standard'`,
`meterName eq 'Standard IPv4 Static Public IP'`, $0.005/hr. Basic SKU (retiring) and Public IP
Prefix meters are excluded.

### Bandwidth / internet egress (`priceBandwidth`) — s04, s16
**Judgment call.** Two competing products exist in Central US:

| productName | tier bands (GB → $/GB) |
|---|---|
| **`Rtn Preference: MGN`** (chosen) | 0→**free**, 100→0.087, 10335→0.083, 51295→0.07, 153695→0.05, 512095→0.05 |
| `Bandwidth - Routing Preference: Internet` | 0→free, 100→0.08, 10100→0.065, 50100→0.06, 150100→0.04 |

I use **`Rtn Preference: MGN`** — "Microsoft Global Network", i.e. the **default** routing
preference every VM/storage account gets unless the customer explicitly opts into the cheaper
"Internet" routing preference at resource-creation time. It also matches the headline public
$0.087/GB North America price. Both use `skuName 'Standard'` / `meterName 'Standard Data Transfer Out'`.

The **first 100 GB/month free** is read from the data (a $0 band at `tierMinimumUnits 0`, with the
paid band starting at `tierMinimumUnits 100`) — not assumed.

### Load Balancer (`priceLoadBalancer`) — s12
Standard LB meters are **global**: `armRegionName eq 'Global'`, `productName eq 'Load Balancer'`,
`skuName eq 'Standard'`.
* `Standard Included LB Rules and Outbound Rules` — `1 Hour`, $0.025/hr, flat, covers the **first 5 rules**.
* `Standard Overage LB Rules and Outbound Rules` — `1/Hour`, $0.01/hr **per rule beyond 5**.
* `Standard Data Processed` — `1 GB`, $0.005/GB.

s12 asks for exactly 5 rules → only the Included meter, no overage.
(<https://learn.microsoft.com/azure/load-balancer/skus>)

### AKS (`priceAksStandardTier`) — s05
`serviceName eq 'Azure Kubernetes Service' and productName eq 'Azure Kubernetes Service' and
skuName eq 'Standard'`, `meterName eq 'Standard Uptime SLA'`, $0.10/hr → $73.00/mo. The customer
said "production, we need the uptime SLA", which is exactly the Standard tier.
`Azure Kubernetes Service - Automatic` (a different product) and `Standard Long Term Support`
($0.60/hr) are excluded. (<https://learn.microsoft.com/azure/aks/free-standard-pricing-tiers>)

### App Service (`priceAppService`) — s06
`productName eq 'Azure App Service Premium v3 Plan'` (**no** `- Linux` suffix = Windows),
`skuName eq 'P1 v3'`, `meterName eq 'P1 v3 App'`. East US 2 = $0.315/hr. The Linux product
`Azure App Service Premium v3 Plan - Linux` is a distinct, cheaper meter ($0.155/hr) and must not
be used for a Windows plan.

### Azure SQL Database GP (`priceSqlDatabaseGP`) — s06
**Azure SQL PaaS vCore pricing is split across TWO meters.** This was corrected after an
explicit license-meter audit (see section 8).

* Base compute: `productName 'SQL Database Single/Elastic Pool General Purpose - Compute Gen5'`,
  `skuName '4 vCore'`, `meterName 'vCore'`, `1 Hour`. East US 2 = $0.152217/vCore-hr.
  **Judgment call**: the `<n> vCore` row's `retailPrice` is the hourly price for the **whole n-vCore
  database**, not a per-vCore rate — it is exactly `n ×` the `1 vCore` row. I use the `<n> vCore` row
  directly with `qty = hours`. This meter is the **base compute rate**, i.e. the Azure Hybrid Benefit price.
  Zone-Redundancy rows (`skuName '<n> vCore Zone Redundancy'`) and Serverless rows are excluded —
  the customer said "provisioned, not serverless" and did not ask for zone redundancy.
* **SQL Server license**: `serviceName 'SQL Database'`, **`armRegionName eq 'Global'`**,
  `productName 'SQL Database Single/Elastic Pool General Purpose - SQL License'`, `skuName 'vCore'`,
  `meterName 'vCore'`, `1 Hour`, **$0.099966 per vCore-hour** (a single worldwide rate).
  Unlike the compute meter there are **no `'<n> vCore'` rows**, so this one **must** be multiplied by
  the vCore count. s06 facts say `"sql_licenses": "no existing SQL licenses"` → license-included →
  this line applies.
* Storage: `productName 'SQL Database Single/Elastic Pool General Purpose - Storage'`,
  `skuName 'General Purpose'`, `meterName 'General Purpose Data Stored'`, $0.115/GB/mo on the
  **provisioned** size (no free allowance for single databases; the `... Data Stored - Free` meter is a
  $0 promotional meter, not a per-database credit).
  (<https://learn.microsoft.com/azure/azure-sql/database/service-tiers-sql-database-vcore>,
  <https://learn.microsoft.com/azure/azure-sql/azure-hybrid-benefit>)

### Azure SQL Managed Instance GP (`priceSqlMiGP`) — s12
Identical two-meter structure.
* Base compute: `productName 'SQL Managed Instance General Purpose - Compute Gen5'`, `skuName '8 vCore'`,
  `meterName 'vCore'`, $1.217744/hr for the whole 8-vCore instance (= $0.152218/vCore-hr).
  (Premium-series and Zone-Redundancy products excluded.)
* **SQL Server license**: `serviceName 'SQL Managed Instance'`, **`armRegionName eq 'Global'`**,
  `productName 'SQL Managed Instance General Purpose - SQL License'`, `skuName 'vCore'`,
  `meterName 'vCore'`, **$0.099966 per vCore-hour**. s12 facts say *"we do NOT have SQL licenses"* →
  the line applies.
* Storage: `productName 'SQL Managed Instance General Purpose - Storage'`, `skuName 'General Purpose'`,
  `meterName 'General Purpose Data Stored'`, $0.115/GB/mo.
  **Included allowance: the first 32 GB are free.** Learn: *"The minimum amount of storage available
  in an instance is 32 GB … First 32 GB are free of charge"* and *"you're charged for the maximum
  storage size configured"*
  (<https://learn.microsoft.com/azure/azure-sql/managed-instance/frequently-asked-questions-faq>,
  <https://learn.microsoft.com/azure/azure-sql/managed-instance/resource-limits>).
  So 512 GB → 480 GB billed.

### Functions Consumption (`priceFunctionsConsumption`) — s07
`serviceName 'Functions'`, `productName 'Functions'`, `skuName 'Standard'`:

| meterName | uom | tierMinimumUnits → price |
|---|---|---|
| `Standard Total Executions` | **`10`** | 0 → $0; **100 000** → $0.000002 |
| `Standard Execution Time` | `1 GB Second` | 0 → $0; **400 000** → $0.000016 |

**How the API represents the free grants** (this was the question to answer): the executions meter's
`unitOfMeasure` is `10`, i.e. **one billing unit = 10 executions**, so `tierMinimumUnits = 100 000`
units = **1 000 000 executions free** — exactly the published 1M grant. The execution-time meter is
in raw GB-seconds, so `tierMinimumUnits = 400 000` is **400 000 GB-s free** directly. Both grants are
therefore read out of the API rather than hard-coded.
(<https://learn.microsoft.com/azure/azure-functions/functions-consumption-costs>)

The Flex Consumption (`On Demand` / `Always Ready`) meters exist and are in `accept.plans`, but the
canonical component says `functions-consumption`, so the classic Consumption meters are priced.

### Blob (`priceBlob`) — s08, s16
`productName eq 'General Block Blob v2'`, `skuName eq '<tier> <redundancy>'`.
* Data stored: `meterName` ending `Data Stored`, `1 GB/Month`. **Hot LRS is tiered**
  (0 → $0.0184, 51 200 → $0.017664, 512 000 → $0.016928); Archive LRS is flat $0.002.
* Operations: `Write Operations` / `Read Operations`, `unitOfMeasure '10K'` → divide by 10 000.
  `Archive Priority Read Operations` ($62.50/10K) is excluded — that is priority rehydration.
(<https://learn.microsoft.com/azure/storage/blobs/access-tiers-overview>)

### Azure OpenAI tokens (`priceOpenAiTokens`) — s09
The meters live under **`serviceName eq 'Foundry Models'`** (not "Cognitive Services") with
`productName` `Azure OpenAI` (4.x generation) or `Azure OpenAI GPT5` (5.x generation).

**Judgment call: sku naming is not derivable.** It varies by model generation
(`glbl` vs `Glbl` vs `Gl`, `Inp`/`Inpt`, `Outp`/`outpt`), so the Global-Standard meters are pinned
explicitly in `OPENAI_MODELS`. Batch (`Batch`), cached-input (`cchd`/`cd`), DataZone (`Dz`/`DZone`),
Flex, provisioned and fine-tuned (`pp`/`ft`) meters are all deliberately excluded.

Cheapest current GPT mini/nano **Global Standard** models found, East US 2 (200M in / 40M out):

| Model | productName | input meter (uom, $) | output meter (uom, $) | Monthly list |
|---|---|---|---|---|
| **gpt-5-nano** | `Azure OpenAI GPT5` | `GPT 5 Nano Inpt Glbl 1M Tokens` (`1M`, 0.05) | `GPT 5 Nano outpt Glbl 1M Tokens` (`1M`, 0.40) | **$26.00** |
| gpt-4.1-nano | `Azure OpenAI` | `gpt 4.1 nano Inp glbl Tokens` (`1K`, 0.0001) | `gpt 4.1 nano Outp glbl Tokens` (`1K`, 0.0004) | $36.00 |
| gpt-4o-mini | `Azure OpenAI` | `gpt-4o-mini-0718-Inp-glbl Tokens` (`1K`, 0.00015) | `gpt-4o-mini-0718-Outp-glbl Tokens` (`1K`, 0.0006) | $54.00 |
| gpt-5-mini | `Azure OpenAI GPT5` | `GPT 5 Mini Inpt Glbl 1M Tokens` (`1M`, 0.25) | `GPT 5 Mini outpt Glbl 1M Tokens` (`1M`, 2.00) | $130.00 |
| gpt-4.1-mini | `Azure OpenAI` | `gpt 4.1 mini Inp glbl Tokens` (`1K`, 0.0004) | `gpt 4.1 mini Outp glbl Tokens` (`1K`, 0.0016) | $144.00 |

The canonical "cheapest current GPT mini model" therefore resolves to **gpt-5-nano, $26.00/mo list**.
All five are in `variants.openai` so the grader can re-price whichever model the tool picked.
Note the **unit multiplier changes between generations** (`1K` for 4.x, `1M` for 5.x) — a tool that
assumes one of them will be off by 1000×.
(<https://learn.microsoft.com/azure/ai-foundry/openai/how-to/deployment-types>)

### Cosmos DB autoscale (`priceCosmosAutoscale`) — s10
* Throughput: `productName eq 'Azure Cosmos DB autoscale'`, `meterName '<AP1..AP4> 100 RUs'`,
  `unitOfMeasure '1/Hour'` → **one billing unit = 100 RU/s for one hour**, $0.012.
  All four `AP1`–`AP4` meters carry the identical price; `AP1` is used.
  **Judgment call**: autoscale bills the **maximum** provisioned RU/s for every hour unless the
  container actually scales down. With no scaling profile given, pricing max RU/s × 730 h is the
  conventional (and worst-case) estimate. (<https://learn.microsoft.com/azure/cosmos-db/provision-throughput-autoscale>)
* Storage: `productName 'Azure Cosmos DB'`, `skuName 'RUs'`, `meterName 'Data Stored'`, $0.25/GB/mo.
* No backup line: two periodic backup copies are included free, and the customer asked for defaults.
* Single region, so no multi-region write/replica multiplier.

### PostgreSQL Flexible Server (`pricePostgresFlex`) — s11
* Compute: `productName 'Azure Database for PostgreSQL Flexible Server General Purpose Ddsv5 Series Compute'`,
  `skuName '4 vCore'`, `meterName 'vCore'`, $0.356/hr East US 2 (= 4 × $0.089).
* Storage: `productName 'Azure Database for PostgreSQL Flex Server Storage'`, `skuName 'Storage'`,
  `meterName 'Storage Data Stored'`, $0.115/GB/mo.
* **Judgment call — HA doubles compute *and* storage.** Learn (cost-optimization guidance):
  *"If your workload requires AZ resiliency and lower RTO, you can enable High Availability (HA)
  with in-zone or cross-AZ standby. **This option doubles your deployment costs**"*
  (<https://learn.microsoft.com/azure/postgresql/flexible-server/how-to-cost-optimization>), and the
  compare doc: *"a standby server is created and it's billed at the same rate as the primary server …
  If you use the v5 tier with HA-enabled servers, you now see **billing quantities multiplied by 2**"*
  (<https://learn.microsoft.com/azure/postgresql/flexible-server/concepts-compare-single-server-flexible-server>,
  <https://learn.microsoft.com/azure/reliability/reliability-postgresql-flexible-server>).
  So both lines are ×2.
* No backup line: the default 7-day retention includes backup storage up to 100% of provisioned storage.

### Log Analytics (`priceLogAnalytics`) — s12
* PAYG: `serviceName 'Log Analytics'`, `skuName 'Analytics Logs'`,
  `meterName 'Analytics Logs Data Ingestion'`, `1 GB`. Bands: `0 → $0`, `5 → $2.76`.
  **The 5 GB/month free allowance is in the API** as that $0 band, so the tier walk applies it.
* **How the free tier is handled (explicitly):** it is applied, but it is a **per-billing-account**
  allowance, not per workspace. If the customer already burns it elsewhere the true figure is
  **$839.50** instead of $825.70. Both numbers are recorded in `notes`.
* **Commitment tier** is also computed: `serviceName 'Azure Monitor'`,
  `skuName '100 GB Commitment Tier'`, `meterName '100 GB Commitment Tier Capacity Reservation'`,
  `unitOfMeasure '1/Day'`, $196/day → **$5 961.67/mo**. That is far more than PAYG at 10 GB/day, so
  per the spec it is **not** selected; it is reported in `variants.logAnalytics` / `notes` only.
* Month length = 730/24 = 30.4167 days (consistent with 730 h/mo). 10 GB/day → 304.1667 GB/mo.
* No retention line: Analytics Logs include 31 days of retention free and the customer asked for no more.
  (<https://learn.microsoft.com/azure/azure-monitor/logs/cost-logs>)

### Container Apps Consumption (`priceContainerAppsConsumption`) — s18
`serviceName 'Azure Container Apps'`, `skuName 'Standard'`:
`Standard vCPU Active Usage` (`1 Second`, $0.000024), `Standard Memory Active Usage`
(`1 GiB Second`, $0.000003), `Standard Requests` (`1M`, $0.40).
Idle counterparts: `Standard vCPU Idle Usage` ($0.000003/s), `Standard Memory Idle Usage` ($0.000003/GiB-s).

* **Free grants are NOT in the API** — every Container Apps row has `tierMinimumUnits = 0`. They are
  subtracted explicitly from Learn *"Billing in Azure Container Apps"*: **180 000 vCPU-seconds,
  360 000 GiB-seconds, 2 000 000 HTTP requests per subscription per calendar month**
  (<https://learn.microsoft.com/azure/container-apps/billing>).
* **Judgment call — active vs idle.** Learn requires *all* of: replica started, **no HTTP requests being
  processed**, **< 0.01 vCPU**, **< 1000 B/s** network. A min-replica-1 production microservice serving
  3M requests/month does not qualify, so the canonical uses the **active** rate. The idle-rate figure
  (**$22.43/mo**, a strict lower bound) is recorded in `variants.containerApps.idleRate`.
* Environment management / private-endpoint hours are not billed for the default Consumption-only
  workload profile environment, so no environment line.

### Azure Files (`priceAzureFiles`) — s20
Both models are priced, as required.

**A. Provisioned v2, HDD LRS** (`productName 'Azure Files Provisioned v2'`, `skuName 'HDD LRS'`):

| meterName | uom | price |
|---|---|---|
| `HDD LRS Provisioned Storage` | 1 GiB/Hour | 0.00001 |
| `HDD LRS Provisioned IOPS` | 1/Hour | 0.000055 |
| `HDD LRS Provisioned Throughput MiBPS` | 1/Hour | 0.000082 |

**Judgment call — baseline IOPS/throughput.** Unlike the SSD tier (which has explicit
`SSD LRS Provisioned IOPS Free` / `... Throughput MiBPS Free` $0 meters), **HDD provisioned v2 has no
free band in the API — every provisioned IOP and MiB/s is billed.** The "default baseline" is therefore
the Learn recommendation formula, which is what the portal pre-fills
(<https://learn.microsoft.com/azure/storage/files/understanding-billing>):

```
IOPS       = MIN(MAX(1000 + CEILING(0.2  * GiB), 500), 50000)
Throughput = MIN(MAX(60   + CEILING(0.02 * GiB), 60),  5120)   MiB/s
```
For 5 TiB = 5120 GiB → **2024 IOPS** and **163 MiB/s**. (Minimum provisioned storage 32 GiB,
minimum IOPS 500, minimum throughput 60 MiB/s — all satisfied.)

**B. Pay-as-you-go** (`productName 'Files v2'`): Hot LRS `Hot LRS Data Stored` $0.0255/GB/mo;
Transaction optimized = `skuName 'Standard LRS'` / `meterName 'LRS Data Stored'` $0.06/GB/mo;
Cool LRS $0.015/GB/mo. Only the **data-stored** component is priced — the customer gave no transaction
volume, and PAYG Azure Files also bills per-operation meters. **This is a real gap**: a PAYG quote
without transactions is an underestimate. Flagged in the result notes.

| s20 option (5 TB = 5120 GB) | Monthly list | @16% |
|---|---|---|
| **Provisioned v2 HDD LRS (canonical)** | **$128.40** | **$107.86** |
| PAYG Hot LRS (data stored only) | $130.56 | $109.67 |
| PAYG Transaction optimized LRS (data stored only) | $307.20 | $258.05 |
| PAYG Cool LRS (data stored only) | $76.80 | $64.51 |

---

## 3. Per-scenario notes and judgment calls

| Scenario | Notes |
|---|---|
| **s01** | Canonical `E10 Standard SSD LRS` for a 128 GB disk. E10 is the 128 GiB Standard SSD tier — right-sized. `must_not: public-ip` respected (internal/VPN only, no IP or egress line). |
| **s02** | RHEL PAYG = compute (non-Windows meter) **+** regionless license meter, license counted **once** (the scenario lists `rhel-license` as its own component, so `priceVm` is called with `includeRhelLicense:false` to avoid double counting). P40 = 2 TiB Premium SSD; P6 = 64 GiB OS disk. |
| **s03** | AHB → non-Windows meter ($0.172/hr for D4as_v5 East US 2 vs $0.356 Windows). E15 = 256 GiB Standard SSD. |
| **s04** | Discount `"none"` → 0%. Standard static IPv4 $3.65/mo. Egress 200 GB → first 100 free, 100 × $0.087 = $8.70. |
| **s05** | AKS **Standard** tier chosen because the customer explicitly asked for the uptime SLA. 3 × D4as_v5 + 3 × P10 (128 GiB Premium, the AKS default managed OS disk). `Ephemeral` is in `accept.disk_tiers` and is priced at **$0** in the variants (ephemeral OS disks use VM cache/temp storage already inside the VM price). |
| **s06** | P1v3 **Windows** product; SQL DB GP Gen5 4 vCore **license included** = base compute **+** the global SQL License meter (facts: `"sql_licenses": "no existing SQL licenses"`); 250 GB provisioned storage. |
| **s07** | 5M executions × 200 ms × 0.5 GB = 500 000 GB-s (matches the canonical `gbSeconds`). Both free grants read from the API. |
| **s08** | Archive LRS, 50 TB = 51 200 GB. 100 000 writes / 10 000 = 10 units × $0.10. Rehydration reads are **not** priced (customer restores "once or twice a year", no volume given) — an advisory, not a line. |
| **s09** | gpt-5-nano Global Standard is cheapest. All five accept-list models priced in `variants.openai`. |
| **s10** | Discount `"none"` → 0%. Autoscale max RU/s billed for all 730 h. |
| **s11** | Zone-redundant HA doubles **both** compute and storage. |
| **s12** | 2 × AHB Windows VMs, 5-rule Standard LB (no overage), SQL MI GP 8 vCore **license included** (base compute + global SQL License meter; facts: *"we do NOT have SQL licenses"*) with 32 GB free storage, Log Analytics PAYG (commitment tier rejected as more expensive). Note the scenario mixes licensing modes: Windows Server **with** SA → VM AHB applies; SQL **without** licenses → SQL license meter applies. |
| **s13** | Full PAYG / RI 1y / RI 3y / SP 1y / SP 3y comparison, per instance and ×10, for the canonical SKU **and** every accept-list SKU (`variants.commitmentBySku`). Canonical top-level total is the **PAYG** figure. |
| **s14** | `hours = 220` (10 h/day × 22 days) for the VMs. **Disks are billed all 730 h regardless of VM state** — the E10 line is full price. `variants.commitment` shows the trap: SP/RI commitments are billed for all 730 h, so every commitment option costs **more** than PAYG at 220 h/mo. |
| **s15** | Premium SSD v2 with the API's own $0 baseline bands. `P40` (2 TiB, $235.52 East US 2) is the accept-list alternative — the "premium tier cliff": 1.1 TB needs a 2 TiB P40 because P30 is only 1 TiB. |
| **s16** | Hot LRS blob (tiered, all 2048 GB in the first band) + 4M reads + 20 TB tiered egress. |
| **s17** | Queried natively with `currencyCode='EUR'`. **No FX conversion.** D4as_v5 Germany West Central = €0.178602/hr, E15 LRS = €16.486347/mo. Discount 20%. |
| **s18** | Discount `"we don't have any discount"` → 0%. Active rate canonical; idle rate in variants. |
| **s19** | Canonical is the **modernized** `Standard_D4s_v5`; `Standard_D4s_v3` is in `accept.vm_skus` and is priced in `variants.vm` so the grader can re-price either. |
| **s20** | See the Azure Files table above. |

---

## 4. Hand spot-checks (raw API rows → arithmetic)

Raw rows reproducible with `node tests\oracle\spotcheck.js`; captured in `spotcheck-output.txt`.
All prices verified **2026-09-30**.

### Check 1 — Central US `Standard_D4s_v5` Linux, PAYG / RI / SP (s19, and reference point)
Raw row: `productName="Virtual Machines Dsv5 Series"`, `skuName="Standard_D4s_v5"`,
`meterName="D4s v5"`, `unitOfMeasure="1 Hour"`, `retailPrice=0.217`, `type=Consumption`,
`savingsPlan=[{3 Years: 0.088319},{1 Year: 0.131502}]`; plus
`type=Reservation, term=1 Year, retailPrice=992` and `term=3 Years, retailPrice=1867`.
✔ Matches every stated reference point.

```
PAYG  = 730 h / 1 (unitOfMeasure '1 Hour') × 0.217            = 158.41   -> s19 VM line 158.41 ✔
RI 1y = 992  / 12 months                                      = 82.6667  -> 82.67
RI 3y = 1867 / 36 months                                      = 51.8611  -> 51.86
SP 1y = 0.131502 × 730 h                                      = 95.9965  -> 96.00
```

### Check 2 — s13 fleet: Central US `Standard_D8as_v5` Linux ×10, 730 h
Raw rows: `Virtual Machines Dasv5 Series` / `D8as v5` / `1 Hour` /
`Consumption 0.389`, `SP 1 Year 0.234956`, `SP 3 Years 0.157545`,
`Reservation 1 Year 1778`, `Reservation 3 Years 3435`.
(The `Dasv5 Series Cloud Services` row at 0.757 is present under the same `armSkuName` and is
correctly excluded by the `Virtual Machines ` product-prefix rule.)

```
PAYG  per instance = 730 × 0.389            = 283.97      fleet ×10 = 2 839.70   ✔ oracle 2839.70
RI 1y per instance = 1778 / 12              = 148.1667 -> 148.17    ×10 = 1 481.67  ✔
RI 3y per instance = 3435 / 36              =  95.4167 ->  95.42    ×10 =   954.17  ✔  (per-line rounding then ×10)
SP 1y per instance = 0.234956 × 730         = 171.5179 -> 171.52    ×10 = 1 715.18  ✔
SP 3y per instance = 0.157545 × 730         = 115.0079 -> 115.01    ×10 = 1 150.08  ✔
16% discount on the PAYG fleet: round2(2839.70 × 0.84) = 2 385.35   ✔
```
Cheapest for a 24×7 fleet: **RI 3y, $954.17/mo list ($801.50 @16%)**.

### Check 3 — s16 tiered internet egress, Central US, 20 TB = 20 480 GB
Raw bands (`Rtn Preference: MGN` / `Standard` / `Standard Data Transfer Out`, `1 GB`):
`tierMin 0 → $0`, `100 → 0.087`, `10335 → 0.083`, `51295 → 0.07`, `153695 → 0.05`, `512095 → 0.05`.

```
band 0     .. 100     : 100 GB              × 0        =     0.000
band 100   .. 10 335  : 10 335 − 100 = 10 235 × 0.087  =   890.445
band 10 335.. 20 480  : 20 480 − 10 335 = 10 145 × 0.083 = 842.035
                                            total      = 1 732.480  -> 1 732.48   ✔ oracle 1732.48
```

### Check 4 — s07 Azure Functions free grants, East US 2
Raw: `Standard Total Executions`, uom **`10`**, `tierMin 0 → $0`, `tierMin 100000 → $0.000002`;
`Standard Execution Time`, uom `1 GB Second`, `tierMin 0 → $0`, `tierMin 400000 → $0.000016`.

```
executions: 5 000 000 / 10 = 500 000 billing units
            band 0..100 000      : 100 000 units × 0         = 0.00      (= 1 000 000 executions free)
            band 100 000..       : 400 000 units × 0.000002  = 0.80      ✔
GB-seconds: 500 000 GB-s
            band 0..400 000      : 400 000 × 0               = 0.00      (400 000 GB-s free)
            band 400 000..       : 100 000 × 0.000016        = 1.60      ✔
total 2.40 list;  @16%: round2(0.80×0.84)=0.67 + round2(1.60×0.84)=1.34 = 2.01   ✔
```

### Check 5 — s15 Premium SSD v2, East US 2, 1126 GiB / 5000 IOPS / 200 MB/s
Raw: capacity `1 GiB/Hour` 0.00011; IOPS `1/Hour` `0 → $0`, `3000 → 0.000007`;
throughput `1/Hour` `0 → $0`, `125 → 0.000055`.

```
capacity   = 1126 GiB × 730 h × 0.00011 (821 980 GiB-h)  =  90.4178 ->  90.42   ✔
IOPS       = (5000 − 3000) = 2000 × 730 h × 0.000007     =  10.22            ✔
throughput = (200  − 125)  =   75 × 730 h × 0.000055     =   3.01125 ->  3.01  ✔
total list 103.65 ;  @16%: 75.95 + 8.58 + 2.53          = 87.06            ✔
```

### Check 6 — s12 SQL Managed Instance GP, East US 2, 8 vCore / 512 GB, **license included**
Raw: `SQL Managed Instance General Purpose - Compute Gen5` / `8 vCore` / `vCore` / `1 Hour` / 1.217744 (regional);
**`SQL Managed Instance General Purpose - SQL License` / `vCore` / `vCore` / `1 Hour` / 0.099966 (armRegionName `Global`)**;
`SQL Managed Instance General Purpose - Storage` / `General Purpose Data Stored` / `1 GB/Month` / 0.115.

```
base compute = 730 × 1.217744                      = 888.9531 -> 888.95   ✔
SQL license  = 8 vCore × 730 h = 5840 × 0.099966   = 583.8014 -> 583.80   ✔
storage      = (512 − 32 free) = 480 × 0.115       =  55.20             ✔
sanity: (1.217744 + 8×0.099966) / 8 = 0.252184 /vCore-hr = the published license-included GP rate ✔
```

### Check 6b — s06 Azure SQL Database GP, East US 2, 4 vCore / 250 GB, **license included**
Raw: `SQL Database Single/Elastic Pool General Purpose - Compute Gen5` / `4 vCore` / `1 Hour` / 0.608868 (regional);
**`SQL Database Single/Elastic Pool General Purpose - SQL License` / `vCore` / `1 Hour` / 0.099966 (`Global`)**;
storage 0.115 /GB/mo.

```
base compute = 730 × 0.608868                      = 444.4736 -> 444.47   ✔
SQL license  = 4 vCore × 730 h = 2920 × 0.099966   = 291.9007 -> 291.90   ✔
storage      = 250 × 0.115                         =  28.75             ✔
sanity: (0.608868/4) + 0.099966 = 0.252183 /vCore-hr = the published license-included GP rate ✔
```

### Check 7 — s12 Log Analytics, East US 2, 10 GB/day
Raw: `Analytics Logs Data Ingestion`, `1 GB`, `tierMin 0 → $0`, `tierMin 5 → 2.76`;
`Azure Monitor` / `100 GB Commitment Tier Capacity Reservation`, `1/Day`, 196.

```
monthly GB = 10 × (730/24 = 30.416667)              = 304.16667 GB
band 0..5  : 5 GB × 0                                =   0.00
band 5..   : 299.16667 GB × 2.76                     = 825.700   -> 825.70   ✔
commitment : 196 × 30.416667                         = 5 961.67  -> PAYG is cheaper, so PAYG is used ✔
without the 5 GB credit: 304.16667 × 2.76            = 839.50   (recorded in notes)
```

### Check 8 — s02 RHEL, East US 2, 8 vCPU
Raw: `Virtual Machines Easv6 Series` / `E8as v6` / `1 Hour` / 0.477 (Consumption);
regionless `Red Hat Enterprise Linux` / `8 vCPU VM License` / `1 Hour` / 0.1152.

```
compute = 730 × 0.477    = 348.21   ✔
license = 730 × 0.1152   =  84.096 -> 84.10   ✔   (Support meter 0.075/hr deliberately NOT added)
disks   = P40 LRS 235.52 + P6 LRS 9.2801 -> 9.28
total   = 348.21 + 84.10 + 235.52 + 9.28 = 677.11   ✔
```

### Check 9 — s17 EUR, Germany West Central
Raw (queried with `currencyCode='EUR'`): `Virtual Machines Dasv5 Series` / `Standard_D4as_v5` /
`1 Hour` / **0.178602**; `Standard SSD Managed Disks` / `E15 LRS` / `1/Month` / **16.486347**.

```
VMs   = 730 × 0.178602 × 2 = 260.7589 -> 260.76   ✔
disks = 16.486347 × 2      =  32.9727 ->  32.97   ✔
total 293.73 EUR;  @20%: round2(260.76×0.8)=208.61 + round2(32.97×0.8)=26.38 = 234.99   ✔
```

### Check 10 — s18 Container Apps, Central US
Raw: `Standard vCPU Active Usage` `1 Second` 0.000024; `Standard Memory Active Usage`
`1 GiB Second` 0.000003; `Standard Requests` `1M` 0.40.

```
vCPU-s  = 2 apps × 1 replica × 0.5 vCPU × 730 h × 3600 s = 2 628 000
          billable = 2 628 000 − 180 000 = 2 448 000 × 0.000024 = 58.752  -> 58.75   ✔
GiB-s   = 2 × 1 × 1 GiB × 730 × 3600                      = 5 256 000
          billable = 5 256 000 − 360 000 = 4 896 000 × 0.000003 = 14.688  -> 14.69   ✔
requests= (3 000 000 − 2 000 000) / 1 000 000 = 1 unit × 0.40   =  0.40            ✔
total 73.84 (0% discount)                                                          ✔
```

### Check 11 — s09 gpt-5-nano token units, East US 2
Raw: `GPT 5 Nano Inpt Glbl 1M Tokens`, uom `1M`, 0.05; `GPT 5 Nano outpt Glbl 1M Tokens`, uom `1M`, 0.40.

```
input  = 200 000 000 / 1 000 000 = 200 units × 0.05 = 10.00   ✔
output =  40 000 000 / 1 000 000 =  40 units × 0.40 = 16.00   ✔
total 26.00 list;  @16%: 8.40 + 13.44 = 21.84                 ✔
```

---

## 5. Things I could NOT price from public data

1. **`Standard_D2als_v5` (s04 `accept.vm_skus`) does not exist in the retail price API at all.**
   A global `contains(armSkuName,'D2als_v5')` query returns **0 rows** in every region and currency —
   the memory-constrained `als` variants begin at v6 (`Standard_D2als_v6`). Recorded as
   `{"error": "..."}` in `variants.vm` rather than guessed. Every other accept-list SKU priced cleanly.
2. **PAYG Azure Files transactions (s20).** Pay-as-you-go Azure Files bills write/read/list/other
   operation meters in addition to data stored. The customer supplied no transaction volume, so the
   PAYG variants are **data-stored only** and are a floor, not a full quote. The provisioned v2 model
   (the canonical) has no such gap.
3. **Archive rehydration (s08).** "Restore something once or twice a year" gives no GB or urgency, so
   `Archive Read Operations` ($5.00/10K) and `Archive Priority Read Operations` ($62.50/10K) plus the
   early-deletion penalty (180-day minimum) are not priced. They belong in the advisory, not the estimate.
4. **Container Apps active-vs-idle split (s18)** cannot be determined from list prices; it depends on
   runtime behavior. Canonical uses active ($73.84); the idle floor ($22.43) is in the variants.
5. **Cosmos DB actual autoscale scale-down (s10)** is a runtime behavior, not a price. Max RU/s for all
   730 h is the priced upper bound.
6. **Discounts themselves.** The customer-stated 10/12/16/20% are applied as a flat multiplier per
   line. Real MACC/EA discounts vary by meter category (and often exclude Marketplace/third-party
   items such as the RHEL license). That nuance is not modelable from public data.

---

## 6. Learn / reference URLs used (all verified HTTP 200 with `Invoke-WebRequest -Method Head`, 2026-09-30)

| Topic | URL |
|---|---|
| Retail Prices API contract | <https://learn.microsoft.com/rest/api/cost-management/retail-prices/azure-retail-prices> |
| Managed disk + Premium SSD v2 billing (3 000 IOPS / 125 MB/s free) | <https://learn.microsoft.com/azure/virtual-machines/disks-types> |
| Azure Files billing (provisioned v2 model, recommendation formulas) | <https://learn.microsoft.com/azure/storage/files/understanding-billing> |
| Blob access tiers | <https://learn.microsoft.com/azure/storage/blobs/access-tiers-overview> |
| Container Apps billing + free grants + idle rules | <https://learn.microsoft.com/azure/container-apps/billing> |
| PostgreSQL flexible server HA cost doubling | <https://learn.microsoft.com/azure/postgresql/flexible-server/how-to-cost-optimization> |
| PostgreSQL flexible server standby billed at primary rate / v5 ×2 | <https://learn.microsoft.com/azure/postgresql/flexible-server/concepts-compare-single-server-flexible-server> |
| PostgreSQL flexible server reliability / zone redundancy | <https://learn.microsoft.com/azure/reliability/reliability-postgresql-flexible-server> |
| SQL MI first 32 GB storage free | <https://learn.microsoft.com/azure/azure-sql/managed-instance/frequently-asked-questions-faq> |
| SQL MI resource limits / billed on max configured storage | <https://learn.microsoft.com/azure/azure-sql/managed-instance/resource-limits> |
| Azure SQL Database vCore tiers (license included) | <https://learn.microsoft.com/azure/azure-sql/database/service-tiers-sql-database-vcore> |
| **Azure Hybrid Benefit — Azure SQL Database & SQL Managed Instance** (base compute + SQL license split) | <https://learn.microsoft.com/azure/azure-sql/azure-hybrid-benefit> |
| vCore purchasing model (SQL Database) | <https://learn.microsoft.com/azure/azure-sql/database/service-tiers-vcore> |
| Centrally managed Azure Hybrid Benefit for SQL Server | <https://learn.microsoft.com/azure/cost-management-billing/scope-level/overview-azure-hybrid-benefit-scope> |
| Log Analytics cost (Analytics Logs, commitment tiers, 31-day retention) | <https://learn.microsoft.com/azure/azure-monitor/logs/cost-logs> |
| Functions consumption cost estimation / free grants | <https://learn.microsoft.com/azure/azure-functions/functions-consumption-costs> |
| Azure Hybrid Benefit for Windows Server | <https://learn.microsoft.com/azure/virtual-machines/windows/hybrid-use-benefit-licensing> |
| Azure Hybrid Benefit for Linux / PAYG vs BYOS | <https://learn.microsoft.com/azure/virtual-machines/linux/azure-hybrid-benefit-linux> |
| RHEL support bundled into on-demand consumption cost | <https://learn.microsoft.com/troubleshoot/azure/cloud-services/support-linux-open-source-technology> |
| AKS Free vs Standard vs Premium tiers | <https://learn.microsoft.com/azure/aks/free-standard-pricing-tiers> |
| Load Balancer SKUs (rules, data processed) | <https://learn.microsoft.com/azure/load-balancer/skus> |
| Cosmos DB autoscale provisioned throughput | <https://learn.microsoft.com/azure/cosmos-db/provision-throughput-autoscale> |
| Azure OpenAI deployment types (Global Standard) | <https://learn.microsoft.com/azure/ai-foundry/openai/how-to/deployment-types> |
| Public IP addresses (Standard vs Basic) | <https://learn.microsoft.com/azure/virtual-network/ip-services/public-ip-addresses> |

---

## 7. Results summary (captured from `oracle-results.json`)

| Scenario | Currency | Discount | Canonical monthly **list** | Canonical monthly **discounted** |
|---|---|---|---|---|
| s01-small-web-linux | USD | 16% | 80.56 | 67.67 |
| s02-rhel-8x64 | USD | 16% | 677.11 | 568.78 |
| s03-windows-ahb | USD | 10% | 144.76 | 130.28 |
| s04-web-vm-public-ip | USD | 0% | 53.58 | 53.58 |
| s05-aks-prod | USD | 0% | 556.99 | 556.99 |
| s06-appservice-sql | USD | 12% | 1 225.02 | 1 078.01 |
| s07-functions | USD | 16% | 2.40 | 2.01 |
| s08-blob-archive | USD | 16% | 103.40 | 86.86 |
| s09-openai-chatbot | USD | 16% | 26.00 | 21.84 |
| s10-cosmos | USD | 0% | 375.40 | 375.40 |
| s11-postgres-ha | USD | 16% | 637.52 | 535.52 |
| s12-three-tier | USD | 16% | 2 647.34 | 2 223.77 |
| s13-reservations (PAYG) | USD | 16% | 2 839.70 | 2 385.35 |
| s14-dev-business-hours | USD | 16% | 418.24 | 351.32 |
| s15-disk-cliff | USD | 16% | 103.65 | 87.06 |
| s16-egress-heavy | USD | 16% | 1 771.76 | 1 488.27 |
| s17-eur-germany | **EUR** | 20% | 293.73 | 234.99 |
| s18-container-apps | USD | 0% | 73.84 | 73.84 |
| s19-legacy-v3 | USD | 16% | 168.01 | 141.12 |
| s20-azure-files | USD | 16% | 128.40 | 107.86 |

### s13 commitment comparison (Central US, `Standard_D8as_v5` Linux, 10 × 730 h)

| Option | Per instance / mo (list) | Fleet / mo (list) | Fleet / mo @16% |
|---|---|---|---|
| Pay-as-you-go | 283.97 | 2 839.70 | 2 385.35 |
| Reservation 1 year | 148.17 | 1 481.67 | 1 244.60 |
| **Reservation 3 years** | **95.42** | **954.17** | **801.50** |
| Savings plan 1 year | 171.52 | 1 715.18 | 1 440.75 |
| Savings plan 3 years | 115.01 | 1 150.08 | 966.07 |

### s14 savings-plan trap (Central US, `Standard_D4as_v5` Linux ×8, 220 h/mo)

| Option | Fleet compute / mo (list) | @16% |
|---|---|---|
| **Pay-as-you-go @ 220 h (correct answer)** | **341.44** | **286.81** |
| Savings plan 3 years (billed all 730 h) | 458.85 | 385.43 |
| Reservation 3 years (billed whole term) | 381.78 | 320.70 |
| Reservation 1 year | 592.67 | 497.84 |
| Savings plan 1 year (billed all 730 h) | 684.31 | 574.82 |

Every commitment option costs **more** than PAYG at 220 h/mo — the trap the scenario is testing.
Disks (E10 × 8 = $76.80/mo) bill for all 730 h regardless of the auto-shutdown schedule.

---

## 8. Correction — Azure SQL PaaS license meters (audit, 2026-09-30)

### 8.1 What was wrong

The first version of this oracle priced Azure SQL Database and SQL Managed Instance using the
`... General Purpose - Compute Gen5` meter alone and labeled it "license included". **That was an
underestimate.** That meter is the **base compute** rate — the Azure Hybrid Benefit price. A customer
without SQL Server licenses additionally pays a separate **SQL license** meter.

### 8.2 API evidence

The license meters are easy to miss because they are **not regional** — they sit under
`armRegionName eq 'Global'` and are therefore invisible to any query filtered on the customer's
region. Query used:

```
$filter=contains(productName,'SQL License')
```

Relevant rows (USD, Consumption, `unitOfMeasure '1 Hour'`, `skuName 'vCore'`, `meterName 'vCore'`):

| armRegionName | serviceName | productName | retailPrice |
|---|---|---|---|
| **Global** | SQL Database | **SQL Database Single/Elastic Pool General Purpose - SQL License** | **0.099966** |
| Global | SQL Database | SQL Database Single/Elastic Pool Hyperscale - SQL License | 0.099966 |
| **Global** | SQL Managed Instance | **SQL Managed Instance General Purpose - SQL License** | **0.099966** |
| Global | SQL Managed Instance | SQL Managed Instance Business Critical - SQL License | 0.375 |
| US Gov | SQL Database | SQL Database Single/Elastic Pool General Purpose - SQL License | 0.124957 |
| US Gov | SQL Managed Instance | SQL Managed Instance General Purpose - SQL License | 0.124957 |
| Global | (all of the above) | — | 0 (`DevTestConsumption` — excluded) |

Two structural details that matter:

1. The license meter's `skuName` is a bare **`vCore`** — there are **no `'<n> vCore'` rows**. So unlike
   the compute meter (whose `'4 vCore'` row is already the whole-database price), the license meter
   **must be multiplied by the vCore count**.
2. It carries `savingsPlan` entries (1 Year 0.0799728, 3 Years 0.0699762 for SQL DB GP), confirming it
   is a first-class billable meter, not a catalog artifact.

### 8.3 Learn evidence

<https://learn.microsoft.com/azure/azure-sql/azure-hybrid-benefit> (HTTP 200), describing the vCore
pricing structure diagram:

> "**'License Included' pricing is made up of base compute and SQL license components.** Azure Hybrid
> Benefit pricing is made up of base compute and software assurance components."

and

> "Azure Hybrid Benefit grants you the ability to allocate your SQL Server license to Azure SQL
> Database and Azure SQL Managed Instance. You can **save up to 30 percent or more** on SQL Database
> and SQL Managed Instance by using your Software Assurance-enabled SQL Server licenses on Azure."

<https://learn.microsoft.com/azure/cost-management-billing/scope-level/overview-azure-hybrid-benefit-scope> (HTTP 200):

> "SQL Server Enterprise Edition core customers with SA — **Can pay base rate** on General Purpose or
> Business Critical SKU"
> "*License included*: The price of the SQL Server licenses is included."

So: **license included = base compute + SQL license**; **AHB = base compute only**. The retail API
models exactly this, with the license component broken out as a global meter.

### 8.4 Arithmetic cross-check against published list prices

```
SQL DB GP Gen5, East US 2:
  base compute per vCore = 0.608868 / 4          = 0.152217 /vCore-hr   (= the AHB price)
  SQL license per vCore                          = 0.099966 /vCore-hr
  license-included per vCore                     = 0.252183 /vCore-hr   <- matches the published rate

SQL MI GP Gen5, East US 2:
  base compute per vCore = 1.217744 / 8          = 0.152218 /vCore-hr
  SQL license per vCore                          = 0.099966 /vCore-hr
  license-included per vCore                     = 0.252184 /vCore-hr   <- matches the published rate

AHB saving = 0.099966 / 0.252183 = 39.6%  -> consistent with Learn's "save up to 30 percent or more".
```
The earlier per-vCore figure of $0.152217 is ~40% below the published license-included list price,
which is exactly the size of the error.

### 8.5 Conclusion — yes, s06 and s12 must include a license line

Both scenarios explicitly state the customer has no SQL Server licenses
(s06 `"sql_licenses": "no existing SQL licenses"`; s12 *"we do NOT have SQL licenses"*), so
license-included pricing applies and the global SQL License meter is billed.

**s06 — Azure SQL Database GP Gen5, 4 vCore, 250 GB, East US 2, 12% discount**

```
                                                list      @12%
App Service 2 x P1v3 Windows  730 x 0.315 x 2 = 459.90    404.71
SQL DB base compute           730 x 0.608868  = 444.47    391.13
SQL DB SQL license   4 x 730 = 2920 x 0.099966= 291.90    256.87   <-- NEW
SQL DB storage                250 x 0.115     =  28.75     25.30
                                        total  1 225.02  1 078.01
        (was 933.12 / 821.14 -- understated by 291.90 / 256.87)
```

**s12 — SQL MI GP Gen5, 8 vCore, 512 GB, East US 2, 16% discount**

```
                                                list      @16%
2 x D4as_v5 Windows AHB       730 x 0.172 x 2 = 251.12    210.94
2 x E10 Standard SSD LRS       9.60 x 2       =  19.20     16.13
LB included rules             730 x 0.025     =  18.25     15.33
LB data processed             1024 x 0.005    =   5.12      4.30
SQL MI base compute           730 x 1.217744  = 888.95    746.72
SQL MI SQL license   8 x 730 = 5840 x 0.099966= 583.80    490.39   <-- NEW
SQL MI storage                480 x 0.115     =  55.20     46.37
Log Analytics                 299.16667 x 2.76= 825.70    693.59
                                        total  2 647.34  2 223.77
        (was 2 063.54 / 1 733.38 -- understated by 583.80 / 490.39)
```

### 8.6 What changed in the code

* `oracle.js` — new helper `sqlLicenseMeter(serviceName, licenseProductName, currency)` querying the
  `Global` license meter; `priceSqlDatabaseGP` and `priceSqlMiGP` both gained a
  `licenseIncluded = true` option and now emit a third line when it is set. Line descriptions renamed
  from "(license included)" to "- base compute" so the two components can't be confused again.
* `run-oracle.js` — passes `licenseIncluded` (honors a component-level `licenseIncluded:false` or
  `ahb:true`), and records a new `variants.sqlLicensing` block with **both** the `licenseIncluded` and
  `azureHybridBenefit` priced alternatives plus `canonicalChoice` / `why`, so the grader can re-price
  whichever assumption the tool under test made:

  | Scenario | licenseIncluded (canonical) | azureHybridBenefit |
  |---|---|---|
  | s06 SQL DB component | 765.12 list / 673.30 @12% | 473.22 list / 416.43 @12% |
  | s12 SQL MI component | 1 527.95 list / 1 283.48 @16% | 944.15 list / 793.09 @16% |

* No other scenario contains a SQL PaaS component, so s01–s05, s07–s11 and s13–s20 are unchanged.

### 8.7 Related meters checked and deliberately NOT applied

* `SQL Managed Instance Business Critical - SQL License` ($0.375/vCore-hr) — wrong service tier.
* `SQL Database SingleDB/Elastic Pool Hyperscale - SQL License` — wrong service tier.
* `Azure Arc enabled SQL Managed Instance - * - SQL License` and
  `Azure Arc Enabled PostgreSQL Hyperscale - SQL License` ($27/hr) — Azure **Arc** (on-premises /
  customer-hardware) products, not the Azure PaaS services in these scenarios.
* `SQL DB Edge - SQL License` ($0, `1/Month`) — Azure SQL Edge, a different product.
* US Gov rows ($0.124957) — sovereign cloud, not applicable to commercial regions.
* All `DevTestConsumption` rows ($0) — Dev/Test subscription benefit, not assumable.
* PostgreSQL Flexible Server (s11) has **no** license meter — it is open source, so there is no
  equivalent charge and s11 is unaffected.
