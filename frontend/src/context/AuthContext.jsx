import { createContext, useContext, useState, useEffect } from "react";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [isAdmin, setIsAdmin] = useState(false);
  const [token, setToken] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const stored = localStorage.getItem("adminToken");
    if (stored) {
      setToken(stored);
      setIsAdmin(true);
    }
    setLoading(false);
  }, []);

  const login = (jwt) => {
    localStorage.setItem("adminToken", jwt);
    setToken(jwt);
    setIsAdmin(true);
  };

  const logout = () => {
    localStorage.removeItem("adminToken");
    setToken(null);
    setIsAdmin(false);
  };

  return (
    <AuthContext.Provider value={{ isAdmin, token, login, logout, loading }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}