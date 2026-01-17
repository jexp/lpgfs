/**
 * FUSE Handlers
 *
 * Implementation of FUSE filesystem operations for LPGFS.
 * Maps filesystem operations to database queries via path parsing.
 */

import type { DatabaseConnection } from '../db/connection.js';
import type { ConfigSchema, DirectoryEntry, StatResult } from '../types/index.js';
import { DEFAULT_CONFIG, POSIX_ERRORS, LpgfsError } from '../types/index.js';
import { Cache } from '../cache/index.js';
import { getLabels, getNodesByLabel, getRelationshipTypes, getRelationships } from '../db/queries.js';
import { parsePath, CONFIG_FILENAME, PROPERTIES_FILENAME, extractTargetFromRelPropertiesFilename } from '../core/path-parser.js';
import type { Direction } from '../types/index.js';
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

    case 'label':
      return readdirLabel(pathContext.label!, ctx);

    case 'node':
      return readdirNode(pathContext.label!, pathContext.nodeName!, ctx);

    case 'reltype':
      return readdirReltype();

    case 'direction':
      return readdirDirection(
        pathContext.label!,
        pathContext.nodeName!,
        pathContext.relType!,
        pathContext.direction!,
        ctx
      );

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
 * Read label directory contents.
 *
 * Returns all nodes with the specified label as directories.
 * Node display names are determined by the naming configuration
 * (elementId or property strategy) with collision handling.
 *
 * @param label - The node label (e.g., "Person", "Company")
 * @param ctx - Handler context
 * @returns Directory entries for each node
 *
 * @example
 * // List all Person nodes
 * const entries = await readdirLabel('Person', ctx);
 * // Returns: [
 * //   { name: 'alice', type: 'directory' },
 * //   { name: 'bob', type: 'directory' },
 * //   { name: 'carol', type: 'directory' }
 * // ]
 */
async function readdirLabel(
  label: string,
  ctx: HandlerContext
): Promise<DirectoryEntry[]> {
  // Get all nodes for this label with display names
  const nodes = await getNodesByLabel(ctx.db, label, ctx.config, ctx.cache);

  // Return each node as a directory entry
  return nodes.map((node) => ({
    name: node.name,
    type: 'directory' as const,
  }));
}

/**
 * Read node directory contents.
 *
 * Returns:
 * - .properties.json file (node properties)
 * - All relationship type directories for this node
 *
 * @param label - The node label (e.g., "Person")
 * @param nodeName - The node display name (e.g., "alice")
 * @param ctx - Handler context
 * @returns Directory entries for the node
 *
 * @example
 * // Node alice has KNOWS and WORKS_AT relationships
 * const entries = await readdirNode('Person', 'alice', ctx);
 * // Returns: [
 * //   { name: '.properties.json', type: 'file' },
 * //   { name: 'KNOWS', type: 'directory' },
 * //   { name: 'WORKS_AT', type: 'directory' }
 * // ]
 */
async function readdirNode(
  label: string,
  nodeName: string,
  ctx: HandlerContext
): Promise<DirectoryEntry[]> {
  const entries: DirectoryEntry[] = [];

  // Add the properties file
  entries.push({
    name: PROPERTIES_FILENAME,
    type: 'file',
  });

  // Get all relationship types for this node
  const relTypes = await getRelationshipTypes(
    ctx.db,
    label,
    nodeName,
    ctx.config,
    ctx.cache
  );

  // Add each relationship type as a directory
  for (const relType of relTypes) {
    entries.push({
      name: relType,
      type: 'directory',
    });
  }

  return entries;
}

/**
 * Read relationship type directory contents.
 *
 * Always returns OUT and IN subdirectories representing
 * outgoing and incoming relationships of this type.
 *
 * @returns Directory entries for OUT and IN
 *
 * @example
 * // /Person/alice/KNOWS/ directory
 * const entries = readdirReltype();
 * // Returns: [
 * //   { name: 'OUT', type: 'directory' },
 * //   { name: 'IN', type: 'directory' }
 * // ]
 */
