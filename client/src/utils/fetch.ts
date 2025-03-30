export const authenticatedFetch = (
    input: RequestInfo | URL,
    init?: RequestInit
): Promise<Response> => {
    const token = localStorage.getItem('token');
    if (!token) throw new Error('Request is not authorized.');
    return fetch(input, {
        ...(init !== undefined ? init : {}),
        headers: {
            ...(init?.headers ? init.headers : {}),
            Authorization: `Bearer ${token}`,
        },
    });
};
