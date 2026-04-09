import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const BCRYPT_COST = 12;
const SCRYPT_KEYLEN = 64;
const SCRYPT_PREFIX = "scrypt";

type BcryptModule = {
  hash(input: string, cost: number): Promise<string>;
  compare(input: string, hash: string): Promise<boolean>;
};

let bcryptModulePromise: Promise<BcryptModule | undefined> | undefined;

async function resolveBcryptModule(): Promise<BcryptModule | undefined> {
  if (!bcryptModulePromise) {
    const moduleName = "bcrypt";
    bcryptModulePromise = import(moduleName)
      .then((mod) => {
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
        return undefined;
      })
      .catch(() => undefined);
  }
  return bcryptModulePromise;
}

async function hashWithScrypt(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const derived = scryptSync(password, salt, SCRYPT_KEYLEN);
  return [SCRYPT_PREFIX, salt, derived.toString("hex")].join("$");
}

async function verifyWithScrypt(password: string, hash: string): Promise<boolean> {
  const parts = hash.split("$");
  if (parts.length !== 3 || parts[0] !== SCRYPT_PREFIX) {
    return false;
  }
  const salt = parts[1] ?? "";
  const expectedHex = parts[2] ?? "";
  if (!salt || !expectedHex) {
    return false;
  }
  const expected = Buffer.from(expectedHex, "hex");
  if (expected.length === 0) {
    return false;
  }
  const derived = scryptSync(password, salt, expected.length);
  if (derived.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(derived, expected);
}

export async function hashPassword(password: string): Promise<string> {
  if (!password || password.length < 8) {
    throw new Error("Password must be at least 8 characters");
  }
  if (password.length > 128) {
    throw new Error("Password must be at most 128 characters");
  }
  const bcrypt = await resolveBcryptModule();
  if (bcrypt) {
    return bcrypt.hash(password, BCRYPT_COST);
  }
  return hashWithScrypt(password);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  if (!password || !hash) {
    return false;
  }
  if (hash.startsWith("$2")) {
    const bcrypt = await resolveBcryptModule();
    if (!bcrypt) {
      return false;
    }
    return bcrypt.compare(password, hash);
  }
  if (hash.startsWith(`${SCRYPT_PREFIX}$`)) {
    return verifyWithScrypt(password, hash);
  }
  return false;
}

export function validatePasswordStrength(password: string): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  
  if (!password || password.length < 8) {
    errors.push("Password must be at least 8 characters");
  }
  
  if (password.length > 128) {
    errors.push("Password must be at most 128 characters");
  }
  
  if (!/[a-zA-Z]/.test(password)) {
    errors.push("Password must contain at least one letter");
  }
  
  if (!/[0-9]/.test(password)) {
    errors.push("Password must contain at least one number");
  }
  
  return {
    valid: errors.length === 0,
    errors
  };
}
