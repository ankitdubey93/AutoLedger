import { fetchWithAutoRefresh } from "../utils/fetchWithAutoRefresh";

const API_BASE_URL = `${import.meta.env.VITE_API_BASE_URL}/api`



export const getCurrentUser = async () => {
    const response = await fetchWithAutoRefresh(`${API_BASE_URL}/check`, {
        method: "GET",
        credentials: "include",
    });

    if(!response.ok){
        throw new Error("Not Authenticated.");
    }

    return response.json();
};


export const register = async (name: string, email: string, password: string) => {
    const response = await fetch(`${API_BASE_URL}/register`, {
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
    const response = await fetch(`${API_BASE_URL}/login`, {
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



