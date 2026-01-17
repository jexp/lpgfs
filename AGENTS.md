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
- `npm test` - Run tests with vitest

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
- `getNodesByLabel(db, label, config?)` - Get all nodes of a label with display names
  - Respects naming config (elementId vs property strategy)
  - Applies collision handling automatically
  - Returns `NodeQueryResult[]` with name, elementId, properties
  - Uses backticks to safely escape label names in Cypher: `MATCH (n:\`Label\`)`

### Naming Strategy Logic
- Check for per-label override in `config.naming.overrides.nodes[label]`
- If override exists, use 'property' strategy with specified property
- Otherwise, use `config.naming.default` strategy
- If property naming is used but property is missing, fall back to elementId

### Node Properties Lookup (src/db/queries.ts)
- `getNodeProperties(db, label, name, config?)` - Get single node properties by display name
  - Returns `NodePropertiesResult` with `_elementId` plus all properties
  - Returns `null` if node not found
  - Reuses `getNodesByLabel()` for consistent naming logic
  - Handles both naming strategies (elementId and property) transparently
  - O(n) lookup will be optimized by caching in task-014

### Relationship Types Query (src/db/queries.ts)
- `getRelationshipTypes(db, label, name, config?)` - Get distinct relationship types for a node
  - Returns `string[]` of relationship type names (e.g., `['KNOWS', 'WORKS_AT']`)
  - Returns empty array if node not found or has no relationships
  - Queries both outgoing and incoming relationships combined
  - Uses parameterized Cypher: `MATCH (n)-[r]-() WHERE elementId(n) = $elementId RETURN DISTINCT type(r)`
  - Reuses `getNodesByLabel()` for consistent naming logic with filesystem display names

### Relationships Query (src/db/queries.ts)
- `getRelationships(db, label, name, relType, direction, config?)` - Get relationships of a specific type and direction
  - Returns `RelationshipQueryResult[]` with target node info and relationship properties
  - Direction 'OUT': Queries `(n)-[r:TYPE]->(m)` where n is source node
  - Direction 'IN': Queries `(n)<-[r:TYPE]-(m)` where n is source node
  - Target node names determined using target label's naming strategy (supports cross-label relationships)
  - Handles collision resolution per target label group
  - Uses backticks to safely escape relationship type names in Cypher: `[r:\`KNOWS\`]`
  - First label used as primary when target node has multiple labels

### Relationship Properties Query (src/db/queries.ts)
- `getRelationshipProperties(db, relElementId)` - Get relationship properties by elementId
  - Returns `RelationshipPropertiesResult` with `_elementId` plus all properties
  - Returns `null` if relationship not found
  - Uses Cypher: `MATCH ()-[r]-() WHERE elementId(r) = $relElementId RETURN elementId(r), properties(r) LIMIT 1`
  - No naming strategy needed - relationships are always looked up by elementId
  - Simpler than node properties since no collision handling is required

## Caching Layer

### Cache Class (src/cache/index.ts)
- `Cache` class wraps lru-cache with automatic TTL-based expiration
- Uses `ttlAutopurge: true` for automatic cleanup of expired entries
- Methods: `get<T>(key)`, `set<T>(key, value, ttlSeconds?)`, `has(key)`, `delete(key)`, `clear()`
- `get()` returns `undefined` on cache miss (not `null`)
- TTL is determined per-entry based on key prefix

### Cache Key Builder
- `cacheKey.labels()` → `"labels"`
- `cacheKey.nodes(label)` → `"nodes:Person"`
- `cacheKey.props(elementId)` → `"props:4:abc:0"`
- `cacheKey.reltypes(elementId)` → `"reltypes:4:abc:0"`
- `cacheKey.rels(elementId, relType, direction)` → `"rels:4:abc:0:KNOWS:OUT"`

### Default TTL Values (from DEFAULT_CACHE_TTL)
- labels: 60s
- nodes: 30s
- properties: 10s
- relationships: 10s
- symlinks: 60s

### lru-cache Type Constraint
- lru-cache v11 requires value types to extend `{}` (not `unknown`)
- Workaround: Use a wrapper type `{ data: unknown }` internally
- This is transparent to the API consumer

### Cache Integration with Queries (src/db/queries.ts)
All query functions accept an optional `cache?: Cache` parameter:
- `getLabels(db, cache?)` - caches labels with key `labels` (TTL 60s)
- `getNodesByLabel(db, label, config?, cache?)` - caches nodes with key `nodes:Label` (TTL 30s)
- `getNodeProperties(db, label, name, config?, cache?)` - uses getNodesByLabel's cache internally
- `getRelationshipTypes(db, label, name, config?, cache?)` - caches with key `reltypes:elementId` (TTL 10s)
- `getRelationships(db, label, name, relType, direction, config?, cache?)` - caches with key `rels:elementId:relType:direction` (TTL 10s)
- `getRelationshipProperties(db, relElementId, cache?)` - caches with key `props:elementId` (TTL 10s)

**Cache Pattern:**
1. Check cache first using appropriate cache key
2. If cache hit, return cached value immediately
3. If cache miss, execute database query
4. Store result in cache (including empty/null results)
5. Return result

**Usage Example:**
```typescript
import { createCache } from './cache/index.js';
import { getLabels, getNodesByLabel } from './db/queries.js';

const cache = createCache({ debug: true });

// These calls will use caching
const labels = await getLabels(db, cache);
const nodes = await getNodesByLabel(db, 'Person', config, cache);

// Second call returns cached result (no DB query)
const labelsCached = await getLabels(db, cache);
```

## Path Resolution

