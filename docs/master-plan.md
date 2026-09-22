# AutoLedger — Master Plan: from portfolio suite to an AI-native ERP business

**Written:** 2026-09-22, after Phase 26 · **Status: PROPOSAL — nothing in this file is built or approved.**
Nothing here overrides [roadmap.md](roadmap.md), the hard rules in [CLAUDE.md](../CLAUDE.md), or [guardrails.md](guardrails.md). Where this plan wants one of those changed, it says so in [§ 11 — Decisions that need your sign-off](#11-decisions-that-need-your-sign-off). Phase numbers below are **proposals**; the roadmap only assigns a number when a phase starts.

---

## Contents

1. [The honest starting position](#1-the-honest-starting-position)
2. [The thesis: how a small team beats SAP, Oracle, Zoho, QuickBooks and Xero](#2-the-thesis)
3. [Selling outcomes, not seats — the business model](#3-selling-outcomes-not-seats)
4. [The target product map](#4-the-target-product-map)
5. [Platform work that every paying customer needs first](#5-platform-work-every-paying-customer-needs-first)
6. [The AI-in-the-loop layer — one runtime, not seven integrations](#6-the-ai-in-the-loop-layer)
7. [New applications in detail](#7-new-applications-in-detail)
8. [Upgrades to the seven existing apps](#8-upgrades-to-the-seven-existing-apps)
9. [Sequenced roadmap — horizons and phases](#9-sequenced-roadmap)
10. [The showcase plan — skills proof alongside revenue](#10-the-showcase-plan)
11. [Decisions that need your sign-off](#11-decisions-that-need-your-sign-off)
12. [What I need from you](#12-what-i-need-from-you)
13. [Risks, stated plainly](#13-risks-stated-plainly)
14. [The next 90 days](#14-the-next-90-days)

---

## 1. The honest starting position

### What is genuinely strong — keep it, and sell it

Most accounting startups can't make these claims. AutoLedger can make all of them, and each one is proven by a test:

| Asset | Why it matters commercially |
|---|---|
| **Double-entry enforced in the database** (deferred constraint trigger, posted-row immutability, `verify:integrity`) | "Your books cannot be out of balance, and no one, including us, can quietly edit a posted entry." Auditors and CFOs trust that sentence. |
| **CDC audit trail on every financial table** (Phase 5) | In India, Rule 3(1) of the Companies (Accounts) Rules has required accounting software with a non-disableable edit log since 1 April 2023. AutoLedger already has one at the database level. That makes it a **compliance feature you can sell**, not only an engineering detail. |
| **Tenant isolation as a first-class rule** (`org_id` on everything, isolation tests per app) | This is what makes it possible to run many client companies on one platform, and the outcome model depends on that. |
| **AI with guardrails already shipped**: PII pixel masking *before* a provider sees an image, confidence-gated auto-post, human review queue, per-call token and cost metering (19.1), two providers | This is the working part of an outcome business. The review queue is already the start of an **operations console**. |
| **Bank reconciliation engine** (40/30/30 confidence matching, approval queue, Phase 6.1 direct posting) | Reconciliation is the most repetitive bookkeeping job, so it is the easiest outcome to sell. |
| **Subsidiary ledgers that reconcile to control** (Phase 25: Σ parties = aging = control) | This is SAP's reconciliation-account discipline, which small-business tools don't have. |
| **Sandbox + walkthrough** | You can demo in 30 seconds and teach in 3 months. That is a sales asset. |

### What stands between this and a product anyone pays for

These gaps come from the "Not built" sections of each spec file and from the codebase itself:

1. **It is not deployed anywhere.** It has no Dockerfiles, no hosting, no backups, and no object storage (the Document Vault is local disk and single-instance by its own admission).
2. **It has no dimensions on ledger lines** (department, cost centre, project, location). Management accounting, segment reporting, and serious budgeting all depend on them, so this is the most important *data-model* gap.
3. **It has no statutory tax engine.** Invoices have a flat tax amount into `1180`/`2140`. It has no GST place-of-supply, no CGST/SGST/IGST split, no returns, no e-invoicing, and no TDS. The first market will not buy without these (see §2).
4. **It has no operations modules.** There is no inventory, no purchase orders or goods receipts, no sales orders or deliveries, no fixed assets, and no payroll. The roadmap dropped these on purpose ([roadmap.md § Dropped from scope](roadmap.md#dropped-from-scope)), and this plan proposes bringing them back (Decision D1).
5. **It has no document outputs.** There is no PDF invoice, no emailed statement, and no XLSX export.
6. **It has no fine-grained permissions or approval workflows.** It has four fixed roles and no "approve bills over ₹5 lakh" matrix.
7. **It has no multi-entity support or consolidation.**
8. **It has no way to bring a real business in cheaply.** CSV importers exist, but there is no importer for Tally, Zoho Books, or QuickBooks. Migration cost is what keeps customers with their incumbent.
9. **It has no commercial plumbing.** It has no billing, no metering of *our* outcomes, no client portal, and no ops console for the people delivering the service.

---

## 2. The thesis

### Don't fight the incumbents on features

SAP and Oracle don't lose deals on feature count. They lose on **cost of implementation, time to value, and needing a consultant for every change**. QuickBooks, Xero and Zoho lose on **depth** (weak controls, weak multi-entity, weak management reporting) and on the fact that **the customer still has to do the bookkeeping**.

The gap is the same in both cases: **every one of them sells software, and the customer still has to do the work.** AutoLedger should sell *finished accounting work* on top of an ERP-grade core:

> **"Your books closed, reconciled and GST-filed by business day 5 every month, backed by a database that cannot be out of balance, with every AI decision explained and reversible."**

Each clause in that sentence is backed by something that already exists or is in this plan.

### Pick a beachhead, then expand

A new entrant can't be a "SAP killer" on day one. It gets there by winning one segment well enough that the segment funds the next. **My recommendation, which is Decision D2:**

**Beachhead: Indian SMEs and startups with ₹2–100 crore in revenue, reached through Chartered Accountant (CA) firms.**

- **Why India.** TaxGuard's statute parser is already tuned for Indian drafting. The audit-trail mandate turns Phase 5 into a selling point. GST and e-invoicing complexity is exactly where rules plus AI beat manual work. Tally dominates, but it is desktop-first and has little AI, so there is a clear switching story. Local cost structure also makes a human-in-the-loop service profitable.
- **Why through CA firms.** In India the CA owns the SME relationship. A CA firm with 80 clients is a better first customer than 80 SMEs: one sale, 80 tenants, and they already do the work you want to automate. AutoLedger becomes **the operating system for a CA firm**, and the firm delivers outcomes to its clients on it. Multi-org membership (Phase 1) already supports one user working across many client organizations.
- **Expansion path.** India CA firms → Indian mid-market (multi-entity, inventory, manufacturing) → cross-border (Indian companies with US/UK subsidiaries, which uses the FX engine and needs consolidation) → US/UK SMBs served by an India-based ops team.

**Alternatives considered:**

- **US SMB bookkeeping direct.** This is the largest market, but Bench (shut down December 2024) showed that the "cheap bookkeeping at scale" model fails when automation lags behind the promise. It is also crowded with AI-native entrants (Digits, Pilot, and newer AI-native GL startups). Not the first market.
- **US startup mid-market ERP.** This is the NetSuite-replacement space, where several well-funded AI-native GL companies already compete. It is a good second-stage market, but not a place to start as a solo builder.
- **Horizontal "all countries" launch.** This loses to depth everywhere. Tax and compliance are local, so go deep in one jurisdiction first.

---

## 3. Selling outcomes, not seats

### What "outcomes" actually means here

"Sell outcomes, not SaaS" is a slogan. The version that works has four conditions, and each outcome AutoLedger sells has to meet all four:

1. **Measurable.** The system itself can tell whether the outcome happened. For example, "Bank account X reconciled for August" is a row with a status.
2. **Attributable.** It is clear who did the work: the platform, an AI agent, or a human reviewer. AutoLedger's audit trail already records the actor.
3. **Within your control.** You can't guarantee "collect 90% of receivables", because the customer's customers decide that. You *can* guarantee "every overdue invoice is chased on schedule with a correct statement".
4. **Cheaper to deliver than to price.** Delivery cost = AI cost (already metered by 19.1) + human exception minutes + platform cost.

### The outcome catalogue (pricing hypotheses to validate, not decisions)

| Outcome (the "SKU") | Unit | Delivered by | Existing foundation | Hypothesis price (India) |
|---|---|---|---|---|
| **Bills processed** | per bill posted to the ledger | AP-Flow capture → AI extract → confidence gate → human review of exceptions | Phases 10, 11, 19, 19.x | ₹15–40 per bill |
| **Bank reconciled** | per bank account per month | Bank feed → matching engine → agent proposes → human approves | Phases 6, 6.1 | ₹500–1,500 per account per month |
| **Books closed** | per entity per month, with an SLA of "business day N" | Close agent runs the checklist; human signs off | Phase 15 close checks | ₹5,000–25,000 per month by complexity |
| **GST filed** | per return (GSTR-1, 3B) including 2B reconciliation | Tax engine + reconciliation agent + human practitioner files | New (Phase T1) | ₹1,000–3,000 per return |
| **Collections run** | per active debtor per month | Collections agent drafts, human approves, sends | Phase 25 party ledger, open items | ₹50–150 per debtor per month |
| **Board pack delivered** | per pack | BoardDeck + variance-commentary agent + human review | Phase 15 | ₹10,000–30,000 per pack |
| **Month-end management accounts** | per month | CostLens allocations + segment P&L + commentary | New (§7.2) | Bundled into "Books closed" (premium tier) |

**The platform itself** is priced low or free for CA firms (a seat licence or a per-client-org fee). The margin comes from outcomes. This mirrors the model the industry is moving toward: software gets cheap, and finished work is what gets paid for.

### Guarantees are the product

Outcome pricing only means something if there's a guarantee behind it:

- **SLA guarantee.** "Closed by business day 5, or that month's close fee is waived." This needs the close agent (§6) and a real SLA timer in the ops console (§5.8).
- **Accuracy guarantee.** "Any error we introduce is corrected free, with a reversing entry and an audit note." Posted-row immutability plus reversals make this cheap to honour, because a correction never destroys history.
- **Explainability guarantee.** "Every AI-made posting shows why: source document, confidence, rule, and reviewer." The data exists already (`ai_model_calls`, extraction confidence, audit rows), so this is a UI job.

**Legal and professional reality (flagged, not legal advice).** Filing GST returns needs a registered GST practitioner or the taxpayer. Statutory audit and attestation are reserved to CAs. Offering "done-for-you" accounting creates professional liability. The CA-firm channel resolves most of this, because the licensed professional stays in the loop and signs. Before selling any done-for-you outcome directly, get a legal opinion, professional indemnity insurance, and a proper engagement letter.

### Unit economics to track from the first pilot

These metrics come from the data model, and most can already be derived today:

- **Touchless rate**: the share of outcomes completed with zero human edits (AP-Flow auto-post rate, bank auto-match rate).
- **Exception minutes per outcome**: time spent in the review queue. This needs timestamps on queue claim and resolve (§5.8).
- **AI cost per outcome**: `ai_model_calls` already gives cost per document.
- **Gross margin per outcome** = price − (AI cost + exception minutes × loaded hourly cost + infra share).
- **Error rate**: corrections (reversals) traced back to an AI or ops action within 60 days.
- **Days to close** per entity per month.

**Target progression:** roughly 40% gross margin in the first 3 pilot months (service-heavy), 60%+ by month 12, and 75%+ at scale. That trajectory, not the starting number, is the proof that it's software rather than an outsourcing firm.

### How the revenue ramps

| Stage | Revenue source | What it proves |
|---|---|---|
| **0: now** | None. It is a portfolio for interviews and consulting credibility. | That you can build finance systems correctly. |
| **1: design partners** (1–3 CA firms, free or near-free) | None or token | That the outcomes can actually be delivered, and at what exception rate. |
| **2: paid pilots** | Outcome fees from 5–20 client orgs | Willingness to pay, first unit economics. |
| **3: CA firm platform** | Platform fee per firm + outcome fees per client org | A channel that repeats. |
| **4: direct mid-market** | Outcome bundles + implementation fees for inventory, manufacturing and multi-entity customers | Expansion beyond the beachhead. |
| **5: ecosystem** | Public API and MCP access, marketplace of add-ons, embedded finance referrals (payment links, working-capital lending on verified books) | Platform leverage. |

**Side income that doesn't distract (optional).** Finance-systems consulting, implementation work, and "AI for finance teams" workshops, built on this codebase and the walkthrough. This pays the bills and produces case studies.

---

## 4. The target product map

The suite grows from 7 apps to about 17, grouped so a customer sees **five products**, not seventeen icons. The app registry (`config/apps.ts`) stays the source of truth for slugs. Grouping into products is a presentation layer on top of it (Decision D4).

| Product (what the customer buys) | Apps inside it | Status |
|---|---|---|
| **Core Finance** | LedgerCore · AssetBook · GroupClose · RevStream | LedgerCore built; the others are new |
| **Operations** | StockLedger · ProcureFlow · OrderDesk · AP-Flow · MakeFlow (later) · ProjectLedger (later) | AP-Flow built; the others are new |
| **Tax & Compliance** | TaxGuard AI (advisory + compliance) · ControlTower | TaxGuard advisory built; compliance and ControlTower are new |
| **Performance & Planning** | CostLens · FP&A Engine · ForecasterPro · UnitEcon · BoardDeck | CostLens new; four built |
| **Cash & People** | CashOps · PeopleCost (later) | New |
| *Platform (invisible)* | Autopilot (agent runtime) · Ops Console · Client Portal · Integrations hub · Billing | Pieces exist (queues, Drive intake, AI metering) |

### Priority of the new apps

| Priority | App | Slug (proposed) | Why this priority |
|---|---|---|---|
| **P0** | Dimensions (a LedgerCore upgrade, not an app) | — | Blocks CostLens, segment reporting, departmental budgets, and project accounting |
| **P0** | TaxGuard Compliance (GST/TDS/e-invoicing) | `taxguard` (extended) | The beachhead can't adopt without it |
| **P0** | Autopilot + Ops Console | platform | The outcome model can't be delivered without it |
| **P1** | **StockLedger**: inventory & warehousing | `stock` | Most Indian SMEs trade goods, and inventory is where Tally keeps them |
| **P1** | **CostLens**: management accounting | `costlens` | Main finance-skill showcase; the premium outcome tier |
| **P1** | ProcureFlow: purchasing & 3-way match | `procure` | Completes P2P with AP-Flow; required for inventory receipts |
| **P1** | OrderDesk: order-to-cash & collections | `orderdesk` | Completes O2C; required for inventory issues |
| **P1** | AssetBook: fixed assets | `assets` | Every company has them; a small, self-contained build |
| **P1** | CashOps: bank feeds, cash forecast, payment runs | `cashops` | Bank feeds make "bank reconciled" touchless |
| **P2** | GroupClose: multi-entity & consolidation | `groupclose` | Required for mid-market and cross-border |
| **P2** | RevStream: subscription billing & revenue recognition | `revstream` | SaaS customers; feeds UnitEcon properly |
| **P2** | ControlTower: controls, anomaly detection, auditor portal | `controls` | Turns the audit trail into a product |
| **P3** | ProjectLedger: projects, time, WIP | `projects` | Professional-services vertical |
| **P3** | PeopleCost: payroll (integrate first, build later) | `payroll` | Indian payroll statutory load is heavy; post journals from a provider first |
| **P3** | MakeFlow: BOM, MRP, production orders | `make` | Manufacturing vertical, after StockLedger has matured |
| **Skip** | CRM, HRMS, e-commerce storefront | — | Integrate instead. These are someone else's core product. |

---

## 5. Platform work every paying customer needs first

None of this is glamorous. All of it comes before the first rupee.

### 5.1 Deployment & operations (proposed Phase 27)
- Dockerfiles for server, worker and client; a single-region cloud deployment (India region for data residency); managed Postgres with point-in-time recovery; managed Redis.
- **Object storage** behind the existing `storageService` interface (S3-compatible). Its own docs call this "a one-file swap".
- Backups with a **tested restore**, structured logs, error tracking, uptime checks, and a status page.
- Secrets management; rotation of `ACCESS_TOKEN_SECRET`/`REFRESH_TOKEN_SECRET` without logging everyone out (dual-key verification window).
- **Interview material:** blue/green deploys with migrations that are additive (rule 13 already enforces this), zero-downtime migration patterns, graceful shutdown (already built).

### 5.2 Postgres Row-Level Security as defense in depth (proposed Phase 28)
- Rule 1 is enforced in application code today. Before AI agents are allowed to *read* through generic tools, add RLS policies keyed on `current_setting('app.current_org_id')`, set with `SET LOCAL` the same way Phase 5 sets the actor.
- One leaked `WHERE` clause then fails closed instead of leaking a tenant.
- **Interview material:** RLS mechanics, `BYPASSRLS`, the performance of `USING` predicates, and why it's defense in depth rather than a replacement for rule 1.

### 5.3 Permissions & approval workflows (proposed Phase 29)
- Move from 4 fixed roles to `roles` + `permissions` tables (the architecture doc already names this as the trigger). Add a **CA-firm role** (`PRACTITIONER`) that spans client orgs, plus an **auditor read-only role**.
- **Approval matrix engine:** rules like "bills > ₹5,00,000 need an ADMIN; payments need two approvers; journals to a control account are refused" (the last already exists). Build it as a generic FSM-hook service that every document type calls.
- **Segregation of duties:** the person who created a payment can't approve it. Enforce it in the service and test it.

### 5.4 Documents out: PDF, email, exports (proposed Phase 30)
- PDF invoices, credit notes, statements and remittance advice (server-side rendering; choose between a headless browser and a PDF library at phase start).
- Transactional email via the outbox (rule 5: never send after `COMMIT` without the queue). Handle bounces and track open and delivery status.
- XLSX/CSV export on every report. Scheduled report delivery.

### 5.5 Dimensions on ledger lines (proposed Phase 31, P0)
- `dimensions` (org-defined types: Department, Cost Centre, Project, Location, Product Line, Customer Segment) and `dimension_values` (hierarchical, with a recursive CTE like accounts).
- **The design choice:** `ledger_lines` is immutable once posted, so dimensions are **captured at posting time** through a `ledger_line_dimensions` junction table, written in the same transaction and immutable by the same trigger pattern. Posted lines are never updated. **Re-tagging is done by a reclassification journal**, not an edit. This is how SAP (profit-centre reposting) and NetSuite handle it.
- Dimensions are carried on invoice, bill, credit note and journal lines, and defaulted from the item, party or employee.
- **Every report gains a dimension filter and a dimension pivot.** The trial balance by department is the acceptance test.
- Mandatory-dimension rules per account ("every 6xxx expense line needs a Cost Centre"), enforced in the service.

### 5.6 Master data layer (folds into reserved Phase 21, "app enablement & cross-app connections")
- Items, customers, vendors, employees, dimensions and payment terms are **shared master data** that StockLedger, ProcureFlow, OrderDesk and CostLens all need.
- Rule 16 forbids reading another app's tables, but the Drive dispatcher precedent (19.3) allows calling another app's **service**. The plan: LedgerCore's `itemService`, `customerService` and `vendorService` become the sanctioned read and write API for master data, with a typed interface other apps import. **No table moves and no migration churn** (Decision D5).

### 5.7 Importers from incumbents (reprioritise Phase 17)
- **Tally import (XML export: masters + vouchers) comes first.** It is the migration path for the beachhead.
- Then Zoho Books and QuickBooks Online, both via API. **Import matters more than sync.** Phase 17 as specced (push journals *to* QuickBooks) helps customers stay on QuickBooks. Recommend re-scoping 17 to "QuickBooks/Zoho/Tally **import**", with two-way sync only when a paying customer asks for it (Decision D6).
- Every importer runs through the existing staged-import pattern (Phase 9b): stage → validate → preview → commit, idempotent, resumable.

### 5.8 Ops Console & outcome metering (proposed Phase 32, P0 for revenue)
- **One unified work queue** across apps: AP-Flow review items, unmatched bank lines, close-check failures, GST mismatches, and agent proposals awaiting approval. Each item has an owner, an SLA timer, claim and resolve timestamps, and an outcome link.
- **`outcomes` table:** every billable outcome as a row (`org_id`, `kind`, `period`, `status`, `delivered_at`, `touchless`, `exception_minutes`, `ai_cost_cents`). This is also the invoice source for our own billing.
- A multi-client dashboard for CA firms showing every client org's close status on one screen. This is the view a firm partner would pay for on its own.
- **Billing:** AutoLedger invoicing its own customers, using LedgerCore itself, on a dedicated AutoLedger org. It eats its own cooking.

### 5.9 Client portal (proposed Phase 33)
- The end client (the SME owner) gets a simple view: upload bills, answer the ops team's questions ("what was this ₹42,000 payment?"), see the monthly pack, and approve payments.
- Questions asked of the client are structured and linked to the specific bank line or document, not sent as loose emails. This is how exception minutes shrink.

### 5.10 Security & compliance posture
- India's DPDP Act 2023: consent, purpose limitation, a breach-notification runbook, and a data-principal request handler.
- **SOC 2 readiness comes later**, triggered by the first cross-border or mid-market customer who asks. The audit trail, RBAC, and access logging already answer a large share of the controls.
- MFA (TOTP) and SSO (Google/Microsoft OAuth) for CA firms; a session and device list; the Redis denylist the architecture doc already names for immediate revocation.

---

## 6. The AI-in-the-loop layer

### The problem with the current shape

Today, AI lives inside two apps by rule (rule 14), and each app wires its own model client, confidence rule, and review queue. That doesn't scale to fifteen apps, and it isn't what an outcome business needs. **Proposal (Decision D3): promote AI to a platform runtime, "Autopilot", with one set of guardrails.** Keep rule 14's discipline (no speculative SDKs), but widen its scope with an explicit amendment.

### The Autopilot contract: every agent action follows the same seven steps

```
1. TRIGGER     a schedule, an event from the outbox, or a human request
2. GATHER      read-only tools, which are typed service functions, RLS-enforced and org-scoped
3. PROPOSE     the model produces a structured proposal (a Zod-validated schema, never free text, never SQL)
4. VERIFY      deterministic checks: balances, tax arithmetic, period open, party exists, amount caps
5. GATE        confidence × materiality × policy → auto-apply | queue for human | refuse
6. APPLY       through the same service function a human would call, with actor = agent:<name>, on_behalf_of = user
7. EXPLAIN     proposal, evidence, confidence, cost and reviewer are stored and shown next to the posted row
```

**Non-negotiables** (these extend the hard rules; see Decision D3):
- A model **never writes SQL** and never touches a table. Tools are service functions. Rule 2 already makes this the natural shape.
- An agent's write goes through the same FSM, period lock, approval matrix and audit trigger as a human's. **No agent-only path exists.**
- PII redaction runs before any provider call. That is already true for AP-Flow and TaxGuard, and it becomes a platform middleware.
- Every call is metered in `ai_model_calls` (already platform-level since 19.1).
- Every agent has an **eval set** (see below) and a **kill switch** per org.
- Materiality caps: an agent can't auto-apply above an org-configured amount, whatever its confidence.

### The agents, in build order

| Agent | Outcome it serves | Proposes | Deterministic verifier |
|---|---|---|---|
| **Bank reconciliation agent** | Bank reconciled | A match, a journal for fees/interest (6.1), or a question to the client | Amount/date tolerance; the control-account rule (Phase 25) |
| **AP agent** (upgrade of AP-Flow) | Bills processed | Vendor, lines, account, dimensions, tax codes | Arithmetic; GST rate validity; duplicate check (19.4) |
| **GST reconciliation agent** | GST filed | GSTR-2B vs purchase register matches and mismatch explanations | Invoice number + GSTIN + amount matching with the 40/30/30 pattern reused |
| **Close agent** | Books closed | The checklist run, accrual/prepaid suggestions, a list of blockers | BoardDeck's five checks, extended |
| **Collections agent** | Collections run | Dunning emails with a statement attached, escalation level | Open items (Phase 25); nothing sent without an approval policy |
| **Variance commentary agent** | Board pack, management accounts | A narrative for each material variance, **citing drill-down lines** | Every number in the narrative must match a computed figure. Reject otherwise. |
| **Ask-your-books** | Every customer | Answers built from typed report functions ("show departmental opex vs budget for Q2") | The answer's numbers come from report functions, never the model's arithmetic |
| **TaxGuard advisory** (exists) | Compliance | Cited answers | Citation grounding (Phase 16) |

### Evals: the part most AI-finance products skip

- **Golden datasets built from what already exists:** `walkthrough/` (4 months with a computed answer key) and the 24-month sandbox. Add real, consented, anonymised pilot data over time.
- Per-agent metrics: precision/recall of matches, field-level extraction accuracy, false-auto-apply rate (the metric that matters most), and cost per outcome.
- **CI gate:** a prompt or model change that lowers an agent's eval score below its threshold fails the build, the same way a test would.
- **Publish the eval results.** This is a differentiator, and a strong showcase artifact (§10).

### An MCP server for AutoLedger

Expose the read-only report functions, plus a small set of proposal-only write tools, as a **Model Context Protocol server**, authenticated per org with scoped API keys. A CFO's own AI assistant can then query their books safely, and every write still lands in the approval queue. This is a cheap build (the service layer already exists), strong positioning, and a very good interview story.

---

## 7. New applications in detail

The two you asked about, inventory and management accounting, are specified at greater depth. The rest follow the same template in shorter form. Each would get its own `docs/<slug>.md` spec file when its phase starts, following the existing pattern.

### 7.1 StockLedger: inventory & warehousing (`stock`)

**Purpose.** A perpetual inventory with exact valuation that always reconciles to the GL inventory control account.

**Finance concepts demonstrated:** perpetual vs periodic inventory; FIFO, moving weighted average and standard cost (with purchase price variance); COGS recognition; the goods-received-not-invoiced (GRNI) accrual; landed cost capitalisation; lower of cost and net realisable value (NRV) write-downs (AS 2 / Ind AS 2); stock-count variance and shrinkage; inventory turnover and days of inventory. **LIFO is excluded on purpose:** it is prohibited under Ind AS 2 and IFRS (permitted only under US GAAP), and leaving it out is a good interview answer.

**Data model (sketch):**

| Table | Notes |
|---|---|
| `stock_warehouses`, `stock_locations` | Locations are hierarchical (warehouse → zone → bin), resolved with a recursive CTE |
| `stock_item_settings` | Per-item stock policy on top of LedgerCore's `items`: tracked flag, base unit, valuation method, reorder point, lot/serial tracking. **A separate table, not new columns on `items`** (rule 16; master data stays LedgerCore's) |
| `stock_uoms`, `stock_uom_conversions` | Box of 12 → each; integer milli-quantities like `quantity_milli` already used on invoice lines |
| `stock_movements` | **Append-only.** Signed `quantity_milli`, `value_cents`, `movement_type` (RECEIPT, ISSUE, TRANSFER_OUT, TRANSFER_IN, ADJUSTMENT, COUNT_VARIANCE, REVALUATION), `source_type`/`source_id` (GRN, delivery, count), `org_id`, `posted_at`. Immutable by trigger, like `ledger_lines` |
| `stock_cost_layers` | For FIFO: one layer per receipt with `remaining_quantity_milli` and `remaining_value_cents`. Consumption records which layers it drew from (`stock_layer_consumptions`) |
| `stock_balances` | A **derived cache**: on-hand quantity and value per (item, location, lot). Maintained in the same transaction as each movement and **verified against Σ movements by an integrity script**, as `verify:integrity` does for the GL |
| `stock_lots`, `stock_serials` | Expiry dates, FEFO picking (first expired, first out) |
| `stock_reservations` | Soft-allocation of on-hand stock to sales orders; available = on hand − reserved |
| `stock_counts`, `stock_count_lines` | Cycle counts and full counts with an FSM: DRAFT → COUNTING → REVIEW → POSTED |
| `stock_landed_costs` | Freight or duty bills allocated across receipt lines by value, weight or quantity |

**The mechanisms (this is the interview material):**

1. **Concurrency on stock.** Two orders issue the last unit at the same moment. The solution: `SELECT … FOR UPDATE` on the `stock_balances` row(s) involved, **locking in a deterministic order (sorted by item id, then location id)** so two multi-line documents can't deadlock. The rejected alternatives were `SERIALIZABLE` isolation (correct, but it moves the problem to retry storms under contention) and optimistic version columns (bad for hot SKUs).
2. **Exact integer valuation.** A layer holds 3 units worth ₹100.00 (10,000 cents). Issuing 1 unit costs 3,333 cents, and the last unit costs 3,334. **The rule: the value consumed is the difference between the layer's remaining value before and after, computed so the final unit takes the remainder.** This keeps Σ issued = Σ received to the paisa. It is the same discipline as `scaleCents`, and the same "no epsilon" stance as rule 3.
3. **Backdated movements.** A receipt dated 3 days ago changes the moving average of every issue after it. **The ruling:** backdating is allowed only within an open fiscal period (Phase 4's lock already exists), and it triggers a **revaluation job** that recomputes affected issues and posts one adjusting COGS journal. It never edits posted movements. NetSuite and Odoo both struggle with this case, and it is an excellent design-doc topic.
4. **Negative stock policy** per org: refuse (the default), or allow with a pending-cost correction when the receipt arrives.
5. **GL integration through LedgerCore's journal service** (rule 16):
   - Goods receipt: DR Inventory · CR GRNI (`source_type = 'stock_receipt'`)
   - Vendor bill matched: DR GRNI · CR AP, with the price difference to PPV or inventory
   - Delivery: DR COGS · CR Inventory
   - Count variance: DR/CR Inventory Shrinkage
   - NRV write-down: DR Inventory Write-down · CR Inventory Provision
6. **The reconciliation invariant**, extending Phase 25's pattern: **Σ `stock_balances.value` = GL inventory control balance** at every point in time. It is tested and checked by the integrity script. Direct manual journals to the inventory control account are refused (the control-account rule from Phase 25).

**Planning features:** ABC classification (Pareto on consumption value); reorder point = average daily demand × lead time + safety stock, where **safety stock = z × σ(daily demand) × √(lead time)**; EOQ = √(2DS/H); inventory turnover and days of inventory; slow-moving and ageing reports.

**AI in the loop (and where it is left out):**
- **Demand forecasting uses statistics, not an LLM.** Exponential smoothing for regular items; Croston's method for intermittent demand. Being honest that an LLM is the wrong tool here is itself a showcase point.
- An agent **proposes** reorders. A human approves, and the approval creates a draft PO in ProcureFlow.
- Anomaly flags: shrinkage outliers by location, count variances above tolerance, and receipts priced above the vendor's history.
- Natural-language stock questions go through Ask-your-books.

**Build ladder (about 4 phases):**
1. Warehouses, locations, item stock settings, UoM, manual receipt/issue/adjustment, moving average, GL posting, the reconciliation invariant.
2. FIFO layers, transfers with in-transit, lots, serials and expiry, stock counts.
3. Integration with ProcureFlow (GRN) and OrderDesk (delivery, reservations), landed cost.
4. Planning: ABC, reorder points, forecasting, NRV write-down, ageing.

**Acceptance criteria (sample):**
- Two concurrent issues of the last unit: exactly one succeeds and the other gets `409`. Proven by a test that runs the requests in parallel.
- Σ movement values = Σ balances = GL control balance after the full sandbox seed.
- A FIFO issue across 3 layers consumes exactly the remaining value of each fully consumed layer.
- A cross-tenant isolation test (rule 15).

---

### 7.2 CostLens: management accounting (`costlens`)

**Purpose.** Answer the questions financial accounting doesn't: *which department, product, customer or project makes money; where cost comes from; why actuals differ from plan; and what the business should do next.*

**Where it sits relative to existing apps:**
- **UnitEcon** does customer and cohort economics from revenue data. CostLens adds the **cost side**, and together they produce customer profitability.
- **ForecasterPro and FP&A** are forward-looking plans. CostLens is **actuals analysis and allocation**, and it feeds actual drivers back into them.
- **BoardDeck** consumes CostLens output (segment P&L, variance commentary) for board packs.
- **It requires Dimensions (§5.5).** Without them there is nothing to allocate or report by, which is why Dimensions is P0.

**Modules:**

1. **Responsibility structure.** Cost centres, profit centres and investment centres as a dimension hierarchy with owners. **Responsibility reports** show each manager only what they control (controllable vs non-controllable costs).
2. **Cost allocation engine.** The main mechanism:
   - Cost pools (for example IT, HR, and facilities costs) and allocation bases (headcount pulled from ForecasterPro's headcount plan, floor area, revenue share, a usage driver entered per period, or a statistical account).
   - Methods: **direct**, **step-down** (with a user-set sequence), and **reciprocal**. Reciprocal is solved as a system of simultaneous linear equations (Gaussian elimination over exact rationals using `BigInt` numerator/denominator, **not floats**), then rounded to cents with the **largest-remainder method** so that allocated totals equal the pool to the paisa.
   - Each allocation run is an **allocation journal** (`source_type = 'costlens_allocation'`), idempotent per (org, period, rule set version), reversible by reversal, and never edited. Re-running a period reverses the old run and posts the new one in one transaction.
   - Allocation rules are versioned. A posted run records the rule version it used, so the run can be reproduced and audited.
3. **Segment and contribution reporting.** A contribution-margin statement (revenue − variable costs = contribution − fixed costs), P&L by any dimension, segment margin, and cost behaviour classification (fixed / variable / semi-variable per account, with the high-low method or regression to split semi-variable costs, and the fit's R² shown).
4. **Cost-volume-profit analysis.** Break-even units and revenue, margin of safety, operating leverage, a multi-product break-even on a weighted-average contribution margin, and an interactive sensitivity view.
5. **Standard costing and variance analysis** (after StockLedger and MakeFlow). Standard cost cards per item, and variances with the textbook decomposition: material price and usage; labour rate and efficiency; variable overhead spending and efficiency; fixed overhead budget and volume. Variances post to variance accounts. This connects to PVM in UnitEcon, the revenue-side twin.
6. **Activity-based costing.** Activities, activity cost pools and cost drivers (number of orders, setups, support tickets), yielding product and customer profitability under ABC compared with traditional absorption costing. The comparison is the insight.
7. **Performance measures.** ROI, residual income, and EVA for investment centres; a balanced-scorecard-style KPI tree tied to actual data.
8. **Transfer pricing (later, with GroupClose).** Cost-plus and market-based internal charges between entities, eliminated on consolidation.
9. **Departmental budget vs actual**, by dimension, reading ForecasterPro's budgets through its service.

**AI in the loop:**
- **Variance commentary agent.** "Marketing is 18% over budget in August: ₹4.2 lakh from the new agency retainer (bill B-0412) and ₹1.1 lakh of events spend moved forward from September." Every number in the narrative is checked against computed figures, and every claim links to a drill-down. Numbers that aren't verified cause the narrative to be rejected.
- **Allocation-basis suggestions:** "IT cost correlates with headcount (R² 0.91) better than with revenue (0.34)". A human chooses.
- **Mis-coding detection:** an expense line whose dimension doesn't fit the vendor's history is flagged for a reclassification journal.

**Build ladder (about 3 phases):** (1) responsibility structure, direct and step-down allocation, contribution-margin and segment P&L, departmental BvA; (2) reciprocal allocation, CVP, cost behaviour, ABC, the commentary agent; (3) standard costing and variances (gated on StockLedger phase 3), performance measures.

**Acceptance criteria (sample):**
- A reciprocal allocation of 3 service departments reproduces a textbook worked example exactly, to the paisa.
- Σ allocated = Σ pool for every run (an integer equality test).
- Reversing and re-running a period gives an identical trial balance to a single run.
- Contribution margin by department sums to the company contribution margin.

---

### 7.3 TaxGuard Compliance: GST, TDS, e-invoicing (extends `taxguard`)

- **Tax codes and determination:** HSN/SAC on items; place-of-supply rules deciding **CGST+SGST vs IGST**; reverse charge; exempt, nil-rated, zero-rated and export (LUT) supplies; composition dealers. Tax lines post to separate output and input accounts per tax component, replacing today's single `1180`/`2140` pair. This needs a migration plan, because existing invoices stay as they are (immutability).
- **Input tax credit (ITC) ledger** with eligibility (blocked credits under section 17(5)), reversal rules, and the GSTR-2B match.
- **Return preparation:** GSTR-1 (outward), GSTR-3B (summary), and the reconciliation workbench. **The GSTR-2B reconciliation reuses the Phase 6 confidence engine** with GSTIN + invoice number + amount + date scoring. This is a strong reuse story.
- **E-invoicing:** IRN generation through an Invoice Registration Portal (via a GST Suvidha Provider API or a direct API), signed QR code on the PDF, and a 30-day reporting window check for large taxpayers. **E-way bill** for goods movement, which links to StockLedger transfers.
- **TDS/TCS:** section-wise deduction on bills and payments, challans, quarterly return preparation (24Q/26Q), and Form 16A generation.
- **Advisory stays RAG** (Phase 16), now able to cite the specific transaction it's asked about.
- **Thresholds and dates change often.** Every rate, threshold and due date lives in a versioned, effective-dated rules table, never in code. Verify current values at build time; don't rely on this document.

### 7.4 ProcureFlow: purchasing (`procure`)
Purchase requisition → approval (the §5.3 matrix) → PO → goods receipt (StockLedger) → **3-way match** (PO × GRN × bill, with tolerance rules; AP-Flow supplies the bill side) → payment run (CashOps). Also vendor onboarding with GSTIN/PAN validation, blanket POs, budget checks against ForecasterPro at requisition time, and a vendor scorecard (on-time delivery, price variance). The FSM on PO status is the rule-10 showcase. An AI agent drafts POs from reorder proposals and flags off-contract prices.

### 7.5 OrderDesk: order-to-cash & collections (`orderdesk`)
Quote → sales order (credit-limit check against Phase 25 open items) → reservation → delivery note (StockLedger issue; COGS) → invoice (LedgerCore) → collection. Also: price lists and discount rules, partial deliveries and back orders, **payment links** (Razorpay/Stripe) with automatic cash application, a **dunning engine** (the collections agent), and a customer portal. It also carries **cash refunds of unapplied credit** and **bad-debt write-off**, both gaps named in Phase 26.

### 7.6 AssetBook: fixed assets (`assets`)
An asset register (from a bill line or a CWIP capitalisation), categories with useful lives, and **dual books**: Companies Act Schedule II (SLM/WDV) for the financial statements and **Income-tax Act block-of-assets WDV** for tax. The difference feeds deferred tax. The **monthly depreciation run is an idempotent scheduled job** (unique on org + asset + period + book; a re-run is a no-op), which is the EAM pattern from "Dropped from scope". Also disposals with gain/loss, impairment, revaluation, transfers between locations and cost centres, and physical verification with QR tags. It feeds the FP&A capex and depreciation schedule, which is currently held flat (a named gap in fpa-engine.md).

### 7.7 CashOps: treasury (`cashops`)
- **Bank feeds:** in India, the RBI **Account Aggregator** framework (consent-based, through a licensed AA and a financial information user arrangement or partner); elsewhere, Plaid, TrueLayer or GoCardless-type aggregators. Feeds flow into the existing Phase 6 import pipeline.
- **13-week cash forecast:** a bottom-up forecast from open AR and AP by due date (Phase 25 open items), payroll, recurring bills, and ForecasterPro drivers. Actual vs forecast accuracy is tracked weekly.
- **Payment runs:** select due bills → approve (dual control) → generate the bank payment file (bank-specific formats) → mark paid on bank-feed confirmation.
- Expense claims and corporate card feeds, with receipts through the AP-Flow capture pipeline.

### 7.8 GroupClose: multi-entity & consolidation (`groupclose`)
Entity groups within a tenant; intercompany transactions that automatically create the mirror entry in the counterparty entity; intercompany reconciliation; **elimination entries**; **currency translation** (assets and liabilities at closing rate, P&L at average rate, differences to the foreign currency translation reserve / CTA, per Ind AS 21 / ASC 830), which reuses the Phase 8 FX engine; non-controlling interest; and a consolidated trial balance, P&L and balance sheet. **Design question for its phase:** is an "entity" a separate `organization` (strong isolation, harder consolidation) or a dimension inside one org (easy consolidation, weaker separation)? SAP uses company codes within one client, and I lean the same way. See Decision D7.

### 7.9 RevStream: subscriptions & revenue recognition (`revstream`)
Contracts, plans, and usage-based pricing; invoicing schedules; **Ind AS 115 / ASC 606's five steps** (identify the contract → performance obligations → transaction price → allocate by standalone selling price → recognise over time or at a point in time); deferred-revenue waterfalls; contract modifications. It feeds UnitEcon with *real* MRR, churn and cohorts, replacing UnitEcon's revenue-account proxy.

### 7.10 ControlTower: controls & audit (`controls`)
A controls library (key controls mapped to the automatic checks that test them); an SoD conflict matrix computed from roles and actual actions in `audit_logs`; **anomaly detection** (duplicate payments, Benford's-law first-digit tests on expense populations, round-amount and weekend postings, a vendor bank-detail change followed by payment); an **auditor portal** (a time-boxed read-only role with sampling tools and document requests); and `audit_logs` retention and partitioning (a named gap). This productises Phase 5.

### 7.11 Later verticals
- **ProjectLedger:** projects as a dimension plus budgets, timesheets, billable rates, WIP and unbilled revenue, milestone and T&M billing, project profitability.
- **PeopleCost:** **integrate first** (import payroll journals from an Indian payroll provider and post them with dimensions), then build statutory payroll only if demand is proven. Headcount actuals feed ForecasterPro.
- **MakeFlow:** multi-level BOMs (a recursive CTE with cycle detection), routings, work orders, backflushing, WIP, MRP netting, and standard cost roll-up (feeding CostLens variances).

---

## 8. Upgrades to the seven existing apps

| App | Upgrades this plan needs from it |
|---|---|
| **LedgerCore** | Dimensions; recurring journals and accrual/prepaid schedules; year-end closing entry (a named gap); bad-debt write-off; cash refunds; discount payment terms ("2/10 Net 30", a named gap); PDF and email documents; external FX rate feed; the master-data service interface |
| **AP-Flow** | Per-org AI provider choice (a named gap); GST fields (GSTIN, HSN, tax components); dimension prediction; 3-way-match hand-off to ProcureFlow; migration onto the Autopilot runtime |
| **TaxGuard AI** | The compliance module (§7.3); US IRC heading support only when entering the US (a named gap); transaction-aware answers |
| **FP&A Engine** | Scenario cloning (a named gap); capex, depreciation and debt schedules from AssetBook (a named gap); fiscal-period alignment; XLSX export |
| **ForecasterPro** | A formula language for cross-line references (a named gap; a good parser/evaluator interview topic, using a safe expression AST, never `eval`); driver import; seasonality curves; budgets by dimension |
| **UnitEcon** | Real subscription data from RevStream; cost side from CostLens for customer profitability; a churn and survival model (a named gap; Kaplan–Meier is an honest first step) |
| **BoardDeck** | Deck templates and branding (a named gap); the variance commentary agent; accrual, prepaid, depreciation and intercompany close checks (a named gap) fed by AssetBook and GroupClose |

---

## 9. Sequenced roadmap

Reserved Phases 20–23 keep their names and are absorbed where they fit. New work starts at **27**, following the roadmap's "next free number" convention.

### Horizon 1: "Sellable to one CA firm" (about 4–6 months)
| Phase | Scope | Why now |
|---|---|---|
| **20** (reserved) | Verification sweep: docs-sync every app; fix drift, including architecture.md's layout section, which says it's stale | Clean foundation before growth |
| **27** | Deployment & operations (§5.1) | Nothing earns money on localhost |
| **28** | Postgres RLS (§5.2) | Required before agents read broadly |
| **29** | Permissions, approval matrix, SoD, `PRACTITIONER` role (§5.3) | CA-firm model; controls |
| **30** | PDF, email, exports (§5.4) | Customers need documents out |
| **31** | Dimensions (§5.5) | Blocks CostLens and much else |
| **17** (re-scoped) | Tally importer, then Zoho/QuickBooks import (§5.7) | Migration cost decides adoption |
| **T1–T3** | TaxGuard Compliance: tax codes and GST determination → returns and 2B reconciliation → e-invoicing and TDS (§7.3) | Beachhead requirement |
| **21** (reserved) | Master-data service interface + cross-app connections (§5.6) | Before any operations app |
| **23** (reserved) | Autopilot runtime + the bank reconciliation agent + eval harness (§6) | First touchless outcome |
| **32** | Ops Console + `outcomes` table + multi-client dashboard (§5.8) | The outcome business itself |

**Exit criterion:** one CA firm runs 10+ real client orgs on it for 2 consecutive month-ends, with measured touchless rate, exception minutes and error rate.

### Horizon 2: "Operations ERP" (about 6–9 months)
StockLedger (4 phases) · ProcureFlow · OrderDesk · AssetBook · CostLens (3 phases) · CashOps · Client Portal (33) · the close, AP, GST and collections agents · Phase 22 (reserved help center, with Ask-your-books over the docs).
**Exit criterion:** a trading company with inventory runs P2P → stock → O2C → GST → close entirely inside AutoLedger, with Σ stock = GL inventory at every month-end.

### Horizon 3: "Mid-market & cross-border" (about 9–12 months)
GroupClose · RevStream · ControlTower · the MCP server · SOC 2 readiness · SSO · ProjectLedger.
**Exit criterion:** a group with an Indian parent and a foreign subsidiary closes and consolidates in AutoLedger.

### Horizon 4: "Verticals & ecosystem"
MakeFlow · PeopleCost · public API and marketplace · US/UK localisation (sales tax integration, UK VAT MTD) · embedded finance partnerships.

**Pacing honesty:** at the current pace (roughly one phase every 1–2 days of focused work, based on the recent phase log), the *engineering* in Horizon 1 is feasible in weeks. What takes longer are the non-engineering parts: pilots, legal, CA partnerships, and real data. Don't let building run ahead of learning (see §13).

---

## 10. The showcase plan

Every phase should be worth something twice: as product, and as proof of skill for interviews and clients.

### The skill map: what each app proves

| App | Finance skill proven | Engineering skill proven | AI skill proven |
|---|---|---|---|
| StockLedger | Inventory valuation, COGS, GRNI, NRV | Row locking, deadlock ordering, append-only ledgers, derived caches with integrity checks | Knowing when *not* to use an LLM (statistical forecasting) |
| CostLens | Allocation methods, ABC, CVP, standard costing variances | Exact rational arithmetic, largest-remainder rounding, versioned rule engines, idempotent reruns | Grounded narrative generation with numeric verification |
| TaxGuard Compliance | GST place of supply, ITC, returns, TDS | Effective-dated rules tables, external API integration (e-invoicing), reconciliation scoring | RAG + transaction-aware advisory |
| GroupClose | Consolidation, eliminations, CTA | Multi-entity tenancy design | — |
| RevStream | Ind AS 115 / ASC 606 | Schedules, waterfalls, contract versioning | — |
| ControlTower | Internal controls, SoD, audit sampling | Log analytics on JSONB, partitioning, retention | Anomaly detection |
| AssetBook | Dual-book depreciation, deferred tax | Idempotent scheduled jobs | — |
| Autopilot | — | Tool-calling runtime, RLS, eval harness in CI, cost metering | Agent design, guardrails, evals, HITL |
| Ops Console | Service delivery economics | Work queues, SLAs, metering | Measuring touchless rate |

### Public artifacts to produce as you go
1. **A public demo**: the deployed sandbox, one click, 24 months of data. It already exists locally.
2. **Write-ups** (a blog, LinkedIn, or dev.to), one per hard problem: "Why our ledger can't be out of balance", "Integer-exact FIFO", "Reciprocal cost allocation without floats", "An eval harness for finance agents", "GSTR-2B reconciliation with a confidence engine". Each is adapted from its study note, so the writing is already half done.
3. **Published agent evals**: accuracy and false-auto-apply rate per agent, versioned over time.
4. **An open-source component**: extract something self-contained and useful (the integer money/FX utility, or the bank-matching scorer) into a small npm package. It's a credible signal for engineering roles.
5. **The walkthrough as a course**: the 4-month Harbor Point scenario extended to inventory and GST is a teaching product, and could be a paid course or lead magnet for CA students.
6. **Case studies** from design partners, with numbers: days to close before and after, touchless rate, and cost per outcome.

### The study-notes standing task continues
Every new mechanism above (RLS, advisory locks and lock ordering, rational arithmetic, MCP, eval design, effective-dated tables, Account Aggregator consent flows) owes a study note, per [docs/study-notes.md](study-notes.md). This plan roughly doubles the interview-question bank.

---

## 11. Decisions that need your sign-off

These change standing rules or recorded decisions. Nothing proceeds on them until you say so.

| # | Decision | Recommendation | What changes if yes |
|---|---|---|---|
| **D1** | Reverse "Dropped from scope": bring back Inventory, P2P, Manufacturing, Payroll and EAM as apps | **Yes**, as StockLedger, ProcureFlow, MakeFlow, PeopleCost and AssetBook | Update roadmap.md's "Dropped from scope" and the app map |
| **D2** | Beachhead market | **Indian SMEs through CA firms** | TaxGuard Compliance becomes P0; Tally import comes first |
| **D3** | Amend **rule 14** so AI is a platform runtime (Autopilot) usable by any app, under the §6 contract | **Yes**, and add the §6 non-negotiables as a new hard rule | CLAUDE.md rule 14 rewritten; guardrails.md gains an agent section |
| **D4** | Present apps to customers as 5 products while keeping per-app slugs | **Yes** | A presentation layer over `config/apps.ts`; no data change |
| **D5** | Master data stays in LedgerCore behind a service interface, rather than moving to a platform schema | **Yes**, following the rule-16 service-call precedent | Phase 21 scope |
| **D6** | Re-scope Phase 17 from "QuickBooks push" to "import from Tally/Zoho/QuickBooks" | **Yes** | Roadmap Phase 17 rewritten |
| **D7** | Multi-entity: entities inside one org (company codes) or separate orgs | Lean toward **inside one org**; decide at GroupClose's phase start with a design spike | Schema design for GroupClose |
| **D8** | Outcome pricing vs seat pricing for the first pilots | **Outcome pricing from day one**, with a floor platform fee | Ops Console and `outcomes` table are P0 |

---

## 12. What I need from you

To turn this plan into phase-level build plans, I need answers that only you can give:

1. **Market:** Is India through CA firms right, or do you have a different first customer in mind (your employer, a family business, a friend's startup, a specific firm)?
2. **Design partners:** Do you know any CA firms or finance teams personally? **One warm introduction is worth more than any phase in this plan.**
3. **Time and goal balance:** How many hours a week, and what's the split between "land a great job" and "build a business"? This decides whether Horizon 1 favours showcase phases (CostLens first) or revenue phases (Ops Console first).
4. **Solo or team:** Will you bring in a co-founder? A CA or finance co-founder would cover the professional-liability and domain-sales gaps directly.
5. **Budget:** Cloud hosting, a GSP/e-invoicing API, Account Aggregator partnership fees, and professional indemnity insurance all cost money. What's the monthly ceiling?
6. **Legal entity:** Is there one? It's needed before taking a customer's money or data.
7. **Real data:** Can you get one real, anonymised set of books (for example a Tally export) to test importers and agents against? Synthetic data hides the messiness that sinks products.
8. **Your own credentials:** If you're studying for or hold a CA, CMA, ACCA or CPA qualification, put it front and centre in positioning. If not, the CA partner covers that.

---

## 13. Risks, stated plainly

| Risk | Why it's real | Mitigation |
|---|---|---|
| **Building ahead of learning** | The phase log shows fast engineering. It's easy to build 10 apps no one has used. | The Horizon 1 exit criterion needs a real firm on real books before Horizon 2 starts |
| **Scope explosion** | "SAP killer" is a decade of work for large teams | The beachhead-first sequence; "Skip" is a real category in §4 |
| **AI error in money movement** | One wrong auto-post damages trust permanently | Materiality caps, deterministic verifiers, kill switches, eval gates, full reversibility |
| **Professional liability and regulation** | Tax filing and attestation are regulated | The CA channel; legal opinion; indemnity insurance; the human signs |
| **Incumbents add AI** | Zoho, Intuit and Xero are all shipping AI assistants | They add assistants to software. You sell finished work with guarantees, which is a different product. |
| **Bench-style failure** | Promising human-quality service at software prices before automation is real | Price above cost from day one; never promise an SLA the touchless rate can't support; track gross margin per outcome monthly |
| **Tax rule drift** | GST rates, thresholds and forms change often | An effective-dated rules table, not code; a monthly review task |
| **Data security** | Financial data for many companies in one database | RLS, isolation tests (already per app), encryption, DPDP compliance, eventual SOC 2 |
| **Solo-founder bandwidth** | Engineering, sales, support and compliance at once | Your answers to §12 (3) and (4) decide this |

---

## 14. The next 90 days

**Weeks 1–2: decide and verify**
- Answer §11 and §12. Update roadmap.md for D1, D6 and the rule-14 amendment (D3), once signed off.
- Phase 20 verification sweep (the docs-sync skill across every app).
- Talk to 5 CA firms or finance leads. Ask what they spend the most hours on at month-end. Don't pitch.

**Weeks 3–6: make it real**
- Phase 27 (deploy), Phase 28 (RLS), and a public sandbox demo.
- Phase 31 (Dimensions).
- The Tally importer (re-scoped 17), tested against one real anonymised export.

**Weeks 7–10: first outcome**
- Phase 23: the Autopilot runtime + bank reconciliation agent + eval harness, with evals built from `walkthrough/`.
- Phase 32: a minimal Ops Console and `outcomes` table.
- TaxGuard Compliance T1 (tax codes and GST determination).

**Weeks 11–13: first design partner**
- Onboard one CA firm with 3–5 client orgs. Deliver "bank reconciled" and "bills processed" as outcomes, at no charge.
- Measure touchless rate, exception minutes, AI cost per outcome and error rate. **These four numbers decide everything that follows.**
- Publish the first write-up and the first eval report.

---

*When any part of this plan starts, it gets a normal roadmap phase entry, a spec file under `docs/`, a `plans/` build plan through the code-planner skill, and its study notes, per the existing conventions. This file then records direction, not delivery: a line here is never a claim that something is built.*
