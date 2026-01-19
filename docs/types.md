# Type Definitions

Core types in `src/types/index.ts`:

## Path Resolution
- `PathContext` - Result of parsing filesystem paths
- `PathType` - Path type enum ('root', 'label', 'node', etc.)
- `Direction` - Relationship direction ('OUT' | 'IN')

## Configuration
- `ConfigSchema` - Complete .lpgfs.yaml structure
- `NamingStrategy` - 'elementId' or 'property'
- `CollisionStrategy` - 'suffix_elementId' or 'fail'
- `DEFAULT_CONFIG` - Default config values

## Database
- `DatabaseNode` - Node from graph DB
- `DatabaseRelationship` - Relationship from graph DB
- `NodeQueryResult` - Query result with display name
- `RelationshipQueryResult` - Query result with target info
- `Properties` - Property map type

## Caching
- `CacheEntry<T>` - Generic cache entry
- `CacheTTLConfig` - TTL configuration
- `DEFAULT_CACHE_TTL` - Default TTL values

## FUSE
- `FileType` - 'directory' | 'file' | 'symlink'
- `StatResult` - Result of stat operation
- `DirectoryEntry` - Directory listing entry

## CLI
- `MountOptions` - CLI mount options
- `DEFAULT_MOUNT_OPTIONS` - Default option values

## Errors
- `POSIX_ERRORS` - Error code constants
- `LpgfsError` - Custom error class with POSIX code
