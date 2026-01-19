# Daemon Module

## Daemon Class (src/core/daemon.ts)
Manages FUSE filesystem lifecycle.

**States:**
- `stopped` - Initial state, not running
- `starting` - Initializing (loading config, connecting, mounting)
- `running` - Filesystem mounted and serving
- `stopping` - Shutting down (unmounting, closing)

**Methods:**
- `getState()` - Returns current state
- `getMountpoint()` - Returns absolute mountpoint path
- `start()` - Start daemon (load config, connect DB, mount FS)
- `stop()` - Stop daemon (unmount FS, close connections)

**Factory Functions:**
- `createDaemon(options)` - Create Daemon instance
- `unmount(mountpoint)` - Unmount using fusermount/umount

## FUSE Handler Mapping
Maps our handlers to fuse-native format:
- File mode constants: `S_IFDIR (0o040000)`, `S_IFREG (0o100000)`, `S_IFLNK (0o120000)`
- Directory mode: `S_IFDIR | 0o555` (read-only)
- File mode: `S_IFREG | 0o444` (read-only)
- Symlink mode: `S_IFLNK | 0o777`

**fuse-native callback pattern:**
```typescript
// Callback with error code first
ops.readdir = (path, cb) => {
  readdir(path, ctx)
    .then((entries) => cb(0, entries.map(e => e.name)))
    .catch((err) => cb(err.code));  // Negative POSIX code
};

ops.read = (path, fd, buffer, length, position, cb) => {
  read(path, ctx, position, length)
    .then((result) => {
      if (position >= result.size) {
        cb(0);  // EOF - 0 bytes read
        return;
      }
      Buffer.from(result.content, 'utf8').copy(buffer);
      cb(result.content.length);  // Bytes written to buffer
    })
    .catch((err) => cb(err.code));
};
```

## Signal Handling
Registers handlers for clean shutdown:
```typescript
process.on('SIGINT', async () => {
  await daemon.stop();
  process.exit(0);
});
```

## Optional Dependency Pattern
fuse-native loaded lazily (optional):
```typescript
let Fuse = null;

function loadFuse() {
  if (Fuse) return Fuse;
  try {
    Fuse = require('fuse-native');
    return Fuse;
  } catch {
    throw new Error('fuse-native is not installed...');
  }
}
```

**Usage:**
```typescript
import { Daemon, unmount } from './core/daemon.js';

const daemon = new Daemon({
  mountpoint: '/mnt/graph',
  mountOptions: {
    db: 'neo4j://localhost:7687',
    debug: true,
    foreground: true,
  },
});

await daemon.start();
// Daemon handles SIGINT/SIGTERM

await unmount('/mnt/graph');
```
