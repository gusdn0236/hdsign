import { createContext, useContext, useState, useEffect } from "react";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
    // ── 관리자 ──
    const [isAdmin, setIsAdmin] = useState(false);
    const [token, setToken]     = useState(null);
    const [loading, setLoading] = useState(true);

    // ── 거래처 ──
    const [clientUser, setClientUser]     = useState(null);
    const [clientToken, setClientToken]   = useState(null);
    const [clientLoading, setClientLoading] = useState(true);

    useEffect(() => {
        const adminStored = sessionStorage.getItem("adminToken");
        if (adminStored) { setToken(adminStored); setIsAdmin(true); }
        setLoading(false);

        const clientStored = localStorage.getItem("clientToken");
        const clientUserStored = localStorage.getItem("clientUser");
        if (clientStored) {
            setClientToken(clientStored);
            if (clientUserStored) {
                try {
                    setClientUser(JSON.parse(clientUserStored));
                } catch {
                    setClientUser({});
                }
            } else {
                setClientUser({});
            }
        }
        setClientLoading(false);
    }, []);

    const login  = (jwt) => { sessionStorage.setItem("adminToken", jwt);  setToken(jwt);        setIsAdmin(true); };
    const logout = ()    => { sessionStorage.removeItem("adminToken");     setToken(null);       setIsAdmin(false); };

    const clientLogin  = (jwt, profile = {}) => {
        const normalizedProfile = profile && typeof profile === "object" ? profile : {};
        localStorage.setItem("clientToken", jwt);
        localStorage.setItem("clientUser", JSON.stringify(normalizedProfile));
        setClientToken(jwt);
        setClientUser(normalizedProfile);
    };
    const clientLogout = () => {
        localStorage.removeItem("clientToken");
        localStorage.removeItem("clientUser");
        setClientToken(null);
        setClientUser(null);
    };

    return (
        <AuthContext.Provider value={{
            isAdmin, token, login, logout, loading,
            clientUser, clientToken, clientLogin, clientLogout, clientLoading,
        }}>
            {children}
        </AuthContext.Provider>
    );
}

export function useAuth() { return useContext(AuthContext); }
