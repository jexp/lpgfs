# LPGFS

LPGFS - FUSE filesystem mounting Neo4j graph databases as navigable directories

## Commands
- `npm run tsc` - Type check
- `npm run build` - Compile TypeScript
- `npm test` - Run tests

## Project Structure
```
src/
├── cache/    # Caching layer
├── config/   # Config parsing, sanitization, collision handling
├── core/     # Path parser, daemon, logger
├── db/       # Database queries and connection
├── fuse/     # FUSE handlers
└── types/    # TypeScript type definitions
```

## Documentation

**Core System:**
- [Setup & Dependencies](docs/setup.md) - Native FUSE requirements, TypeScript config
- [Type Definitions](docs/types.md) - Core types reference
- [Project Structure](docs/project-structure.md) - Module organization

**Configuration & Data:**
- [Configuration](docs/configuration.md) - Config parsing, sanitization, collision handling
- [Database](docs/database.md) - Connection, queries, value transformation
- [Caching](docs/caching.md) - Cache implementation

**Filesystem Layer:**
- [Path Resolution](docs/path-resolution.md) - Path parser and PathContext
- [FUSE Handlers](docs/fuse-handlers.md) - Filesystem operations
- [Daemon](docs/daemon.md) - Daemon lifecycle and fuse-native mapping

**Supporting Modules:**
- [CLI](docs/cli.md) - Argument parsing and options
- [Logging](docs/logging.md) - Logger and Timer
- [Error Handling](docs/error-handling.md) - Error patterns and POSIX codes

## Learnings

**FUSE Error Handling:**
- fuse-native callbacks MUST be wrapped in try-catch - synchronous errors can cause segfaults
- All FUSE callbacks must call their callback exactly once - never throw
- Even trivial operations (like write ops returning EROFS) need try-catch - callback itself could throw
- Signal handlers need state checks - don't call stop() if not running
- Mount operations can hang - use timeout (5s) to fail fast
- cleanup() must never throw - wrap all cleanup in try-catch
- fuse-native stability tested up to Node.js 20 - warn users on Node.js 22+
- Validate FUSE libraries installed before loadFuse() - prevents confusing errors
  - macOS: /Library/Filesystems/macfuse.fs
  - Linux: /dev/fuse
- Register uncaughtException handler for debugging - log full context (state, mountpoint, stack) and attempt cleanup before exit
- Unregister exception handler in stop() to avoid handling exceptions after daemon stops
