# Logging Module

## Logger Class (src/core/logger.ts)
Centralized logging for consistent debug output.

**Features:**
- Log levels: `debug`, `info`, `warn`, `error`
- Debug/info/warn gated by `enabled` flag
- Error messages always logged (not gated)
- Child loggers with sub-prefix support
- Timer utility for measuring operation duration

**Methods:**
- `isEnabled()` - Check if logging enabled
- `setEnabled(bool)` - Enable/disable logging
- `child(subPrefix)` - Create child logger with combined prefix
- `debug(message, data?)` - Log debug (gated)
- `info(message, data?)` - Log info (gated)
- `warn(message, data?)` - Log warning (gated)
- `error(message, error?)` - Log error (always logged)
- `time()` - Start timer, returns Timer object

**Timer Methods:**
- `end(message, data?)` - Log duration since timer started

**Usage:**
```typescript
import { createLogger } from './core/logger.js';

const logger = createLogger({ enabled: true, prefix: 'lpgfs' });

logger.info('Starting server');
logger.debug('Config loaded', { path: '/config.yaml' });
logger.warn('Connection slow');
logger.error('Failed to connect', new Error('timeout'));

// Child loggers
const fuseLogger = logger.child('fuse');
fuseLogger.debug('readdir /');
// Output: [lpgfs:fuse] readdir /

// Timing
const timer = logger.time();
// ... work ...
timer.end('Operation complete', { entries: 5 });
// Output: [lpgfs] Operation complete {"entries":5} (12ms)
```

## HandlerContext Integration
`HandlerContext` includes auto-created logger:
```typescript
const ctx = createHandlerContext(db, {
  debug: true,  // Enables logging
  // logger auto-created with prefix 'lpgfs:fuse'
});

// Or custom logger
const ctx = createHandlerContext(db, {
  logger: customLogger,
});
```
