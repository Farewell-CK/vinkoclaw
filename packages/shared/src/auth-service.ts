import {
  type UserRecord,
  type AuthSessionRecord,
  type CreateUserInput,
  type LoginRequest,
  type LoginResponse,
  type UserRole,
  type AuthErrorCode,
  type LoginRateLimit,
  type SessionPolicy,
  type ValidateResult
} from "./auth-types.js";
import {
  hashPassword,
  verifyPassword,
  generateSecureToken,
  hashToken,
  isTokenExpired,
  validateUsername,
  validatePassword,
  generateUserId,
  generateSessionId
} from "./auth-crypto.js";

const DEFAULT_RATE_LIMIT: LoginRateLimit = {
  maxAttempts: 5,
  lockoutDurationMs: 5 * 60 * 1000,
  resetWindowMs: 15 * 60 * 1000
};

const DEFAULT_SESSION_POLICY: SessionPolicy = {
  defaultExpiryMs: 24 * 60 * 60 * 1000,
  extendedExpiryMs: 7 * 24 * 60 * 60 * 1000,
  maxSessionsPerUser: 5,
  tokenLength: 32
};

export interface AuthServiceConfig {
  rateLimit?: Partial<LoginRateLimit>;
  sessionPolicy?: Partial<SessionPolicy>;
  bcryptCost?: number;
}

export interface AuthServiceStore {
  getUserByUsername(username: string): UserRecord | undefined;
  getUserById(id: string): UserRecord | undefined;
  createUser(input: Omit<UserRecord, "id" | "createdAt" | "updatedAt">): UserRecord;
  updateUser(id: string, updates: Partial<UserRecord>): UserRecord | undefined;
  
  getSessionByTokenHash(tokenHash: string): AuthSessionRecord | undefined;
  getSessionsByUserId(userId: string): AuthSessionRecord[];
  createSession(input: Omit<AuthSessionRecord, "id" | "createdAt" | "lastAccessedAt">): AuthSessionRecord;
  updateSession(id: string, updates: Partial<AuthSessionRecord>): AuthSessionRecord | undefined;
  deleteSession(id: string): void;
  deleteSessionsByUserId(userId: string): void;
  
  appendAuditEvent(event: {
    category: "auth";
    entityType: string;
    entityId: string;
    message: string;
    payload: Record<string, unknown>;
  }): void;
}

export class AuthService {
  private readonly store: AuthServiceStore;
  private readonly rateLimit: LoginRateLimit;
  private readonly sessionPolicy: SessionPolicy;
  private readonly bcryptCost: number;
  private readonly loginAttemptCache = new Map<string, { attempts: number; firstAttemptAt: number }>();

  constructor(store: AuthServiceStore, config: AuthServiceConfig = {}) {
    this.store = store;
    this.rateLimit = { ...DEFAULT_RATE_LIMIT, ...config.rateLimit };
    this.sessionPolicy = { ...DEFAULT_SESSION_POLICY, ...config.sessionPolicy };
    this.bcryptCost = config.bcryptCost ?? 12;
  }

  async createUser(input: CreateUserInput): Promise<UserRecord> {
    const usernameValidation = validateUsername(input.username);
    if (!usernameValidation.valid) {
      throw new Error(usernameValidation.error);
    }

    const passwordValidation = validatePassword(input.password);
    if (!passwordValidation.valid) {
      throw new Error(passwordValidation.error);
    }

    const existingUser = this.store.getUserByUsername(input.username);
    if (existingUser) {
      throw new Error("Username already exists");
    }

    const passwordHash = await hashPassword(input.password, this.bcryptCost);
    const now = new Date().toISOString();

    const user = this.store.createUser({
      username: input.username.trim(),
      email: input.email,
      passwordHash,
      role: input.role ?? "viewer",
      displayName: input.displayName ?? input.username.trim(),
      isActive: input.isActive ?? true,
      failedLoginAttempts: 0,
      loginCount: 0,
      metadata: input.metadata ?? {}
    });

    return user;
  }

