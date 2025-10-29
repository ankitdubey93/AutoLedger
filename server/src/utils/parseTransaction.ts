


export const parseTransactionText = (text:string) => {
    const lowerText = text.toLowerCase();
    let amountMatch = text.match(/(?:rs\.?|inr|₹)\s*([\d,]+)/i);
    let amount = amountMatch ? parseFloat(amountMatch[1].replace(/,/g, "")) : 0;

  let accounts: { accountName: string; type: "debit" | "credit"; amount: number }[] = [];
  let description = text.trim();

  // Define basic keyword → account mapping rules
  if (lowerText.includes("cash")) {
    if (lowerText.includes("bought") || lowerText.includes("paid") || lowerText.includes("spent")) {
      accounts = [
        { accountName: "Expense", type: "debit", amount },
        { accountName: "Cash", type: "credit", amount },
      ];
    } else if (lowerText.includes("received") || lowerText.includes("sold")) {
      accounts = [
        { accountName: "Cash", type: "debit", amount },
        { accountName: "Revenue", type: "credit", amount },
      ];
    }
  } else if (lowerText.includes("bank")) {
    if (lowerText.includes("deposit") || lowerText.includes("received")) {
      accounts = [
        { accountName: "Bank", type: "debit", amount },
        { accountName: "Revenue", type: "credit", amount },
      ];
    } else if (lowerText.includes("withdraw") || lowerText.includes("paid")) {
      accounts = [
        { accountName: "Expense", type: "debit", amount },
        { accountName: "Bank", type: "credit", amount },
      ];
    }
  } else {
    // Fallback generic rule
    accounts = [
      { accountName: "Expense", type: "debit", amount },
      { accountName: "Credit", type: "credit", amount },
    ];
  }

  return { amount, description, accounts };
};

