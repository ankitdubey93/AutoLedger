import { createContext } from "react";

export interface AuthContextType {
    isAuthenticated: boolean;
    username?: string | null;
    login: (token: string, username: string) => void;
    logout: () => void;


}



export const AuthContext = createContext<AuthContextType | undefined>(undefined);