  async login(request: LoginRequest, context: { ipAddress?: string; userAgent?: string } = {}): Promise<LoginResponse> {
    const username = request.username.trim();
    const password = request.password;

    if (!username || !password) {
      return {
        ok: false,
        error: "username_and_password_required",
        message: "Username and password are required"
      };
    }

    const user = this.store.getUserByUsername(username);
    if (!user) {
      this.store.appendAuditEvent({
        category: "auth",
        entityType: "user",
        entityId: "unknown",
        message: "Login attempt with non-existent username",
        payload: {
          eventType: "login_failed",
          username,
          ipAddress: context.ipAddress ?? "unknown",
          userAgent: context.userAgent,
          reason: "user_not_found"
        }
      });
      return {
        ok: false,
        error: "invalid_credentials",
        message: "Invalid username or password"
      };
    }

    if (!user.isActive) {
      this.store.appendAuditEvent({
        category: "auth",
        entityType: "user",
        entityId: user.id,
        message: "Login attempt on inactive account",
        payload: {
          eventType: "login_failed",
          username,
          ipAddress: context.ipAddress ?? "unknown",
          userAgent: context.userAgent,
          reason: "account_inactive"
        }
      });
      return {
        ok: false,
        error: "account_inactive",
        message: "Account is inactive"
      };
    }

    if (user.lockedUntil && !isTokenExpired(user.lockedUntil)) {
      const lockedUntilMs = Date.parse(user.lockedUntil);
      const retryAfter = Math.ceil((lockedUntilMs - Date.now()) / 1000);
      
      this.store.appendAuditEvent({
        category: "auth",
        entityType: "user",
        entityId: user.id,
        message: "Login attempt on locked account",
        payload: {
          eventType: "login_failed",
          username,
          ipAddress: context.ipAddress ?? "unknown",
          userAgent: context.userAgent,
          reason: "account_locked",
          lockedUntil: user.lockedUntil
        }
      });
      
      return {
        ok: false,
        error: "account_locked",
        message: "Account is temporarily locked",
        retryAfter
      };
    }

    const passwordValid = await verifyPassword(password, user.passwordHash);
    if (!passwordValid) {
      const updatedAttempts = user.failedLoginAttempts + 1;
      const updates: Partial<UserRecord> = {
        failedLoginAttempts: updatedAttempts
      };

      if (updatedAttempts >= this.rateLimit.maxAttempts) {
        const lockedUntil = new Date(Date.now() + this.rateLimit.lockoutDurationMs).toISOString();
        updates.lockedUntil = lockedUntil;
        updates.failedLoginAttempts = 0;

        this.store.appendAuditEvent({
          category: "auth",
          entityType: "user",
          entityId: user.id,
          message: "Account locked due to too many failed login attempts",
          payload: {
            eventType: "account_locked",
            username,
            ipAddress: context.ipAddress ?? "unknown",
            userAgent: context.userAgent,
            attemptCount: updatedAttempts,
            lockedUntil
          }
        });
      }

      this.store.updateUser(user.id, updates);

      this.store.appendAuditEvent({
        category: "auth",
        entityType: "user",
        entityId: user.id,
        message: "Login failed - invalid password",
        payload: {
          eventType: "login_failed",
          username,
          ipAddress: context.ipAddress ?? "unknown",
          userAgent: context.userAgent,
          reason: "invalid_password",
          attemptCount: updatedAttempts
        }
      });

      return {
        ok: false,
        error: "invalid_credentials",
        message: "Invalid username or password"
      };
    }

    if (user.lockedUntil) {
      this.store.updateUser(user.id, {
        lockedUntil: undefined,
        failedLoginAttempts: 0
      });
    }

    const existingSessions = this.store.getSessionsByUserId(user.id);
    if (existingSessions.length >= this.sessionPolicy.maxSessionsPerUser) {
      const oldestSession = existingSessions.sort((a, b) => 
        Date.parse(a.createdAt) - Date.parse(b.createdAt)
      )[0];
      if (oldestSession) {
        this.store.deleteSession(oldestSession.id);
      }
    }

    const token = generateSecureToken(this.sessionPolicy.tokenLength);
    const tokenHash = hashToken(token);
    const now = Date.now();
    const expiresAt = new Date(
      now + (request.remember ? this.sessionPolicy.extendedExpiryMs : this.sessionPolicy.defaultExpiryMs)
    ).toISOString();

    const session = this.store.createSession({
      userId: user.id,
      token,
      tokenHash,
      userAgent: context.userAgent,
      ipAddress: context.ipAddress,
      expiresAt
    });

    this.store.updateUser(user.id, {
      failedLoginAttempts: 0,
      lastLoginAt: new Date().toISOString(),
      loginCount: user.loginCount + 1
    });

    this.store.appendAuditEvent({
      category: "auth",
      entityType: "user",
      entityId: user.id,
      message: "User logged in successfully",
      payload: {
        eventType: "login_success",
        username,
        ipAddress: context.ipAddress ?? "unknown",
        userAgent: context.userAgent,
        sessionId: session.id
      }
    });

    return {
      ok: true,
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        displayName: user.displayName
      },
      token,
      expiresAt: Date.parse(expiresAt)
    };
  }

  validateToken(token: string): ValidateResult {
    const tokenHash = hashToken(token);
    const session = this.store.getSessionByTokenHash(tokenHash);

    if (!session) {
      return {
        ok: false,
        error: "invalid_token"
      };
    }

    if (isTokenExpired(session.expiresAt)) {
      this.store.deleteSession(session.id);
      return {
        ok: false,
        error: "token_expired"
      };
    }

    const user = this.store.getUserById(session.userId);
    if (!user || !user.isActive) {
      this.store.deleteSession(session.id);
      return {
        ok: false,
        error: "invalid_token"
      };
    }

    this.store.updateSession(session.id, {
      lastAccessedAt: new Date().toISOString()
    });

    return {
      ok: true,
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        displayName: user.displayName
      }
    };
  }

  logout(token: string): void {
    const tokenHash = hashToken(token);
    const session = this.store.getSessionByTokenHash(tokenHash);
    
    if (session) {
      this.store.deleteSession(session.id);
      this.store.appendAuditEvent({
        category: "auth",
        entityType: "user",
        entityId: session.userId,
        message: "User logged out",
        payload: {
          eventType: "logout",
          sessionId: session.id
        }
      });
    }
  }

  logoutAllSessions(userId: string): void {
    this.store.deleteSessionsByUserId(userId);
    this.store.appendAuditEvent({
      category: "auth",
      entityType: "user",
      entityId: userId,
      message: "All user sessions revoked",
      payload: {
        eventType: "logout"
      }
    });
  }

  changePassword(userId: string, oldPassword: string, newPassword: string): Promise<void> {
    const user = this.store.getUserById(userId);
    if (!user) {
      throw new Error("User not found");
    }

    const passwordValidation = validatePassword(newPassword);
    if (!passwordValidation.valid) {
      throw new Error(passwordValidation.error);
    }

    return verifyPassword(oldPassword, user.passwordHash).then(async (valid) => {
      if (!valid) {
        throw new Error("Invalid old password");
      }

      const passwordHash = await hashPassword(newPassword, this.bcryptCost);
      this.store.updateUser(userId, { passwordHash });

      this.logoutAllSessions(userId);
    });
  }

  cleanup(): void {
    const now = Date.now();
    for (const [key, value] of this.loginAttemptCache.entries()) {
      if (now - value.firstAttemptAt > this.rateLimit.resetWindowMs) {
        this.loginAttemptCache.delete(key);
      }
    }
  }
}
