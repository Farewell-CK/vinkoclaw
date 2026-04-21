import express from "express";
import type { VinkoStore } from "@vinko/shared";

export interface AuthRoutesDeps {
  store: VinkoStore;
  getAuthCredentials: () => Array<{ username: string; password: string }>;
  createSession: (
    userId: string,
    username: string,
    role: string,
    displayName: string,
    remember: boolean,
    request?: express.Request
  ) => { token: string; user: { id: string; username: string; role: string; displayName: string }; expiresAt: number };
  validateToken: (token: string) => { valid: false } | { valid: true; user: { id: string; username: string; role: string; displayName: string } };
  revokeToken: (token: string) => void;
  extractBearerToken: (request: express.Request) => string | null;
}

export function registerAuthRoutes(app: express.Express, deps: AuthRoutesDeps): void {
  const { store, getAuthCredentials, createSession, validateToken, revokeToken, extractBearerToken } = deps;

  app.post("/api/auth/login", (request, response) => {
    const body = request.body as { username?: string; password?: string; remember?: boolean };
    const username = String(body.username || "").trim();
    const password = String(body.password || "");
    const remember = Boolean(body.remember);

    if (!username || !password) {
      response.status(400).json({ error: "username_and_password_required" });
      return;
    }

    const credentials = getAuthCredentials();
    const matched = credentials.find(
      (cred) => cred.username === username && cred.password === password
    );

    if (!matched) {
      response.status(401).json({ error: "invalid_credentials" });
      return;
    }

    const session = createSession(
      `user-${matched.username}`,
      matched.username,
      "owner",
      matched.username,
      remember,
      request
    );

    response.json({
      ok: true,
      user: session.user,
      token: session.token,
      expiresAt: session.expiresAt
    });
  });

  app.post("/api/auth/logout", (request, response) => {
    const token = extractBearerToken(request);
    if (token) {
      revokeToken(token);
    }
    response.json({ ok: true });
  });

  app.get("/api/auth/validate", (request, response) => {
    const token = extractBearerToken(request);
    if (!token) {
      response.status(401).json({ error: "missing_token" });
      return;
    }
    const validation = validateToken(token);
    if (!validation.valid) {
      response.status(401).json({ error: "invalid_token" });
      return;
    }
    response.json({ ok: true, user: validation.user });
  });

  app.get("/api/auth/me", (request, response) => {
    const token = extractBearerToken(request);
    if (!token) {
      response.status(401).json({ error: "missing_authorization" });
      return;
    }
    const validation = validateToken(token);
    if (!validation.valid) {
      response.status(401).json({ error: "invalid_token" });
      return;
    }
    response.json({ user: validation.user });
  });
}
