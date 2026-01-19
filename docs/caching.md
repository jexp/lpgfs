# Caching Layer

## Cache Class (src/cache/index.ts)
Wraps lru-cache with automatic TTL-based expiration:
- Uses `ttlAutopurge: true` for automatic cleanup
- Methods: `get<T>(key)`, `set<T>(key, value, ttlSeconds?)`, `has(key)`, `delete(key)`, `clear()`
- `get()` returns `undefined` on cache miss (not `null`)
- TTL determined per-entry based on key prefix

## Cache Key Builder
- `cacheKey.labels()` → `"labels"`
- `cacheKey.nodes(label)` → `"nodes:Person"`
- `cacheKey.props(elementId)` → `"props:4:abc:0"`
- `cacheKey.reltypes(elementId)` → `"reltypes:4:abc:0"`
- `cacheKey.rels(elementId, relType, direction)` → `"rels:4:abc:0:KNOWS:OUT"`

## Default TTL Values
- labels: 60s
- nodes: 30s
- properties: 10s
- relationships: 10s
- symlinks: 60s

## lru-cache Type Constraint
- lru-cache v11 requires value types extending `{}`
- Workaround: Use wrapper type `{ data: unknown }` internally
- Transparent to API consumer

## Query Integration
All query functions accept optional `cache?: Cache`:
- `getLabels(db, cache?)` - caches with key `labels` (60s)
- `getNodesByLabel(db, label, config?, cache?)` - caches with key `nodes:Label` (30s)
- `getNodeProperties(db, label, name, config?, cache?)` - uses getNodesByLabel's cache
- `getRelationshipTypes(db, label, name, config?, cache?)` - caches with key `reltypes:elementId` (10s)
- `getRelationships(db, label, name, relType, direction, config?, cache?)` - caches with key `rels:elementId:relType:direction` (10s)
- `getRelationshipProperties(db, relElementId, cache?)` - caches with key `props:elementId` (10s)

**Pattern:**
1. Check cache first
2. If hit, return cached value
3. If miss, execute DB query
4. Store result in cache (including empty/null)
5. Return result

**Usage:**
```typescript
import { createCache } from './cache/index.js';
import { getLabels } from './db/queries.js';

const cache = createCache({ debug: true });
const labels = await getLabels(db, cache);
const labelsCached = await getLabels(db, cache); // Returns cached
```
