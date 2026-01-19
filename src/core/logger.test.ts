/**
 * Logger Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Logger, Timer, createLogger } from './logger.js';

describe('Logger', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  describe('constructor', () => {
    it('should create a logger with default options', () => {
      const logger = new Logger();
      expect(logger.isEnabled()).toBe(false);
    });

    it('should create a logger with custom options', () => {
      const logger = new Logger({ enabled: true, prefix: 'test' });
      expect(logger.isEnabled()).toBe(true);
    });
  });

  describe('isEnabled', () => {
    it('should return false when disabled', () => {
      const logger = new Logger({ enabled: false });
      expect(logger.isEnabled()).toBe(false);
    });

    it('should return true when enabled', () => {
      const logger = new Logger({ enabled: true });
      expect(logger.isEnabled()).toBe(true);
    });
  });

  describe('setEnabled', () => {
    it('should enable logging', () => {
      const logger = new Logger({ enabled: false });
      logger.setEnabled(true);
      expect(logger.isEnabled()).toBe(true);
    });

    it('should disable logging', () => {
      const logger = new Logger({ enabled: true });
      logger.setEnabled(false);
      expect(logger.isEnabled()).toBe(false);
    });
  });

  describe('child', () => {
    it('should create a child logger with sub-prefix', () => {
      const logger = new Logger({ enabled: true, prefix: 'parent' });
      const child = logger.child('child');

      child.debug('test message');

      expect(consoleLogSpy).toHaveBeenCalledWith('[parent:child] test message');
    });

    it('should inherit enabled state', () => {
      const logger = new Logger({ enabled: false, prefix: 'parent' });
      const child = logger.child('child');

      expect(child.isEnabled()).toBe(false);
    });
  });

  describe('debug', () => {
    it('should log message when enabled', () => {
      const logger = new Logger({ enabled: true, prefix: 'test' });
      logger.debug('test message');

      expect(consoleLogSpy).toHaveBeenCalledWith('[test] test message');
    });

    it('should log message with data when enabled', () => {
      const logger = new Logger({ enabled: true, prefix: 'test' });
      logger.debug('test message', { key: 'value' });

      expect(consoleLogSpy).toHaveBeenCalledWith('[test] test message {"key":"value"}');
    });

    it('should not log when disabled', () => {
      const logger = new Logger({ enabled: false, prefix: 'test' });
      logger.debug('test message');

      expect(consoleLogSpy).not.toHaveBeenCalled();
    });
  });

  describe('info', () => {
    it('should log message when enabled', () => {
      const logger = new Logger({ enabled: true, prefix: 'test' });
      logger.info('test message');

      expect(consoleLogSpy).toHaveBeenCalledWith('[test] test message');
    });

    it('should not log when disabled', () => {
      const logger = new Logger({ enabled: false, prefix: 'test' });
      logger.info('test message');

      expect(consoleLogSpy).not.toHaveBeenCalled();
    });
  });

  describe('warn', () => {
    it('should log warning when enabled', () => {
      const logger = new Logger({ enabled: true, prefix: 'test' });
      logger.warn('test warning');

      expect(consoleWarnSpy).toHaveBeenCalledWith('[test] test warning');
    });

    it('should not log when disabled', () => {
      const logger = new Logger({ enabled: false, prefix: 'test' });
      logger.warn('test warning');

      expect(consoleWarnSpy).not.toHaveBeenCalled();
    });
  });

  describe('error', () => {
    it('should always log error (even when disabled)', () => {
      const logger = new Logger({ enabled: false, prefix: 'test' });
      logger.error('test error');

      expect(consoleErrorSpy).toHaveBeenCalledWith('[test] test error');
    });

    it('should log error with Error object', () => {
      const logger = new Logger({ enabled: true, prefix: 'test' });
      const error = new Error('test error message');
      logger.error('operation failed', error);

      expect(consoleErrorSpy).toHaveBeenCalledWith('[test] operation failed: test error message');
    });

    it('should log error with other data types', () => {
      const logger = new Logger({ enabled: true, prefix: 'test' });
      logger.error('operation failed', { code: 123 });

      expect(consoleErrorSpy).toHaveBeenCalledWith('[test] operation failed:', { code: 123 });
    });
  });

  describe('time', () => {
    it('should return a Timer instance', () => {
      const logger = new Logger({ enabled: true });
      const timer = logger.time();

      expect(timer).toBeInstanceOf(Timer);
    });

    it('should log duration when timer.end is called', async () => {
      const logger = new Logger({ enabled: true, prefix: 'test' });
      const timer = logger.time();

      // Small delay to get measurable time
      await new Promise(resolve => setTimeout(resolve, 5));

      timer.end('operation complete');

      expect(consoleLogSpy).toHaveBeenCalled();
      const call = consoleLogSpy.mock.calls[0][0];
      expect(call).toMatch(/^\[test\] operation complete \(\d+(\.\d+)?ms\)$/);
    });

    it('should log duration with data', async () => {
      const logger = new Logger({ enabled: true, prefix: 'test' });
      const timer = logger.time();

      await new Promise(resolve => setTimeout(resolve, 5));

      timer.end('operation complete', { result: 'success' });

      expect(consoleLogSpy).toHaveBeenCalled();
      const call = consoleLogSpy.mock.calls[0][0];
      expect(call).toMatch(/^\[test\] operation complete {"result":"success"} \(\d+(\.\d+)?ms\)$/);
    });

    it('should not log when disabled', async () => {
      const logger = new Logger({ enabled: false, prefix: 'test' });
      const timer = logger.time();

      await new Promise(resolve => setTimeout(resolve, 5));

      timer.end('operation complete');

      expect(consoleLogSpy).not.toHaveBeenCalled();
    });
  });
});

describe('createLogger', () => {
  it('should create a logger with default options', () => {
    const logger = createLogger();
    expect(logger).toBeInstanceOf(Logger);
    expect(logger.isEnabled()).toBe(false);
  });

  it('should create a logger with custom options', () => {
    const logger = createLogger({ enabled: true, prefix: 'custom' });
    expect(logger.isEnabled()).toBe(true);
  });
});
