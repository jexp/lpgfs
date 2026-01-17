/**
 * FUSE Handlers
 *
 * Implementation of FUSE filesystem operations for LPGFS.
 * Maps filesystem operations to database queries via path parsing.
 */

import type { DatabaseConnection } from '../db/connection.js';
import type { ConfigSchema, DirectoryEntry } from '../types/index.js';
import { DEFAULT_CONFIG } from '../types/index.js';
import { Cache } from '../cache/index.js';
import { getLabels } from '../db/queries.js';
import { parsePath, CONFIG_FILENAME } from '../core/path-parser.js';
import { ConfigParser } from '../config/parser.js';

/**
 * Context for FUSE handlers containing shared resources.
 */
export interface HandlerContext {
  /** Database connection */
  db: DatabaseConnection;
  /** Configuration schema */
  config: ConfigSchema;
  /** Cache instance */
  cache: Cache;
  /** Enable debug logging */
  debug?: boolean;
}

/**
 * Create a handler context with defaults.
 */
export function createHandlerContext(
  db: DatabaseConnection,
  options: {
    config?: ConfigSchema;
    cache?: Cache;
    debug?: boolean;
  } = {}
): HandlerContext {
  return {
    db,
    config: options.config ?? DEFAULT_CONFIG,
    cache: options.cache ?? new Cache(),
    debug: options.debug ?? false,
  };
}

/**
 * Read directory contents for a given path.
 *
 * Implements FUSE readdir() operation by:
 * 1. Parsing the path to determine context (root, label, node, etc.)
 * 2. Querying the appropriate database function
 * 3. Returning directory entries
 *
 * @param path - The filesystem path to read
 * @param ctx - Handler context with db, config, cache
 * @returns Array of directory entries (name + type)
 * @throws LpgfsError with ENOENT if path doesn't exist
 *
 * @example
 * // Read root directory
 * const entries = await readdir('/', ctx);
 * // Returns: [{ name: 'Person', type: 'directory' }, { name: '.lpgfs.yaml', type: 'file' }]
 */
export async function readdir(
  path: string,
  ctx: HandlerContext
): Promise<DirectoryEntry[]> {
  const pathContext = parsePath(path);

  if (ctx.debug) {
    console.log(`[lpgfs:fuse] readdir: ${path}`, pathContext);
  }

  switch (pathContext.type) {
    case 'root':
      return readdirRoot(ctx);

    default:
      // TODO: Implement other path types in subsequent tasks
      throw new Error(`readdir not implemented for path type: ${pathContext.type}`);
  }
}

/**
 * Read root directory contents.
 *
 * Returns:
 * - All node labels as directories
 * - .lpgfs.yaml configuration file
 *
 * @param ctx - Handler context
 * @returns Directory entries for root
 */
async function readdirRoot(ctx: HandlerContext): Promise<DirectoryEntry[]> {
  const entries: DirectoryEntry[] = [];

  // Get all labels from the database
  const labels = await getLabels(ctx.db, ctx.cache);

  // Add each label as a directory
  for (const label of labels) {
    entries.push({
      name: label,
      type: 'directory',
    });
  }

  // Add the config file
  entries.push({
    name: CONFIG_FILENAME,
    type: 'file',
  });

  return entries;
}

/**
 * Get the configuration file content as YAML.
 *
 * This is used for reading /.lpgfs.yaml
 *
 * @param ctx - Handler context
 * @returns YAML string of the current configuration
 */
export function getConfigContent(ctx: HandlerContext): string {
  return ConfigParser.toYaml(ctx.config);
}
