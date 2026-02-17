import  { useState } from 'react';
import Layout from '../components/layout/Layout';
import { analyzeWithAI, addJournalEntry } from '../services/fetchServices';
import {  Send,  X, Wand2 } from 'lucide-react';

const MagicJournal = () => {
    const [input, setInput] = useState("");
    const [loading, setLoading] = useState(false);
    const [suggestion, setSuggestion] = useState<any>(null);

    const handleProcess = async () => {
        if (!input) return;
        setLoading(true);
        try {
            const data = await analyzeWithAI(input); 
            setSuggestion(data.suggestion);
        } catch (err: any) {
            alert(err.message || "Couldn't parse that. Try: 'Paid 50 for Rent'");
        } finally {
            setLoading(false);
        }
    };

    const handlePost = async () => {
    try {
        setLoading(true);

       
        const now = new Date();
        const localDate = now.toLocaleDateString('en-CA'); 

        await addJournalEntry({
            date: localDate, 
            description: suggestion.description,
            lines: suggestion.lines
        });

        alert("Entry successfully posted for today!");
        setSuggestion(null);
        setInput("");
    } catch (err) {
        alert("Failed to post entry.");
    } finally {
        setLoading(false);
    }
};

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
                        onChange={(e) => setInput(e.target.value)}
                    />
                    <button 
                        onClick={handleProcess}
                        disabled={loading || !input}
                        className="absolute bottom-8 right-8 bg-blue-600 text-white px-8 py-3 rounded-2xl font-black flex items-center gap-3 hover:bg-blue-500 transition-all disabled:opacity-50 shadow-xl"
                    >
                        {loading ? "Processing..." : "Generate Entry"}
                        <Send size={18} />
                    </button>
                </div>

                {suggestion && (
                    <div className="bg-gray-900 border border-gray-700 rounded-[2.5rem] p-10 shadow-2xl animate-in fade-in zoom-in-95 duration-300">
                        <div className="flex justify-between items-center mb-8">
                            <h2 className="text-2xl font-bold text-white">Suggested Entry</h2>
                            <span className="text-[10px] font-bold text-blue-400 border border-blue-400/30 px-3 py-1 rounded-full uppercase tracking-widest">Balanced</span>
                        </div>
                        
                        <div className="space-y-4 mb-10">
                            {suggestion.lines.map((line: any, i: number) => (
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
                            <button onClick={handlePost} className="flex-1 bg-white text-black py-4 rounded-2xl font-black text-lg hover:bg-blue-400 hover:text-white transition-all">
                                Confirm & Post
                            </button>
                            <button onClick={() => setSuggestion(null)} className="px-6 bg-gray-800 text-white rounded-2xl hover:bg-red-500 transition-all">
                                <X />
                            </button>
                        </div>
                    </div>
                )}
            </div>
        </Layout>
    );
};

export default MagicJournal;