import { createContext, useContext, type ReactNode } from "react";

export interface AuthUser {
  id: number;
  displayName: string;
  email: string;
}

interface AuthContextValue {
  user: AuthUser | null;
  isLoading: boolean;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  isLoading: false,
  logout: () => {},
});

/**
 * Checkpoint A placeholder: no backend session wired up yet, so this always
 * renders as logged-out. Checkpoint B replaces the provider body with real
 * /api/auth/me + login/logout calls, keeping this same hook shape.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const value: AuthContextValue = {
    user: null,
    isLoading: false,
    logout: () => {},
  };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}
