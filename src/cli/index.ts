#!/usr/bin/env node
/**
 * LPGFS CLI
 *
 * Command-line interface for mounting the LPGFS virtual filesystem.
 *
 * Usage:
 *   lpgfs mount <mountpoint> [options]
 *   lpgfs unmount <mountpoint>
 *
 * See PRD section 12.7 for mount options.
 */

import { Command } from 'commander';
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { MountOptions } from '../types/index.js';
import { DEFAULT_MOUNT_OPTIONS } from '../types/index.js';

/**
 * Parsed mount command result.
 */
export interface ParsedMountCommand {
  mountpoint: string;
  options: MountOptions;
}

/**
 * Parsed unmount command result.
 */
export interface ParsedUnmountCommand {
  mountpoint: string;
}

/**
 * Result of CLI parsing.
 */
export type ParsedCommand =
  | { command: 'mount'; data: ParsedMountCommand }
  | { command: 'unmount'; data: ParsedUnmountCommand }
  | { command: 'help' }
  | { command: 'version' };

/**
 * Validates that the mountpoint exists and is a directory.
 * @param mountpoint - Path to validate
 * @throws Error if mountpoint is invalid
 */
export function validateMountpoint(mountpoint: string): string {
  const absolutePath = resolve(mountpoint);

  if (!existsSync(absolutePath)) {
    throw new Error(`Mountpoint does not exist: ${absolutePath}`);
  }

  const stats = statSync(absolutePath);
  if (!stats.isDirectory()) {
    throw new Error(`Mountpoint is not a directory: ${absolutePath}`);
  }

  return absolutePath;
}

/**
 * Creates and configures the CLI program.
 * @param exitOverride - If true, configure Commander to throw instead of exiting
 * @returns Configured Commander program
 */
export function createProgram(exitOverride = false): Command {
  const program = new Command();

  if (exitOverride) {
    // Configure Commander to throw errors instead of calling process.exit
    program.exitOverride();
    // Suppress output during testing
    program.configureOutput({
      writeOut: () => {},
      writeErr: () => {},
    });
  }

  program
    .name('lpgfs')
    .description(
      'LPGFS - Labeled Property Graph Filesystem\n' +
        'A read-only virtual filesystem presenting graph DB as native filesystem hierarchy.'
    )
    .version('0.1.0');

  program
    .command('mount')
    .description('Mount the LPGFS filesystem')
    .argument('<mountpoint>', 'Directory to mount the filesystem')
    .option(
      '--db <uri>',
      'Database connection URI',
      DEFAULT_MOUNT_OPTIONS.db
    )
    .option(
      '--config <path>',
      'Path to .lpgfs.yaml config file',
      DEFAULT_MOUNT_OPTIONS.config
    )
    .option(
      '--cache-ttl <seconds>',
      'Cache time-to-live in seconds',
      String(DEFAULT_MOUNT_OPTIONS.cacheTtl)
    )
    .option('--allow-other', 'Allow other users to access mount', false)
    .option('--debug', 'Enable verbose logging of FUSE operations', false)
    .option('--foreground', 'Run in foreground (do not daemonize)', false)
    .option('--user <name>', 'Database username')
    .option('--password <pass>', 'Database password')
    .action(() => {
      // Action is handled by parseArgs
    });

  program
    .command('unmount')
    .description('Unmount the LPGFS filesystem')
    .argument('<mountpoint>', 'Directory where the filesystem is mounted')
    .action(() => {
      // Action is handled by parseArgs
    });

  return program;
}

/**
 * Parse CLI arguments and return the parsed command.
 *
 * @param argv - Command line arguments (defaults to process.argv)
 * @returns Parsed command object
 * @throws Error if arguments are invalid
 */
