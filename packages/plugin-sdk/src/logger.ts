/**
 * Plugin SDK - Logger utilities
 *
 * This module provides a default logger implementation for plugins
 * and allows customization of logging behavior.
 */

import type { PluginLogger } from "./types.js";

/**
 * Create a logger prefixed with the plugin name.
 *
 * @param pluginName - The plugin name to prefix log messages with
 * @param baseLogger - Optional base logger to delegate to
 * @returns A PluginLogger instance
 */
export function createPluginLogger(pluginName: string, baseLogger?: PluginLogger): PluginLogger {
  const prefix = `[${pluginName}]`;

  if (baseLogger) {
    return {
      info: (message, ...args) => baseLogger.info(`${prefix} ${message}`, ...args),
      warn: (message, ...args) => baseLogger.warn(`${prefix} ${message}`, ...args),
      error: (message, ...args) => baseLogger.error(`${prefix} ${message}`, ...args),
      debug: (message, ...args) => baseLogger.debug(`${prefix} ${message}`, ...args)
    };
  }

  // Default console-based logger
  return {
    info: (message, ...args) => console.info(`${prefix} ${message}`, ...args),
    warn: (message, ...args) => console.warn(`${prefix} ${message}`, ...args),
    error: (message, ...args) => console.error(`${prefix} ${message}`, ...args),
    debug: (message, ...args) => {
      if (process.env.DEBUG || process.env.VINKO_DEBUG) {
        console.debug(`${prefix} ${message}`, ...args);
      }
    }
  };
}

/**
 * A silent logger that does nothing - useful for testing.
 */
export const silentLogger: PluginLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {}
};

/**
 * Create a logger that writes to a file.
 *
 * @param pluginName - The plugin name for prefixing
 * @param filePath - Path to the log file
 * @returns A PluginLogger instance
 */
export function createFileLogger(pluginName: string, filePath: string): PluginLogger {
  const prefix = `[${pluginName}]`;
  // Note: File logging would require fs import, but we keep this simple
  // for the SDK. Actual implementation would be in the runtime.
  return {
    info: (message, ...args) => {
      // Placeholder - actual file logging in runtime
      console.info(`${prefix} ${message}`, ...args);
    },
    warn: (message, ...args) => {
      console.warn(`${prefix} ${message}`, ...args);
    },
    error: (message, ...args) => {
      console.error(`${prefix} ${message}`, ...args);
    },
    debug: (message, ...args) => {
      if (process.env.DEBUG || process.env.VINKO_DEBUG) {
        console.debug(`${prefix} ${message}`, ...args);
      }
    }
  };
}