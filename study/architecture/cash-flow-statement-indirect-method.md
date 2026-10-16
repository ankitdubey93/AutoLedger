# The cash flow statement, indirect method, from double entry

> Net income plus the cash effect of every non-cash balance-sheet account. It ties to the bank because the books balance, and a failure to tie is a bug detector.

**Category:** Architecture
**Introduced by:** Phase 45 — `GET /reports/cash-flow`
**Verified against:** IAS 7 / ASC 230 concepts as generally presented; PostgreSQL 16. Flag: classification of interest and dividends differs between IFRS (a choice) and US GAAP (interest in operating); we do not split them.

---

## Mechanism

### Direct vs indirect

The **direct** method lists cash receipts and payments (customers, suppliers). The **indirect** method starts from net income and adjusts for non-cash items and working-capital movements. Indirect is what a ledger can produce without tagging every cash line, which is why it is standard.

### Why it ties by construction

Every posted entry balances: Σ debits = Σ credits. Split accounts into cash accounts `C`, other balance-sheet accounts `B`, and P&L accounts `P`. Then Δcash is `−Δ(B net debit) − Δ(P net debit)`, and P&L net debit change is −net income. So **net change in cash = net income − Σ(change in non-cash balance-sheet accounts, debit-signed)**. For an asset the cash effect is `−(debits − credits)`; for a liability or equity account it is `credits − debits`. Our query returns opening and period debit/credit per postable Asset/Liability/Equity account and the service signs them. The implementation then compares the statement's net change with the movement of the cash accounts and **raises** if they differ — a misclassified account becomes a loud error instead of a plausible wrong statement. In the demo it gave 14,763,120 cents on both sides.

### Classification

Revenue and Expense accounts have no category (they flow through net income). For a balance-sheet account, in order: an explicit `cash_flow_category` override wins; a `BANK` account or the cash control account is `CASH`; an Asset under header 1400 is `INVESTING`; a Liability under 2500 and any Equity is `FINANCING`; everything else, including `CREDIT_CARD`, is `OPERATING`. Ancestry comes from a recursive CTE producing each account's ancestor codes.

It is a **nullable column with a CHECK**, not a sixth account type — rule 12 fixes the account types at five, and a report category is an attribute, not a type.

### Depreciation

`1590 Accumulated Depreciation` is an Asset under 1400, but depreciation is a non-cash expense inside net income. Its credit increases the asset's contra balance without cash, so it must be an **add-back in operating**: it carries an explicit `OPERATING` override (an early bug put the override on 1500; the invariant test found it).

### Credit cards and overdrafts

A credit card is a short-term liability, so it is operating (card spending is an operating outflow when paid, not a cash movement until the card is settled). Only `BANK` accounts are cash. A bank overdraft is a negative balance in a CASH account here; IAS 7 would class it as financing in some cases — not handled.

### What is deliberately missing

An "effect of FX on cash" line: FX revaluation restates open AR/AP only, and every cash line is base currency, so the line would always be zero. The direct method is not built.

## Why we chose it here

| Option | Trade-off | Verdict |
|---|---|---|
| Direct method | Needs a cash-line tag on every posting | Rejected |
| Hard-coded classification by account code | Breaks with a customised chart | Rejected |
| Override + derived classification, stored on the account | One nullable column | **Chosen** |
| A sixth account type | Violates rule 12 | Rejected |

## Where it lives in this codebase

- `server/src/services/accounting/cashFlowService.ts` — the statement and the invariant
- `server/src/utils/cashFlowCategory.ts` — `deriveCashFlowCategory`
- migration `099_ledger-core_account_cash_flow_category.sql`
- `server/src/__tests__/accounting/cashFlow.test.ts`, `cashFlowCategory.test.ts`

## Gotchas

- Opening cash is computed with entry dates before `from`; both bounds are inclusive dates.
- A fixture bug (override on the wrong account) is caught only by the tie-out.
- Foreign-currency cash accounts: base columns only.
- Inventory and AR/AP are operating by derivation.

## Interview Q&A

**Q: Why does the indirect method always reconcile to the bank?**
A: Because every journal entry balances. The sum of changes in all non-cash accounts, signed, plus net income equals the change in cash. If it does not, an account is misclassified or double-counted.

**Q: How do you classify accounts without a chart-specific hard-code?**
A: An override column wins; otherwise derive from account type, bank flag and position in the hierarchy (ancestors).

**Q: Why is depreciation added back?**
A: It reduced net income but moved no cash. Its contra-asset credit is the other half of that entry.

**Q: Where do credit cards go?**
A: Operating — a liability of the business's trade, not cash, until paid.

**Q: Why not a new account type for "cash"?**
A: Rule 12 and the semantic mismatch: a bank account is still an Asset. Cash-ness is an attribute.

**Q: How is the invariant useful beyond the statement?**
A: It is a free integration test on every request; a classification error surfaces as an exception, which our tests caught twice.

## Follow-ups they'll dig into

- "Direct method?" Needs cash-flow tags on bank lines; unbuilt.
- "Multi-currency?" Base columns; the FX line is zero because revaluation touches only AR/AP.
- "Interest paid?" Not separated.

## See also

- [recursive-ctes-and-hierarchies.md](../postgresql/recursive-ctes-and-hierarchies.md)
- [subledger-reconciliation-and-aging.md](../postgresql/subledger-reconciliation-and-aging.md)
