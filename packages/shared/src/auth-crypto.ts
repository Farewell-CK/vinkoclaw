import * as crypto from "node:crypto";

const BCRYPT_COST = 12;
type BcryptModule = {
  hash(input: string, cost: number): Promise<string>;
  compare(input: string, hash: string): Promise<boolean>;
};

let bcryptModulePromise: Promise<BcryptModule> | undefined;

async function resolveBcryptModule(): Promise<BcryptModule> {
  if (!bcryptModulePromise) {
    const moduleName = "bcrypt";
    bcryptModulePromise = import(moduleName).then((mod) => {
      const candidate = (mod as { default?: unknown }).default ?? mod;
      if (
        typeof candidate === "object" &&
        candidate !== null &&
        "hash" in candidate &&
        "compare" in candidate &&
        typeof (candidate as BcryptModule).hash === "function" &&
        typeof (candidate as BcryptModule).compare === "function"
      ) {
        return candidate as BcryptModule;
      }
      throw new Error("Invalid bcrypt module");
    });
  }
  return bcryptModulePromise;
}

export async function hashPassword(password: string, cost: number = BCRYPT_COST): Promise<string> {
  const bcrypt = await resolveBcryptModule();
  return bcrypt.hash(password, cost);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  const bcrypt = await resolveBcryptModule();
  return bcrypt.compare(password, hash);
}

export function generateSecureToken(lengthBytes: number = 32): string {
  const bytes = new Uint8Array(lengthBytes);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function isTokenExpired(expiresAt: string | number): boolean {
  const expiresTimestamp = typeof expiresAt === "string" ? Date.parse(expiresAt) : expiresAt;
  return Date.now() > expiresTimestamp;
}

export function validateUsername(username: string): { valid: boolean; error?: string } {
  const trimmed = username.trim();
  if (!trimmed) {
    return { valid: false, error: "Username is required" };
  }
  if (trimmed.length < 1 || trimmed.length > 64) {
    return { valid: false, error: "Username must be 1-64 characters" };
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(trimmed)) {
    return { valid: false, error: "Username can only contain letters, numbers, underscore and hyphen" };
  }
  return { valid: true };
}

export function validatePassword(password: string): { valid: boolean; error?: string } {
  if (!password) {
    return { valid: false, error: "Password is required" };
  }
  if (password.length < 8) {
    return { valid: false, error: "Password must be at least 8 characters" };
  }
  if (password.length > 128) {
    return { valid: false, error: "Password must be at most 128 characters" };
  }
  return { valid: true };
}

export function generateUserId(): string {
  return `user-${generateSecureToken(8)}`;
}

export function generateSessionId(): string {
  return `session-${generateSecureToken(8)}`;
}