### Path Parser (src/core/path-parser.ts)
- `parsePath(path)` - Parse filesystem path to `PathContext` object
- Returns typed `PathContext` with all extracted path components
- Handles all path types: root, label, node, reltype, direction, target, properties

### Path Types and Examples
```
/                              → { type: 'root' }
/.lpgfs.yaml                   → { type: 'properties', isConfigFile: true }
/Person                        → { type: 'label', label: 'Person' }
/Person/alice                  → { type: 'node', label: 'Person', nodeName: 'alice' }
/Person/alice/.properties.json → { type: 'properties', ..., isPropertiesFile: true }
/Person/alice/KNOWS            → { type: 'reltype', ..., relType: 'KNOWS' }
/Person/alice/KNOWS/OUT        → { type: 'direction', ..., direction: 'OUT' }
/Person/alice/KNOWS/OUT/james  → { type: 'target', ..., targetName: 'james' }
/Person/alice/KNOWS/OUT/.james.json → { type: 'properties', ..., isRelPropertiesFile: true }
```

### Helper Functions
- `extractTargetFromRelPropertiesFilename(filename)` - Extract target name from `.james.json` → `james`
- `pathContextToCacheKey(context)` - Generate cache key string from PathContext

### Exported Constants
- `CONFIG_FILENAME` = `.lpgfs.yaml`
- `PROPERTIES_FILENAME` = `.properties.json`

### Edge Case Handling
- Trailing slashes are normalized (`/Person/` → `/Person`)
- Empty paths are treated as root
- Invalid directions are passed through (FUSE layer validates)
- Self-referential and multi-relationship patterns are supported

## FUSE Handlers

### Handler Context (src/fuse/handlers.ts)
- `HandlerContext` interface holds shared resources: db, config, cache, debug flag
- `createHandlerContext(db, options?)` - Create context with defaults

### FUSE Operations
- `readdir(path, ctx)` - Read directory contents, returns `DirectoryEntry[]`
  - Dispatches based on `PathContext.type` from path parser
  - For root (`/`): Returns labels as directories + `.lpgfs.yaml` file
  - For label (`/Person`): Returns all nodes as directories using `getNodesByLabel()`
  - For node (`/Person/alice`): Returns `.properties.json` file + relationship type directories using `getRelationshipTypes()`
  - For reltype (`/Person/alice/KNOWS`): Returns `['OUT', 'IN']` as directories (static, no DB query)
  - For direction (`/Person/alice/KNOWS/OUT`): Returns symlinks to target nodes + `.targetName.json` files using `getRelationships()`
- `getConfigContent(ctx)` - Get config as YAML string for reading `/.lpgfs.yaml`

### Multiple Relationships to Same Target (Section 8.1)
When multiple relationships of the same type point to the same target node:
- First relationship uses the base target name (e.g., `james`)
- Subsequent relationships get suffix: `james_1`, `james_2`, etc.
- Property files follow same pattern: `.james.json`, `.james_1.json`, etc.
- This is tracked in `readdirDirection()` using a count map per target name

### Usage Example
```typescript
import { createHandlerContext, readdir, getattr } from './fuse/handlers.js';
import { connect } from './db/connection.js';

const db = await connect({ uri: 'neo4j://localhost:7687' });
const ctx = createHandlerContext(db, { debug: true });

// List root directory
const entries = await readdir('/', ctx);
// Returns: [{ name: 'Person', type: 'directory' }, { name: '.lpgfs.yaml', type: 'file' }]

// Stat a file/directory
const stat = await getattr('/Person', ctx);
// Returns: { type: 'directory', mtime: Date, atime: Date, ctime: Date }
```

### getattr() Operation (src/fuse/handlers.ts)
- `getattr(path, ctx)` - Get file/directory attributes, returns `StatResult`
  - Dispatches based on `PathContext.type` from path parser
  - Returns `{ type, size?, mtime, atime, ctime }`
  - Validates path hierarchy (label → node → reltype → direction → target)
  - Throws `LpgfsError` with `POSIX_ERRORS.ENOENT` for invalid paths

**Return types by path type:**
- `root` → directory
- `label` → directory (validates label exists in DB)
- `node` → directory (validates node exists)
- `reltype` → directory (validates relationship type exists for node)
- `direction` → directory (validates direction is OUT or IN)
- `target` → symlink (validates target exists in relationships)
- `properties` → file (.lpgfs.yaml has actual size, others return size 0)

**Validation pattern:**
- Helper functions reuse each other for DRY validation
- `getattrDirection()` calls `getattrReltype()` which validates node and label
- Uses same suffix logic as `readdirDirection()` for multiple rels to same target

### readlink() Operation (src/fuse/handlers.ts)
- `readlink(path, ctx)` - Resolve symlink to relative path
  - Only applies to 'target' path type (symlinks in OUT/IN directories)
  - Returns relative path string to target node directory
  - Throws `LpgfsError` with `POSIX_ERRORS.ENOENT` for non-symlink paths

**Relative path calculation:**
- Same-label: `../../../targetName` (3 levels up from OUT/IN dir to label dir)
- Cross-label: `../../../../TargetLabel/targetName` (4 levels up to root, then target path)

**Example paths:**
```
/Person/alice/KNOWS/OUT/james → ../../../james          (same label)
/Person/alice/WORKS_AT/OUT/acme → ../../../../Company/acme  (cross-label)
```

**Important:** Symlink relative paths are calculated from the directory containing the symlink (e.g., `/Person/alice/KNOWS/OUT/`), not from the symlink itself. This is standard FUSE/filesystem behavior.
