

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
    console.warn("Access token expired. Trying to refresh....");

    const refresh = await fetch(`${API_BASE_URL}/auth/refresh`, {
      method: "GET",
      credentials: "include",
    });

    if (refresh.ok) {
      console.log("Refresh successful. Retrying request....");
      response = await fetch(input, {
        ...init,
        credentials: "include",
      });
    } else {
      console.error("Refresh failed.");
      throw new Error("Session expired. Please log in.");
    }
  }

  return response;
};



export const getCurrentUser = async () => {
    const response = await fetchWithAutoRefresh(`${API_BASE_URL}/auth/check`, {
        method: "GET",
        credentials: "include",
    });

    if(!response.ok){
        throw new Error("Not Authenticated.");
    }

    return response.json();
};


export const register = async (name: string, email: string, password: string) => {
    const response = await fetch(`${API_BASE_URL}/auth/register`, {
        method: "POST",
        credentials: "include",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify({name, email, password})
    });

    return response.json();
};


export const login = async (email: string, password: string) => {
    const response = await fetch(`${API_BASE_URL}/auth/login`, {
        method: "POST",
        credentials: "include",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify({email, password})
    });

      const data = await response.json();

  return {
    status: response.status,
    ok: response.ok,
    ...data,
  };
};




export const logoutUser = async () => {
  const response = await fetch(`${API_BASE_URL}/auth/logout`,{
    method: "POST",
    credentials: "include",
  });
 if (response.status === 204) {
    return { message: "Logged out successfully" };
  }

  return response.json();
}

// ----------------------------------------------------
// JOURNAL ENTRY SERVICES
// ----------------------------------------------------

/**
 * Defines the structure for the data sent to the backend to create a new entry.
 */
export interface JournalEntryPayload {
    date: string;
    description: string;
    accounts: Array<{
        account: string;
        debit: number;
        credit: number;
    }>;
}


/**
 * Fetches all existing journal entries for the current user.
 * @returns A promise that resolves to an array of journal entry objects.
 */
export const getJournalEntries = async () => {
    const response = await fetchWithAutoRefresh(`${API_BASE_URL}/journal-entries`, {
        method: "GET",
        headers: {
            "Content-Type": "application/json",
        },
    });

    if (!response.ok) {
        throw new Error("Failed to fetch journal entries.");
    }

    return response.json();
};

/**
 * Posts a new journal entry to the server.
 * @param entry The journal entry object to create.
 * @returns A promise that resolves to the newly created journal entry object from the server.
 */
export const addJournalEntry = async (entry: JournalEntryPayload) => {
    const response = await fetchWithAutoRefresh(`${API_BASE_URL}/journal-entries`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify(entry),
    });

    if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.message || "Failed to add journal entry.");
    }

    return response.json();
};