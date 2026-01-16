/**
 * LPGFS Core Types
 *
 * Core TypeScript type definitions for the LPGFS virtual filesystem.
 */

// =============================================================================
// Path Resolution Types (Section 12.3)
// =============================================================================

/**
 * The type of filesystem path being accessed.
 */
export type PathType =
  | 'root'
  | 'label'
  | 'node'
  | 'reltype'
  | 'direction'
  | 'target'
  | 'properties';

/**
 * Relationship direction.
 */
export type Direction = 'OUT' | 'IN';

/**
 * Context object resulting from parsing a filesystem path.
 * Used to determine which database query to execute.
 *
 * Examples:
 * - /Person                         → { type: 'label', label: 'Person' }
 * - /Person/alice                   → { type: 'node', label: 'Person', nodeName: 'alice' }
 * - /Person/alice/.properties.json  → { type: 'properties', ..., isPropertiesFile: true }
 * - /Person/alice/KNOWS             → { type: 'reltype', ..., relType: 'KNOWS' }
 * - /Person/alice/KNOWS/OUT         → { type: 'direction', ..., direction: 'OUT' }
 * - /Person/alice/KNOWS/OUT/james   → { type: 'target', ..., targetName: 'james' }
 * - /Person/alice/KNOWS/OUT/.james.json → { type: 'properties', ..., isRelPropertiesFile: true }
 */
export interface PathContext {
  /** The type of path being accessed */
  type: PathType;
  /** Node label (e.g., "Person", "Company") */
  label?: string;
  /** Node name/identifier (e.g., "alice") */
  nodeName?: string;
  /** Relationship type (e.g., "KNOWS", "WORKS_AT") */
  relType?: string;
  /** Relationship direction */
  direction?: Direction;
  /** Target node name in relationship traversal (e.g., "james") */
  targetName?: string;
  /** True if path refers to a node's .properties.json file */
  isPropertiesFile?: boolean;
  /** True if path refers to a relationship's property file (e.g., .james.json) */
  isRelPropertiesFile?: boolean;
  /** True if path refers to the config file /.lpgfs.yaml */
  isConfigFile?: boolean;
}

// =============================================================================
// Configuration Types (Section 5.3)
// =============================================================================

/**
 * Naming strategy for node/relationship directory names.
 * - 'elementId': Use database elementId (guaranteed unique, stable)
 * - 'property': Use a property value (human-readable)
 */
export type NamingStrategy = 'elementId' | 'property';

/**
 * Override configuration for a specific node label.
 */
export interface NodeNamingOverride {
  /** Property name to use for naming (when using property strategy) */
  property: string;
}

/**
 * Naming configuration section.
 */
export interface NamingConfig {
  /** Default naming strategy for all nodes */
  default: NamingStrategy;
  /** Per-label and per-relationship-type overrides */
  overrides?: {
    /** Node label overrides */
    nodes?: Record<string, NodeNamingOverride>;
    /** Relationship type overrides (elementId or property) */
    relationships?: Record<string, NamingStrategy>;
  };
}

/**
 * Sanitization configuration for property values used as filenames.
 * Maps characters to their replacements.
 */
export interface SanitizationConfig {
  /** Character replacement map (e.g., { "/": "_", "\\": "_" }) */
  replace: Record<string, string>;
}

/**
 * Collision handling strategy when property values produce duplicate names.
 * - 'suffix_elementId': Append _<elementId> to create unique name
 * - 'fail': Raise an error requiring manual resolution
 */
export type CollisionStrategy = 'suffix_elementId' | 'fail';

/**
 * Collision handling configuration.
 */
export interface CollisionConfig {
  /** Strategy for handling naming collisions */
  strategy: CollisionStrategy;
}

/**
 * Complete configuration schema for .lpgfs.yaml file.
 */
export interface ConfigSchema {
  /** Naming configuration */
  naming: NamingConfig;
  /** Sanitization rules for filenames */
  sanitization?: SanitizationConfig;
  /** Collision handling configuration */
  collision?: CollisionConfig;
}

/**
 * Default configuration values.
 */
export const DEFAULT_CONFIG: ConfigSchema = {
  naming: {
    default: 'elementId',
  },
  sanitization: {
    replace: {
      '/': '_',
      '\\': '_',
      '\0': '_',
      ':': '_',
      '*': '_',
      '?': '_',
      '"': '_',
      '<': '_',
      '>': '_',
      '|': '_',
    },
  },
  collision: {
    strategy: 'suffix_elementId',
  },
};

// =============================================================================
// Database Types
// =============================================================================

/**
 * Property value types supported by the graph database.
 */
export type PropertyValue =
  | string
  | number
  | boolean
  | null
  | PropertyValue[]
  | { [key: string]: PropertyValue };

/**
 * A map of property names to values.
 */
export type Properties = Record<string, PropertyValue>;

/**
 * Represents a node from the graph database.
 */
