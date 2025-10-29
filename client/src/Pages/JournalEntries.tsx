
import { useState } from 'react';
import Layout from '../components/layout/Layout';



const JournalEntries: React.FC = () => {
    const [searchTerm, setSearchTerm] = useState<string>("");
  
 
    return (
        <Layout>
            <div className="h-full p-6 w-full">
                <div className='flex flex-col sm:flex-row sm_justify-between w-full max-w-6xl mb-4 gap-2'>
          <input
            type="text"
            placeholder="Search..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="border border-gray-300 rounded px-4 py-2 w-full sm:w-64"
          />
                </div>
                  <div className="w-full overflow-x-auto rounded shadow">
          <table className="table-auto w-full text-left">
            <thead>
              <tr className="border-b">
                <th className="px-4 py-2 w-1/12">S.No.</th>
                <th className="px-4 py-2 w-1/12">Date</th>
                <th className="px-4 py-2 w-1/4 max-w-xs text-center">Description</th>
                <th className="px-4 py-2 w-1/8">Accounts</th>
                <th className="px-4 py-2 w-1/8">Debit</th>
                <th className="px-4 py-2 w-1/8">Credit</th>
               
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="px-4 py-2"></td>
                <td className="px-4 py-2"></td>
                <td className="px-4 py-2"></td>
                <td className="px-4 py-2"></td>
                <td className="px-4 py-2"></td>
                <td className="px-4 py-2"></td>
                
              </tr>
            </tbody>
          </table>
        </div>
            </div>
        </Layout>
    )
}

export default JournalEntries;

