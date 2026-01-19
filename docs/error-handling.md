# Error Handling

## Error Codes
- `POSIX_ERRORS.ENOENT` (-2): Path or entity not found
- `POSIX_ERRORS.EIO` (-5): Database or I/O error
- `POSIX_ERRORS.EROFS` (-30): Write operation on read-only filesystem

## FUSE Handler Error Pattern
All handlers follow this pattern:
```typescript
export async function readdir(path: string, ctx: HandlerContext): Promise<DirectoryEntry[]> {
  const timer = ctx.logger.time();
  ctx.logger.debug(`readdir: ${path}`, { type: pathContext.type });

  try {
    // ... implementation ...
    timer.end(`readdir: ${path}`, { entries: result.length });
    return result;
  } catch (error) {
    if (error instanceof LpgfsError) {
      // Expected error - log and rethrow
      ctx.logger.debug(`readdir: ${path} -> error`, { code: error.code, message: error.message });
      throw error;
    }
    // Unexpected error - log, wrap in EIO, throw
    ctx.logger.error(`readdir: ${path}`, error);
    throw new LpgfsError(`readdir failed: ${(error as Error).message}`, POSIX_ERRORS.EIO);
  }
}
```

**Pattern:**
1. Start timer and log debug
2. Try operation
3. On success, end timer with result info
4. On `LpgfsError`, log debug and rethrow
5. On unexpected error, log error, wrap in `EIO`, throw