export interface DatabaseNode {
  /** Database-assigned element ID (e.g., "4:abc123:0") */
  elementId: string;
  /** Node labels (e.g., ["Person"]) */
  labels: string[];
  /** Node properties */
  properties: Properties;
}

/**
 * Represents a relationship from the graph database.
 */
export interface DatabaseRelationship {
  /** Database-assigned element ID (e.g., "5:abc123:7") */
  elementId: string;
  /** Relationship type (e.g., "KNOWS", "WORKS_AT") */
  type: string;
  /** Element ID of the start node */
  startNodeElementId: string;
  /** Element ID of the end node */
  endNodeElementId: string;
  /** Relationship properties */
  properties: Properties;
}

/**
 * Result from a node query including display name.
 */
export interface NodeQueryResult {
  /** Display name for the node (based on naming config) */
  name: string;
  /** Database element ID */
  elementId: string;
  /** Node properties */
  properties: Properties;
}

/**
 * Result from a relationship query including target info.
 */
export interface RelationshipQueryResult {
  /** Display name of the target node */
  targetName: string;
  /** Label of the target node */
  targetLabel: string;
  /** Relationship element ID */
  relElementId: string;
  /** Relationship properties */
  relProperties: Properties;
  /** Target node element ID */
  targetElementId: string;
}

// =============================================================================
// Cache Types (Section 12.4)
// =============================================================================

/**
 * Cache key prefixes for different data types.
 */
export type CacheKeyPrefix =
  | 'labels'
  | 'nodes'
  | 'props'
  | 'rels'
  | 'reltypes';

/**
 * Cache entry metadata.
 */
export interface CacheEntry<T> {
  /** The cache key */
  key: string;
  /** The cached value */
  value: T;
  /** Timestamp when the entry expires (ms since epoch) */
  expiresAt: number;
}

/**
 * Cache TTL configuration in seconds.
 */
export interface CacheTTLConfig {
  /** TTL for label list (default: 60s) */
  labels: number;
  /** TTL for node existence/list (default: 30s) */
  nodes: number;
  /** TTL for node properties (default: 10s) */
  properties: number;
  /** TTL for relationship list (default: 10s) */
  relationships: number;
  /** TTL for symlink targets (default: 60s) */
  symlinks: number;
}

/**
 * Default cache TTL values in seconds.
 */
export const DEFAULT_CACHE_TTL: CacheTTLConfig = {
  labels: 60,
  nodes: 30,
  properties: 10,
  relationships: 10,
  symlinks: 60,
};

// =============================================================================
// FUSE Types
// =============================================================================

/**
 * File type for stat results.
 */
export type FileType = 'directory' | 'file' | 'symlink';

/**
 * Result of a stat operation.
 */
export interface StatResult {
  /** Type of the filesystem entry */
  type: FileType;
  /** File size in bytes (for files) */
  size?: number;
  /** Last modification time */
  mtime?: Date;
  /** Last access time */
  atime?: Date;
  /** Creation time */
  ctime?: Date;
}

/**
 * Entry in a directory listing.
 */
export interface DirectoryEntry {
  /** Entry name */
  name: string;
  /** Entry type */
  type: FileType;
}

// =============================================================================
// CLI Types (Section 12.7)
// =============================================================================

/**
 * CLI mount options.
 */
export interface MountOptions {
  /** Database connection URI */
  db: string;
  /** Path to .lpgfs.yaml config file */
  config?: string;
  /** Cache TTL in seconds */
  cacheTtl?: number;
  /** Allow other users to access mount */
  allowOther?: boolean;
  /** Enable verbose logging */
  debug?: boolean;
  /** Run in foreground (don't daemonize) */
  foreground?: boolean;
  /** Database username */
  user?: string;
  /** Database password */
  password?: string;
}

/**
 * Default mount options.
 */
export const DEFAULT_MOUNT_OPTIONS: Partial<MountOptions> = {
  db: 'neo4j://localhost:7687',
  config: './.lpgfs.yaml',
  cacheTtl: 10,
  allowOther: false,
  debug: false,
  foreground: false,
};

// =============================================================================
// Error Types (Section 12.8)
// =============================================================================

/**
 * POSIX error codes used by LPGFS.
 */
export const POSIX_ERRORS = {
  /** No such file or directory */
  ENOENT: -2,
  /** I/O error */
  EIO: -5,
  /** Read-only filesystem */
  EROFS: -30,
  /** Not a directory */
  ENOTDIR: -20,
  /** Is a directory */
  EISDIR: -21,
} as const;

export type PosixErrorCode = (typeof POSIX_ERRORS)[keyof typeof POSIX_ERRORS];

/**
 * Custom error class for LPGFS errors.
 */
export class LpgfsError extends Error {
  constructor(
    message: string,
    public readonly code: PosixErrorCode
  ) {
    super(message);
    this.name = 'LpgfsError';
  }
}
