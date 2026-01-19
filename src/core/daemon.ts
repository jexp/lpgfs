/**
 * LPGFS Daemon
 *
 * Manages the FUSE filesystem mount/unmount lifecycle.
 * Wraps fuse-native to provide a clean interface for the CLI.
 */

import { execSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import type { ConfigSchema, MountOptions } from '../types/index.js';
import { DEFAULT_CONFIG, LpgfsError, POSIX_ERRORS } from '../types/index.js';
import { DatabaseConnection, connect } from '../db/connection.js';
import { Cache } from '../cache/index.js';
import { ConfigParser } from '../config/parser.js';
import {
  createHandlerContext,
  readdir,
  getattr,
  readlink,
  read,
  type HandlerContext,
} from '../fuse/handlers.js';
import { Logger, createLogger } from './logger.js';

// fuse-native types
interface FuseStats {
  mtime: Date;
  atime: Date;
  ctime: Date;
  size: number;
  mode: number;
  uid: number;
  gid: number;
  nlink?: number;
}

interface FuseOps {
  init?: (cb: (code: number) => void) => void;
  readdir?: (path: string, cb: (code: number, entries?: string[]) => void) => void;
  getattr?: (path: string, cb: (code: number, stats?: FuseStats) => void) => void;
  open?: (path: string, flags: number, cb: (code: number, fd?: number) => void) => void;
  opendir?: (path: string, flags: number, cb: (code: number, fd?: number) => void) => void;
  release?: (path: string, fd: number, cb: (code: number) => void) => void;
  releasedir?: (path: string, fd: number, cb: (code: number) => void) => void;
  read?: (
    path: string,
    fd: number,
    buffer: Buffer,
    length: number,
    position: number,
    cb: (bytesRead: number) => void
  ) => void;
  readlink?: (path: string, cb: (code: number, target?: string) => void) => void;
  // Write operations - all return EROFS
  write?: (
    path: string,
    fd: number,
    buffer: Buffer,
    length: number,
    position: number,
    cb: (code: number) => void
  ) => void;
  create?: (path: string, mode: number, cb: (code: number, fd?: number) => void) => void;
  truncate?: (path: string, size: number, cb: (code: number) => void) => void;
  ftruncate?: (path: string, fd: number, size: number, cb: (code: number) => void) => void;
  unlink?: (path: string, cb: (code: number) => void) => void;
  mkdir?: (path: string, mode: number, cb: (code: number) => void) => void;
  rmdir?: (path: string, cb: (code: number) => void) => void;
  rename?: (src: string, dest: string, cb: (code: number) => void) => void;
  symlink?: (target: string, path: string, cb: (code: number) => void) => void;
  link?: (src: string, dest: string, cb: (code: number) => void) => void;
  chmod?: (path: string, mode: number, cb: (code: number) => void) => void;
  chown?: (path: string, uid: number, gid: number, cb: (code: number) => void) => void;
  utimens?: (
    path: string,
    atime: number,
    mtime: number,
    cb: (code: number) => void
  ) => void;
  mknod?: (path: string, mode: number, dev: number, cb: (code: number) => void) => void;
  setxattr?: (
    path: string,
    name: string,
    value: Buffer,
    position: number,
    flags: number,
    cb: (code: number) => void
  ) => void;
  removexattr?: (path: string, name: string, cb: (code: number) => void) => void;
}

interface FuseOptions {
  displayFolder?: string;
  debug?: boolean;
  force?: boolean;
  mkdir?: boolean;
  allowOther?: boolean;
}

interface FuseInstance {
  mount(cb: (err: Error | null) => void): void;
  unmount(cb: (err: Error | null) => void): void;
}

interface FuseConstructor {
  new (mountpoint: string, ops: FuseOps, options?: FuseOptions): FuseInstance;
  ENOENT: number;
  EIO: number;
  EROFS: number;
  isConfigured(cb: (err: Error | null, configured: boolean) => void): void;
  configure(cb: (err: Error | null) => void): void;
}

// Lazy load fuse-native since it's optional
let Fuse: FuseConstructor | null = null;

/**
 * Load fuse-native module.
 * Throws if fuse-native is not installed.
 */
function loadFuse(): FuseConstructor {
  if (Fuse) {
    return Fuse;
  }

  try {
    // Create require function for ES module context
    const require = createRequire(import.meta.url);
    Fuse = require('fuse-native') as FuseConstructor;
    return Fuse;
  } catch {
    throw new Error(
      'fuse-native is not installed. ' +
        'Please install it with: npm install fuse-native\n' +
        'You may also need to install FUSE libraries:\n' +
        '  - Linux: sudo apt install libfuse-dev\n' +
        '  - macOS: Install macFUSE from https://osxfuse.github.io/'
    );
  }
}

/**
 * Daemon state.
 */
export type DaemonState = 'stopped' | 'starting' | 'running' | 'stopping';

/**
 * Daemon configuration options.
 */
export interface DaemonOptions {
  /** Mountpoint path */
  mountpoint: string;
  /** Mount options from CLI */
  mountOptions: MountOptions;
}

/**
 * LPGFS Daemon
 *
 * Manages the FUSE filesystem lifecycle:
 * - Parses configuration
 * - Establishes database connection
 * - Registers FUSE handlers
 * - Mounts filesystem
 * - Handles signals for clean unmount
 */
export class Daemon {
  private state: DaemonState = 'stopped';
  private mountpoint: string;
  private mountOptions: MountOptions;
  private db: DatabaseConnection | null = null;
  private fuse: FuseInstance | null = null;
  private config: ConfigSchema = DEFAULT_CONFIG;
  private cache: Cache | null = null;
  private handlerContext: HandlerContext | null = null;
  private signalHandlers: { signal: NodeJS.Signals; handler: () => void }[] = [];
  private uncaughtExceptionHandler: ((error: Error) => void) | null = null;
  private logger: Logger;

  constructor(options: DaemonOptions) {
    this.mountpoint = resolve(options.mountpoint);
    this.mountOptions = options.mountOptions;
    this.logger = createLogger({
      enabled: options.mountOptions.debug ?? false,
      prefix: 'lpgfs',
    });
  }

  /**
   * Get the current daemon state.
   */
  getState(): DaemonState {
    return this.state;
  }

  /**
   * Get the mountpoint path.
   */
  getMountpoint(): string {
    return this.mountpoint;
  }

  /**
   * Check Node.js version and warn if potentially unstable with fuse-native.
   */
  private checkNodeVersion(): void {
    const version = process.version;
    const majorVersion = parseInt(version.slice(1).split('.')[0], 10);

    if (majorVersion > 20) {
      this.logger.warn(
        `Running on Node.js ${version}. fuse-native may be unstable on Node.js 22+, consider Node 18 or 20 for stability.`
      );
    }
  }

  /**
   * Validate FUSE libraries are installed on the system.
   * Checks platform-specific FUSE paths before attempting mount.
   */
  private validateFuseLibraries(): void {
    const platform = process.platform;

    if (platform === 'darwin') {
      // macOS - check for macFUSE installation
      if (!existsSync('/Library/Filesystems/macfuse.fs')) {
        throw new Error(
          'macFUSE not found. Install from https://osxfuse.github.io/\n' +
            'After installation, restart your terminal and try again.'
        );
      }
    } else if (platform === 'linux') {
      // Linux - check for /dev/fuse device
      if (!existsSync('/dev/fuse')) {
        throw new Error(
          'FUSE device not found. Install FUSE libraries:\n' +
            '  Ubuntu/Debian: sudo apt install fuse libfuse-dev\n' +
            '  Fedora/RHEL: sudo dnf install fuse fuse-devel\n' +
            '  Arch: sudo pacman -S fuse2\n' +
            'Then load the FUSE kernel module: sudo modprobe fuse'
        );
      }
    }
    // Other platforms - proceed without validation
  }

  /**
   * Start the daemon and mount the filesystem.
   */
  async start(): Promise<void> {
    if (this.state !== 'stopped') {
      throw new Error(`Cannot start daemon: current state is ${this.state}`);
    }

    this.state = 'starting';
    const debug = this.mountOptions.debug ?? false;

    try {
      // Check Node.js version
      this.checkNodeVersion();

      // Validate FUSE libraries are installed
      this.logger.info('Validating FUSE libraries...');
      this.validateFuseLibraries();

      // Load fuse-native
      this.logger.info('Loading fuse-native module...');
      const FuseModule = loadFuse();

      // Check if FUSE is configured
      this.logger.info('Checking FUSE configuration...');
      await this.checkFuseConfigured();

      // Load configuration
      this.logger.info('Loading configuration...');
      this.config = await this.loadConfig();
      this.logger.debug('Configuration loaded', {
        naming: this.config.naming?.default,
        collision: this.config.collision?.strategy,
      });

      // Connect to database
      this.logger.info(`Connecting to database at ${this.mountOptions.db}...`);
      this.db = await connect({
        uri: this.mountOptions.db,
        username: this.mountOptions.user,
        password: this.mountOptions.password,
        debug,
      });
      this.logger.info('Database connection established');

      // Test database connectivity
      this.logger.info('Testing database connectivity...');
      try {
        await this.db.executeQuery('RETURN 1 as test');
        this.logger.debug('Database connectivity test passed');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Cannot connect to database at ${this.mountOptions.db}\n` +
            `Error: ${message}\n` +
            'Please check that:\n' +
            '  - Neo4j is running and accessible\n' +
            '  - The connection URI is correct\n' +
            '  - Username and password are correct'
        );
      }

      // Create cache
      this.cache = new Cache({ debug });
      this.logger.debug('Cache initialized');

      // Create handler context with its own logger
      const fuseLogger = this.logger.child('fuse');
      this.handlerContext = createHandlerContext(this.db, {
        config: this.config,
        cache: this.cache,
        debug,
        logger: fuseLogger,
      });

      // Create FUSE operations
      const ops = this.createFuseOps();

      // Create FUSE instance
      const fuseOptions: FuseOptions = {
        debug,
        force: true, // Unmount any existing mount
      };

      if (this.mountOptions.allowOther) {
        fuseOptions.allowOther = true;
      }

      this.fuse = new FuseModule(this.mountpoint, ops, fuseOptions);

      // Mount filesystem
      this.logger.info(`Mounting filesystem at ${this.mountpoint}...`);
      await new Promise<void>((resolve, reject) => {
        // Add timeout to prevent hanging indefinitely
        const timeout = setTimeout(() => {
          reject(new Error('Mount operation timed out after 5 seconds'));
        }, 5000);

        try {
          this.fuse!.mount((err) => {
            clearTimeout(timeout);
            if (err) {
              reject(new Error(`Failed to mount filesystem: ${err.message}`));
            } else {
              resolve();
            }
          });
        } catch (err) {
          clearTimeout(timeout);
          reject(err);
        }
      });

      // Register signal handlers for clean shutdown
      this.registerSignalHandlers();

      // Register uncaught exception handler
      this.registerUncaughtExceptionHandler();

      this.state = 'running';
      this.logger.info(`Filesystem mounted successfully at ${this.mountpoint}`);
    } catch (error) {
      this.logger.error('Failed to start daemon', error);
      this.state = 'stopped';
      await this.cleanup();
      throw error;
    }
  }

  /**
   * Stop the daemon and unmount the filesystem.
   */
  async stop(): Promise<void> {
    if (this.state !== 'running') {
      return;
    }

    this.state = 'stopping';
    this.logger.info('Stopping daemon...');

    // Unregister exception handler
    this.unregisterUncaughtExceptionHandler();

    // Unregister signal handlers
    this.unregisterSignalHandlers();

    // Unmount FUSE
    if (this.fuse) {
      this.logger.info('Unmounting filesystem...');
      try {
        await new Promise<void>((resolve, reject) => {
          this.fuse!.unmount((err) => {
            if (err) {
              // Ignore unmount errors - may already be unmounted
              this.logger.warn(`Unmount warning: ${err.message}`);
            }
            resolve();
          });
        });
      } catch (err) {
        this.logger.warn('Error during unmount', err);
      }
    }

    await this.cleanup();
    this.state = 'stopped';
    this.logger.info('Filesystem unmounted successfully');
  }

  /**
   * Clean up resources.
   * This method must never throw exceptions to ensure cleanup always succeeds.
   */
  private async cleanup(): Promise<void> {
    // Close database connection
    if (this.db) {
      try {
        this.logger.debug('Closing database connection...');
        await this.db.close();
      } catch (err) {
        this.logger.warn('Error closing database connection', err);
      } finally {
        this.db = null;
      }
    }

    // Clear cache
    if (this.cache) {
      try {
        this.logger.debug('Clearing cache...');
        this.cache.clear();
      } catch (err) {
        this.logger.warn('Error clearing cache', err);
      } finally {
        this.cache = null;
      }
    }

    this.handlerContext = null;
    this.fuse = null;
    this.logger.debug('Cleanup complete');
  }

  /**
   * Check if FUSE is configured on the system.
   */
  private checkFuseConfigured(): Promise<void> {
    return new Promise((resolve, reject) => {
      const FuseModule = loadFuse();
      FuseModule.isConfigured((err, configured) => {
        if (err) {
          reject(new Error(`Failed to check FUSE configuration: ${err.message}`));
        } else if (!configured) {
          reject(
            new Error(
              'FUSE is not configured on this system.\n' +
                'Please run: sudo fuse-native configure\n' +
                'Or install FUSE libraries manually.'
            )
          );
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * Load configuration from file.
   */
  private async loadConfig(): Promise<ConfigSchema> {
    const configPath = this.mountOptions.config;

    if (configPath) {
      const absolutePath = resolve(configPath);
      if (existsSync(absolutePath)) {
        return ConfigParser.load(absolutePath);
      }
    }

    // Return default config if no config file
    return DEFAULT_CONFIG;
  }

  /**
   * Register signal handlers for clean shutdown.
   */
  private registerSignalHandlers(): void {
    const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];

    for (const signal of signals) {
      const handler = () => {
        // Check state before attempting to stop
        if (this.state !== 'running') {
          console.log(`\n[lpgfs] Received ${signal}, but daemon is not running (state: ${this.state})`);
          process.exit(0);
          return;
        }

        // Always log signal reception (not gated by debug)
        console.log(`\n[lpgfs] Received ${signal}, shutting down...`);
        this.stop()
          .then(() => {
            process.exit(0);
          })
          .catch((err) => {
            this.logger.error(`Error during shutdown`, err);
            process.exit(1);
          });
      };

      process.on(signal, handler);
      this.signalHandlers.push({ signal, handler });
    }
    this.logger.debug('Signal handlers registered', { signals });
  }

  /**
   * Unregister signal handlers.
   */
  private unregisterSignalHandlers(): void {
    for (const { signal, handler } of this.signalHandlers) {
      process.off(signal, handler);
    }
    this.signalHandlers = [];
  }

  /**
   * Register uncaught exception handler for debugging segfaults and crashes.
   */
  private registerUncaughtExceptionHandler(): void {
    this.uncaughtExceptionHandler = (error: Error) => {
      // Log full error with daemon context
      console.error('\n[lpgfs] UNCAUGHT EXCEPTION:');
      console.error(`  State: ${this.state}`);
      console.error(`  Mountpoint: ${this.mountpoint}`);
      console.error(`  Error: ${error.message}`);
      console.error(`  Stack: ${error.stack}`);

      // Attempt graceful cleanup
      this.logger.error('Attempting graceful cleanup after uncaught exception...');
      this.cleanup()
        .then(() => {
          console.error('[lpgfs] Cleanup complete, exiting with code 1');
          process.exit(1);
        })
        .catch((cleanupErr) => {
          console.error('[lpgfs] Cleanup failed:', cleanupErr);
          process.exit(1);
        });
    };

    process.on('uncaughtException', this.uncaughtExceptionHandler);
    this.logger.debug('Uncaught exception handler registered');
  }

  /**
   * Unregister uncaught exception handler.
   */
  private unregisterUncaughtExceptionHandler(): void {
    if (this.uncaughtExceptionHandler) {
      process.off('uncaughtException', this.uncaughtExceptionHandler);
      this.uncaughtExceptionHandler = null;
    }
  }

  /**
   * Create FUSE operations object mapping our handlers to fuse-native format.
   */
  private createFuseOps(): FuseOps {
    const ctx = this.handlerContext!;
    const logger = this.logger.child('fuse');

    // File mode constants
    const S_IFDIR = 0o040000; // Directory
    const S_IFREG = 0o100000; // Regular file
    const S_IFLNK = 0o120000; // Symbolic link

    // Permission bits (read-only)
    const DIR_MODE = S_IFDIR | 0o555;
    const FILE_MODE = S_IFREG | 0o444;
    const LINK_MODE = S_IFLNK | 0o777;

    const uid = process.getuid?.() ?? 0;
    const gid = process.getgid?.() ?? 0;

    return {
      // Initialization
      init: (cb) => {
        try {
          logger.debug('FUSE initialized');
          cb(0);
        } catch (err) {
          logger.error('Error in init callback', err);
          cb(POSIX_ERRORS.EIO);
        }
      },

      // Directory listing
      readdir: (path, cb) => {
        try {
          readdir(path, ctx)
            .then((entries) => {
              cb(0, entries.map((e) => e.name));
            })
            .catch((err) => {
              if (err instanceof LpgfsError) {
                cb(err.code);
              } else {
                // Unexpected error - handlers should wrap all errors, but log just in case
                logger.error(`readdir unexpected error: ${path}`, err);
                cb(POSIX_ERRORS.EIO);
              }
            });
        } catch (err) {
          logger.error(`readdir synchronous error: ${path}`, err);
          cb(POSIX_ERRORS.EIO);
        }
      },

      // File/directory attributes
      getattr: (path, cb) => {
        try {
          getattr(path, ctx)
            .then((stat) => {
              let mode: number;
              switch (stat.type) {
                case 'directory':
                  mode = DIR_MODE;
                  break;
                case 'file':
                  mode = FILE_MODE;
                  break;
                case 'symlink':
                  mode = LINK_MODE;
                  break;
                default:
                  mode = FILE_MODE;
              }

              const fuseStats: FuseStats = {
                mtime: stat.mtime ?? new Date(),
                atime: stat.atime ?? new Date(),
                ctime: stat.ctime ?? new Date(),
                size: stat.size ?? 0,
                mode,
                uid,
                gid,
                nlink: stat.type === 'directory' ? 2 : 1,
              };

              cb(0, fuseStats);
            })
            .catch((err) => {
              if (err instanceof LpgfsError) {
                cb(err.code);
              } else {
                // Unexpected error - handlers should wrap all errors, but log just in case
                logger.error(`getattr unexpected error: ${path}`, err);
                cb(POSIX_ERRORS.EIO);
              }
            });
        } catch (err) {
          logger.error(`getattr synchronous error: ${path}`, err);
          cb(POSIX_ERRORS.EIO);
        }
      },

      // Open file (no-op for read-only FS)
      open: (path, flags, cb) => {
        try {
          // Just return a dummy file descriptor
          cb(0, 42);
        } catch (err) {
          logger.error(`open error: ${path}`, err);
          cb(POSIX_ERRORS.EIO);
        }
      },

      // Open directory (no-op)
      opendir: (path, flags, cb) => {
        try {
          cb(0, 43);
        } catch (err) {
          logger.error(`opendir error: ${path}`, err);
          cb(POSIX_ERRORS.EIO);
        }
      },

      // Close file (no-op)
      release: (path, fd, cb) => {
        try {
          cb(0);
        } catch (err) {
          logger.error(`release error: ${path}`, err);
          cb(POSIX_ERRORS.EIO);
        }
      },

      // Close directory (no-op)
      releasedir: (path, fd, cb) => {
        try {
          cb(0);
        } catch (err) {
          logger.error(`releasedir error: ${path}`, err);
          cb(POSIX_ERRORS.EIO);
        }
      },

      // Read file contents
      read: (path, fd, buffer, length, position, cb) => {
        try {
          read(path, ctx, position, length)
            .then((result) => {
              if (position >= result.size) {
                // End of file
                cb(0);
                return;
              }

              const content = Buffer.from(result.content, 'utf8');
              content.copy(buffer);
              cb(content.length);
            })
            .catch((err) => {
              if (err instanceof LpgfsError) {
                cb(err.code);
              } else {
                // Unexpected error - handlers should wrap all errors, but log just in case
                logger.error(`read unexpected error: ${path}`, err);
                cb(POSIX_ERRORS.EIO);
              }
            });
        } catch (err) {
          logger.error(`read synchronous error: ${path}`, err);
          cb(POSIX_ERRORS.EIO);
        }
      },

      // Read symlink target
      readlink: (path, cb) => {
        try {
          readlink(path, ctx)
            .then((target) => {
              cb(0, target);
            })
            .catch((err) => {
              if (err instanceof LpgfsError) {
                cb(err.code);
              } else {
                // Unexpected error - handlers should wrap all errors, but log just in case
                logger.error(`readlink unexpected error: ${path}`, err);
                cb(POSIX_ERRORS.EIO);
              }
            });
        } catch (err) {
          logger.error(`readlink synchronous error: ${path}`, err);
          cb(POSIX_ERRORS.EIO);
        }
      },

      // Write operations - all return EROFS
      write: (_path, _fd, _buffer, _length, _position, cb) => {
        try {
          cb(POSIX_ERRORS.EROFS);
        } catch (err) {
          logger.error('write error', err);
          cb(POSIX_ERRORS.EIO);
        }
      },

      create: (_path, _mode, cb) => {
        try {
          cb(POSIX_ERRORS.EROFS);
        } catch (err) {
          logger.error('create error', err);
          cb(POSIX_ERRORS.EIO);
        }
      },

      truncate: (_path, _size, cb) => {
        try {
          cb(POSIX_ERRORS.EROFS);
        } catch (err) {
          logger.error('truncate error', err);
          cb(POSIX_ERRORS.EIO);
        }
      },

      ftruncate: (_path, _fd, _size, cb) => {
        try {
          cb(POSIX_ERRORS.EROFS);
        } catch (err) {
          logger.error('ftruncate error', err);
          cb(POSIX_ERRORS.EIO);
        }
      },

      unlink: (_path, cb) => {
        try {
          cb(POSIX_ERRORS.EROFS);
        } catch (err) {
          logger.error('unlink error', err);
          cb(POSIX_ERRORS.EIO);
        }
      },

      mkdir: (_path, _mode, cb) => {
        try {
          cb(POSIX_ERRORS.EROFS);
        } catch (err) {
          logger.error('mkdir error', err);
          cb(POSIX_ERRORS.EIO);
        }
      },

      rmdir: (_path, cb) => {
        try {
          cb(POSIX_ERRORS.EROFS);
        } catch (err) {
          logger.error('rmdir error', err);
          cb(POSIX_ERRORS.EIO);
        }
      },

      rename: (_src, _dest, cb) => {
        try {
          cb(POSIX_ERRORS.EROFS);
        } catch (err) {
          logger.error('rename error', err);
          cb(POSIX_ERRORS.EIO);
        }
      },

      symlink: (_target, _path, cb) => {
        try {
          cb(POSIX_ERRORS.EROFS);
        } catch (err) {
          logger.error('symlink error', err);
          cb(POSIX_ERRORS.EIO);
        }
      },

      link: (_src, _dest, cb) => {
        try {
          cb(POSIX_ERRORS.EROFS);
        } catch (err) {
          logger.error('link error', err);
          cb(POSIX_ERRORS.EIO);
        }
      },

      chmod: (_path, _mode, cb) => {
        try {
          cb(POSIX_ERRORS.EROFS);
        } catch (err) {
          logger.error('chmod error', err);
          cb(POSIX_ERRORS.EIO);
        }
      },

      chown: (_path, _uid, _gid, cb) => {
        try {
          cb(POSIX_ERRORS.EROFS);
        } catch (err) {
          logger.error('chown error', err);
          cb(POSIX_ERRORS.EIO);
        }
      },

      utimens: (_path, _atime, _mtime, cb) => {
        try {
          cb(POSIX_ERRORS.EROFS);
        } catch (err) {
          logger.error('utimens error', err);
          cb(POSIX_ERRORS.EIO);
        }
      },

      mknod: (_path, _mode, _dev, cb) => {
        try {
          cb(POSIX_ERRORS.EROFS);
        } catch (err) {
          logger.error('mknod error', err);
          cb(POSIX_ERRORS.EIO);
        }
      },

      setxattr: (_path, _name, _value, _position, _flags, cb) => {
        try {
          cb(POSIX_ERRORS.EROFS);
        } catch (err) {
          logger.error('setxattr error', err);
          cb(POSIX_ERRORS.EIO);
        }
      },

      removexattr: (_path, _name, cb) => {
        try {
          cb(POSIX_ERRORS.EROFS);
        } catch (err) {
          logger.error('removexattr error', err);
          cb(POSIX_ERRORS.EIO);
        }
      },
    };
  }
}

/**
 * Unmount a filesystem at the given path using fusermount.
 *
 * @param mountpoint - The mountpoint to unmount
 */
export async function unmount(mountpoint: string): Promise<void> {
  const absolutePath = resolve(mountpoint);

  // Check if path exists
  if (!existsSync(absolutePath)) {
    throw new Error(`Mountpoint does not exist: ${absolutePath}`);
  }

  // Check if it's a directory
  const stats = statSync(absolutePath);
  if (!stats.isDirectory()) {
    throw new Error(`Mountpoint is not a directory: ${absolutePath}`);
  }

  // Try to unmount using fusermount (Linux) or umount (macOS)
  const platform = process.platform;

  try {
    if (platform === 'darwin') {
      // macOS
      execSync(`umount "${absolutePath}"`, { stdio: 'pipe' });
    } else {
      // Linux and others
      execSync(`fusermount -u "${absolutePath}"`, { stdio: 'pipe' });
    }
  } catch (error) {
    const err = error as { stderr?: Buffer; message?: string };
    const stderr = err.stderr?.toString() ?? err.message ?? 'Unknown error';
    throw new Error(`Failed to unmount: ${stderr}`);
  }
}

/**
 * Create a new daemon instance.
 *
 * @param options - Daemon options
 * @returns Daemon instance
 */
export function createDaemon(options: DaemonOptions): Daemon {
  return new Daemon(options);
}
