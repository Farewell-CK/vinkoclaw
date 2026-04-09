import type { VinkoStore } from "../store.js";
import type { UserRecord, AuthSessionRecord, LoginInput, LoginResult, AuthErrorCode } from "../types.js";
import { hashPassword, verifyPassword } from "./password.js";
import { LoginLimiter } from "./login-limiter.js";

export class AuthService {
  private limiter: LoginLimiter;

  constructor(private store: VinkoStore) {
    this.limiter = new LoginLimiter(store);
  }

  async login(input: LoginInput): Promise<LoginResult> {
    const { username, password, rememberMe, userAgent, ipAddress } = input;

    // Validation
    if (!username || !password) {
      return {
        success: false,
        error: "username_and_password_required"
      };
    }

    // Check rate limiting
    const rateCheck = this.limiter.checkLoginAllowed(username);
    if (!rateCheck.allowed) {
      this.limiter.recordLoginAttempt(username, ipAddress || "unknown", false, rateCheck.reason);
      return {
        success: false,
        error: (rateCheck.reason as AuthErrorCode) || "rate_limited",
        ...(rateCheck.retryAfter && { retryAfter: rateCheck.retryAfter })
      };
    }

    // Find user
    const user = this.store.getUserByUsername(username);
    if (!user) {
      this.limiter.recordLoginAttempt(username, ipAddress || "unknown", false, "invalid_credentials");
      return {
        success: false,
        error: "invalid_credentials"
      };
    }

    // Check if active
    if (!user.isActive) {
      this.limiter.recordLoginAttempt(username, ipAddress || "unknown", false, "account_inactive");
      return {
        success: false,
        error: "account_inactive"
      };
    }

    // Verify password
    const isValid = await verifyPassword(password, user.passwordHash);
    if (!isValid) {
      this.limiter.recordLoginAttempt(username, ipAddress || "unknown", false, "invalid_credentials");
      return {
        success: false,
        error: "invalid_credentials"
      };
    }

    // Create session
    const session = this.store.createAuthSession({
      userId: user.id,
      userAgent,
      ipAddress,
      rememberMe
    });

    // Update user last login
    this.store.updateUserLastLogin(user.id);

    // Record successful login
    this.limiter.recordLoginAttempt(username, ipAddress || "unknown", true);

    return {
      success: true,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        passwordHash: user.passwordHash,
        role: user.role,
        displayName: user.displayName,
        isActive: user.isActive,
        lastLoginAt: user.lastLoginAt,
        loginCount: user.loginCount,
        metadata: user.metadata,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt
      },
      token: session.token,
      expiresAt: session.expiresAt
    };
  }

  logout(token: string): boolean {
    return this.store.deleteAuthSessionByToken(token);
  }

  validateToken(token: string): { valid: boolean; user?: UserRecord } {
    const session = this.store.getAuthSessionByToken(token);
    
    if (!session) {
      return { valid: false };
    }

    // Check expiration
    if (new Date(session.expiresAt) < new Date()) {
      this.store.deleteAuthSession(session.id);
      return { valid: false };
    }

    // Get user
    const user = this.store.getUser(session.userId);
    if (!user || !user.isActive) {
      this.store.deleteAuthSession(session.id);
      return { valid: false };
    }

    // Update last accessed
    this.store.updateAuthSessionLastAccessed(session.id);

    return { valid: true, user };
  }

  async createUser(input: { username: string; password: string; email?: string; role?: string; displayName?: string }): Promise<UserRecord> {
    // Check if username exists
    const existing = this.store.getUserByUsername(input.username);
    if (existing) {
      throw new Error("Username already exists");
    }

    // Hash password
    const passwordHash = await hashPassword(input.password);

    // Create user
    return this.store.createUser({
      username: input.username,
      password: passwordHash,
      email: input.email,
      role: input.role as UserRecord["role"],
      displayName: input.displayName
    });
  }

  async changePassword(userId: string, oldPassword: string, newPassword: string): Promise<boolean> {
    const user = this.store.getUser(userId);
    if (!user) {
      return false;
    }

    // Verify old password
    const isValid = await verifyPassword(oldPassword, user.passwordHash);
    if (!isValid) {
      return false;
    }

    // Hash new password
    const passwordHash = await hashPassword(newPassword);

    // Update password
    this.store.updateUserPassword(userId, passwordHash);

    // Invalidate all sessions
    this.store.deleteAllAuthSessionsByUser(userId);

    return true;
  }

  listActiveSessions(userId: string): AuthSessionRecord[] {
    return this.store.listAuthSessionsByUser(userId);
  }

  revokeAllSessions(userId: string): number {
    return this.store.deleteAllAuthSessionsByUser(userId);
  }
}
