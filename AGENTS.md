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
