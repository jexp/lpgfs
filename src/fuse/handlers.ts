/**
 * FUSE Handlers
 *
 * Implementation of FUSE filesystem operations for LPGFS.
 * Maps filesystem operations to database queries via path parsing.
 */

import type { DatabaseConnection } from "../db/connection.js";
import type {
  ConfigSchema,
  DirectoryEntry,
  MarkdownPathContext,
  StatResult,
} from "../types/index.js";
import {
  DEFAULT_CONFIG,
  DEFAULT_MARKDOWN_MODE_CONFIG,
  POSIX_ERRORS,
  LpgfsError,
} from "../types/index.js";
import { Cache, cacheKey } from "../cache/index.js";
import {
  getLabels,
  getNodesByLabel,
  getRelationshipTypes,
  getRelationships,
  getNodeProperties,
  getRelationshipProperties,
  getNodeForMarkdown,
  groupRelationshipsForMarkdown,
} from "../db/queries.js";
import {
  parsePath,
  CONFIG_FILENAME,
  PROPERTIES_FILENAME,
  extractTargetFromRelPropertiesFilename,
} from "../core/path-parser.js";
import { parseMarkdownPath } from "../core/markdown-path-parser.js";
import type { Direction } from "../types/index.js";
import { ConfigParser } from "../config/parser.js";
import { Logger, createLogger } from "../core/logger.js";
import {
  renderNodeMarkdown,
  type MarkdownRelationshipLink,
} from "../markdown/renderer.js";
import { propertyFallbackFieldResolver } from "../markdown/fields.js";

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
  /** Logger instance */
  logger: Logger;
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
    logger?: Logger;
  } = {},
): HandlerContext {
  const debug = options.debug ?? false;
  return {
    db,
    config: options.config ?? DEFAULT_CONFIG,
    cache: options.cache ?? new Cache(),
    debug,
    logger:
      options.logger ?? createLogger({ enabled: debug, prefix: "lpgfs:fuse" }),
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
  ctx: HandlerContext,
): Promise<DirectoryEntry[]> {
  const timer = ctx.logger.time();

  try {
    if (ctx.config.mode.type === "markdown") {
      const result = await readdirMarkdown(path, ctx);
      timer.end(`readdir: ${path}`, { entries: result.length });
      return result;
    }

    const pathContext = parsePath(path);
    ctx.logger.debug(`readdir: ${path}`, { type: pathContext.type });

    let result: DirectoryEntry[];

    switch (pathContext.type) {
      case "root":
        result = await readdirRoot(ctx);
        break;

      case "label":
        result = await readdirLabel(pathContext.label!, ctx);
        break;

      case "node":
        result = await readdirNode(
          pathContext.label!,
          pathContext.nodeName!,
          ctx,
        );
        break;

      case "reltype":
        result = readdirReltype();
        break;

      case "direction":
        result = await readdirDirection(
          pathContext.label!,
          pathContext.nodeName!,
          pathContext.relType!,
          pathContext.direction!,
          ctx,
        );
        break;

      default:
        throw new LpgfsError(
          `readdir not implemented for path type: ${pathContext.type}`,
          POSIX_ERRORS.ENOENT,
        );
    }

    timer.end(`readdir: ${path}`, { entries: result.length });
    return result;
  } catch (error) {
    if (error instanceof LpgfsError) {
      ctx.logger.debug(`readdir: ${path} -> error`, {
        code: error.code,
        message: error.message,
      });
      throw error;
    }
    ctx.logger.error(`readdir: ${path}`, error);
    throw new LpgfsError(
      `readdir failed: ${(error as Error).message}`,
      POSIX_ERRORS.EIO,
    );
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
      type: "directory",
    });
  }

  // Add the config file
  entries.push({
    name: CONFIG_FILENAME,
    type: "file",
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
  ctx: HandlerContext,
): Promise<DirectoryEntry[]> {
  // Get all nodes for this label with display names
  const nodes = await getNodesByLabel(ctx.db, label, ctx.config, ctx.cache);

  // Return each node as a directory entry
  return nodes.map((node) => ({
    name: node.name,
    type: "directory" as const,
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
  ctx: HandlerContext,
): Promise<DirectoryEntry[]> {
  const entries: DirectoryEntry[] = [];

  // Add the properties file
  entries.push({
    name: PROPERTIES_FILENAME,
    type: "file",
  });

  // Get all relationship types for this node
  const relTypes = await getRelationshipTypes(
    ctx.db,
    label,
    nodeName,
    ctx.config,
    ctx.cache,
  );

  // Add each relationship type as a directory
  for (const relType of relTypes) {
    entries.push({
      name: relType,
      type: "directory",
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
    { name: "OUT", type: "directory" },
    { name: "IN", type: "directory" },
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
  ctx: HandlerContext,
): Promise<DirectoryEntry[]> {
  // Get all relationships of this type and direction from the source node
  const relationships = await getRelationships(
    ctx.db,
    label,
    nodeName,
    relType,
    direction,
    ctx.config,
    ctx.cache,
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
      type: "symlink",
    });

    // Add relationship properties file (.targetName.json)
    entries.push({
      name: `.${displayName}.json`,
      type: "file",
    });
  }

  return entries;
}

// =============================================================================
// Markdown Mode Handlers
//
// Active when ctx.config.mode.type === 'markdown'. Dispatches via
// parseMarkdownPath instead of the classic path-parser. Generated files
// (/index.md, /log.md, /<Label>/index.md) are not yet implemented, so
// their path-context types (root-index/root-log/label-index) always
// throw ENOENT here for now.
// =============================================================================

/**
 * Validates that a label exists in the database and, if
 * `mode.markdown.labels` is set, that it is included in the allow-list.
 * Throws LpgfsError(ENOENT) otherwise.
 */
async function assertLabelAllowed(
  label: string,
  ctx: HandlerContext,
): Promise<void> {
  const labels = await getLabels(ctx.db, ctx.cache);
  if (!labels.includes(label)) {
    throw new LpgfsError(`Label not found: ${label}`, POSIX_ERRORS.ENOENT);
  }

  const allowList = ctx.config.mode.markdown?.labels;
  if (allowList && allowList.length > 0 && !allowList.includes(label)) {
    throw new LpgfsError(`Label not found: ${label}`, POSIX_ERRORS.ENOENT);
  }
}

/**
 * Root directory listing for markdown mode: one directory per rendered
 * label (respecting mode.markdown.labels when set).
 */
async function readdirMarkdownRoot(
  ctx: HandlerContext,
): Promise<DirectoryEntry[]> {
  const labels = await getLabels(ctx.db, ctx.cache);
  const allowList = ctx.config.mode.markdown?.labels;
  const rendered =
    allowList && allowList.length > 0
      ? labels.filter((label) => allowList.includes(label))
      : labels;

  return rendered.map((label) => ({ name: label, type: "directory" }));
}

/**
 * Label directory listing for markdown mode: one `<name>.md` file per node.
 */
async function readdirMarkdownLabel(
  label: string,
  ctx: HandlerContext,
): Promise<DirectoryEntry[]> {
  await assertLabelAllowed(label, ctx);
  const nodes = await getNodesByLabel(ctx.db, label, ctx.config, ctx.cache);
  return nodes.map((node) => ({ name: `${node.name}.md`, type: "file" }));
}

/**
 * Markdown-mode readdir dispatch.
 */
async function readdirMarkdown(
  path: string,
  ctx: HandlerContext,
): Promise<DirectoryEntry[]> {
  const pathContext = parseMarkdownPath(path);
  ctx.logger.debug(`readdir(markdown): ${path}`, {
    type: pathContext.type,
  });

  switch (pathContext.type) {
    case "root":
      return readdirMarkdownRoot(ctx);
    case "label":
      return readdirMarkdownLabel(pathContext.label!, ctx);
    default:
      throw new LpgfsError(`Not a directory: ${path}`, POSIX_ERRORS.ENOENT);
  }
}

/**
 * Renders (and caches, keyed by node elementId) a single node's markdown
 * file. Shared by getattrMarkdown (for the size) and readMarkdown (which
 * relies on this hitting the cache set up by the preceding getattr call,
 * so the node is never rendered twice for one open/read cycle).
 */
async function renderMarkdownNode(
  label: string,
  nodeName: string,
  ctx: HandlerContext,
): Promise<string> {
  await assertLabelAllowed(label, ctx);

  const nodes = await getNodesByLabel(ctx.db, label, ctx.config, ctx.cache);
  const node = nodes.find((n) => n.name === nodeName);
  if (!node) {
    throw new LpgfsError(
      `Node not found: ${label}/${nodeName}`,
      POSIX_ERRORS.ENOENT,
    );
  }

  const key = cacheKey.markdown(node.elementId);
  const cached = ctx.cache.get<string>(key);
  if (cached !== undefined) {
    return cached;
  }

  const nodeData = await getNodeForMarkdown(ctx.db, node.elementId, ctx.cache);
  if (!nodeData) {
    throw new LpgfsError(
      `Node not found: ${label}/${nodeName}`,
      POSIX_ERRORS.ENOENT,
    );
  }

  const markdownConfig =
    ctx.config.mode.markdown ?? DEFAULT_MARKDOWN_MODE_CONFIG;
  const groups = groupRelationshipsForMarkdown(nodeData.relationships, ctx.config);
  const relationships: MarkdownRelationshipLink[] = groups.flatMap(
    (group) => group.links,
  );

  const content = renderNodeMarkdown({
    labels: nodeData.labels,
    properties: nodeData.properties,
    relationships,
    config: markdownConfig,
    fieldResolver: propertyFallbackFieldResolver,
  });

  ctx.cache.set(key, content);
  return content;
}

/**
 * Markdown-mode getattr dispatch.
 */
async function getattrMarkdown(
  path: string,
  ctx: HandlerContext,
): Promise<StatResult> {
  const pathContext = parseMarkdownPath(path);
  const now = new Date();

  switch (pathContext.type) {
    case "root":
      return { type: "directory", mtime: now, atime: now, ctime: now };

    case "label":
      await assertLabelAllowed(pathContext.label!, ctx);
      return { type: "directory", mtime: now, atime: now, ctime: now };

    case "node": {
      const content = await renderMarkdownNode(
        pathContext.label!,
        pathContext.nodeName!,
        ctx,
      );
      return {
        type: "file",
        size: Buffer.byteLength(content, "utf8"),
        mtime: now,
        atime: now,
        ctime: now,
      };
    }

    default:
      throw new LpgfsError(
        `Not implemented in markdown mode: ${path}`,
        POSIX_ERRORS.ENOENT,
      );
  }
}

/**
 * Applies a read offset/length window to already-rendered content,
 * mirroring the classic read() slicing behavior.
 */
function sliceMarkdownContent(
  content: string,
  offset: number,
  length?: number,
): ReadResult {
  const totalSize = Buffer.byteLength(content, "utf8");

  if (offset <= 0 && length === undefined) {
    return { content, size: totalSize };
  }

  const contentBuffer = Buffer.from(content, "utf8");
  const end =
    length !== undefined ? Math.min(offset + length, totalSize) : totalSize;
  const sliced = contentBuffer.subarray(offset, end);

  return { content: sliced.toString("utf8"), size: totalSize };
}

/**
 * Markdown-mode read dispatch. Only `/<Label>/<name>.md` node files are
 * readable; root/label directories and the not-yet-implemented generated
 * files (root-index/root-log/label-index) are rejected with ENOENT.
 */
async function readMarkdown(
  path: string,
  ctx: HandlerContext,
  offset: number,
  length: number | undefined,
): Promise<ReadResult> {
  const pathContext: MarkdownPathContext = parseMarkdownPath(path);

  if (pathContext.type !== "node") {
    throw new LpgfsError(`Not a file: ${path}`, POSIX_ERRORS.ENOENT);
  }

  const content = await renderMarkdownNode(
    pathContext.label!,
    pathContext.nodeName!,
    ctx,
  );
  return sliceMarkdownContent(content, offset, length);
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
  ctx: HandlerContext,
): Promise<StatResult> {
  const timer = ctx.logger.time();

  try {
    if (ctx.config.mode.type === "markdown") {
      const result = await getattrMarkdown(path, ctx);
      timer.end(`getattr: ${path}`, { type: result.type });
      return result;
    }

    const pathContext = parsePath(path);
    ctx.logger.debug(`getattr: ${path}`, { type: pathContext.type });

    const now = new Date();
    let result: StatResult;

    switch (pathContext.type) {
      case "root":
        result = { type: "directory", mtime: now, atime: now, ctime: now };
        break;

      case "label":
        result = await getattrLabel(pathContext.label!, ctx);
        break;

      case "node":
        result = await getattrNode(
          pathContext.label!,
          pathContext.nodeName!,
          ctx,
        );
        break;

      case "reltype":
        result = await getattrReltype(
          pathContext.label!,
          pathContext.nodeName!,
          pathContext.relType!,
          ctx,
        );
        break;

      case "direction":
        result = await getattrDirection(
          pathContext.label!,
          pathContext.nodeName!,
          pathContext.relType!,
          pathContext.direction!,
          ctx,
        );
        break;

      case "target":
        result = await getattrTarget(
          pathContext.label!,
          pathContext.nodeName!,
          pathContext.relType!,
          pathContext.direction!,
          pathContext.targetName!,
          ctx,
        );
        break;

      case "properties":
        result = await getattrProperties(pathContext, ctx);
        break;

      default:
        throw new LpgfsError(
          `Unknown path type: ${pathContext.type}`,
          POSIX_ERRORS.ENOENT,
        );
    }

    timer.end(`getattr: ${path}`, { type: result.type });
    return result;
  } catch (error) {
    if (error instanceof LpgfsError) {
      ctx.logger.debug(`getattr: ${path} -> error`, {
        code: error.code,
        message: error.message,
      });
      throw error;
    }
    ctx.logger.error(`getattr: ${path}`, error);
    throw new LpgfsError(
      `getattr failed: ${(error as Error).message}`,
      POSIX_ERRORS.EIO,
    );
  }
}

/**
 * Get attributes for a label directory.
 * Validates that the label exists in the database.
 */
async function getattrLabel(
  label: string,
  ctx: HandlerContext,
): Promise<StatResult> {
  const now = new Date();
  const labels = await getLabels(ctx.db, ctx.cache);

  if (!labels.includes(label)) {
    throw new LpgfsError(`Label not found: ${label}`, POSIX_ERRORS.ENOENT);
  }

  return { type: "directory", mtime: now, atime: now, ctime: now };
}

/**
 * Get attributes for a node directory.
 * Validates that the node exists in the database.
 */
async function getattrNode(
  label: string,
  nodeName: string,
  ctx: HandlerContext,
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

  return { type: "directory", mtime: now, atime: now, ctime: now };
}

/**
 * Get attributes for a relationship type directory.
 * Validates that the node exists and has relationships of this type.
 */
async function getattrReltype(
  label: string,
  nodeName: string,
  relType: string,
  ctx: HandlerContext,
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
    ctx.cache,
  );

  if (!relTypes.includes(relType)) {
    throw new LpgfsError(
      `Relationship type not found: ${relType}`,
      POSIX_ERRORS.ENOENT,
    );
  }

  return { type: "directory", mtime: now, atime: now, ctime: now };
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
  ctx: HandlerContext,
): Promise<StatResult> {
  const now = new Date();

  // Validate direction value
  if (direction !== "OUT" && direction !== "IN") {
    throw new LpgfsError(
      `Invalid direction: ${direction}`,
      POSIX_ERRORS.ENOENT,
    );
  }

  // Validate parent hierarchy (label, node, relType)
  await getattrReltype(label, nodeName, relType, ctx);

  return { type: "directory", mtime: now, atime: now, ctime: now };
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
  ctx: HandlerContext,
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
    ctx.cache,
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
    throw new LpgfsError(
      `Target not found: ${targetName}`,
      POSIX_ERRORS.ENOENT,
    );
  }

  return { type: "symlink", mtime: now, atime: now, ctime: now };
}

/**
 * Get attributes for property files.
 * Handles .lpgfs.yaml, .properties.json, and .targetName.json files.
 */
async function getattrProperties(
  pathContext: ReturnType<typeof parsePath>,
  ctx: HandlerContext,
): Promise<StatResult> {
  const now = new Date();

  // Config file at root
  if (pathContext.isConfigFile) {
    const content = getConfigContent(ctx);
    return {
      type: "file",
      size: Buffer.byteLength(content, "utf8"),
      mtime: now,
      atime: now,
      ctime: now,
    };
  }

  // Node properties file (.properties.json)
  if (
    pathContext.isPropertiesFile &&
    pathContext.label &&
    pathContext.nodeName
  ) {
    // Get node properties to calculate actual file size
    const content = await readNodeProperties(
      pathContext.label,
      pathContext.nodeName,
      ctx,
    );

    return {
      type: "file",
      size: Buffer.byteLength(content, "utf8"),
      mtime: now,
      atime: now,
      ctime: now,
    };
  }

  // Relationship properties file (.targetName.json)
  if (
    pathContext.isRelPropertiesFile &&
    pathContext.direction &&
    pathContext.targetName
  ) {
    // Validate the parent path
    await getattrDirection(
      pathContext.label!,
      pathContext.nodeName!,
      pathContext.relType!,
      pathContext.direction,
      ctx,
    );

    // Get relationships and check if this target's property file exists
    const relationships = await getRelationships(
      ctx.db,
      pathContext.label!,
      pathContext.nodeName!,
      pathContext.relType!,
      pathContext.direction,
      ctx.config,
      ctx.cache,
    );

    // Get the actual content to calculate size
    const content = await readRelationshipProperties(
      pathContext.label!,
      pathContext.nodeName!,
      pathContext.relType!,
      pathContext.direction,
      pathContext.targetName,
      ctx,
    );

    return {
      type: "file",
      size: Buffer.byteLength(content, "utf8"),
      mtime: now,
      atime: now,
      ctime: now,
    };
  }

  throw new LpgfsError("Properties file not found", POSIX_ERRORS.ENOENT);
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
  ctx: HandlerContext,
): Promise<string> {
  const pathContext = parsePath(path);
  const timer = ctx.logger.time();

  ctx.logger.debug(`readlink: ${path}`, { type: pathContext.type });

  try {
    // readlink only applies to target symlinks
    if (pathContext.type !== "target") {
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
      throw new LpgfsError(
        `Invalid symlink path: ${path}`,
        POSIX_ERRORS.ENOENT,
      );
    }

    // Get relationships to find target info
    const relationships = await getRelationships(
      ctx.db,
      pathContext.label,
      pathContext.nodeName,
      pathContext.relType,
      pathContext.direction,
      ctx.config,
      ctx.cache,
    );

    if (relationships.length === 0) {
      throw new LpgfsError(
        `No relationships found for symlink: ${path}`,
        POSIX_ERRORS.ENOENT,
      );
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
      throw new LpgfsError(
        `Target not found: ${pathContext.targetName}`,
        POSIX_ERRORS.ENOENT,
      );
    }

    // Build relative path based on whether same or different label
    // Symlink is at: /Label/node/RELTYPE/DIR/target
    // We need to navigate from the DIR directory to the target node directory

    const sourceLabel = pathContext.label;
    const targetLabel = targetRel.targetLabel;
    const targetName = targetRel.targetName;

    let result: string;
    if (sourceLabel === targetLabel) {
      // Same label: go up 3 levels (to label dir) then to target
      // From /Label/node/RELTYPE/DIR/ → ../../.. → /Label/, then targetName → /Label/targetName
      result = `../../../${targetName}`;
    } else {
      // Different label: go up 4 levels (to root) then to target label and name
      // From /Label/node/RELTYPE/DIR/ → ../../../.. → /, then Label/targetName → /Label/targetName
      result = `../../../../${targetLabel}/${targetName}`;
    }

    timer.end(`readlink: ${path}`, { target: result });
    return result;
  } catch (error) {
    if (error instanceof LpgfsError) {
      ctx.logger.debug(`readlink: ${path} -> error`, {
        code: error.code,
        message: error.message,
      });
      throw error;
    }
    ctx.logger.error(`readlink: ${path}`, error);
    throw new LpgfsError(
      `readlink failed: ${(error as Error).message}`,
      POSIX_ERRORS.EIO,
    );
  }
}

/**
 * Read result containing file content and metadata.
 */
export interface ReadResult {
  /** The file content as a string */
  content: string;
  /** Total size of the content in bytes */
  size: number;
}

/**
 * Read file contents.
 *
 * Implements FUSE read() operation by:
 * 1. Parsing the path to determine file type
 * 2. Fetching appropriate data from database
 * 3. Returning JSON content for property files
 *
 * Currently supports:
 * - /.lpgfs.yaml - Configuration file
 * - /Label/nodeName/.properties.json - Node properties
 *
 * @param path - The file path to read
 * @param ctx - Handler context with db, config, cache
 * @param offset - Byte offset to start reading from (default: 0)
 * @param length - Number of bytes to read (default: entire file)
 * @returns ReadResult with content string and total size
 * @throws LpgfsError with ENOENT if file doesn't exist
 *
 * @example
 * // Read node properties
 * const result = await read('/Person/alice/.properties.json', ctx);
 * // Returns: { content: '{"_elementId":"4:abc:0","username":"alice",...}', size: ... }
 *
 * @example
 * // Partial read with offset
 * const result = await read('/Person/alice/.properties.json', ctx, 10, 50);
 * // Returns 50 bytes starting at offset 10
 */
export async function read(
  path: string,
  ctx: HandlerContext,
  offset: number = 0,
  length?: number,
): Promise<ReadResult> {
  const timer = ctx.logger.time();

  try {
    if (ctx.config.mode.type === "markdown") {
      const result = await readMarkdown(path, ctx, offset, length);
      timer.end(`read: ${path}`, {
        size: result.size,
        returned: result.content.length,
      });
      return result;
    }

    const pathContext = parsePath(path);
    ctx.logger.debug(`read: ${path}`, {
      offset,
      length,
      type: pathContext.type,
    });

    // Only property files can be read
    if (pathContext.type !== "properties") {
      throw new LpgfsError(`Not a file: ${path}`, POSIX_ERRORS.ENOENT);
    }

    let content: string;

    // Config file (/.lpgfs.yaml)
    if (pathContext.isConfigFile) {
      content = getConfigContent(ctx);
    }
    // Node properties file (.properties.json)
    else if (
      pathContext.isPropertiesFile &&
      pathContext.label &&
      pathContext.nodeName
    ) {
      content = await readNodeProperties(
        pathContext.label,
        pathContext.nodeName,
        ctx,
      );
    }
    // Relationship properties file (.targetName.json)
    else if (
      pathContext.isRelPropertiesFile &&
      pathContext.label &&
      pathContext.nodeName &&
      pathContext.relType &&
      pathContext.direction &&
      pathContext.targetName
    ) {
      content = await readRelationshipProperties(
        pathContext.label,
        pathContext.nodeName,
        pathContext.relType,
        pathContext.direction,
        pathContext.targetName,
        ctx,
      );
    }
    // Unknown file type
    else {
      throw new LpgfsError(`Unknown file type: ${path}`, POSIX_ERRORS.ENOENT);
    }

    // Calculate total size in bytes
    const totalSize = Buffer.byteLength(content, "utf8");

    // Handle offset and length for partial reads
    if (offset > 0 || length !== undefined) {
      const contentBuffer = Buffer.from(content, "utf8");
      const end =
        length !== undefined ? Math.min(offset + length, totalSize) : totalSize;
      const sliced = contentBuffer.subarray(offset, end);
      content = sliced.toString("utf8");
    }

    timer.end(`read: ${path}`, { size: totalSize, returned: content.length });
    return {
      content,
      size: totalSize,
    };
  } catch (error) {
    if (error instanceof LpgfsError) {
      ctx.logger.debug(`read: ${path} -> error`, {
        code: error.code,
        message: error.message,
      });
      throw error;
    }
    ctx.logger.error(`read: ${path}`, error);
    throw new LpgfsError(
      `read failed: ${(error as Error).message}`,
      POSIX_ERRORS.EIO,
    );
  }
}

/**
 * Read node properties and return as JSON string.
 *
 * @param label - The node label (e.g., "Person")
 * @param nodeName - The node display name (e.g., "alice")
 * @param ctx - Handler context
 * @returns JSON string with _elementId and all node properties
 * @throws LpgfsError with ENOENT if node doesn't exist
 */
async function readNodeProperties(
  label: string,
  nodeName: string,
  ctx: HandlerContext,
): Promise<string> {
  const props = await getNodeProperties(
    ctx.db,
    label,
    nodeName,
    ctx.config,
    ctx.cache,
  );

  if (props === null) {
    throw new LpgfsError(
      `Node not found: ${label}/${nodeName}`,
      POSIX_ERRORS.ENOENT,
    );
  }

  // Return formatted JSON with 2-space indentation for readability
  return JSON.stringify(props, null, 2);
}

/**
 * Read relationship properties and return as JSON string.
 *
 * Per PRD section 5.2.4 (Canonical Ownership):
 * - OUT side: Returns full properties { _elementId, ...properties }
 * - IN side: Returns reference { _ref: relElementId } pointing to canonical location
 *
 * @param label - The source node label (e.g., "Person")
 * @param nodeName - The source node display name (e.g., "alice")
 * @param relType - The relationship type (e.g., "KNOWS")
 * @param direction - The direction: 'OUT' or 'IN'
 * @param targetName - The target display name including any suffix (e.g., "james" or "james_1")
 * @param ctx - Handler context
 * @returns JSON string with properties (OUT) or _ref (IN)
 * @throws LpgfsError with ENOENT if relationship doesn't exist
 */
async function readRelationshipProperties(
  label: string,
  nodeName: string,
  relType: string,
  direction: Direction,
  targetName: string,
  ctx: HandlerContext,
): Promise<string> {
  // Get relationships to find the matching one
  const relationships = await getRelationships(
    ctx.db,
    label,
    nodeName,
    relType,
    direction,
    ctx.config,
    ctx.cache,
  );

  if (relationships.length === 0) {
    throw new LpgfsError(
      `No relationships found: ${label}/${nodeName}/${relType}/${direction}`,
      POSIX_ERRORS.ENOENT,
    );
  }

  // Find the relationship using the same suffix logic as readdirDirection and getattrTarget
  const targetNameCounts = new Map<string, number>();
  let matchedRel = null;

  for (const rel of relationships) {
    const baseName = rel.targetName;
    const count = targetNameCounts.get(baseName) || 0;
    targetNameCounts.set(baseName, count + 1);

    const displayName = count === 0 ? baseName : `${baseName}_${count}`;
    if (displayName === targetName) {
      matchedRel = rel;
      break;
    }
  }

  if (!matchedRel) {
    throw new LpgfsError(
      `Relationship not found: ${label}/${nodeName}/${relType}/${direction}/.${targetName}.json`,
      POSIX_ERRORS.ENOENT,
    );
  }

  // Per PRD section 5.2.4: OUT side has canonical properties, IN side has _ref
  if (direction === "OUT") {
    // Fetch full relationship properties from database
    const props = await getRelationshipProperties(
      ctx.db,
      matchedRel.relElementId,
      ctx.cache,
    );

    if (props === null) {
      // This shouldn't happen if we found the relationship above, but handle it
      throw new LpgfsError(
        `Relationship properties not found: ${matchedRel.relElementId}`,
        POSIX_ERRORS.ENOENT,
      );
    }

    return JSON.stringify(props, null, 2);
  } else {
    // IN side: return reference to the canonical OUT location
    // The _ref points to the relationship elementId
    const ref = {
      _ref: matchedRel.relElementId,
    };
    return JSON.stringify(ref, null, 2);
  }
}

// =============================================================================
// Write Operations - All return EROFS (Read-Only Filesystem)
// =============================================================================

/**
 * Error message for read-only filesystem operations.
 */
const EROFS_MESSAGE = "LPGFS is read-only";

/**
 * Write data to a file.
 *
 * LPGFS is a read-only filesystem, so this operation always fails with EROFS.
 *
 * @param _path - The file path (unused)
 * @param _data - The data to write (unused)
 * @param _offset - The offset to write at (unused)
 * @param _ctx - Handler context (unused)
 * @throws LpgfsError with EROFS error code
 */
export function write(
  _path: string,
  _data: Buffer | string,
  _offset: number,
  _ctx: HandlerContext,
): never {
  throw new LpgfsError(EROFS_MESSAGE, POSIX_ERRORS.EROFS);
}

/**
 * Create a directory.
 *
 * LPGFS is a read-only filesystem, so this operation always fails with EROFS.
 *
 * @param _path - The directory path to create (unused)
 * @param _mode - The directory mode (unused)
 * @param _ctx - Handler context (unused)
 * @throws LpgfsError with EROFS error code
 */
export function mkdir(
  _path: string,
  _mode: number,
  _ctx: HandlerContext,
): never {
  throw new LpgfsError(EROFS_MESSAGE, POSIX_ERRORS.EROFS);
}

/**
 * Remove a file.
 *
 * LPGFS is a read-only filesystem, so this operation always fails with EROFS.
 *
 * @param _path - The file path to remove (unused)
 * @param _ctx - Handler context (unused)
 * @throws LpgfsError with EROFS error code
 */
export function unlink(_path: string, _ctx: HandlerContext): never {
  throw new LpgfsError(EROFS_MESSAGE, POSIX_ERRORS.EROFS);
}

/**
 * Remove a directory.
 *
 * LPGFS is a read-only filesystem, so this operation always fails with EROFS.
 *
 * @param _path - The directory path to remove (unused)
 * @param _ctx - Handler context (unused)
 * @throws LpgfsError with EROFS error code
 */
export function rmdir(_path: string, _ctx: HandlerContext): never {
  throw new LpgfsError(EROFS_MESSAGE, POSIX_ERRORS.EROFS);
}

/**
 * Rename/move a file or directory.
 *
 * LPGFS is a read-only filesystem, so this operation always fails with EROFS.
 *
 * @param _srcPath - The source path (unused)
 * @param _destPath - The destination path (unused)
 * @param _ctx - Handler context (unused)
 * @throws LpgfsError with EROFS error code
 */
export function rename(
  _srcPath: string,
  _destPath: string,
  _ctx: HandlerContext,
): never {
  throw new LpgfsError(EROFS_MESSAGE, POSIX_ERRORS.EROFS);
}

/**
 * Create a symlink.
 *
 * LPGFS is a read-only filesystem, so this operation always fails with EROFS.
 *
 * @param _target - The target path of the symlink (unused)
 * @param _linkPath - The path where the symlink will be created (unused)
 * @param _ctx - Handler context (unused)
 * @throws LpgfsError with EROFS error code
 */
export function symlink(
  _target: string,
  _linkPath: string,
  _ctx: HandlerContext,
): never {
  throw new LpgfsError(EROFS_MESSAGE, POSIX_ERRORS.EROFS);
}

/**
 * Create a hard link.
 *
 * LPGFS is a read-only filesystem, so this operation always fails with EROFS.
 *
 * @param _srcPath - The source path to link from (unused)
 * @param _destPath - The destination path for the link (unused)
 * @param _ctx - Handler context (unused)
 * @throws LpgfsError with EROFS error code
 */
export function link(
  _srcPath: string,
  _destPath: string,
  _ctx: HandlerContext,
): never {
  throw new LpgfsError(EROFS_MESSAGE, POSIX_ERRORS.EROFS);
}

/**
 * Truncate a file to a specified length.
 *
 * LPGFS is a read-only filesystem, so this operation always fails with EROFS.
 *
 * @param _path - The file path to truncate (unused)
 * @param _size - The size to truncate to (unused)
 * @param _ctx - Handler context (unused)
 * @throws LpgfsError with EROFS error code
 */
export function truncate(
  _path: string,
  _size: number,
  _ctx: HandlerContext,
): never {
  throw new LpgfsError(EROFS_MESSAGE, POSIX_ERRORS.EROFS);
}

/**
 * Change file mode/permissions.
 *
 * LPGFS is a read-only filesystem, so this operation always fails with EROFS.
 *
 * @param _path - The file path (unused)
 * @param _mode - The new mode/permissions (unused)
 * @param _ctx - Handler context (unused)
 * @throws LpgfsError with EROFS error code
 */
export function chmod(
  _path: string,
  _mode: number,
  _ctx: HandlerContext,
): never {
  throw new LpgfsError(EROFS_MESSAGE, POSIX_ERRORS.EROFS);
}

/**
 * Change file owner and group.
 *
 * LPGFS is a read-only filesystem, so this operation always fails with EROFS.
 *
 * @param _path - The file path (unused)
 * @param _uid - The new user ID (unused)
 * @param _gid - The new group ID (unused)
 * @param _ctx - Handler context (unused)
 * @throws LpgfsError with EROFS error code
 */
export function chown(
  _path: string,
  _uid: number,
  _gid: number,
  _ctx: HandlerContext,
): never {
  throw new LpgfsError(EROFS_MESSAGE, POSIX_ERRORS.EROFS);
}

/**
 * Update file access and modification times.
 *
 * LPGFS is a read-only filesystem, so this operation always fails with EROFS.
 *
 * @param _path - The file path (unused)
 * @param _atime - The new access time (unused)
 * @param _mtime - The new modification time (unused)
 * @param _ctx - Handler context (unused)
 * @throws LpgfsError with EROFS error code
 */
export function utimens(
  _path: string,
  _atime: Date | number,
  _mtime: Date | number,
  _ctx: HandlerContext,
): never {
  throw new LpgfsError(EROFS_MESSAGE, POSIX_ERRORS.EROFS);
}

/**
 * Create a new file.
 *
 * LPGFS is a read-only filesystem, so this operation always fails with EROFS.
 *
 * @param _path - The file path to create (unused)
 * @param _mode - The file mode/permissions (unused)
 * @param _ctx - Handler context (unused)
 * @throws LpgfsError with EROFS error code
 */
export function create(
  _path: string,
  _mode: number,
  _ctx: HandlerContext,
): never {
  throw new LpgfsError(EROFS_MESSAGE, POSIX_ERRORS.EROFS);
}

/**
 * Create a special or device file (mknod).
 *
 * LPGFS is a read-only filesystem, so this operation always fails with EROFS.
 *
 * @param _path - The file path to create (unused)
 * @param _mode - The file mode/type (unused)
 * @param _dev - The device number (unused)
 * @param _ctx - Handler context (unused)
 * @throws LpgfsError with EROFS error code
 */
export function mknod(
  _path: string,
  _mode: number,
  _dev: number,
  _ctx: HandlerContext,
): never {
  throw new LpgfsError(EROFS_MESSAGE, POSIX_ERRORS.EROFS);
}

/**
 * Set extended attribute.
 *
 * LPGFS is a read-only filesystem, so this operation always fails with EROFS.
 *
 * @param _path - The file path (unused)
 * @param _name - The attribute name (unused)
 * @param _value - The attribute value (unused)
 * @param _flags - The flags (unused)
 * @param _ctx - Handler context (unused)
 * @throws LpgfsError with EROFS error code
 */
export function setxattr(
  _path: string,
  _name: string,
  _value: Buffer,
  _flags: number,
  _ctx: HandlerContext,
): never {
  throw new LpgfsError(EROFS_MESSAGE, POSIX_ERRORS.EROFS);
}

/**
 * Remove extended attribute.
 *
 * LPGFS is a read-only filesystem, so this operation always fails with EROFS.
 *
 * @param _path - The file path (unused)
 * @param _name - The attribute name to remove (unused)
 * @param _ctx - Handler context (unused)
 * @throws LpgfsError with EROFS error code
 */
export function removexattr(
  _path: string,
  _name: string,
  _ctx: HandlerContext,
): never {
  throw new LpgfsError(EROFS_MESSAGE, POSIX_ERRORS.EROFS);
}
