import React, { useState } from 'react';

interface Props {
  onClose: () => void;
}

interface AccountLine {
  account: string;
  debit: string;
  credit: string;
}

const AddJournalEntryModal: React.FC<Props> = ({ onClose }) => {
  const [date, setDate] = useState('');
  const [description, setDescription] = useState('');
  const [lines, setLines] = useState<AccountLine[]>([
    { account: '', debit: '', credit: '' },
  ]);

  const handleAddLine = () => {
    setLines([...lines, { account: '', debit: '', credit: '' }]);
  };

  const handleLineChange = (
  index: number,
  field: keyof AccountLine,
  value: string
) => {
  const updated = [...lines];
  updated[index][field] = value;
  setLines(updated);
};

const handleSubmit = (e: React.FormEvent) => {
  e.preventDefault();
  const formattedLines = lines.map(l => ({
    ...l,
    debit: l.debit === '' ? 0 : Number(l.debit),
    credit: l.credit === '' ? 0 : Number(l.credit),
  }));
  const newEntry = { date, description, lines: formattedLines };
  console.log(newEntry);
  onClose();
};

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-lg p-6 w-full max-w-2xl">
        <h2 className="text-xl font-bold mb-4">New Journal Entry</h2>
        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Date */}
          <div>
            <label className="block text-sm font-medium">Date</label>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="border rounded px-3 py-2 w-full"
              required
            />
          </div>
          {/* Description */}
          <div>
            <label className="block text-sm font-medium">Description</label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="border rounded px-3 py-2 w-full"
              placeholder="Description"
              required
            />
          </div>

          {/* Accounts Lines */}
          <div>
            <label className="block text-sm font-medium mb-2">
              Accounts Affected
            </label>
            {lines.map((line, i) => (
              <div key={i} className="grid grid-cols-3 gap-2 mb-2">
                <input
                  type="text"
                  placeholder="Account"
                  value={line.account}
                  onChange={(e) =>
                    handleLineChange(i, 'account', e.target.value)
                  }
                  className="border rounded px-3 py-2"
                  required
                />
                <input
                  type="number"
                  placeholder="Debit"
                  value={line.debit}
                  onChange={(e) =>
                    handleLineChange(i, 'debit', e.target.value)
                  }
                  className="border rounded px-3 py-2"
                />
                <input
                  type="number"
                  placeholder="Credit"
                  value={line.credit}
                  onChange={(e) =>
                    handleLineChange(i, 'credit', e.target.value)
                  }
                  className="border rounded px-3 py-2"
                />
              </div>
            ))}
            <button
              type="button"
              onClick={handleAddLine}
              className="bg-gray-200 hover:bg-gray-300 text-sm px-3 py-1 rounded"
            >
              + Add Another Account
            </button>
          </div>

          {/* Actions */}
          <div className="flex justify-end gap-2 mt-4">
            <button
              type="button"
              onClick={onClose}
              className="bg-gray-300 hover:bg-gray-400 px-4 py-2 rounded"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="bg-blue-500 hover:bg-blue-700 text-white px-4 py-2 rounded"
            >
              Save Entry
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default AddJournalEntryModal;
