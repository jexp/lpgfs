/**
 * LPGFS Logger
 *
 * Centralized logging utility for consistent debug output.
 * All logging is gated by the debug flag.
 */

/**
 * Log level for categorizing messages.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Logger configuration options.
 */
export interface LoggerOptions {
  /** Enable logging (default: false) */
  enabled?: boolean;
  /** Logger prefix (default: 'lpgfs') */
  prefix?: string;
}

/**
 * Logger class for consistent debug output.
 *
 * Provides:
 * - Namespaced log messages with prefix
 * - Log level support (debug, info, warn, error)
 * - Timing helpers for measuring operation duration
 * - Conditional logging based on enabled flag
 *
 * @example
 * const logger = new Logger({ enabled: true, prefix: 'lpgfs:fuse' });
 * logger.debug('readdir', '/Person');
 * // Output: [lpgfs:fuse] readdir /Person
 *
 * @example
 * const timer = logger.time('readdir');
 * // ... do work ...
 * timer.end('readdir complete', { entries: 5 });
 * // Output: [lpgfs:fuse] readdir complete { entries: 5 } (12ms)
 */
export class Logger {
  private enabled: boolean;
  private prefix: string;

  constructor(options: LoggerOptions = {}) {
    this.enabled = options.enabled ?? false;
    this.prefix = options.prefix ?? 'lpgfs';
  }

  /**
   * Check if logging is enabled.
   */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Set the enabled state.
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  /**
   * Create a child logger with a sub-prefix.
   *
   * @param subPrefix - The sub-prefix to append
   * @returns A new Logger instance with the combined prefix
   *
   * @example
   * const fuseLogger = logger.child('fuse');
   * fuseLogger.debug('readdir', '/');
   * // Output: [lpgfs:fuse] readdir /
   */
  child(subPrefix: string): Logger {
    return new Logger({
      enabled: this.enabled,
      prefix: `${this.prefix}:${subPrefix}`,
    });
  }

  /**
   * Format the log prefix.
   */
  private formatPrefix(): string {
    return `[${this.prefix}]`;
  }

  /**
   * Format a log message with optional data.
   */
  private formatMessage(message: string, data?: unknown): string {
    const prefix = this.formatPrefix();
    if (data !== undefined) {
      const dataStr = typeof data === 'object' ? JSON.stringify(data) : String(data);
      return `${prefix} ${message} ${dataStr}`;
    }
    return `${prefix} ${message}`;
  }

  /**
   * Log a debug message (only if enabled).
   *
   * @param message - The message to log
   * @param data - Optional data to include
   */
  debug(message: string, data?: unknown): void {
    if (this.enabled) {
      console.log(this.formatMessage(message, data));
    }
  }

  /**
   * Log an info message (only if enabled).
   *
   * @param message - The message to log
   * @param data - Optional data to include
   */
  info(message: string, data?: unknown): void {
    if (this.enabled) {
      console.log(this.formatMessage(message, data));
    }
  }

  /**
   * Log a warning message (only if enabled).
   *
   * @param message - The message to log
   * @param data - Optional data to include
   */
  warn(message: string, data?: unknown): void {
    if (this.enabled) {
      console.warn(this.formatMessage(message, data));
    }
  }

  /**
   * Log an error message (always logged, even when not enabled).
   *
   * @param message - The message to log
   * @param error - Optional error to include
   */
  error(message: string, error?: Error | unknown): void {
    const prefix = this.formatPrefix();
    if (error instanceof Error) {
      console.error(`${prefix} ${message}: ${error.message}`);
      if (this.enabled && error.stack) {
        console.error(error.stack);
      }
    } else if (error !== undefined) {
      console.error(`${prefix} ${message}:`, error);
    } else {
      console.error(`${prefix} ${message}`);
    }
  }

  /**
   * Start a timer for measuring operation duration.
   *
   * @returns A timer object with an end() method
   *
   * @example
   * const timer = logger.time();
   * // ... do work ...
   * timer.end('operation complete');
   * // Output: [lpgfs] operation complete (12ms)
   */
  time(): Timer {
    const start = process.hrtime.bigint();
    return new Timer(this, start);
  }
}

/**
 * Timer for measuring operation duration.
 */
export class Timer {
  private logger: Logger;
  private start: bigint;

  constructor(logger: Logger, start: bigint) {
    this.logger = logger;
    this.start = start;
  }

  /**
   * End the timer and log the duration.
   *
   * @param message - The message to log
   * @param data - Optional data to include
   */
  end(message: string, data?: unknown): void {
    if (!this.logger.isEnabled()) {
      return;
    }

    const end = process.hrtime.bigint();
    const durationNs = end - this.start;
    const durationMs = Number(durationNs) / 1_000_000;

    const durationStr = durationMs < 1
      ? `${durationMs.toFixed(2)}ms`
      : `${Math.round(durationMs)}ms`;

    if (data !== undefined) {
      const dataStr = typeof data === 'object' ? JSON.stringify(data) : String(data);
      this.logger.debug(`${message} ${dataStr} (${durationStr})`);
    } else {
      this.logger.debug(`${message} (${durationStr})`);
    }
  }
}

/**
 * Create a new logger instance.
 *
 * @param options - Logger configuration
 * @returns Logger instance
 */
export function createLogger(options: LoggerOptions = {}): Logger {
  return new Logger(options);
}
