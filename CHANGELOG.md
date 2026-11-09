# Changelog

All notable changes to this project are documented here. This project uses
[Semantic Versioning](https://semver.org/).

## [1.3.0] - 2026-11-09

### Added
- Optional field-level `sources` distinguish verified customer values from assumptions in readback,
  build facts, HTML and audit JSON. VM CPU/memory provenance is checked against the selected SKU.
- Native Copilot `ask_user` evidence: linked start/completion events, matching tool call and turn,
  successful human interaction, and observed choice/form result layouts only. Questions, schema
  defaults, unlinked or other-tool output are never answers; unsupported layouts fail explicitly.
  `answers` exposes verified human values and locators without invocation defaults or questions.
- `preflight` validates the spec and grounded evidence without pricing or confirmation. `readback`
  runs the same validation and fails with structured errors before emitting any readback text.
- `prepare` checks spec/report/audit collisions, allocates numbered fresh paths, and exclusively
  creates only the spec. Build exclusively creates both outputs and preserves existing contents.
- `--compact` provides complete one-line JSON for agent consumption. VM `--limit 1..50` bounds
  only `allMatches`, with total/has-more metadata and an untrimmed shortlist and explanations.
- Offline synthetic-session tests cover native answers, preflight, explicit confirmation,
  evidence-only relinking, exclusions, collision preservation and a complete fixture-priced build.
  Installer regression coverage includes every new runtime module and CLI payload.

### Fixed
- Readback codes now bind all scope and visible text, including customer quotes, assumptions,
  discount exclusions and report descriptions; changes require a newly displayed readback and
  subsequent explicit approval. Identical evidence locator changes do not invalidate approval.
- Silence, unrelated replies, corrections and unrelated native forms no longer count as approval.
  Supported single-answer native approvals must reference the displayed check code.
- Approval is bound to the prompt actually answered: an intervening different readback or
  customer-facing question invalidates stale generic approval, while ordinary tool calls do not.
- Schema-based native confirmation requires an unambiguous positive approval field and label;
  rejection/ambiguous booleans and custom reinterpretations of `true` cannot approve an estimate.
- Native approval text is normalized before checking bare `true`, so capitalization,
  recommended-choice labels, punctuation and polite suffixes cannot bypass positive-approval metadata.
- Plain exclusions say "not included", never claim "as agreed"; declined advisory decisions remain
  distinct and are preflight-checked against exact human words. Offline decisions are labeled
  unverified rather than claiming agreement. Final narrative guidance uses engine facts, preserving
  known CPU answers as facts.

### Changed
- Skill workflow allocates paths before writing/reading, preflights before confirmation, and uses
  structured compact output without truncation. README removes stale recommended-model setup.
- Offline regression tests run before network-dependent suites; the oracle comparison runs last
  so known live-price drift cannot prevent the new unit tests. Oracle mismatches return a failing
  exit status and write diagnostics only to `.cache`; tracked oracle snapshots are unchanged.

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
