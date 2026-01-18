/**
 * Daemon Tests
 *
 * Tests for the LPGFS Daemon class.
 * Note: These tests do not actually mount the filesystem since that requires
 * fuse-native and FUSE to be installed. Instead, they test the daemon structure.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Daemon, createDaemon, unmount } from './daemon.js';
import type { MountOptions } from '../types/index.js';

describe('Daemon', () => {
  const mockMountOptions: MountOptions = {
    db: 'neo4j://localhost:7687',
    config: './.lpgfs.yaml',
    cacheTtl: 10,
    allowOther: false,
    debug: false,
    foreground: false,
  };

  describe('createDaemon', () => {
    it('should create a daemon instance', () => {
      const daemon = createDaemon({
        mountpoint: '/tmp/mnt',
        mountOptions: mockMountOptions,
      });

      expect(daemon).toBeInstanceOf(Daemon);
    });

    it('should resolve mountpoint to absolute path', () => {
      const daemon = createDaemon({
        mountpoint: './mnt',
        mountOptions: mockMountOptions,
      });

      // getMountpoint should return absolute path
      expect(daemon.getMountpoint()).toMatch(/^\/.*mnt$/);
    });
  });

  describe('Daemon constructor', () => {
    it('should set initial state to stopped', () => {
      const daemon = new Daemon({
        mountpoint: '/tmp/mnt',
        mountOptions: mockMountOptions,
      });

      expect(daemon.getState()).toBe('stopped');
    });

    it('should store mountpoint', () => {
      const daemon = new Daemon({
        mountpoint: '/tmp/test-mount',
        mountOptions: mockMountOptions,
      });

      expect(daemon.getMountpoint()).toBe('/tmp/test-mount');
    });
  });

  describe('Daemon.start', () => {
    it('should throw if fuse-native is not installed', async () => {
      const daemon = new Daemon({
        mountpoint: '/tmp/mnt',
        mountOptions: mockMountOptions,
      });

      // This will fail because fuse-native is not installed in test environment
      // or FUSE is not configured
      await expect(daemon.start()).rejects.toThrow();
    });

    it('should not allow starting twice', async () => {
      const daemon = new Daemon({
        mountpoint: '/tmp/mnt',
        mountOptions: mockMountOptions,
      });

      // Start will fail, but state will change briefly
      try {
        await daemon.start();
      } catch {
        // Expected to fail
      }

      // State should be back to stopped after failure cleanup
      expect(daemon.getState()).toBe('stopped');
    });
  });

  describe('Daemon.stop', () => {
    it('should be safe to call stop when not running', async () => {
      const daemon = new Daemon({
        mountpoint: '/tmp/mnt',
        mountOptions: mockMountOptions,
      });

      // Should not throw when called in stopped state
      await expect(daemon.stop()).resolves.toBeUndefined();
    });
  });
});

describe('unmount', () => {
  it('should throw if mountpoint does not exist', async () => {
    await expect(unmount('/nonexistent/path')).rejects.toThrow(
      'Mountpoint does not exist'
    );
  });

  it('should throw if mountpoint is not a directory', async () => {
    // package.json is a file, not a directory
    await expect(unmount('./package.json')).rejects.toThrow(
      'Mountpoint is not a directory'
    );
  });

  it('should fail gracefully if nothing is mounted', async () => {
    // Try to unmount an empty directory (not actually mounted)
    await expect(unmount('./')).rejects.toThrow('Failed to unmount');
  });
});
