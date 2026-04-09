const AUTH_STORAGE_KEY = "vinkoclaw.auth";
const AUTH_USER_KEY = "vinkoclaw.user";
const SESSION_TIMEOUT_MS = 24 * 60 * 60 * 1000;

export interface AuthUser {
  id: string;
  username: string;
  role: "owner" | "operator" | "viewer";
  displayName: string;
}

export interface AuthSession {
  user: AuthUser;
  token: string;
  expiresAt: number;
  createdAt: number;
}

export interface AuthState {
  isAuthenticated: boolean;
  user: AuthUser | null;
  session: AuthSession | null;
}

function getStoredSession(): AuthSession | null {
  try {
    const raw = localStorage.getItem(AUTH_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const session = JSON.parse(raw) as AuthSession;
    if (!session || !session.token || !session.user) {
      return null;
    }
    if (Date.now() > session.expiresAt) {
      clearAuth();
      return null;
    }
    return session;
  } catch {
    clearAuth();
    return null;
  }
}

function storeSession(session: AuthSession): void {
  localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(session));
}

export function clearAuth(): void {
  localStorage.removeItem(AUTH_STORAGE_KEY);
  localStorage.removeItem(AUTH_USER_KEY);
}

export function getAuthState(): AuthState {
  const session = getStoredSession();
  if (!session) {
    return {
      isAuthenticated: false,
      user: null,
      session: null
    };
  }
  return {
    isAuthenticated: true,
    user: session.user,
    session
  };
}

export function getCurrentUser(): AuthUser | null {
  const state = getAuthState();
  return state.user;
}

export function isAuthenticated(): boolean {
  return getAuthState().isAuthenticated;
}

export function getAuthToken(): string | null {
  const session = getStoredSession();
  return session?.token ?? null;
}

export async function login(
  username: string,
  password: string,
  remember: boolean
): Promise<{ success: boolean; error?: string; user?: AuthUser }> {
  try {
    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ username, password })
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      return {
        success: false,
        error: body.error || `Login failed with status ${response.status}`
      };
    }

    const data = await response.json();
    const session: AuthSession = {
      user: data.user,
      token: data.token,
      expiresAt: Date.now() + (remember ? SESSION_TIMEOUT_MS * 7 : SESSION_TIMEOUT_MS),
      createdAt: Date.now()
    };

    storeSession(session);

    return {
      success: true,
      user: data.user
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Network error during login"
    };
  }
}

export async function logout(): Promise<void> {
  const token = getAuthToken();
  if (token) {
    try {
      await fetch("/api/auth/logout", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`
        }
      });
    } catch {
      // Ignore logout API errors
    }
  }
  clearAuth();
}

export async function validateSession(): Promise<boolean> {
  const token = getAuthToken();
  if (!token) {
    return false;
  }

  try {
    const response = await fetch("/api/auth/validate", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`
      }
    });

    if (!response.ok) {
      clearAuth();
      return false;
    }

    return true;
  } catch {
    return isAuthenticated();
  }
}

export function requireAuth(redirectUrl: string = "/login.html"): void {
  if (!isAuthenticated()) {
    window.location.href = redirectUrl;
  }
}

export function redirectIfAuthenticated(redirectUrl: string = "/"): void {
  if (isAuthenticated()) {
    window.location.href = redirectUrl;
  }
}

export function authFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const token = getAuthToken();
  const headers = new Headers(options.headers);

  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  if (!headers.has("Content-Type") && options.body) {
    headers.set("Content-Type", "application/json");
  }

  return fetch(url, {
    ...options,
    headers
  });
}
