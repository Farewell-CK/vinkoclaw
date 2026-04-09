/**
 * Plugin SDK - Configuration validation utilities
 *
 * This module provides helpers for validating plugin configurations
 * against their declared schemas.
 */

import type { PluginConfigSchema, PluginConfigProperty } from "./types.js";

/**
 * Validate a configuration object against a schema.
 *
 * @param config - The configuration object to validate
 * @param schema - The schema to validate against
 * @returns Validation result with any errors found
 */
export function validateConfig(
  config: Record<string, unknown>,
  schema: PluginConfigSchema
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // Check required fields
  if (schema.required) {
    for (const requiredField of schema.required) {
      if (!(requiredField in config) || config[requiredField] === undefined) {
        errors.push(`Missing required field: ${requiredField}`);
      }
    }
  }

  // Validate each property
  if (schema.properties) {
    for (const [key, value] of Object.entries(config)) {
      const propSchema = schema.properties[key];
      if (propSchema) {
        const propError = validateProperty(key, value, propSchema);
        if (propError) {
          errors.push(propError);
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Validate a single property value against its schema.
 */
function validateProperty(key: string, value: unknown, schema: PluginConfigProperty): string | null {
  const expectedType = schema.type;
  const actualType = getActualType(value);

  // Check type match
  if (!typeMatches(actualType, expectedType)) {
    return `Property '${key}' has type '${actualType}', expected '${expectedType}'`;
  }

  // Check enum values
  if (schema.enum && typeof value === "string") {
    if (!schema.enum.includes(value)) {
      return `Property '${key}' value '${value}' not in allowed values: ${schema.enum.join(", ")}`;
    }
  }

  // Check numeric bounds
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      return `Property '${key}' value ${value} is below minimum ${schema.minimum}`;
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      return `Property '${key}' value ${value} is above maximum ${schema.maximum}`;
    }
  }

  return null;
}

/**
 * Get the actual type of a value.
 */
function getActualType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "object") return "object";
  return typeof value;
}

/**
 * Check if actual type matches expected type.
 */
function typeMatches(actual: string, expected: string): boolean {
  if (actual === expected) return true;
  // Treat null as valid for any type (optional field without value)
  if (actual === "null") return true;
  return false;
}

/**
 * Apply default values from schema to config.
 *
 * @param config - The configuration object (may be partial)
 * @param schema - The schema containing default values
 * @returns Configuration with defaults applied
 */
export function applyDefaults(
  config: Record<string, unknown>,
  schema: PluginConfigSchema
): Record<string, unknown> {
  const result = { ...config };

  if (schema.properties) {
    for (const [key, propSchema] of Object.entries(schema.properties)) {
      if (propSchema.default !== undefined && result[key] === undefined) {
        result[key] = propSchema.default;
      }
    }
  }

  return result;
}

/**
 * Create a simple string property schema.
 */
export function stringProperty(
  description?: string,
  defaultValue?: string,
  enumValues?: string[]
): PluginConfigProperty {
  return {
    type: "string",
    description,
    default: defaultValue,
    enum: enumValues
  };
}

/**
 * Create a simple number property schema.
 */
export function numberProperty(
  description?: string,
  defaultValue?: number,
  min?: number,
  max?: number
): PluginConfigProperty {
  return {
    type: "number",
    description,
    default: defaultValue,
    minimum: min,
    maximum: max
  };
}

/**
 * Create a simple boolean property schema.
 */
export function booleanProperty(
  description?: string,
  defaultValue?: boolean
): PluginConfigProperty {
  return {
    type: "boolean",
    description,
    default: defaultValue
  };
}

/**
 * Create a config schema from property definitions.
 */
export function createSchema(
  properties: Record<string, PluginConfigProperty>,
  required?: string[] | undefined
): PluginConfigSchema {
  return {
    type: "object",
    properties,
    required
  };
}