export function parseArgs(argv?: string[]): ParsedCommand {
  // Check for help and version flags before parsing to avoid Commander's exit behavior
  const args = argv || process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    return { command: 'help' };
  }

  if (args.includes('--version') || args.includes('-V')) {
    return { command: 'version' };
  }

  // Check for no command before parsing to avoid Commander's help output
  if (args.length === 0) {
    throw new Error('Unknown command: (none). Use --help to see available commands.');
  }

  // Create program with exit override for testing
  const program = createProgram(true);

  try {
    program.parse(argv, { from: argv ? 'user' : 'node' });
  } catch (err) {
    // Commander throws CommanderError with code property
    const error = err as { code?: string; message?: string };
    if (error.code === 'commander.missingArgument') {
      throw new Error('Mountpoint is required. Usage: lpgfs mount <mountpoint> [options]');
    }
    if (error.code === 'commander.unknownCommand') {
      throw new Error(
        `Unknown command. Use --help to see available commands.`
      );
    }
    if (error.code === 'commander.missingMandatoryOptionValue') {
      throw new Error(error.message || 'Missing option value');
    }
    // Re-throw with cleaner message
    throw new Error(error.message || 'CLI parsing error');
  }

  // Get the parsed subcommand
  const parsedSubcommand = program.commands.find(
    (cmd) => cmd.args.length > 0 || cmd.processedArgs?.length > 0
  );

  if (!parsedSubcommand) {
    throw new Error(
      `Unknown command: (none). Use --help to see available commands.`
    );
  }

  const commandName = parsedSubcommand.name();

  if (commandName === 'mount') {
    return parseMountCommand(parsedSubcommand);
  }

  if (commandName === 'unmount') {
    return parseUnmountCommand(parsedSubcommand);
  }

  throw new Error(`Unknown command: ${commandName}`);
}

/**
 * Parse the mount command options.
 */
function parseMountCommand(cmd: Command): ParsedCommand {
  const mountpointArg = cmd.args[0];

  if (!mountpointArg) {
    throw new Error('Mountpoint is required. Usage: lpgfs mount <mountpoint> [options]');
  }

  const mountpoint = validateMountpoint(mountpointArg);
  const opts = cmd.opts();

  const options: MountOptions = {
    db: opts.db as string,
    config: opts.config as string | undefined,
    cacheTtl: parseInt(opts.cacheTtl as string, 10),
    allowOther: opts.allowOther as boolean,
    debug: opts.debug as boolean,
    foreground: opts.foreground as boolean,
    user: opts.user as string | undefined,
    password: opts.password as string | undefined,
  };

  // Validate cache TTL
  if (isNaN(options.cacheTtl!) || options.cacheTtl! < 0) {
    throw new Error('--cache-ttl must be a non-negative number');
  }

  return {
    command: 'mount',
    data: {
      mountpoint,
      options,
    },
  };
}

/**
 * Parse the unmount command options.
 */
function parseUnmountCommand(cmd: Command): ParsedCommand {
  const mountpointArg = cmd.args[0];

  if (!mountpointArg) {
    throw new Error('Mountpoint is required. Usage: lpgfs unmount <mountpoint>');
  }

  const mountpoint = resolve(mountpointArg);

  return {
    command: 'unmount',
    data: {
      mountpoint,
    },
  };
}

/**
 * Main CLI entry point.
 */
export async function main(): Promise<void> {
  try {
    const result = parseArgs();

    if (result.command === 'help') {
      createProgram().outputHelp();
      process.exit(0);
    }

    if (result.command === 'version') {
      console.log('0.1.0');
      process.exit(0);
    }

    if (result.command === 'mount') {
      const { mountpoint, options } = result.data;
      console.log(`Mounting LPGFS at ${mountpoint}`);
      console.log('Options:', JSON.stringify(options, null, 2));
      // TODO: Implement actual mount in task-028
      console.log(
        'Mount operation not yet implemented. See task-028 for FUSE mount/unmount.'
      );
    }

    if (result.command === 'unmount') {
      const { mountpoint } = result.data;
      console.log(`Unmounting LPGFS at ${mountpoint}`);
      // TODO: Implement actual unmount in task-028
      console.log(
        'Unmount operation not yet implemented. See task-028 for FUSE mount/unmount.'
      );
    }
  } catch (error) {
    if (error instanceof Error) {
      console.error(`Error: ${error.message}`);
    } else {
      console.error('An unexpected error occurred');
    }
    process.exit(1);
  }
}

// Run if this is the main module
// Using import.meta.url to detect if we're the entry point
const isMain =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  (process.argv[1].endsWith('/cli/index.js') ||
    process.argv[1].endsWith('/cli/index.ts'));

if (isMain) {
  main();
}
