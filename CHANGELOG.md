# Changelog

All notable changes to this project are documented here. This project uses
[Semantic Versioning](https://semver.org/).

## [1.1.0] - 2026-10-07

Tier 1 coverage for every Azure Pricing Calculator product that is still sold.

### Added
- **148 component types** with their own interview questions, units, free grants, tiers and cited
  advice, up from 21. Run `azp services` for the list, or `azp services --find "words"`.
- **Per-service advisory rules** in `catalog/rules/<type>.json`; 370 cited rules in total, each with
  a verbatim quote that `check-citations` verifies live.
- **Independent oracle per service** (`tests/oracle/services/`), written from the Retail Prices API,
  the pricing calculator and Microsoft Learn without reading the engine: 1,571 checks.
- **Contract tests** for every type (`services-contract.js`, `builtin-contract.js`): required and
  unknown fields, text in number fields, readback.
- **Excluded products** list (`catalog/excluded.json`) with Microsoft's reason; asking for one returns
  the reason and a link (for example Azure Communication Services, which is retiring).
- **Lifecycle exceptions**, priced with a cited note because the service sets the size: Azure Cloud
  Services (extended support), Azure-SSIS integration runtime nodes, HDInsight ZooKeeper and ID
  Broker nodes.
- Savings plans for databases (SQL Database, elastic pools, PostgreSQL, MySQL, Cosmos DB for
  PostgreSQL), US Gov meters where Microsoft publishes them, and EUR for Blob directory operations.

### Changed
- **Stricter input checks.** Unknown fields are refused for every type. Text, true/false or other
  non-numbers in quantity fields are refused. A line that cannot be priced stops the build.
- **Generic `meter` component.** Hourly meters require `hours` (quantity is the instance count);
  other meters refuse `hours`.
- **Readback** shows 0 hours ("not running") and any value other than 730.
- **Advisories:** reserved-capacity rules stay silent when a commitment is already selected; SQL
  license advisories skip Hyperscale and serverless where they do not apply.
- `check-citations --type <type>` includes shared rules that apply to the type.
- The interview asks for the currency when the region is outside the United States.

### Fixed
- Blob hierarchical-namespace operations use the calculator rate per redundancy.
- Azure Files refuses shares above the 256 TiB maximum.
- Azure OpenAI provisioned throughput accepts only the models in Microsoft's PTU sizing table.
- Many service-specific fixes found by the oracle and review cross-checks.

## [1.0.0] - 2026-10-01

First public release.

### Added
- **Pricing engine** (`scripts/azp.js`, zero dependencies) covering VMs (Linux, Windows, Azure Hybrid
  Benefit, Red Hat, SUSE; pay-as-you-go, 1- and 3-year reservations and savings plans), all managed
  disk types, public IPs, internet egress, Standard Load Balancer, Application Gateway v2, AKS, App
  Service, Functions, Container Apps, Azure SQL Database, SQL Managed Instance, PostgreSQL and MySQL
  flexible server, Cosmos DB, Blob storage, Azure Files, Log Analytics, Azure OpenAI models, and any
  other meter through a generic component. Rates come live from the Azure Retail Prices API.
- **Interview skill** (`SKILL.md`) for people new to Azure: plain-language questions, at most three
  per message, no SKU names asked.
- **Readback**: a plain-language list of every quantity, what the person said, and what is not
  included. The engine builds only after the person has replied to it.
- **Verified answers**: region, discount and requirements must match what the person typed.
- **97 advisory rules**, each citing published Microsoft guidance (Well-Architected Framework,
  Microsoft cloud security benchmark, Microsoft Learn, Azure pricing pages) with a verbatim quote,
  drawn from a review of 1,442 published recommendations. `check-citations` verifies every quote
  against the live page.
- **VM lifecycle policy**: only Current and Extended VM size series are priced. End of Life and
  retired series are refused, with Microsoft's explanation and links, and a current equivalent is
  priced instead.
- **Model check**: the engine detects the AI model in use, tells the person if it was not
  recommended in testing, stamps it on the report, and refuses to build with a blocked model.
- **Must-act warnings** (no disk, disk below required performance), built-in commitment comparisons,
  and a question plan.
- **Installer** (`npx github:chrislittle/azure-pricing-skill init`) with project, global and explicit
  path installs, `update`, `status`, `doctor` and `uninstall`.
- **Tests**: an independent pricing oracle (142 checks), rule fire/silent tests, and split-invariance
  tests.
