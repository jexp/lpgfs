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
