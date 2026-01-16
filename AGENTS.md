# LPGFS Agent Learnings

## Project Setup

### Dependencies
- **fuse-native** requires native FUSE libraries:
  - Linux: `libfuse-dev` package
  - macOS: macFUSE (https://osxfuse.github.io/)
  - Also requires C compiler and node-gyp build tools
- Placed fuse-native in `optionalDependencies` to allow development on systems without FUSE

### TypeScript Configuration
- Using ESM modules with `"type": "module"` in package.json
- Module resolution: `NodeNext` for proper ESM support
- Target: `ES2022` for modern Node.js features

### Project Structure
```
src/
├── cache/    # Caching layer
├── config/   # Configuration parsing
├── core/     # Core logic (path parser, daemon)
├── db/       # Database queries and connection
├── fuse/     # FUSE handlers
└── types/    # TypeScript type definitions
```

## Commands
- `npm run tsc` - Type check without emitting
- `npm run build` - Compile TypeScript to dist/
- `npm test` - Run tests (to be configured)

## Type Definitions

### Core Types Location
All core types are defined in `src/types/index.ts`. Key exports:

**Path Resolution:**
- `PathContext` - Result of parsing filesystem paths
- `PathType` - Path type enum ('root', 'label', 'node', etc.)
- `Direction` - Relationship direction ('OUT' | 'IN')

**Configuration:**
- `ConfigSchema` - Complete .lpgfs.yaml structure
- `NamingStrategy` - 'elementId' or 'property'
- `CollisionStrategy` - 'suffix_elementId' or 'fail'
- `DEFAULT_CONFIG` - Default configuration values

**Database:**
- `DatabaseNode` - Node from graph DB
- `DatabaseRelationship` - Relationship from graph DB
- `NodeQueryResult` - Query result with display name
- `RelationshipQueryResult` - Query result with target info
- `Properties` - Property map type

**Caching:**
- `CacheEntry<T>` - Generic cache entry
- `CacheTTLConfig` - TTL configuration
- `DEFAULT_CACHE_TTL` - Default TTL values

**FUSE:**
- `FileType` - 'directory' | 'file' | 'symlink'
- `StatResult` - Result of stat operation
- `DirectoryEntry` - Directory listing entry

**CLI:**
- `MountOptions` - CLI mount options
- `DEFAULT_MOUNT_OPTIONS` - Default option values

**Errors:**
- `POSIX_ERRORS` - Error code constants
- `LpgfsError` - Custom error class with POSIX code

## Configuration System

### ConfigParser (src/config/parser.ts)
- `ConfigParser.load(path)` - Load config, throws `LpgfsError` if file missing
- `ConfigParser.loadOrDefault(path)` - Load config or return `DEFAULT_CONFIG` if missing
- `ConfigParser.parse(yamlContent)` - Parse YAML string to `ConfigSchema`
- `ConfigParser.toYaml(config)` - Serialize config back to YAML string

### Config Validation
- All sections (naming, sanitization, collision) are validated thoroughly
- User config is merged with defaults, so partial configs are supported
- `ConfigValidationError` is thrown for invalid config with specific error messages

### Filename Sanitization (src/config/sanitize.ts)
- `sanitize(value, config?)` - Sanitize any `PropertyValue` for use as filename
- `sanitizeElementId(id, config?)` - Helper for Neo4j elementIds (contain colons)
- `isValidFilename(name)` - Validate a sanitized filename
- Empty/null/undefined values return `_empty_` placeholder
- Uses `DEFAULT_CONFIG.sanitization` when no config provided

### Collision Handling (src/config/collision.ts)
- `CollisionResolver` class tracks used names per context (label/reltype)
- `resolver.resolve(baseName, elementId)` - Resolve name with collision handling
- `resolveCollisions(items, context, config?)` - Batch resolve names
- `createCollisionResolver(context, config?)` - Factory for incremental resolution
- Strategies:
  - `suffix_elementId`: Appends `_<sanitizedElementId>` to colliding names
  - `fail`: Throws `CollisionError` with descriptive message
- Uses `DEFAULT_CONFIG.collision` when no config provided

## Database Layer

### DatabaseConnection (src/db/connection.ts)
- `DatabaseConnection` class wraps neo4j-driver with retry logic
- `connect()` - Initialize and verify connectivity
- `executeQuery<T>(cypher, params)` - Execute Cypher query with automatic retry
- `isConnected()` - Check connection status
- `close()` - Close connection

### Factory Functions
- `createConnection(options)` - Create connection instance (not connected)
- `connect(options)` - Create and connect in one call

### Connection Options
```typescript
interface ConnectionOptions {
  uri: string;           // e.g., 'neo4j://localhost:7687'
  username?: string;
  password?: string;
  maxRetries?: number;   // default: 3
  retryDelayMs?: number; // default: 1000
  connectionTimeoutMs?: number; // default: 30000
  debug?: boolean;       // default: false
}
```

### Value Transformation
- Neo4j Integer → JavaScript number
- Neo4j Node → `{ elementId, labels, properties }`
- Neo4j Relationship → `{ elementId, type, startNodeElementId, endNodeElementId, properties }`

### Error Mapping
- `ServiceUnavailable` / connection errors → `POSIX_ERRORS.ENOENT`
- Other database errors → `POSIX_ERRORS.EIO`

### Query Functions (src/db/queries.ts)
- `getLabels(db)` - Get all node labels: `CALL db.labels() YIELD label RETURN label`
