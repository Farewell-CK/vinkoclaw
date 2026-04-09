import type { VinkoStore } from "../store.js";

export interface LoginRateLimit {
  maxAttempts: number;
  lockoutDurationMs: number;
  resetWindowMs: number;
}

const DEFAULT_RATE_LIMIT: LoginRateLimit = {
  maxAttempts: 5,
  lockoutDurationMs: 5 * 60 * 1000,
  resetWindowMs: 15 * 60 * 1000
};

export class LoginLimiter {
  constructor(
    private store: VinkoStore,
    private config: LoginRateLimit = DEFAULT_RATE_LIMIT
  ) {}

  checkLoginAllowed(username: string): { allowed: boolean; retryAfter?: number; reason?: string } {
    const user = this.store.getUserByUsername(username);
    
    if (user && !user.isActive) {
      return {
        allowed: false,
        reason: "account_inactive"
      };
    }

    const failedAttempts = this.getRecentFailedAttempts(username);
    
    if (failedAttempts >= this.config.maxAttempts) {
      const lastFailedAt = this.getLastFailedAttemptTime(username);
      if (lastFailedAt) {
        const elapsedMs = Date.now() - new Date(lastFailedAt).getTime();
        const remainingMs = this.config.lockoutDurationMs - elapsedMs;
        
        if (remainingMs > 0) {
          return {
            allowed: false,
            retryAfter: Math.ceil(remainingMs / 1000),
            reason: "account_locked"
          };
        }
      }
    }

    return { allowed: true };
  }

  recordLoginAttempt(username: string, ipAddress: string, success: boolean, reason?: string): void {
    this.store.appendAuditEvent({
      category: "auth",
      entityType: "user",
      entityId: username,
      message: success ? "login_success" : "login_failed",
      payload: {
        success,
        ipAddress,
        reason: reason || "",
        timestamp: new Date().toISOString()
      }
    });
  }

  private getRecentFailedAttempts(username: string): number {
    const cutoff = new Date(Date.now() - this.config.resetWindowMs).toISOString();
    const events = this.store.listAuditEvents(100);
    
    return events.filter(event => 
      event.category === "auth" &&
      event.entityType === "user" &&
      event.entityId === username &&
      event.message === "login_failed" &&
      event.createdAt >= cutoff
    ).length;
  }

  private getLastFailedAttemptTime(username: string): string | undefined {
    const events = this.store.listAuditEvents(100);
    const failedEvents = events.filter(event =>
      event.category === "auth" &&
      event.entityType === "user" &&
      event.entityId === username &&
      event.message === "login_failed"
    );
    
    return failedEvents.length > 0 ? failedEvents[0]?.createdAt : undefined;
  }

  resetFailedAttempts(username: string): void {
    // No-op: failed attempts will naturally expire after resetWindowMs
  }
}
