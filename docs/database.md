# Database Layer

## DatabaseConnection (src/db/connection.ts)
Wraps neo4j-driver with retry logic:
- `connect()` - Initialize and verify connectivity
- `executeQuery<T>(cypher, params)` - Execute Cypher with automatic retry
- `isConnected()` - Check connection status
- `close()` - Close connection

### Factory Functions
- `createConnection(options)` - Create instance (not connected)
- `connect(options)` - Create and connect in one call

### Connection Options
```typescript
interface ConnectionOptions {
  uri: string;           // e.g., 'neo4j://localhost:7687'
  username?: string;
  password?: string;
  maxRetries?: number;   // default: 3
  retryDelayMs?: number; // default: 1000
  connectionTimeoutMs?: number; // default: 30000
  debug?: boolean;       // default: false
}
```

## Value Transformation
- Neo4j Integer → JavaScript number
- Neo4j Node → `{ elementId, labels, properties }`
- Neo4j Relationship → `{ elementId, type, startNodeElementId, endNodeElementId, properties }`

## Error Mapping
- `ServiceUnavailable` / connection errors → `POSIX_ERRORS.ENOENT`
- Other database errors → `POSIX_ERRORS.EIO`

## Query Functions (src/db/queries.ts)

### getLabels(db, cache?)
Get all node labels: `CALL db.labels() YIELD label RETURN label`

### getNodesByLabel(db, label, config?, cache?)
Get all nodes of a label with display names:
- Respects naming config (elementId vs property strategy)
- Applies collision handling automatically
- Returns `NodeQueryResult[]` with name, elementId, properties
- Uses backticks to escape label names: `MATCH (n:\`Label\`)`

### Naming Strategy Logic
- Check for per-label override in `config.naming.overrides.nodes[label]`
- If override exists, use 'property' strategy with specified property
- Otherwise, use `config.naming.default` strategy
- If property naming used but property missing, fall back to elementId

### getNodeProperties(db, label, name, config?, cache?)
Get single node properties by display name:
- Returns `NodePropertiesResult` with `_elementId` plus all properties
- Returns `null` if node not found
- Reuses `getNodesByLabel()` for consistent naming logic
- Handles both naming strategies transparently

### getRelationshipTypes(db, label, name, config?, cache?)
Get distinct relationship types for a node:
- Returns `string[]` of type names (e.g., `['KNOWS', 'WORKS_AT']`)
- Returns empty array if node not found or has no relationships
- Queries both outgoing and incoming relationships combined
- Uses parameterized Cypher: `MATCH (n)-[r]-() WHERE elementId(n) = $elementId RETURN DISTINCT type(r)`

### getRelationships(db, label, name, relType, direction, config?, cache?)
Get relationships of specific type and direction:
- Returns `RelationshipQueryResult[]` with target node info and relationship properties
- Direction 'OUT': `(n)-[r:TYPE]->(m)` where n is source
- Direction 'IN': `(n)<-[r:TYPE]-(m)` where n is source
- Target names use target label's naming strategy (supports cross-label)
- Handles collision resolution per target label group
- Uses backticks to escape type names: `[r:\`KNOWS\`]`
- First label used as primary when target has multiple labels

### getRelationshipProperties(db, relElementId, cache?)
Get relationship properties by elementId:
- Returns `RelationshipPropertiesResult` with `_elementId` plus all properties
- Returns `null` if relationship not found
- Uses: `MATCH ()-[r]-() WHERE elementId(r) = $relElementId RETURN elementId(r), properties(r) LIMIT 1`
- No naming strategy needed - always looked up by elementId