function readdirReltype(): DirectoryEntry[] {
  return [
    { name: 'OUT', type: 'directory' },
    { name: 'IN', type: 'directory' },
  ];
}

/**
 * Read direction directory contents (OUT or IN).
 *
 * Returns symlinks to target nodes and their .targetName.json property files.
 * When multiple relationships point to the same target, suffixes (_1, _2, etc.)
 * are added to distinguish them.
 *
 * @param label - The source node label (e.g., "Person")
 * @param nodeName - The source node display name (e.g., "alice")
 * @param relType - The relationship type (e.g., "KNOWS")
 * @param direction - The direction: 'OUT' or 'IN'
 * @param ctx - Handler context
 * @returns Directory entries with symlinks and property files
 *
 * @example
 * // Alice has one outgoing KNOWS relationship to james
 * const entries = await readdirDirection('Person', 'alice', 'KNOWS', 'OUT', ctx);
 * // Returns: [
 * //   { name: 'james', type: 'symlink' },
 * //   { name: '.james.json', type: 'file' }
 * // ]
 *
 * @example
 * // Alice has two outgoing KNOWS relationships to james (different rel instances)
 * const entries = await readdirDirection('Person', 'alice', 'KNOWS', 'OUT', ctx);
 * // Returns: [
 * //   { name: 'james', type: 'symlink' },
 * //   { name: '.james.json', type: 'file' },
 * //   { name: 'james_1', type: 'symlink' },
 * //   { name: '.james_1.json', type: 'file' }
 * // ]
 */
