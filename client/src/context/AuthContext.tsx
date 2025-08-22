import React, { createContext, useState, useEffect, useContext } from "react";

import { getCurrentUser } from "../services/fetchServices";

interface User {
  _id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  
}

interface AuthContextType {
  user: User | null;
  isLoggedIn: boolean;
  setUser: (user: User | null) => void;
  setIsLoggedIn: (loggedIn: boolean) => void;
  refreshUserDetails: () => Promise<void>;
  logout: () => void;

}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const [user, setUser] = useState<User | null>(null);
  const [isLoggedIn, setIsLoggedIn] = useState<boolean>(false);
  const [loading, setLoading] = useState(true);

  const fetchUser = async () => {
    try {
      const data = await getCurrentUser();
      setUser(data.user);
      setIsLoggedIn(true);
    } catch (err) {
      setUser(null);
      setIsLoggedIn(false);
    }
  };

  const refreshUserDetails = async () => {
    await fetchUser(); // Reuse same function
  };

   const logout = () => {
    // Optional: await logoutApi(); // Call backend logout to clear session
    setUser(null);
    setIsLoggedIn(false);
    // If using localStorage or cookies for tokens, clear them here
  };


  // Check if the user is already logged in (on initial load)
  useEffect(() => {
    const checkAuth = async () => {
      await fetchUser();
      setLoading(false);
    };

    checkAuth();
  }, []);

  if (loading) return null;

  return (
    <AuthContext.Provider
      value={{ user, isLoggedIn, setUser, setIsLoggedIn, refreshUserDetails, logout }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = (): AuthContextType => {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used inside AuthProvider.");
  return context;
};
