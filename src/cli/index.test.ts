/**
 * Tests for CLI argument parsing
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, rmSync, existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parseArgs,
  validateMountpoint,
  createProgram,
} from './index.js';

// Create a temporary directory for testing
const testDir = join(tmpdir(), 'lpgfs-test-' + Date.now());

beforeAll(() => {
  if (!existsSync(testDir)) {
    mkdirSync(testDir, { recursive: true });
  }
});

afterAll(() => {
  if (existsSync(testDir)) {
    rmSync(testDir, { recursive: true });
  }
});

describe('validateMountpoint', () => {
  it('returns absolute path for valid directory', () => {
    const result = validateMountpoint(testDir);
    expect(result).toBe(testDir);
  });

  it('throws for non-existent path', () => {
    expect(() => validateMountpoint('/nonexistent/path/12345')).toThrow(
      'Mountpoint does not exist'
    );
  });

  it('throws for file path', () => {
    const filePath = join(testDir, 'testfile');
    writeFileSync(filePath, 'test');
    try {
      expect(() => validateMountpoint(filePath)).toThrow(
        'Mountpoint is not a directory'
      );
    } finally {
      unlinkSync(filePath);
    }
  });
});

describe('createProgram', () => {
  it('creates a program with mount and unmount commands', () => {
    const program = createProgram();
    expect(program.name()).toBe('lpgfs');

    const commands = program.commands.map((c) => c.name());
    expect(commands).toContain('mount');
    expect(commands).toContain('unmount');
  });

  it('mount command has all required options', () => {
    const program = createProgram();
    const mountCmd = program.commands.find((c) => c.name() === 'mount');
    expect(mountCmd).toBeDefined();

    const optionNames = mountCmd!.options.map((o) => o.long);
    expect(optionNames).toContain('--db');
    expect(optionNames).toContain('--config');
    expect(optionNames).toContain('--cache-ttl');
    expect(optionNames).toContain('--allow-other');
    expect(optionNames).toContain('--debug');
    expect(optionNames).toContain('--foreground');
    expect(optionNames).toContain('--user');
    expect(optionNames).toContain('--password');
  });
});

describe('parseArgs - mount command', () => {
  it('parses mount command with default options', () => {
    const result = parseArgs(['mount', testDir]);

    expect(result.command).toBe('mount');
    if (result.command === 'mount') {
      expect(result.data.mountpoint).toBe(testDir);
      expect(result.data.options.db).toBe('neo4j://localhost:7687');
      expect(result.data.options.config).toBe('./.lpgfs.yaml');
      expect(result.data.options.cacheTtl).toBe(10);
      expect(result.data.options.allowOther).toBe(false);
      expect(result.data.options.debug).toBe(false);
      expect(result.data.options.foreground).toBe(false);
    }
  });

  it('parses mount command with custom db URI', () => {
    const result = parseArgs(['mount', testDir, '--db', 'neo4j://myhost:7688']);

    expect(result.command).toBe('mount');
    if (result.command === 'mount') {
      expect(result.data.options.db).toBe('neo4j://myhost:7688');
    }
  });

  it('parses mount command with custom config path', () => {
    const result = parseArgs([
      'mount',
      testDir,
      '--config',
      '/path/to/config.yaml',
    ]);

    expect(result.command).toBe('mount');
    if (result.command === 'mount') {
      expect(result.data.options.config).toBe('/path/to/config.yaml');
    }
  });

  it('parses mount command with cache TTL', () => {
    const result = parseArgs(['mount', testDir, '--cache-ttl', '30']);

    expect(result.command).toBe('mount');
    if (result.command === 'mount') {
      expect(result.data.options.cacheTtl).toBe(30);
    }
  });

  it('parses mount command with boolean flags', () => {
    const result = parseArgs([
      'mount',
      testDir,
      '--allow-other',
      '--debug',
      '--foreground',
    ]);

    expect(result.command).toBe('mount');
    if (result.command === 'mount') {
      expect(result.data.options.allowOther).toBe(true);
      expect(result.data.options.debug).toBe(true);
      expect(result.data.options.foreground).toBe(true);
    }
  });

  it('parses mount command with database credentials', () => {
    const result = parseArgs([
      'mount',
      testDir,
      '--user',
      'admin',
      '--password',
      'secret',
    ]);

    expect(result.command).toBe('mount');
    if (result.command === 'mount') {
      expect(result.data.options.user).toBe('admin');
      expect(result.data.options.password).toBe('secret');
    }
  });

  it('parses mount command with all options combined', () => {
    const result = parseArgs([
      'mount',
      testDir,
      '--db',
      'neo4j://prod:7687',
      '--config',
      './prod.yaml',
      '--cache-ttl',
      '60',
      '--allow-other',
      '--debug',
      '--foreground',
      '--user',
      'neo4j',
      '--password',
      'password123',
    ]);

    expect(result.command).toBe('mount');
    if (result.command === 'mount') {
      expect(result.data.mountpoint).toBe(testDir);
      expect(result.data.options.db).toBe('neo4j://prod:7687');
      expect(result.data.options.config).toBe('./prod.yaml');
      expect(result.data.options.cacheTtl).toBe(60);
      expect(result.data.options.allowOther).toBe(true);
      expect(result.data.options.debug).toBe(true);
      expect(result.data.options.foreground).toBe(true);
      expect(result.data.options.user).toBe('neo4j');
      expect(result.data.options.password).toBe('password123');
    }
  });

  it('throws for mount without mountpoint', () => {
    expect(() => parseArgs(['mount'])).toThrow('Mountpoint is required');
  });

  it('throws for mount with invalid mountpoint', () => {
    expect(() => parseArgs(['mount', '/nonexistent/path/12345'])).toThrow(
      'Mountpoint does not exist'
    );
  });

  it('throws for invalid cache TTL', () => {
    expect(() =>
      parseArgs(['mount', testDir, '--cache-ttl', 'invalid'])
    ).toThrow('--cache-ttl must be a non-negative number');
  });

  it('throws for negative cache TTL', () => {
    expect(() => parseArgs(['mount', testDir, '--cache-ttl', '-5'])).toThrow(
      '--cache-ttl must be a non-negative number'
    );
  });
});

describe('parseArgs - unmount command', () => {
  it('parses unmount command', () => {
    const result = parseArgs(['unmount', testDir]);

    expect(result.command).toBe('unmount');
    if (result.command === 'unmount') {
      expect(result.data.mountpoint).toBe(testDir);
    }
  });

  it('throws for unmount without mountpoint', () => {
    expect(() => parseArgs(['unmount'])).toThrow('Mountpoint is required');
  });
});

describe('parseArgs - help and version', () => {
  it('parses help flag', () => {
    const result = parseArgs(['--help']);
    expect(result.command).toBe('help');
  });

  it('parses short help flag', () => {
    const result = parseArgs(['-h']);
    expect(result.command).toBe('help');
  });

  it('parses version flag', () => {
    const result = parseArgs(['--version']);
    expect(result.command).toBe('version');
  });

  it('parses short version flag', () => {
    const result = parseArgs(['-V']);
    expect(result.command).toBe('version');
  });

  it('parses help with command', () => {
    const result = parseArgs(['mount', '--help']);
    expect(result.command).toBe('help');
  });
});

describe('parseArgs - error handling', () => {
  it('throws for unknown command', () => {
    expect(() => parseArgs(['invalid-command'])).toThrow('Unknown command');
  });

  it('throws for no command', () => {
    expect(() => parseArgs([])).toThrow('Unknown command');
  });
});
