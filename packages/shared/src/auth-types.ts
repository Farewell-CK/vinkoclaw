export type UserRole = "owner" | "operator" | "viewer";

export type AuthErrorCode =
  | "username_and_password_required"
  | "invalid_credentials"
  | "account_locked"
  | "account_inactive"
  | "missing_token"
  | "invalid_token"
  | "token_expired"
  | "rate_limited"
  | "internal_error";

export interface UserRecord {
  id: string;
  username: string;
  email?: string | undefined;
  passwordHash: string;
  role: UserRole;
  displayName: string;
  isActive: boolean;
  failedLoginAttempts: number;
  lockedUntil?: string | undefined;
  lastLoginAt?: string | undefined;
  loginCount: number;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface AuthSessionRecord {
  id: string;
  userId: string;
  token: string;
  tokenHash: string;
  userAgent?: string | undefined;
  ipAddress?: string | undefined;
  expiresAt: string;
  createdAt: string;
  lastAccessedAt: string;
}

export interface AuthAuditEvent {
  id: string;
  category: "auth";
  eventType: "login_success" | "login_failed" | "logout" | "token_refresh" | "account_locked";
  userId?: string;
  username?: string;
  ipAddress: string;
  userAgent?: string;
  message: string;
  metadata: {
    reason?: string;
    attemptCount?: number;
  };
  createdAt: string;
}

export interface LoginRateLimit {
  maxAttempts: number;
  lockoutDurationMs: number;
  resetWindowMs: number;
}

export interface SessionPolicy {
  defaultExpiryMs: number;
  extendedExpiryMs: number;
  maxSessionsPerUser: number;
  tokenLength: number;
}

export interface AuthConfig {
  security: {
    bcryptCost: number;
    maxLoginAttempts: number;
    lockoutDurationMs: number;
    tokenExpiryMs: number;
    extendedTokenExpiryMs: number;
  };
  rateLimit: {
    windowMs: number;
    maxRequests: number;
  };
}

export interface CreateUserInput {
  username: string;
  password: string;
  email?: string;
  role?: UserRole;
  displayName?: string;
  isActive?: boolean;
  metadata?: Record<string, unknown>;
}

export interface LoginRequest {
  username: string;
  password: string;
  remember?: boolean;
}

export interface LoginSuccessResponse {
  ok: true;
  user: {
    id: string;
    username: string;
    role: UserRole;
    displayName: string;
  };
  token: string;
  expiresAt: number;
}

export interface LoginErrorResponse {
  ok: false;
  error: AuthErrorCode;
  message: string;
  retryAfter?: number;
}

export type LoginResponse = LoginSuccessResponse | LoginErrorResponse;

export interface ValidateResponse {
  ok: true;
  user: {
    id: string;
    username: string;
    role: UserRole;
    displayName: string;
  };
}

export interface ValidateErrorResponse {
  ok: false;
  error: "missing_token" | "invalid_token" | "token_expired";
}

export type ValidateResult = ValidateResponse | ValidateErrorResponse;
