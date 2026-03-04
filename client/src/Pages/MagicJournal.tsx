import { useState } from 'react';
import Layout from '../components/layout/Layout';
import { analyzeWithAI, addJournalEntry, createAccount } from '../services/fetchServices';
import { Send, X, Wand2, Plus, ChevronDown, ChevronUp } from 'lucide-react';

interface MissingAccount {
  suggestedName: string;
  suggestedType: string;
}

interface Suggestion {
  description: string;
  lines: { accountId: string; accountName: string; debit: number; credit: number }[];
  missingAccounts?: MissingAccount[];
}

// ── Missing Account Modal ────────────────────────────────────────────────────

interface MissingAccountModalProps {
  missing: MissingAccount;
  onSave: (name: string, code: string, type: string, description: string) => Promise<void>;
  onSkip: () => void;
  current: number;
  total: number;
}

const MissingAccountModal = ({ missing, onSave, onSkip, current, total }: MissingAccountModalProps) => {
  const [name, setName] = useState(missing.suggestedName);
  const [code, setCode] = useState('');
  const [type, setType] = useState(missing.suggestedType);
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await onSave(name, code, type, description);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4 z-50">
      <div className="bg-gray-900 border border-gray-700 rounded-2xl w-full max-w-md shadow-2xl">
        {/* Header */}
        <div className="flex items-start justify-between p-6 border-b border-gray-800">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <Plus size={16} className="text-blue-400" />
              <span className="text-xs font-bold text-blue-400 uppercase tracking-widest">
                Missing Account {current} of {total}
              </span>
            </div>
            <h2 className="text-xl font-bold text-white">Add to Chart of Accounts?</h2>
            <p className="text-gray-400 text-sm mt-1">
              The engine suggested <span className="text-white font-semibold">"{missing.suggestedName}"</span> but it's
              not in your chart. Create it now or skip.
            </p>
          </div>
        </div>

        {/* Form */}
        <form onSubmit={handleSave} className="p-6 space-y-4">
          <div>
            <label className="block text-xs font-bold text-gray-400 uppercase tracking-wider mb-1">Account Name</label>
            <input
              type="text"
              className="w-full bg-gray-800 border border-gray-700 rounded-xl p-3 text-white focus:outline-none focus:border-blue-500"
              value={name}
              onChange={e => setName(e.target.value)}
              required
            />
          </div>
          <div className="flex gap-3">
            <div className="flex-1">
              <label className="block text-xs font-bold text-gray-400 uppercase tracking-wider mb-1">Code</label>
              <input
                type="text"
                placeholder="e.g. 5300"
                className="w-full bg-gray-800 border border-gray-700 rounded-xl p-3 text-white focus:outline-none focus:border-blue-500"
                value={code}
                onChange={e => setCode(e.target.value)}
                required
              />
            </div>
            <div className="flex-1">
              <label className="block text-xs font-bold text-gray-400 uppercase tracking-wider mb-1">Type</label>
              <select
                className="w-full bg-gray-800 border border-gray-700 rounded-xl p-3 text-white focus:outline-none focus:border-blue-500"
                value={type}
                onChange={e => setType(e.target.value)}
              >
                <option value="Asset">Asset</option>
                <option value="Liability">Liability</option>
                <option value="Equity">Equity</option>
                <option value="Revenue">Revenue</option>
                <option value="Expense">Expense</option>
              </select>
            </div>
          </div>
          <div>
            <label className="block text-xs font-bold text-gray-400 uppercase tracking-wider mb-1">
              Description <span className="text-gray-600 normal-case font-normal">(optional)</span>
            </label>
            <input
              type="text"
              placeholder="e.g. Electricity, water, internet bills"
              className="w-full bg-gray-800 border border-gray-700 rounded-xl p-3 text-white focus:outline-none focus:border-blue-500"
              value={description}
              onChange={e => setDescription(e.target.value)}
            />
          </div>

          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={onSkip}
              className="flex-1 text-gray-400 font-bold py-3 rounded-xl hover:bg-gray-800 transition-all"
            >
              Skip
            </button>
            <button
              type="submit"
              disabled={saving}
              className="flex-1 bg-blue-600 text-white py-3 rounded-xl font-bold hover:bg-blue-500 transition-all disabled:opacity-50"
            >
              {saving ? 'Saving...' : 'Save Account'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

// ── Main Page ────────────────────────────────────────────────────────────────

const TIPS = [
  { action: 'Paid / Spent / Bought',   example: 'Paid 1500 for office rent via Bank'          },
  { action: 'Received / Earned / Sold', example: 'Received 5000 from client for consulting'    },
  { action: 'Accrued',                  example: 'Accrued 400 for accounting fees not yet paid' },
  { action: 'Amortized / Expensed',     example: 'Amortized 100 of prepaid insurance this month'},
  { action: 'Recorded / Recognized',   example: 'Recorded 300 depreciation on equipment'       },
];

const MagicJournal = () => {
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [tipsOpen, setTipsOpen] = useState(false);
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);

  // Queue of missing accounts to prompt for, and which index we're on
  const [missingQueue, setMissingQueue] = useState<MissingAccount[]>([]);
  const [missingIndex, setMissingIndex] = useState(0);

  const handleProcess = async () => {
    if (!input) return;
    setLoading(true);
    try {
      const data = await analyzeWithAI(input);
      const s: Suggestion = data.suggestion;
      setSuggestion(s);

      // If the engine flagged missing accounts, start the creation queue
      if (s.missingAccounts && s.missingAccounts.length > 0) {
        setMissingQueue(s.missingAccounts);
        setMissingIndex(0);
      }
    } catch (err: any) {
      alert(err.message || "Couldn't parse that. Try: 'Paid 50 for Rent'");
    } finally {
      setLoading(false);
    }
  };

  const handleSaveMissingAccount = async (
    name: string, code: string, type: string, description: string
  ) => {
    await createAccount({ name, code, type, description });
    advanceMissingQueue();
  };

  const advanceMissingQueue = () => {
    if (missingIndex + 1 < missingQueue.length) {
      setMissingIndex(i => i + 1);
    } else {
      // All done — clear the queue and re-run analysis with fresh accounts
      setMissingQueue([]);
      setMissingIndex(0);
      reAnalyze();
    }
  };

  // Re-runs the analysis after new accounts have been created so the suggestion
  // lines now use the real newly-created account IDs and names.
  const reAnalyze = async () => {
    setLoading(true);
    try {
      const data = await analyzeWithAI(input);
      setSuggestion(data.suggestion);
    } catch {
      // Suggestion already shown — ignore re-analysis errors silently
    } finally {
      setLoading(false);
    }
  };

  const handlePost = async () => {
    if (!suggestion) return;
    setLoading(true);
    try {
      const localDate = new Date().toLocaleDateString('en-CA');
      await addJournalEntry({
        date: localDate,
        description: suggestion.description,
        lines: suggestion.lines,
      });
      alert('Entry successfully posted for today!');
      setSuggestion(null);
      setInput('');
    } catch {
      alert('Failed to post entry.');
    } finally {
      setLoading(false);
    }
  };

  const currentMissing = missingQueue.length > 0 ? missingQueue[missingIndex] : null;

  return (
    <Layout>
      <div className="max-w-4xl mx-auto p-8 space-y-12">
        <header className="text-center">
          <div className="inline-flex p-4 bg-blue-500/10 rounded-3xl mb-4 border border-blue-500/20">
            <Wand2 className="text-blue-400" size={32} />
          </div>
          <h1 className="text-5xl font-black text-white tracking-tighter">Quick Entry</h1>
          <p className="text-gray-500 mt-2 text-lg">Type naturally. No accounting knowledge required.</p>
        </header>

        <div className="relative group">
          <textarea
            className="w-full h-40 bg-gray-900 border-2 border-gray-800 rounded-[2.5rem] p-10 text-xl text-white outline-none focus:border-blue-500 transition-all shadow-2xl resize-none"
            placeholder="e.g. Paid 100 for internet bill"
            value={input}
            onChange={e => setInput(e.target.value)}
          />
          <button
            onClick={handleProcess}
            disabled={loading || !input}
            className="absolute bottom-8 right-8 bg-blue-600 text-white px-8 py-3 rounded-2xl font-black flex items-center gap-3 hover:bg-blue-500 transition-all disabled:opacity-50 shadow-xl"
          >
            {loading ? 'Processing...' : 'Generate Entry'}
            <Send size={18} />
          </button>
        </div>

        {/* Tips panel */}
        <div className="bg-gray-900/60 border border-gray-800 rounded-2xl overflow-hidden">
          <button
            onClick={() => setTipsOpen(o => !o)}
            className="w-full flex items-center justify-between px-6 py-4 text-left hover:bg-gray-800/40 transition-all"
          >
            <div className="flex items-center gap-3">
              <span className="text-xs font-bold text-blue-400 uppercase tracking-widest">How to write a good entry</span>
              <span className="hidden sm:block text-gray-600 text-xs">· use an action word · include the amount · name the payment method</span>
            </div>
            {tipsOpen ? <ChevronUp size={16} className="text-gray-500 shrink-0" /> : <ChevronDown size={16} className="text-gray-500 shrink-0" />}
          </button>

          {tipsOpen && (
            <div className="px-6 pb-6 space-y-5">
              {/* Formula */}
              <div className="bg-gray-800/60 rounded-xl px-5 py-4 font-mono text-sm">
                <span className="text-blue-400">[Action]</span>
                <span className="text-gray-500"> + </span>
                <span className="text-green-400">[Amount]</span>
                <span className="text-gray-500"> + for/of </span>
                <span className="text-yellow-400">[What]</span>
                <span className="text-gray-500"> + via/using/from </span>
                <span className="text-purple-400">[Payment method]</span>
              </div>

              {/* Example rows */}
              <div className="space-y-2">
                {TIPS.map(({ action, example }) => (
                  <div key={action} className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-4">
                    <span className="w-44 shrink-0 text-xs font-bold text-gray-500 uppercase tracking-wider">{action}</span>
                    <button
                      type="button"
                      onClick={() => { setInput(example); setTipsOpen(false); }}
                      className="text-left text-sm text-gray-300 bg-gray-800/50 hover:bg-gray-700/60 border border-gray-700/50 rounded-lg px-4 py-2 transition-all font-mono"
                    >
                      "{example}"
                    </button>
                  </div>
                ))}
              </div>

              <p className="text-xs text-gray-600 leading-relaxed">
                The payment method (<span className="text-gray-400">bank, cash, petty cash, card</span>) is optional — if omitted the engine picks your default bank account.
                Amounts can be written as <span className="text-gray-400">100</span>, <span className="text-gray-400">1,500</span>, or <span className="text-gray-400">Rs. 250</span>.
              </p>
            </div>
          )}
        </div>

        {suggestion && (
          <div className="bg-gray-900 border border-gray-700 rounded-[2.5rem] p-10 shadow-2xl animate-in fade-in zoom-in-95 duration-300">
            <div className="flex justify-between items-center mb-8">
              <h2 className="text-2xl font-bold text-white">Suggested Entry</h2>
              <span className="text-[10px] font-bold text-blue-400 border border-blue-400/30 px-3 py-1 rounded-full uppercase tracking-widest">
                Balanced
              </span>
            </div>

            <div className="space-y-4 mb-10">
              {suggestion.lines.map((line, i) => (
                <div key={i} className="flex justify-between items-center p-4 bg-gray-800/50 rounded-2xl border border-gray-800">
                  <span className="text-gray-300 font-bold">{line.accountName}</span>
                  <div className="text-right">
                    <span className={`text-sm font-mono font-bold ${line.debit > 0 ? 'text-green-400' : 'text-red-400'}`}>
                      {line.debit > 0 ? `Debit $${line.debit}` : `Credit $${line.credit}`}
                    </span>
                  </div>
                </div>
              ))}
            </div>

            <div className="flex gap-4">
              <button
                onClick={handlePost}
                disabled={loading || missingQueue.length > 0}
                className="flex-1 bg-white text-black py-4 rounded-2xl font-black text-lg hover:bg-blue-400 hover:text-white transition-all disabled:opacity-50"
              >
                Confirm & Post
              </button>
              <button
                onClick={() => { setSuggestion(null); setMissingQueue([]); }}
                className="px-6 bg-gray-800 text-white rounded-2xl hover:bg-red-500 transition-all"
              >
                <X />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Missing Account popup — rendered outside the card so it overlays everything */}
      {currentMissing && (
        <MissingAccountModal
          missing={currentMissing}
          onSave={handleSaveMissingAccount}
          onSkip={advanceMissingQueue}
          current={missingIndex + 1}
          total={missingQueue.length}
        />
      )}
    </Layout>
  );
};

export default MagicJournal;