async function readdirDirection(
  label: string,
  nodeName: string,
  relType: string,
  direction: Direction,
  ctx: HandlerContext
): Promise<DirectoryEntry[]> {
  // Get all relationships of this type and direction from the source node
  const relationships = await getRelationships(
    ctx.db,
    label,
    nodeName,
    relType,
    direction,
    ctx.config,
    ctx.cache
  );

  if (relationships.length === 0) {
    return [];
  }

  // Track occurrences of each target name to handle multiple relationships to same target
  // Per section 8.1: Multiple relationships of the same type to the same target get suffixes (_1, _2, etc.)
  const targetNameCounts = new Map<string, number>();
  const entries: DirectoryEntry[] = [];

  for (const rel of relationships) {
    const baseName = rel.targetName;
    const count = targetNameCounts.get(baseName) || 0;
    targetNameCounts.set(baseName, count + 1);

    // First occurrence uses base name, subsequent ones get _1, _2, etc.
    const displayName = count === 0 ? baseName : `${baseName}_${count}`;

    // Add symlink to target node
    entries.push({
      name: displayName,
      type: 'symlink',
    });

    // Add relationship properties file (.targetName.json)
    entries.push({
      name: `.${displayName}.json`,
      type: 'file',
    });
  }

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

/**
 * Get file/directory attributes for a given path.
 *
 * Implements FUSE getattr() operation by:
 * 1. Parsing the path to determine context
 * 2. Validating the path exists (checking database where needed)
 * 3. Returning appropriate stat information
 *
 * @param path - The filesystem path to stat
 * @param ctx - Handler context with db, config, cache
 * @returns StatResult with type, size, and timestamps
 * @throws LpgfsError with ENOENT if path doesn't exist
 *
 * @example
 * // Stat a label directory
 * const stat = await getattr('/Person', ctx);
 * // Returns: { type: 'directory', mtime: Date, atime: Date, ctime: Date }
 *
 * @example
 * // Stat a node properties file
 * const stat = await getattr('/Person/alice/.properties.json', ctx);
 * // Returns: { type: 'file', size: <content_length>, mtime: Date, ... }
 *
 * @example
 * // Stat a symlink target
 * const stat = await getattr('/Person/alice/KNOWS/OUT/james', ctx);
 * // Returns: { type: 'symlink', mtime: Date, ... }
 */
export async function getattr(
  path: string,
  ctx: HandlerContext
): Promise<StatResult> {
  const pathContext = parsePath(path);

  if (ctx.debug) {
    console.log(`[lpgfs:fuse] getattr: ${path}`, pathContext);
  }

  const now = new Date();

  switch (pathContext.type) {
    case 'root':
      return { type: 'directory', mtime: now, atime: now, ctime: now };

    case 'label':
      return getattrLabel(pathContext.label!, ctx);

    case 'node':
      return getattrNode(pathContext.label!, pathContext.nodeName!, ctx);

    case 'reltype':
      return getattrReltype(
        pathContext.label!,
        pathContext.nodeName!,
        pathContext.relType!,
        ctx
      );

    case 'direction':
      return getattrDirection(
        pathContext.label!,
        pathContext.nodeName!,
        pathContext.relType!,
        pathContext.direction!,
        ctx
      );

    case 'target':
      return getattrTarget(
        pathContext.label!,
        pathContext.nodeName!,
        pathContext.relType!,
        pathContext.direction!,
        pathContext.targetName!,
        ctx
      );

    case 'properties':
      return getattrProperties(pathContext, ctx);

    default:
      throw new LpgfsError(`Unknown path type: ${pathContext.type}`, POSIX_ERRORS.ENOENT);
  }
}

/**
 * Get attributes for a label directory.
 * Validates that the label exists in the database.
 */
async function getattrLabel(
  label: string,
  ctx: HandlerContext
): Promise<StatResult> {
  const now = new Date();
  const labels = await getLabels(ctx.db, ctx.cache);

  if (!labels.includes(label)) {
    throw new LpgfsError(`Label not found: ${label}`, POSIX_ERRORS.ENOENT);
  }

  return { type: 'directory', mtime: now, atime: now, ctime: now };
}

/**
 * Get attributes for a node directory.
 * Validates that the node exists in the database.
 */
async function getattrNode(
  label: string,
  nodeName: string,
  ctx: HandlerContext
): Promise<StatResult> {
  const now = new Date();

  // First check if label exists
  const labels = await getLabels(ctx.db, ctx.cache);
  if (!labels.includes(label)) {
    throw new LpgfsError(`Label not found: ${label}`, POSIX_ERRORS.ENOENT);
  }

  // Then check if node exists
  const nodes = await getNodesByLabel(ctx.db, label, ctx.config, ctx.cache);
  const nodeExists = nodes.some((n) => n.name === nodeName);

  if (!nodeExists) {
    throw new LpgfsError(`Node not found: ${nodeName}`, POSIX_ERRORS.ENOENT);
  }

  return { type: 'directory', mtime: now, atime: now, ctime: now };
}

/**
 * Get attributes for a relationship type directory.
 * Validates that the node exists and has relationships of this type.
 */
async function getattrReltype(
  label: string,
  nodeName: string,
  relType: string,
  ctx: HandlerContext
): Promise<StatResult> {
  const now = new Date();

  // First validate the node exists
  const labels = await getLabels(ctx.db, ctx.cache);
  if (!labels.includes(label)) {
    throw new LpgfsError(`Label not found: ${label}`, POSIX_ERRORS.ENOENT);
  }

  const nodes = await getNodesByLabel(ctx.db, label, ctx.config, ctx.cache);
  const nodeExists = nodes.some((n) => n.name === nodeName);
  if (!nodeExists) {
    throw new LpgfsError(`Node not found: ${nodeName}`, POSIX_ERRORS.ENOENT);
  }

  // Check if the node has this relationship type
  const relTypes = await getRelationshipTypes(
    ctx.db,
    label,
    nodeName,
    ctx.config,
    ctx.cache
  );

  if (!relTypes.includes(relType)) {
    throw new LpgfsError(`Relationship type not found: ${relType}`, POSIX_ERRORS.ENOENT);
  }

  return { type: 'directory', mtime: now, atime: now, ctime: now };
}

/**
 * Get attributes for a direction directory (OUT or IN).
 * Validates the full path hierarchy exists.
 */
async function getattrDirection(
  label: string,
  nodeName: string,
  relType: string,
  direction: Direction,
  ctx: HandlerContext
): Promise<StatResult> {
  const now = new Date();

  // Validate direction value
  if (direction !== 'OUT' && direction !== 'IN') {
    throw new LpgfsError(`Invalid direction: ${direction}`, POSIX_ERRORS.ENOENT);
  }

  // Validate parent hierarchy (label, node, relType)
  await getattrReltype(label, nodeName, relType, ctx);

  return { type: 'directory', mtime: now, atime: now, ctime: now };
}

/**
 * Get attributes for a target symlink.
 * Validates the relationship target exists.
 */
async function getattrTarget(
  label: string,
  nodeName: string,
  relType: string,
  direction: Direction,
  targetName: string,
  ctx: HandlerContext
): Promise<StatResult> {
  const now = new Date();

  // Validate parent hierarchy
  await getattrDirection(label, nodeName, relType, direction, ctx);

  // Get relationships and check if target exists
  const relationships = await getRelationships(
    ctx.db,
    label,
    nodeName,
    relType,
    direction,
    ctx.config,
    ctx.cache
  );

  // Build the target name map (same logic as readdirDirection)
  const targetNameCounts = new Map<string, number>();
  let targetExists = false;

  for (const rel of relationships) {
    const baseName = rel.targetName;
    const count = targetNameCounts.get(baseName) || 0;
    targetNameCounts.set(baseName, count + 1);

    const displayName = count === 0 ? baseName : `${baseName}_${count}`;
    if (displayName === targetName) {
      targetExists = true;
      break;
    }
  }

  if (!targetExists) {
    throw new LpgfsError(`Target not found: ${targetName}`, POSIX_ERRORS.ENOENT);
  }

  return { type: 'symlink', mtime: now, atime: now, ctime: now };
}

/**
 * Get attributes for property files.
 * Handles .lpgfs.yaml, .properties.json, and .targetName.json files.
 */
async function getattrProperties(
  pathContext: ReturnType<typeof parsePath>,
  ctx: HandlerContext
): Promise<StatResult> {
  const now = new Date();

  // Config file at root
  if (pathContext.isConfigFile) {
    const content = getConfigContent(ctx);
    return {
      type: 'file',
      size: Buffer.byteLength(content, 'utf8'),
      mtime: now,
      atime: now,
      ctime: now,
    };
  }

  // Node properties file (.properties.json)
  if (pathContext.isPropertiesFile && pathContext.label && pathContext.nodeName) {
    // Validate the node exists
    await getattrNode(pathContext.label, pathContext.nodeName, ctx);

    // For now, we don't calculate actual size until read() is called
    // Return a placeholder size (FUSE allows this)
    return {
      type: 'file',
      size: 0,
      mtime: now,
      atime: now,
      ctime: now,
    };
  }

  // Relationship properties file (.targetName.json)
  if (pathContext.isRelPropertiesFile && pathContext.direction && pathContext.targetName) {
    // Validate the parent path
    await getattrDirection(
      pathContext.label!,
      pathContext.nodeName!,
      pathContext.relType!,
      pathContext.direction,
      ctx
    );

    // Get relationships and check if this target's property file exists
    const relationships = await getRelationships(
      ctx.db,
      pathContext.label!,
      pathContext.nodeName!,
      pathContext.relType!,
      pathContext.direction,
      ctx.config,
      ctx.cache
    );

    // Build the target name map
    const targetNameCounts = new Map<string, number>();
    let fileExists = false;

    for (const rel of relationships) {
      const baseName = rel.targetName;
      const count = targetNameCounts.get(baseName) || 0;
      targetNameCounts.set(baseName, count + 1);

      const displayName = count === 0 ? baseName : `${baseName}_${count}`;
      if (displayName === pathContext.targetName) {
        fileExists = true;
        break;
      }
    }

    if (!fileExists) {
      throw new LpgfsError(
        `Relationship properties file not found: .${pathContext.targetName}.json`,
        POSIX_ERRORS.ENOENT
      );
    }

    return {
      type: 'file',
      size: 0,
      mtime: now,
      atime: now,
      ctime: now,
    };
  }

  throw new LpgfsError('Properties file not found', POSIX_ERRORS.ENOENT);
}

/**
 * Resolve symlink target to relative path.
 *
 * Implements FUSE readlink() operation by:
 * 1. Parsing the path to get the symlink context
 * 2. Finding the target node's label and name
 * 3. Calculating the relative path from symlink to target
 *
 * @param path - The symlink path (e.g., /Person/alice/KNOWS/OUT/james)
 * @param ctx - Handler context with db, config, cache
 * @returns Relative path to target node directory
 * @throws LpgfsError with ENOENT if symlink doesn't exist
 *
 * @example
 * // Same-label relationship
 * const target = await readlink('/Person/alice/KNOWS/OUT/james', ctx);
 * // Returns: '../../../james'
 *
 * @example
 * // Cross-label relationship
 * const target = await readlink('/Person/alice/WORKS_AT/OUT/acme', ctx);
 * // Returns: '../../../../Company/acme'
 */
export async function readlink(
  path: string,
  ctx: HandlerContext
): Promise<string> {
  const pathContext = parsePath(path);

  if (ctx.debug) {
    console.log(`[lpgfs:fuse] readlink: ${path}`, pathContext);
  }

  // readlink only applies to target symlinks
  if (pathContext.type !== 'target') {
    throw new LpgfsError(`Not a symlink: ${path}`, POSIX_ERRORS.ENOENT);
  }

  // Validate required path components
  if (
    !pathContext.label ||
    !pathContext.nodeName ||
    !pathContext.relType ||
    !pathContext.direction ||
    !pathContext.targetName
  ) {
    throw new LpgfsError(`Invalid symlink path: ${path}`, POSIX_ERRORS.ENOENT);
  }

  // Get relationships to find target info
  const relationships = await getRelationships(
    ctx.db,
    pathContext.label,
    pathContext.nodeName,
    pathContext.relType,
    pathContext.direction,
    ctx.config,
    ctx.cache
  );

  if (relationships.length === 0) {
    throw new LpgfsError(`No relationships found for symlink: ${path}`, POSIX_ERRORS.ENOENT);
  }

  // Find the target relationship using the same suffix logic as readdirDirection and getattrTarget
  const targetNameCounts = new Map<string, number>();
  let targetRel = null;

  for (const rel of relationships) {
    const baseName = rel.targetName;
    const count = targetNameCounts.get(baseName) || 0;
    targetNameCounts.set(baseName, count + 1);

    const displayName = count === 0 ? baseName : `${baseName}_${count}`;
    if (displayName === pathContext.targetName) {
      targetRel = rel;
      break;
    }
  }

  if (!targetRel) {
    throw new LpgfsError(`Target not found: ${pathContext.targetName}`, POSIX_ERRORS.ENOENT);
  }

  // Build relative path based on whether same or different label
  // Symlink is at: /Label/node/RELTYPE/DIR/target
  // We need to navigate from the DIR directory to the target node directory

  const sourceLabel = pathContext.label;
  const targetLabel = targetRel.targetLabel;
  const targetName = targetRel.targetName;

  if (sourceLabel === targetLabel) {
    // Same label: go up 3 levels (to label dir) then to target
    // From /Label/node/RELTYPE/DIR/ → ../../.. → /Label/, then targetName → /Label/targetName
    return `../../../${targetName}`;
  } else {
    // Different label: go up 4 levels (to root) then to target label and name
    // From /Label/node/RELTYPE/DIR/ → ../../../.. → /, then Label/targetName → /Label/targetName
    return `../../../../${targetLabel}/${targetName}`;
  }
}
