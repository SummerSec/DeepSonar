/**
 * Web 用户会话：与 API Token 共用 localStorage key（deepsonar_token），
 * 登录写入用户会话 token；服务账号仍可粘贴 API Token。
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { Navigate, useLocation } from "react-router-dom";
import {
  api,
  getLocalToken,
  setLocalToken,
  type AuthMe,
  type AuthStatus,
  type PublicUser,
} from "./api";

interface AuthContextValue {
  loading: boolean;
  status: AuthStatus | null;
  me: AuthMe | null;
  user: PublicUser | null;
  token: string;
  refresh: () => Promise<void>;
  login: (username: string, password: string) => Promise<void>;
  bootstrap: (username: string, password: string, display_name?: string) => Promise<void>;
  logout: () => Promise<void>;
  setToken: (token: string) => void;
}

const AuthCtx = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [me, setMe] = useState<AuthMe | null>(null);
  const [token, setTokenState] = useState(getLocalToken());

  const setToken = useCallback((t: string) => {
    setLocalToken(t);
    setTokenState(t);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const st = await api.authStatus();
      setStatus(st);
      if (!st.auth_required) {
        setMe({
          auth_required: false,
          authenticated: true,
          actor: { type: "internal", name: "dev", role: null, scopes: ["admin"] },
          user: null,
        });
        return;
      }
      if (!getLocalToken()) {
        setMe({ auth_required: true, authenticated: false, actor: null, user: null });
        return;
      }
      try {
        const m = await api.authMe();
        setMe(m);
      } catch {
        setLocalToken("");
        setTokenState("");
        setMe({ auth_required: true, authenticated: false, actor: null, user: null });
      }
    } catch {
      setStatus(null);
      setMe(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, token]);

  const login = useCallback(
    async (username: string, password: string) => {
      const r = await api.login({ username, password });
      setToken(r.token);
      setMe({
        auth_required: true,
        authenticated: true,
        actor: {
          type: "user",
          name: r.user.username,
          role: r.user.role,
          scopes: [],
        },
        user: r.user,
      });
    },
    [setToken],
  );

  const bootstrap = useCallback(
    async (username: string, password: string, display_name?: string) => {
      const r = await api.bootstrap({ username, password, display_name });
      setToken(r.token);
      setMe({
        auth_required: true,
        authenticated: true,
        actor: {
          type: "user",
          name: r.user.username,
          role: r.user.role,
          scopes: [],
        },
        user: r.user,
      });
      setStatus((s) => (s ? { ...s, has_users: true, bootstrap_available: false } : s));
    },
    [setToken],
  );

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } catch {
      /* ignore */
    }
    setToken("");
    setMe({
      auth_required: status?.auth_required ?? true,
      authenticated: false,
      actor: null,
      user: null,
    });
  }, [setToken, status?.auth_required]);

  const value = useMemo(
    () => ({
      loading,
      status,
      me,
      user: me?.user ?? null,
      token,
      refresh,
      login,
      bootstrap,
      logout,
      setToken,
    }),
    [loading, status, me, token, refresh, login, bootstrap, logout, setToken],
  );

  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthCtx);
  if (!ctx) throw new Error("useAuth outside AuthProvider");
  return ctx;
}

/** 需要登录时拦截；auth 未开启或已登录则放行 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { loading, status, me } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-[13px] text-zinc-500">
        检查登录状态…
      </div>
    );
  }

  if (status?.auth_required && !me?.authenticated) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  return <>{children}</>;
}
