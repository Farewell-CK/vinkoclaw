const AUTH_STORAGE_KEY = "vinkoclaw.auth";
const AUTH_USER_KEY = "vinkoclaw.user";
const SESSION_TIMEOUT_MS = 24 * 60 * 60 * 1000;

// AuthSession: { user: AuthUser, token: string, expiresAt: number, createdAt: number }
// AuthUser: { id: string, username: string, role: "owner"|"operator"|"viewer", displayName: string }

function getStoredSession() {
  try {
    const raw = localStorage.getItem(AUTH_STORAGE_KEY);
    if (!raw) return null;
    const session = JSON.parse(raw);
    if (!session || !session.token || !session.user) return null;
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

function storeSession(session) {
  localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(session));
}

export function clearAuth() {
  localStorage.removeItem(AUTH_STORAGE_KEY);
  localStorage.removeItem(AUTH_USER_KEY);
}

export function getAuthState() {
  const session = getStoredSession();
  if (!session) {
    return { isAuthenticated: false, user: null, session: null };
  }
  return { isAuthenticated: true, user: session.user, session };
}

export function getCurrentUser() {
  return getAuthState().user;
}

export function isAuthenticated() {
  return getAuthState().isAuthenticated;
}

export function getAuthToken() {
  const session = getStoredSession();
  return session?.token ?? null;
}

export async function login(username, password, remember) {
  try {
    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password })
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      return { success: false, error: body.error || `Login failed with status ${response.status}` };
    }
    const data = await response.json();
    const session = {
      user: data.user,
      token: data.token,
      expiresAt: Date.now() + (remember ? SESSION_TIMEOUT_MS * 7 : SESSION_TIMEOUT_MS),
      createdAt: Date.now()
    };
    storeSession(session);
    return { success: true, user: data.user };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : "Network error during login" };
  }
}

export async function logout() {
  const token = getAuthToken();
  if (token) {
    try {
      await fetch("/api/auth/logout", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }
      });
    } catch { /* ignore */ }
  }
  clearAuth();
}

export async function validateSession() {
  const token = getAuthToken();
  if (!token) return false;
  try {
    const response = await fetch("/api/auth/validate", {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!response.ok) { clearAuth(); return false; }
    return true;
  } catch {
    return isAuthenticated();
  }
}

export function requireAuth(redirectUrl = "/login.html") {
  if (!isAuthenticated()) {
    window.location.href = redirectUrl;
  }
}

export function redirectIfAuthenticated(redirectUrl = "/") {
  if (isAuthenticated()) {
    window.location.href = redirectUrl;
  }
}

export function authFetch(url, options = {}) {
  const token = getAuthToken();
  const headers = new Headers(options.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (!headers.has("Content-Type") && options.body) {
    headers.set("Content-Type", "application/json");
  }
  return fetch(url, { ...options, headers });
}
