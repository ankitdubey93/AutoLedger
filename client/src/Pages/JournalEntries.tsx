// client/src/pages/JournalEntriesPage.tsx
import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

interface JournalEntryLine {
  account: string;
  description: string;
  debit: number;
  credit: number;
}

interface JournalEntry {
  _id?: string;
  date: string;
  description: string;
  lines: JournalEntryLine[];
}

const JournalEntriesPage: React.FC = () => {
  const [journalEntries, setJournalEntries] = useState<JournalEntry[]>([]);
  const [newEntry, setNewEntry] = useState<JournalEntry>({
    date: new Date().toISOString().split('T')[0],
    description: '',
    lines: [{ account: '', description: '', debit: 0, credit: 0 }],
  });
  const [isEditing, setIsEditing] = useState<boolean>(false);
  const [editingEntryId, setEditingEntryId] = useState<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    const token = localStorage.getItem('token');
    if (token) {
      try {
        fetch(`/api/journal-entries`, {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        })
          .then((response) => response.json())
          .then((entries: JournalEntry[]) => setJournalEntries(entries))
          .catch((error) => console.error('Error fetching journal entries:', error));
      } catch (error) {
        console.error('Error decoding token:', error);
        navigate('/');
      }
    } else {
      navigate('/');
    }
  }, [navigate]);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    setNewEntry({ ...newEntry, [e.target.name as keyof JournalEntry]: e.target.value });
  };

  const handleLineChange = (index: number, e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const {name, value} = e.target;
    const updatedLines = [...newEntry.lines];
    updatedLines[index] = {
        ...updatedLines[index],
        [name]: name === 'debit' || name === 'credit' ? parseFloat(value) || 0 : value,
      };
    setNewEntry({ ...newEntry, lines: updatedLines });
  };

  const addLine = () => {
    setNewEntry({ ...newEntry, lines: [...newEntry.lines, { account: '', description: '', debit: 0, credit: 0 }] });
  };

  const removeLine = (index: number) => {
    const updatedLines = [...newEntry.lines];
    updatedLines.splice(index, 1);
    setNewEntry({ ...newEntry, lines: updatedLines });
  };

  const addEntry = async () => {
    const token = localStorage.getItem('token');
    console.log(newEntry);
    if (token) {
      try {
        await fetch(`/api/journal-entries`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(newEntry),
        });
        fetch(`/api/journal-entries`, {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        })
          .then((response) => response.json())
          .then((entries: JournalEntry[]) => setJournalEntries(entries));
        setNewEntry({
          date: new Date().toISOString().split('T')[0],
          description: '',
          lines: [{ account: '', description: '', debit: 0, credit: 0 }],
        });
      } catch (error) {
        console.error('Error adding entry:', error);
      }
    }
  };

  const startEdit = (entry: JournalEntry) => {
    setIsEditing(true);
    setEditingEntryId(entry._id || null);
    setNewEntry({ ...entry });
  };

  const updateEntry = async () => {
    const token = localStorage.getItem('token');
    if (token && editingEntryId) {
      try {
        await fetch(`/api/journal-entries/${editingEntryId}`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(newEntry),
        });
        fetch(`/api/journal-entries`, {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        })
          .then((response) => response.json())
          .then((entries: JournalEntry[]) => setJournalEntries(entries));
        setIsEditing(false);
        setEditingEntryId(null);
        setNewEntry({
          date: new Date().toISOString().split('T')[0],
          description: '',
          lines: [{ account: '', description: '', debit: 0, credit: 0 }],
        });
      } catch (error) {
        console.error('Error updating entry:', error);
      }
    }
  };

  const deleteEntry = async (id: string) => {
    const token = localStorage.getItem('token');
    if (token) {
      try {
        await fetch(`/api/journal-entries/${id}`, {
          method: 'DELETE',
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });
        fetch(`/api/journal-entries`, {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        })
          .then((response) => response.json())
          .then((entries: JournalEntry[]) => setJournalEntries(entries));
      } catch (error) {
        console.error('Error deleting entry:', error);
      }
    }
  };

  return (
    <div className="container mx-auto p-4">
      <h1 className="text-2xl font-semibold mb-4">Journal Entries</h1>
      <div className="mb-4">
        <input type="date" name="date" value={newEntry.date} onChange={handleInputChange} className="border p-2 mr-2" />
        <input type="text" name="description" value={newEntry.description} onChange={handleInputChange} placeholder="Journal Description" className="border p-2 mr-2" />
        {newEntry.lines.map((line, index) => (
          <div key={index} className="flex mb-2">
            <input type="text" name="account" value={line.account} onChange={(e) => handleLineChange(index, e)} placeholder="Account" className="border p-2 mr-2" />
            <input type="text" name="description" value={line.description} onChange={(e) => handleLineChange(index, e)} placeholder="Line Description" className="border p-2 mr-2" />
            <input type="number" name="debit" value={line.debit} onChange={(e) => handleLineChange(index, e)} placeholder="Debit" className="border p-2 mr-2" />
            <input type="number" name="credit" value={line.credit} onChange={(e) => handleLineChange(index, e)} placeholder="Credit" className="border p-2 mr-2" />
            <button type="button" onClick={() => removeLine(index)} className="bg-red-500 hover:bg-red-700 text-white font-bold py-1 px-2 rounded mr-2">Remove</button>
          </div>
        ))}
        <button type="button" onClick={addLine} className="bg-green-500 hover:bg-green-700 text-white font-bold py-2 px-4 rounded mr-2">Add Line</button>
        <button onClick={isEditing ? updateEntry : addEntry} className="bg-blue-500 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded">
          {isEditing ? 'Update' : 'Add'}
        </button>
      </div>
      <table className="min-w-full divide-y divide-gray-200">
  <thead className="bg-gray-50">
    <tr>
      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Date</th>
      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Description</th>
      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Account</th>
      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Line Description</th>
      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Debit</th>
      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Credit</th>
      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
    </tr>
  </thead>
  <tbody className="bg-white divide-y divide-gray-200">
    {journalEntries.map((entry) => (
      <tr key={entry._id}>
        <td className="px-6 py-4 whitespace-nowrap">{entry.date.split('T')[0]}</td>
        <td className="px-6 py-4 whitespace-nowrap">{entry.description}</td>
        <td className="px-6 py-4 whitespace-nowrap">
          {entry.lines.map((line, index) => (
            <div key={index}>{line.account}</div>
          ))}
        </td>
        <td className="px-6 py-4 whitespace-nowrap">
          {entry.lines.map((line, index) => (
            <div key={index}>{line.description}</div>
          ))}
        </td>
        <td className="px-6 py-4 whitespace-nowrap">
          {entry.lines.map((line, index) => (
            <div key={index}>{line.debit}</div>
          ))}
        </td>
        <td className="px-6 py-4 whitespace-nowrap">
          {entry.lines.map((line, index) => (
            <div key={index}>{line.credit}</div>
          ))}
        </td>
        <td className="px-6 py-4 whitespace-nowrap">
          <button
            onClick={() => startEdit(entry)}
            className="bg-yellow-500 hover:bg-yellow-700 text-white font-bold py-2 px-4 rounded mr-2"
          >
            Edit
          </button>
          <button
            onClick={() => deleteEntry(entry._id || '')}
            className="bg-red-500 hover:bg-red-700 text-white font-bold py-2 px-4 rounded"
          >
            Delete
          </button>
        </td>
      </tr>
    ))}
  </tbody>
</table>
</div>
  )
}


export default JournalEntriesPage;