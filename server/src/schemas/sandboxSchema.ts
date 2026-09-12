import { z } from 'zod';

/**
 * Phase 18 — zod schemas for every sandbox fixture file.
 *
 * These schemas validate SHAPE only. A fixture's money fields stay decimal
 * strings after parsing here — each seeder calls `parseMoneyText` itself at
 * the point of use, because money fields are not uniform across fixtures
 * (some map straight to a `*Cents` argument, some need summing first). That
 * keeps the conversion visible at the call site rather than hidden in a
 * schema transform, while still applying guardrail rule 3's parse-don't-
 * validate rule at this file boundary exactly as the HTTP boundary does.
 *
 * `monthOffset` is `-23..0` and `day` is `1..28` throughout: fixtures carry
 * no absolute dates, and day is capped so no resolved month is ever invalid.
 */

const monthOffset = z.number().int().min(-23).max(0);
const day = z.number().int().min(1).max(28);

// ------------------------------------------------------------- manifest

export const manifestSchema = z.object({
  datasetVersion: z.string().min(1),
  baseCurrency: z.string().length(3),
  months: z.number().int().positive(),
  description: z.string().min(1),
  apps: z.array(z.string()),
});
export type SandboxManifestFile = z.infer<typeof manifestSchema>;

// ------------------------------------------------------------- ledger-core/accounts.json

export const accountsFixtureSchema = z.object({
  comment: z.string(),
  accounts: z.array(
    z.object({
      code: z.string(),
      name: z.string(),
      type: z.enum(['Asset', 'Liability', 'Equity', 'Revenue', 'Expense']),
      parentCode: z.string(),
      isPostable: z.boolean(),
    }),
  ),
});
export type AccountsFixture = z.infer<typeof accountsFixtureSchema>;

// ------------------------------------------------------------- ledger-core/customers.json

export const customersFixtureSchema = z.object({
  comment: z.string(),
  customers: z.array(
    z.object({
      key: z.string(),
      name: z.string(),
      email: z.string().nullable(),
      phone: z.string().nullable(),
      billingAddress: z.string().nullable(),
      taxNumber: z.string().nullable(),
      notes: z.string().nullable(),
      cohortOffset: monthOffset,
      currency: z.string().length(3),
      revenueAccount: z.string(),
      taxRateBp: z.number().int().min(0).max(10000),
      paysInDays: z.number().int().positive(),
      monthly: z.array(z.string()),
    }),
  ),
});
export type CustomersFixture = z.infer<typeof customersFixtureSchema>;

// ------------------------------------------------------------- ledger-core/vendors.json

export const vendorsFixtureSchema = z.object({
  comment: z.string(),
  vendors: z.array(
    z.object({
      key: z.string(),
      name: z.string(),
      email: z.string().nullable(),
      phone: z.string().nullable(),
      address: z.string().nullable(),
      taxNumber: z.string().nullable(),
      expenseAccount: z.string(),
      description: z.string(),
      taxRateBp: z.number().int().min(0).max(10000),
      paysInDays: z.number().int().positive(),
      startOffset: monthOffset,
      leaveUnapprovedFromOffset: monthOffset.nullable().default(null),
      monthly: z.array(z.string()),
    }),
  ),
});
export type VendorsFixture = z.infer<typeof vendorsFixtureSchema>;

// ------------------------------------------------------------- ledger-core/fx-rates.json

export const fxRatesFixtureSchema = z.object({
  comment: z.string(),
  rates: z.array(
    z.object({
      fromCode: z.string().length(3),
      toCode: z.string().length(3),
      monthOffset,
      // A rate is NOT money (guardrails rule 3's one documented exception) —
      // it stays a plain validated string, never run through parseMoneyText.
      rate: z.string().regex(/^\d{1,6}\.\d{8}$/),
    }),
  ),
});
export type FxRatesFixture = z.infer<typeof fxRatesFixtureSchema>;

// ------------------------------------------------------------- ledger-core/bank-import.json

export const bankImportFixtureSchema = z.object({
  comment: z.string(),
  fileName: z.string(),
  dateFormat: z.enum(['ISO', 'DMY', 'MDY']),
  cashAccountCode: z.string(),
  window: z.object({
    comment: z.string(),
    fromMonthOffset: monthOffset,
    toMonthOffset: monthOffset,
  }),
  matching: z.object({
    comment: z.string(),
    exactFraction: z.number().min(0).max(1),
    perturbed: z.object({
      comment: z.string(),
      dateShiftDays: z.number().int(),
      descriptionStyle: z.string(),
    }),
  }),
  noiseLines: z.object({
    comment: z.string(),
    monthlyBankFee: z.string(),
    monthlyInterest: z.string(),
    extras: z.array(
      z.object({
        monthOffset,
        day,
        description: z.string(),
        amount: z.string(),
      }),
    ),
  }),
});
export type BankImportFixture = z.infer<typeof bankImportFixtureSchema>;

// ------------------------------------------------------------- forecaster/plan.json

