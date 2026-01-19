# CLI Module

## CLI Parser (src/cli/index.ts)
- `parseArgs(argv?)` - Parse CLI arguments, return typed `ParsedCommand`
- `createProgram(exitOverride?)` - Create Commander program instance
- `validateMountpoint(path)` - Validate directory exists and is a directory
- `main()` - Main CLI entry point

## Parsed Command Types
```typescript
type ParsedCommand =
  | { command: 'mount'; data: ParsedMountCommand }
  | { command: 'unmount'; data: ParsedUnmountCommand }
  | { command: 'help' }
  | { command: 'version' };

interface ParsedMountCommand {
  mountpoint: string;  // Absolute path to mount directory
  options: MountOptions;
}

interface ParsedUnmountCommand {
  mountpoint: string;  // Absolute path to mounted directory
}
```

## Mount Options
- `db: string` - Database URI (default: `neo4j://localhost:7687`)
- `config?: string` - Path to .lpgfs.yaml (default: `./.lpgfs.yaml`)
- `cacheTtl?: number` - Cache TTL in seconds (default: `10`)
- `allowOther?: boolean` - Allow other users (default: `false`)
- `debug?: boolean` - Verbose logging (default: `false`)
- `foreground?: boolean` - Run in foreground (default: `false`)
- `user?: string` - Database username
- `password?: string` - Database password

## Commander Testing Patterns
When testing CLI with Commander:
1. Use `exitOverride()` to make Commander throw instead of `process.exit()`
2. Use `configureOutput()` to suppress help/error during tests
3. Check `--help`/`--version` before `parse()` to avoid exit
4. Handle Commander error codes: `commander.missingArgument`, `commander.unknownCommand`, etc.

**Usage:**
```typescript
import { parseArgs } from './cli/index.js';

const result = parseArgs(['mount', '/mnt/graph', '--db', 'neo4j://localhost:7687']);
if (result.command === 'mount') {
  console.log(result.data.mountpoint);
  console.log(result.data.options.db);
}
```
