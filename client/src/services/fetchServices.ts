

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

