# Changelog

All notable changes to this project are documented here. This project uses
[Semantic Versioning](https://semver.org/).

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