export const forecasterPlanFixtureSchema = z.object({
  comment: z.string(),
  plan: z.object({
    name: z.string(),
    description: z.string().nullable(),
    startsOnMonthOffset: monthOffset,
    actualsThroughMonthOffset: monthOffset,
    horizonMonths: z.number().int().positive(),
  }),
  drivers: z.array(
    z.object({
      key: z.string(),
      name: z.string(),
      unitLabel: z.string(),
      kind: z.enum(['COUNT', 'CENTS', 'BPS']),
      monthly: z.array(z.object({ monthOffset, value: z.number().int() })),
    }),
  ),
  headcount: z.array(
    z.object({
      title: z.string(),
      department: z.string().nullable(),
      accountCode: z.string(),
      startsOnMonthOffset: monthOffset,
      endsOnMonthOffset: monthOffset.nullable(),
      fteCount: z.number().positive(),
      annualSalaryCents: z.number().int().positive(),
      loadingBps: z.number().int().min(0),
    }),
  ),
  forecastLines: z.array(
    z.discriminatedUnion('kind', [
      z.object({
        kind: z.literal('DRIVER_PRODUCT'),
        label: z.string(),
        accountCode: z.string(),
        quantityDriverKey: z.string(),
        rateDriverKey: z.string(),
      }),
      z.object({
        kind: z.literal('DRIVER_PERCENT'),
        label: z.string(),
        accountCode: z.string(),
        sourceDriverKey: z.string(),
        percentBps: z.number().int(),
      }),
      z.object({
        kind: z.literal('FIXED_CENTS'),
        label: z.string(),
        accountCode: z.string(),
        fixedCents: z.number().int(),
      }),
    ]),
  ),
  budget: z.object({
    comment: z.string(),
    label: z.string(),
    approve: z.boolean(),
    manualLines: z.array(
      z.object({
        accountCode: z.string(),
        amountCents: z.number().int(),
        justification: z.string().min(1),
      }),
    ),
  }),
});
export type ForecasterPlanFixture = z.infer<typeof forecasterPlanFixtureSchema>;

// ------------------------------------------------------------- fpa-engine/model.json

export const fpaModelFixtureSchema = z.object({
  comment: z.string(),
  model: z.object({
    name: z.string(),
    description: z.string().nullable(),
    startsOnMonthOffset: monthOffset,
    actualsThroughMonthOffset: monthOffset,
    horizonMonths: z.number().int().positive(),
  }),
  scenarios: z.array(
    z.object({
      key: z.string(),
      name: z.string(),
      isDefault: z.boolean(),
      comment: z.string().optional(),
      dsoDays: z.number().int().positive(),
      dpoDays: z.number().int().positive(),
      taxRateBps: z.number().int().min(0),
      assumptions: z.array(
        z.discriminatedUnion('kind', [
          z.object({ accountCode: z.string(), kind: z.literal('GROWTH_BPS'), growthBps: z.number().int() }),
          z.object({ accountCode: z.string(), kind: z.literal('FIXED_CENTS'), fixedCents: z.number().int() }),
          z.object({
            accountCode: z.string(),
            kind: z.literal('PERCENT_OF_REVENUE_BPS'),
            percentOfRevenueBps: z.number().int(),
          }),
        ]),
      ),
    }),
  ),
});
export type FpaModelFixture = z.infer<typeof fpaModelFixtureSchema>;

// ------------------------------------------------------------- unitecon/settings.json

export const uniteconSettingsFixtureSchema = z.object({
  comment: z.string(),
  settings: z.object({
    grossMarginBps: z.number().int().min(0).max(10000),
    acquisitionAccountCodes: z.array(z.string()),
  }),
  productLines: z.array(
    z.object({
      revenueAccountCode: z.string(),
      name: z.string(),
      unitLabel: z.string(),
    }),
  ),
});
export type UniteconSettingsFixture = z.infer<typeof uniteconSettingsFixtureSchema>;

// ------------------------------------------------------------- ap-flow/documents.json

const apFlowLineItemFixture = z.object({
  description: z.string(),
  amount: z.string(),
  accountCode: z.string().nullable(),
});

export const apFlowDocumentsFixtureSchema = z.object({
  comment: z.string(),
  pageImage: z.object({
    comment: z.string(),
    widthPx: z.number().int().positive(),
    heightPx: z.number().int().positive(),
  }),
  documents: z.array(
    z.object({
      key: z.string(),
      originalFilename: z.string(),
      monthOffset,
      day,
      outcome: z.enum(['POSTED', 'REVIEW']),
      outcomeComment: z.string(),
      extraction: z.object({
        vendorName: z.string(),
        invoiceNumber: z.string(),
        currency: z.string().length(3),
        subtotal: z.string(),
        tax: z.string(),
        total: z.string(),
        arithmeticOk: z.boolean(),
        validationErrors: z.array(z.string()),
        fieldConfidence: z.record(z.string(), z.number()),
        lineItems: z.array(apFlowLineItemFixture),
      }),
    }),
  ),
});
export type ApFlowDocumentsFixture = z.infer<typeof apFlowDocumentsFixtureSchema>;

// ------------------------------------------------------------- taxguard/sample-act.json

export const taxguardActFixtureSchema = z.object({
  comment: z.string(),
  title: z.string(),
  jurisdiction: z.enum(['IN', 'US', 'UK', 'CA', 'AU', 'OTHER']),
  actYear: z.number().int(),
  fileName: z.string(),
  ingestionNote: z.string(),
  body: z.array(z.string()),
});
export type TaxguardActFixture = z.infer<typeof taxguardActFixtureSchema>;
