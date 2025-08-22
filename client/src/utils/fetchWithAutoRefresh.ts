const API_BASE_AUTH = `${import.meta.env.VITE_API_BASE_URL}/auth`;

export const fetchWithAutoRefresh = async (
  input: RequestInfo,
  init: RequestInit = {}
): Promise<Response> => {
  let response = await fetch(input, {
    ...init,
    credentials: "include",
  });

  if (response.status === 401 || response.status === 403) {
    console.warn("Access token expired. Trying to refresh....");

    const refresh = await fetch(`${API_BASE_AUTH}/refresh`, {
      method: "POST",
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
