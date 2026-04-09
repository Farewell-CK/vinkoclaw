import { describe, it, expect } from "vitest";
import { validateManifest, isValidManifestId, MANIFEST_FILE_NAME } from "./manifest.js";

describe("validateManifest", () => {
  it("should validate a minimal valid manifest", () => {
    const manifest = validateManifest({
      id: "test-plugin",
      name: "Test Plugin",
      version: "1.0.0",
      kind: "skill"
    });

    expect(manifest).not.toBeNull();
    expect(manifest?.id).toBe("test-plugin");
    expect(manifest?.name).toBe("Test Plugin");
    expect(manifest?.version).toBe("1.0.0");
    expect(manifest?.kind).toBe("skill");
  });

  it("should validate a complete manifest", () => {
    const manifest = validateManifest({
      id: "complete-plugin",
      name: "Complete Plugin",
      version: "2.0.0",
      kind: "provider",
      description: "A complete plugin manifest",
      configSchema: {
        type: "object",
        properties: {
          setting: { type: "string" }
        }
      },
      allowedRoles: ["developer", "cto"],
      dependencies: {
        "other-plugin": "^1.0.0"
      },
      entry: "./src/main.ts"
    });

    expect(manifest).not.toBeNull();
    expect(manifest?.description).toBe("A complete plugin manifest");
    expect(manifest?.allowedRoles).toEqual(["developer", "cto"]);
    expect(manifest?.dependencies).toEqual({ "other-plugin": "^1.0.0" });
    expect(manifest?.entry).toBe("./src/main.ts");
  });

  it("should reject manifest with missing id", () => {
    expect(validateManifest({
      name: "No ID",
      version: "1.0.0",
      kind: "skill"
    })).toBeNull();
  });

  it("should reject manifest with empty id", () => {
    expect(validateManifest({
      id: "",
      name: "Empty ID",
      version: "1.0.0",
      kind: "skill"
    })).toBeNull();
  });

  it("should reject manifest with missing name", () => {
    expect(validateManifest({
      id: "no-name",
      version: "1.0.0",
      kind: "skill"
    })).toBeNull();
  });

  it("should reject manifest with missing version", () => {
    expect(validateManifest({
      id: "no-version",
      name: "No Version",
      kind: "skill"
    })).toBeNull();
  });

  it("should reject manifest with invalid kind", () => {
    expect(validateManifest({
      id: "invalid-kind",
      name: "Invalid Kind",
      version: "1.0.0",
      kind: "invalid"
    })).toBeNull();
  });

  it("should reject manifest with non-array allowedRoles", () => {
    expect(validateManifest({
      id: "bad-roles",
      name: "Bad Roles",
      version: "1.0.0",
      kind: "skill",
      allowedRoles: "developer"
    })).toBeNull();
  });

  it("should reject manifest with invalid configSchema type", () => {
    expect(validateManifest({
      id: "bad-schema",
      name: "Bad Schema",
      version: "1.0.0",
      kind: "skill",
      configSchema: {
        type: "string"
      }
    })).toBeNull();
  });

  it("should reject non-object input", () => {
    expect(validateManifest(null)).toBeNull();
    expect(validateManifest(undefined)).toBeNull();
    expect(validateManifest("string")).toBeNull();
    expect(validateManifest(123)).toBeNull();
    expect(validateManifest([])).toBeNull();
  });

  it("should trim whitespace from string fields", () => {
    const manifest = validateManifest({
      id: "  trimmed-id  ",
      name: "  Trimmed Name  ",
      version: "  1.0.0  ",
      kind: "skill",
      description: "  Trimmed description  "
    });

    expect(manifest?.id).toBe("trimmed-id");
    expect(manifest?.name).toBe("Trimmed Name");
    expect(manifest?.version).toBe("1.0.0");
    expect(manifest?.description).toBe("Trimmed description");
  });
});

describe("isValidManifestId", () => {
  it("should accept valid IDs", () => {
    expect(isValidManifestId("simple")).toBe(true);
    expect(isValidManifestId("with-dash")).toBe(true);
    expect(isValidManifestId("with_underscore")).toBe(true);
    expect(isValidManifestId("CamelCase")).toBe(true);
    expect(isValidManifestId("numbers123")).toBe(true);
  });

  it("should reject invalid IDs", () => {
    expect(isValidManifestId("")).toBe(false);
    expect(isValidManifestId("with space")).toBe(false);
    expect(isValidManifestId("with.dot")).toBe(false);
    expect(isValidManifestId("with/slash")).toBe(false);
    expect(isValidManifestId("a".repeat(65))).toBe(false);
  });
});

describe("MANIFEST_FILE_NAME", () => {
  it("should be vinkoclaw.plugin.json", () => {
    expect(MANIFEST_FILE_NAME).toBe("vinkoclaw.plugin.json");
  });
});