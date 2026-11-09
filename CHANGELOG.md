# Changelog

All notable changes to this project are documented here. This project uses
[Semantic Versioning](https://semver.org/).

## [1.2.2] - 2026-11-09

### Fixed
- `update` and `status` now find existing global installs named `azure-pricing-skill`, not only
  `azure-pricing`. Updates overwrite the existing folder without creating a duplicate install.
- `update --global` leaves the project install alone. A missing install now returns a failure
  exit code instead of appearing to succeed.
- Installation output no longer asks people to choose an older tested model.

### Added
- Installer regression tests verify the actual installed engine, skill instructions and manifest
  for both global folder names and an explicit destination.

## [1.2.1] - 2026-11-09

### Fixed
- Estimates failed with "The conversation log does not match what the person typed" in genuine
  Copilot CLI sessions (auto mode, compaction, mid-turn messages). The session-log integrity check
  assumed an older event layout. It now requires an intact parent chain only for the person's own
  messages, tolerates a few milliseconds of timestamp skew, and no longer requires a
  `system.message` parent or `supportedNativeDocumentMimeTypes`. Duplicate ids, unknown parents,
  missing `delivery`/`interactionId`, large time inversions and edited message text are still rejected.
- The error now names the check that failed.

### Changed
- Untested and "works, less consistent" models no longer show a model notice or ask the person to
  switch. Only models listed as not recommended are warned about and blocked.

### Added
- `tests/unit/session-log.js`: accepts real Copilot log shapes and rejects forged ones.

## [1.2.0] - 2026-11-04

### Added
- Self-contained tabbed estimates: navy header, Summary purchasing comparison, detail tabs per
  requested solution or deployment phase, and an Assumptions tab for scope, discount rules,
  next steps and Microsoft-sourced guidance.
- Keyboard tab navigation, hash links, no-JavaScript reading, responsive tables and printing
  of every pane. Critical warnings and incomplete-pricing notices remain outside the tabs.
- Explicit original-estimate IDs, purchasing labels and line-to-component provenance in priced
  results. Exact meter quantities, rate units and unit prices remain in the companion audit file.
- Optional explicit deployment-phase labels and per-scope workload context, preventing production
  advice or like-for-like alternative warnings from being applied to unlike phases.
- Focused report tests for lineage, quantities, totals, currencies, exclusions, failed pricing,
  escaping and readback reconfirmation.

### Changed
- The interview starts with one estimate, asks only missing requirements and uses customer
  terminology. Alternatives are opt-in or motivated by a real decision; phases are not ranked
  as competing architectures, and purchasing comparisons stay within their original estimate.
- Five-column customer tables show service/description, quantity, unit, monthly list and your
  price. Explicit VM counts and runtime are separated without changing pricing arithmetic.
- Lowest-cost flags compare only purchasing variants of the same original estimate, never
  unrelated phases. Readback check codes include scope labels as well as quantities.
- Completeness checks and option-level advice stay within their original estimate, so a resource
  in another phase cannot hide a missing disk or missing cluster nodes in this one.

### Fixed
- Zero-runtime VMs no longer generate full-month purchasing comparison variants.

### Validation note
- The canonical suite reports eight EUR snapshot differences, reproduced with identical values
  on unchanged `main`. All 142 canonical check results match that baseline; pricing expectations
  were not changed to force a pass.
- This release contains only the report and interview redesign on top of 1.0.0. The separate,
  unpublished Tier 1 service expansion is not included.

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
