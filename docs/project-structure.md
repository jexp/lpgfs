# Project Structure

```
src/
├── cache/
│   └── index.ts         # Cache class wrapping lru-cache
├── config/
│   ├── parser.ts        # ConfigParser.load/parse/toYaml
│   ├── sanitize.ts      # sanitize(), sanitizeElementId()
│   └── collision.ts     # CollisionResolver, resolveCollisions()
├── core/
│   ├── path-parser.ts   # parsePath(), extractTargetFromRelPropertiesFilename()
│   ├── daemon.ts        # Daemon class, unmount()
│   └── logger.ts        # Logger class, createLogger()
├── db/
│   ├── connection.ts    # DatabaseConnection, connect()
│   └── queries.ts       # getLabels(), getNodesByLabel(), etc.
├── fuse/
│   └── handlers.ts      # readdir(), getattr(), read(), write stubs
└── types/
    └── index.ts         # All type definitions
```
