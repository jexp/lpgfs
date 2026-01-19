# Path Resolution

## Path Parser (src/core/path-parser.ts)
- `parsePath(path)` - Parse filesystem path to `PathContext` object
- Returns typed `PathContext` with all extracted path components
- Handles all path types: root, label, node, reltype, direction, target, properties

## Path Types and Examples
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

## Helper Functions
- `extractTargetFromRelPropertiesFilename(filename)` - Extract target name from `.james.json` → `james`
- `pathContextToCacheKey(context)` - Generate cache key from PathContext

## Exported Constants
- `CONFIG_FILENAME` = `.lpgfs.yaml`
- `PROPERTIES_FILENAME` = `.properties.json`

## Edge Cases
- Trailing slashes normalized (`/Person/` → `/Person`)
- Empty paths treated as root
- Invalid directions passed through (FUSE layer validates)
- Self-referential and multi-relationship patterns supported
