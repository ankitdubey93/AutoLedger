interface Account {
  id: string;
  name: string;
  code: string;
  type: string;
}

interface JournalLine {
  accountId: string;
  accountName: string;
  debit: number;
  credit: number;
}

interface Suggestion {
  description: string;
  lines: JournalLine[];
}

/**
 * 🧠 AutoLedger Rule Engine
 * Converts natural language into a balanced double-entry journal suggestion.
 */
export const parseTransaction = (sentence: string, accounts: Account[]): Suggestion => {
  const input = sentence.toLowerCase();

  // 1. Extract the Amount (Support decimals like 100 or 100.50)
  const amountMatch = sentence.match(/(\d+(\.\d{1,2})?)/);
  const amount = amountMatch ? parseFloat(amountMatch[0]) : 0;

  if (amount === 0) {
    throw new Error("I couldn't find a valid amount in your sentence. Try including a number like '100'.");
  }

  // 2. Identify Financial Intent
  const isSpending = /paid|spent|bought|purchase|expense|bill|gave|payment/.test(input);
  const isEarning = /received|sold|earned|income|revenue|deposit|sale/.test(input);

  // 3. Smart Account Matching Logic
  // We prioritize specialized keywords over general ones.
  let categoryAccount: Account | undefined;

  // Utility Mapping (Internet, Water, Electricity)
  if (/internet|wifi|utility|electric|water|phone/.test(input)) {
    categoryAccount = accounts.find(acc => 
      acc.name.toLowerCase().includes('utilities') || 
      acc.name.toLowerCase().includes('internet')
    );
  } 
  // Inventory/Supplies Mapping
  else if (/stock|inventory|goods|items/.test(input)) {
    categoryAccount = accounts.find(acc => acc.name.toLowerCase().includes('inventory'));
  }
  // Salary/Payroll
  else if (/salary|wages|payroll/.test(input)) {
    categoryAccount = accounts.find(acc => acc.name.toLowerCase().includes('salary') || acc.name.toLowerCase().includes('wages'));
  }

  // Fallback: Direct name match if the user actually typed the account name
  if (!categoryAccount) {
    categoryAccount = accounts.find(acc => 
      input.includes(acc.name.toLowerCase())
    );
  }

  // Ultimate Fallback: Select first account of the correct type (but avoid COGS for general bills)
  if (!categoryAccount) {
    categoryAccount = accounts.find(acc => 
      acc.type === (isSpending ? 'Expense' : 'Revenue') && 
      acc.name !== 'Cost of Goods Sold'
    );
  }

  // 4. Find the Asset/Payment side (Bank or Cash)
  const paymentAccount = accounts.find(acc => 
    /bank|cash|card|wallet|checking/.test(acc.name.toLowerCase())
  );

  if (!categoryAccount || !paymentAccount) {
    throw new Error("I understood the amount, but I'm not sure which accounts to use. Try mentioning the account name!");
  }

  // 5. Generate the Balanced Double-Entry Lines
  // RULE: Debits increase Assets/Expenses. Credits increase Revenue/Liabilities.
  let lines: JournalLine[] = [];

  if (isSpending) {
    // Expense increases (Debit) | Cash decreases (Credit)
    lines = [
      { accountId: categoryAccount.id, accountName: categoryAccount.name, debit: amount, credit: 0 },
      { accountId: paymentAccount.id, accountName: paymentAccount.name, debit: 0, credit: amount }
    ];
  } else {
    // Cash increases (Debit) | Revenue increases (Credit)
    lines = [
      { accountId: paymentAccount.id, accountName: paymentAccount.name, debit: amount, credit: 0 },
      { accountId: categoryAccount.id, accountName: categoryAccount.name, debit: 0, credit: amount }
    ];
  }

  return {
    description: sentence,
    lines
  };
};