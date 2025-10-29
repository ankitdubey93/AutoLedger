import { useState } from "react";
import Layout from "../components/layout/Layout";
import { generateJournalFromText, postJournalEntry } from "../services/fetchServices";

const Transactions: React.FC = () => {
  const [searchTerm, setSearchTerm] = useState<string>("");
  const [showModal, setShowModal] = useState(false);
  const [transactionText, setTransactionText] = useState("");
  const [generatedEntry, setGeneratedEntry] = useState<any | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);

  const handleGenerateJournal = async () => {
      try {
            setIsLoading(true);
            const entry = await generateJournalFromText(transactionText);
            setGeneratedEntry(entry);
        
      } catch (error) {
        console.error(error);

      } finally {
        setIsLoading(false);
      }
  };


  const handlePost = async () => {
    if(!generatedEntry) return;

    try {
      await postJournalEntry (generatedEntry);
      alert("Journal entry posted successfully.");
      setGeneratedEntry(null);
      setTransactionText("");

    } catch (error) {
      console.error(error);
      alert("Failed to post journal entry.")
    }
  };

  return (
    <Layout>
      <div className="h-full p-6 w-full">
        <div className="flex flex-col sm:flex-row sm_justify-between w-full max-w-6xl mb-4 gap-2">
          <input
            type="text"
            placeholder="Search..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="border border-gray-300 rounded px-4 py-2 w-full sm:w-64"
          />
          <button
            onClick={() => setShowModal(true)}
            className="bg-blue-500 text-white px-4 py-2 rounded hover:bg-blue-600"
          >
            + Add Transaction
          </button>
        </div>

        <div className="w-full overflow-x-auto rounded shadow">
          <table className="table-auto w-full text-left">
            <thead>
              <tr className="border-b">
                <th className="px-4 py-2">S.No.</th>
                <th className="px-4 py-2">Date</th>
                <th className="px-4 py-2">Description</th>
                <th className="px-4 py-2">Debit</th>
                <th className="px-4 py-2">Credit</th>
                <th className="px-4 py-2">Amount</th>
              </tr>
            </thead>
            <tbody>
              {generatedEntry && (
                <tr>
                  <td className="px-4 py-2">1</td>
                  <td className="px-4 py-2">{new Date().toLocaleDateString()}</td>
                  <td className="px-4 py-2">{generatedEntry.description}</td>
                  <td className="px-4 py-2">{generatedEntry.debit}</td>
                  <td className="px-4 py-2">{generatedEntry.credit}</td>
                  <td className="px-4 py-2">₹{generatedEntry.amount}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Modal */}
        {showModal && (
          <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center">
            <div className="bg-white p-6 rounded shadow-lg w-full max-w-md">
              <h2 className="text-xl font-semibold mb-4">
                Add Transaction (Sentence)
              </h2>
              <textarea
                rows={3}
                placeholder="e.g. Bought stationery for Rs 500 in cash"
                value={transactionText}
                onChange={(e) => setTransactionText(e.target.value)}
                className="border border-gray-300 rounded w-full p-2 mb-4 text-black"
              />
              <div className="flex justify-end gap-2">
                <button
                  onClick={() => setShowModal(false)}
                  className="px-4 py-2 rounded bg-gray-300 hover:bg-gray-400"
                >
                  Cancel
                </button>
                <button
                disabled={isLoading || !transactionText}
                  onClick={handleGenerateJournal}
                  className="px-4 py-2 rounded bg-blue-500 text-white hover:bg-blue-600"
                >
                   {isLoading ? "Generating..." : "Generate Journal"}
                </button>
              </div>

              {generatedEntry && (
                <div className="mt-4 border-t pt-2 text-sm text-black">
                  <p>
                    <strong>Debit:</strong> {generatedEntry.debit}
                  </p>
                  <p>
                    <strong>Credit:</strong> {generatedEntry.credit}
                  </p>
                  <p>
                    <strong>Amount:</strong> ₹{generatedEntry.amount}
                  </p>
                </div>
              )}
            <button
              onClick={handlePost}
              disabled={!generatedEntry} // disable if nothing generated yet
              className={`${
              generatedEntry
                ? 'bg-green-600 hover:bg-green-700'
                : 'bg-gray-300 cursor-not-allowed'
                } text-white font-semibold py-2 px-4 rounded`}
                >
              Post Entry
            </button>
            </div>
          </div>
        )}
      </div>
    </Layout>
  );
};

export default Transactions;
