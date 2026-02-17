const API_BASE_URL = `${import.meta.env.VITE_API_BASE_URL}/api`

const fetchWithAutoRefresh = async (
  input: RequestInfo,
  init: RequestInit = {}
): Promise<Response> => {
  let response = await fetch(input, {
    ...init,
    credentials: "include",
  });

  if (response.status === 401 || response.status === 403) {
    const refresh = await fetch(`${API_BASE_URL}/auth/refresh`, {
      method: "GET",
      credentials: "include",
    });

    if (refresh.ok) {
      response = await fetch(input, {
        ...init,
        credentials: "include",
      });
    } else {
      throw new Error("Session expired. Please log in.");
    }
  }

  return response;
};

// --- AUTH SERVICES ---

export const getCurrentUser = async () => {
    const response = await fetchWithAutoRefresh(`${API_BASE_URL}/auth/check`);
    if(!response.ok) throw new Error("Not Authenticated.");
    return response.json();
};

export const register = async (name: string, email: string, password: string) => {
    const response = await fetch(`${API_BASE_URL}/auth/register`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({name, email, password})
    });
    return response.json();
};

export const login = async (email: string, password: string) => {
    const response = await fetch(`${API_BASE_URL}/auth/login`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({email, password})
    });
    const data = await response.json();
    return { status: response.status, ok: response.ok, ...data };
};

export const logoutUser = async () => {
  const response = await fetch(`${API_BASE_URL}/auth/logout`, { method: "POST", credentials: "include" });
  if (response.status === 204) return { message: "Logged out successfully" };
  return response.json();
}

// --- ACCOUNT SERVICES ---

export const getAccounts = async () => {
    const response = await fetchWithAutoRefresh(`${API_BASE_URL}/accounts`);
    return response.json(); 
};

// --- JOURNAL SERVICES ---

// Unified Interfaces
export interface JournalEntryLine {
    accountId: string;
    debit: number;
    credit: number;
}

export interface JournalEntryPayload {
    date: string;
    description: string;
    lines: JournalEntryLine[]; // Changed 'accounts' to 'lines' to match your backend
}

export const getJournalEntries = async () => {
    const response = await fetchWithAutoRefresh(`${API_BASE_URL}/journals`);
    return response.json();
};

export const addJournalEntry = async (entry: JournalEntryPayload) => {
    const response = await fetchWithAutoRefresh(`${API_BASE_URL}/journals`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(entry),
    });

    if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.message || "Failed to add journal entry.");
    }
    return response.json();
};

// --- REPORT SERVICES ---

export const getTrialBalance = async () => {
    const response = await fetchWithAutoRefresh(`${API_BASE_URL}/reports/trial-balance`);
    return response.json();
};


export const analyzeWithAI = async (sentence: string) => {
    const response = await fetchWithAutoRefresh(`${API_BASE_URL}/ai/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sentence }),
    });
    if (!response.ok) throw new Error("AI Analysis failed.");
    return response.json();
};