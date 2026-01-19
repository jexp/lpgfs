# Configuration System

## ConfigParser (src/config/parser.ts)
- `ConfigParser.load(path)` - Load config, throws `LpgfsError` if missing
- `ConfigParser.loadOrDefault(path)` - Load or return `DEFAULT_CONFIG` if missing
- `ConfigParser.parse(yamlContent)` - Parse YAML to `ConfigSchema`
- `ConfigParser.toYaml(config)` - Serialize config back to YAML

## Validation
- All sections (naming, sanitization, collision) validated
- User config merged with defaults (partial configs supported)
- `ConfigValidationError` thrown for invalid config

## Filename Sanitization (src/config/sanitize.ts)
- `sanitize(value, config?)` - Sanitize any `PropertyValue` for filename use
- `sanitizeElementId(id, config?)` - Helper for Neo4j elementIds (contain colons)
- `isValidFilename(name)` - Validate sanitized filename
- Empty/null/undefined values return `_empty_` placeholder
- Uses `DEFAULT_CONFIG.sanitization` when no config provided

## Collision Handling (src/config/collision.ts)
- `CollisionResolver` class tracks used names per context (label/reltype)
- `resolver.resolve(baseName, elementId)` - Resolve name with collision handling
- `resolveCollisions(items, context, config?)` - Batch resolve names
- `createCollisionResolver(context, config?)` - Factory for incremental resolution
- Strategies:
  - `suffix_elementId`: Appends `_<sanitizedElementId>` to colliding names
  - `fail`: Throws `CollisionError` with descriptive message
- Uses `DEFAULT_CONFIG.collision` when no config provided
