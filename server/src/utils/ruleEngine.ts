interface Account {

  id: string;

  name: string;

  code: string;

  type: string;

}



export const parseTransaction = (sentence: string, accounts: Account[]) => {

  const input = sentence.toLowerCase();



  // 1. Extract ALL numbers found in the sentence

  const numbers = sentence.match(/(\d+(\.\d{1,2})?)/g)?.map(Number) || [];

  if (numbers.length === 0) throw new Error("Please include an amount (e.g., 100).");



  // 2. Identify Intent

  const isSpending = /paid|spent|bought|bill|purchase|expense/.test(input);

  const isEarning = /received|sold|earned|income|revenue|deposit/.test(input);



  // 3. Find ALL mentioned accounts

  const mentionedAccounts = accounts.filter(acc => 

    input.includes(acc.name.toLowerCase()) || 

    acc.name.toLowerCase().split(' ').some(word => word.length > 3 && input.includes(word))

  );



  // 4. Identify the "Money" side (Cash/Bank)

  const moneyAccount = accounts.find(acc => /bank|cash|card|wallet/.test(acc.name.toLowerCase()));



  // 5. Logic for "Paid for Office expense with 100 cash and 200 from bank"

  let lines: any[] = [];

  let totalAmount = 0;



  if (mentionedAccounts.length >= 2) {

    // We have specific accounts. Let's map them.

    mentionedAccounts.forEach((acc, index) => {

      // If we have multiple numbers, try to pair them. If not, use the first number.

      const amount = numbers[index] || numbers[0];

      

      const isAsset = acc.type === 'Asset';

      const isExp = acc.type === 'Expense';



      lines.push({

        accountId: acc.id,

        accountName: acc.name,

        debit: (isSpending && isExp) || (isEarning && isAsset) ? amount : 0,

        credit: (isSpending && isAsset) || (isEarning && !isAsset) ? amount : 0

      });

      totalAmount += amount;

    });

  } else {

    // FALLBACK: Simple "Amount + Category" logic

    const category = mentionedAccounts[0] || accounts.find(acc => acc.type === (isSpending ? 'Expense' : 'Revenue'));

    const amount = numbers[0];



    if (!category || !moneyAccount) throw new Error("Could not identify accounts. Try mentioning 'Cash' or 'Bank'.");



    lines = [

      {

        accountId: category.id,

        accountName: category.name,

        debit: isSpending ? amount : 0,

        credit: isEarning ? amount : 0

      },

      {

        accountId: moneyAccount.id,

        accountName: moneyAccount.name,

        debit: isEarning ? amount : 0,

        credit: isSpending ? amount : 0

      }

    ];

  }





  return {

    description: sentence,

    lines: lines.filter((v, i, a) => a.findIndex(t => t.accountId === v.accountId) === i)

  };

};