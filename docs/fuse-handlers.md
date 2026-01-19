# FUSE Handlers

## Handler Context (src/fuse/handlers.ts)
- `HandlerContext` interface holds shared resources: db, config, cache, debug flag
- `createHandlerContext(db, options?)` - Create context with defaults

## readdir(path, ctx)
Read directory contents, returns `DirectoryEntry[]`:
- Dispatches based on `PathContext.type`
- Root (`/`): Returns labels as directories + `.lpgfs.yaml` file
- Label (`/Person`): Returns all nodes as directories using `getNodesByLabel()`
- Node (`/Person/alice`): Returns `.properties.json` + relationship type directories using `getRelationshipTypes()`
- Reltype (`/Person/alice/KNOWS`): Returns `['OUT', 'IN']` as directories (static)
- Direction (`/Person/alice/KNOWS/OUT`): Returns symlinks to targets + `.targetName.json` files using `getRelationships()`

### Multiple Relationships to Same Target
When multiple relationships of same type point to same target:
- First relationship uses base target name (e.g., `james`)
- Subsequent get suffix: `james_1`, `james_2`, etc.
- Property files follow pattern: `.james.json`, `.james_1.json`, etc.
- Tracked in `readdirDirection()` using count map per target name

## getattr(path, ctx)
Get file/directory attributes, returns `StatResult`:
- Dispatches based on `PathContext.type`
- Returns `{ type, size?, mtime, atime, ctime }`
- Validates path hierarchy (label → node → reltype → direction → target)
- Throws `LpgfsError` with `POSIX_ERRORS.ENOENT` for invalid paths

**Return types:**
- `root` → directory
- `label` → directory (validates label exists)
- `node` → directory (validates node exists)
- `reltype` → directory (validates type exists for node)
- `direction` → directory (validates direction is OUT or IN)
- `target` → symlink (validates target exists in relationships)
- `properties` → file (.lpgfs.yaml has actual size, others size 0)

**Validation:**
- Helpers reuse each other for DRY
- `getattrDirection()` calls `getattrReltype()` which validates node and label
- Uses same suffix logic as `readdirDirection()` for multiple rels

## readlink(path, ctx)
Resolve symlink to relative path:
- Only applies to 'target' path type
- Returns relative path string to target node directory
- Throws `LpgfsError` with `POSIX_ERRORS.ENOENT` for non-symlinks

**Relative path calculation:**
- Same-label: `../../../targetName` (3 levels up)
- Cross-label: `../../../../TargetLabel/targetName` (4 levels up)

**Examples:**
```
/Person/alice/KNOWS/OUT/james → ../../../james
/Person/alice/WORKS_AT/OUT/acme → ../../../../Company/acme
```

**Important:** Symlink paths calculated from directory containing symlink, not symlink itself (standard FUSE behavior).

## read(path, ctx, offset?, length?)
Read file contents, returns `ReadResult`:
- Returns `{ content: string, size: number }`
- `size` always total file size, even for partial reads
- `content` is (possibly partial) file content

**Supported files:**
- `/.lpgfs.yaml` - Config file (YAML)
- `/Label/nodeName/.properties.json` - Node properties (JSON)
- `/Label/nodeName/RELTYPE/OUT/.target.json` - Relationship properties (JSON)

**Node properties format:**
```json
{
  "_elementId": "4:abc:0",
  "username": "alice",
  "age": 30
}
```

**Relationship properties (OUT - canonical):**
```json
{
  "_elementId": "5:abc:0",
  "since": 2020,
  "weight": 0.8
}
```

**Relationship properties (IN - reference):**
```json
{
  "_ref": "5:abc:0"
}
```
OUT side owns canonical properties. IN side returns `_ref` pointer to avoid duplication (PRD 5.2.4).

**Partial read:**
- `offset` - Start byte position (default: 0)
- `length` - Max bytes to read (default: entire file)
- Uses Buffer for byte-accurate UTF-8 slicing
- Returns empty string if offset exceeds size

## Write Operations
All write operations return EROFS (Read-Only Filesystem) per PRD 2.3:
- `write()`, `mkdir()`, `unlink()`, `rmdir()`, `rename()`, `symlink()`, `link()`, `truncate()`, `chmod()`, `chown()`, `utimens()`, `create()`, `mknod()`, `setxattr()`, `removexattr()`
- All throw `LpgfsError` with code `POSIX_ERRORS.EROFS` (-30), message `"LPGFS is read-only"`

## getConfigContent(ctx)
Get config as YAML string for reading `/.lpgfs.yaml`
