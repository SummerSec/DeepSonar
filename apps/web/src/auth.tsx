/**
 * Web 鉴权：用户会话（deepsonar_session）与平台 API Token（deepsonar_api_token）分存；
 * 请求时会话优先。登录写会话；登录页「API Token」模式写 API Token。
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
import { AUTH_STATUS_UNAVAILABLE, resolveAuthStatusReadiness } from "./auth-status";

interface AuthContextValue {
  loading: boolean;
  status: AuthStatus | null;
  statusError: unknown | null;
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
  const [statusError, setStatusError] = useState<unknown | null>(null);
  const [me, setMe] = useState<AuthMe | null>(null);
  const [token, setTokenState] = useState(getLocalToken());

  const setToken = useCallback((t: string) => {
    setLocalToken(t);
    setTokenState(getLocalToken());
  }, []);

  const refresh = useCallback(async () => {
    try {
      const st = await api.authStatus();
      setStatus(st);
      setStatusError(null);
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
        setTokenState(getLocalToken());
      } catch {
        setLocalToken("");
        setTokenState("");
        setMe({ auth_required: true, authenticated: false, actor: null, user: null });
      }
    } catch (error) {
      setStatus(null);
      setStatusError(error);
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
      statusError,
      me,
      user: me?.user ?? null,
      token,
      refresh,
      login,
      bootstrap,
      logout,
      setToken,
    }),
    [loading, status, statusError, me, token, refresh, login, bootstrap, logout, setToken],
  );

  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthCtx);
  if (!ctx) throw new Error("useAuth outside AuthProvider");
  return ctx;
}

/** 需要登录时拦截；仅明确关闭鉴权或已登录则放行，status 失败不按开发模式放行 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { loading, status, statusError, me, refresh } = useAuth();
  const location = useLocation();
  const readiness = resolveAuthStatusReadiness({ loading, status, error: statusError });

  if (readiness.kind === "loading") {
    return (
      <div className="flex h-full items-center justify-center text-[13px] text-zinc-500">
        检查登录状态…
      </div>
    );
  }

  if (readiness.kind === "error" && !me?.authenticated) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-[13px] text-zinc-500">
        <p role="alert">{readiness.message || AUTH_STATUS_UNAVAILABLE}</p>
        <button type="button" className="text-[12px] text-zinc-300 underline-offset-2 hover:underline" onClick={() => void refresh()}>
          重试
        </button>
      </div>
    );
  }

  if (status?.auth_required && !me?.authenticated) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  return <>{children}</>;
}
