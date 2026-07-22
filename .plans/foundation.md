# Product Requirements Document: LPGFS

**Labeled Property Graph Filesystem**

Version 1.0 | Draft

---

## 1. Executive Summary

LPGFS (Labeled Property Graph Filesystem) is a **read-only virtual filesystem** that presents graph database structures as a native filesystem hierarchy. Implemented using FUSE, it allows users to browse and query graph data using standard filesystem tools (ls, cat, find, grep) without copying data to disk.

The core insight is that graph traversal patterns map naturally to filesystem navigation: labels become directories, nodes become subdirectories, relationships become symlinks, and properties become JSON files. The database remains the single source of truth.

---

## 2. Problem Statement

### 2.1 Current Challenges

- Graph databases store data in formats optimized for query engines, not human readability
- Exporting graph data to flat files (CSV, JSON) loses traversal semantics
- Version control of graph data requires custom tooling
- Human supervision of automated graph modifications is difficult
- Integration with filesystem-based tools (grep, find, git) is not possible

### 2.2 Goals

- Enable native filesystem traversal that mirrors graph traversal
- Preserve all graph semantics: labels, properties, relationship types, and direction
- Support human-readable filenames while maintaining stable identity via elementIds
- Provide a read-only virtual filesystem backed by a live database
- Integrate with standard filesystem tools (ls, cat, find, grep, etc.)

### 2.3 Non-Goals (Current Version)

- Write operations (create, update, delete) — planned for future versions
- Replacing graph database query engines for complex queries
- Real-time cache invalidation from database change streams
- Supporting hypergraphs or property graph extensions

---

## 3. Design Principles

| Principle | Description |
|-----------|-------------|
| Traversal is Navigation | Following a relationship should be equivalent to following a symlink |
| Structure over Content | Direction and relationship type are encoded in path structure, not file content |
| Identity vs. Convenience | ElementIds provide stable identity; filenames provide human convenience |
| Canonical Ownership | Each piece of data has exactly one canonical location; other references point to it |
| Filesystem-Native | Operations should work with standard tools: ls, cat, find, grep, git |

---

## 4. Architecture Overview

### 4.1 Directory Hierarchy

The root of an LPGFS filesystem contains one directory per node label. Each label directory contains one subdirectory per node of that label.

```
/                           # LPGFS root
├── Person/                 # Node label
│   ├── alice/              # Node (named by config)
│   │   ├── .properties.json
│   │   └── KNOWS/          # Relationship type
│   │       ├── OUT/        # Outgoing relationships
│   │       │   ├── james   # Symlink to target node
│   │       │   └── .james.json  # Relationship properties
│   │       └── IN/         # Incoming relationships
│   │           ├── bob
│   │           └── .bob.json
│   └── james/
│       └── ...
└── Company/
    └── acme/
        └── ...
```

### 4.2 Component Summary

| Component | Filesystem Representation | Example |
|-----------|---------------------------|---------|
| Node Label | Top-level directory | `/Person/` |
| Node | Directory within label | `/Person/alice/` |
| Node Properties | Hidden JSON file | `/Person/alice/.properties.json` |
| Relationship Type | Directory within node | `/Person/alice/KNOWS/` |
| Direction | Subdirectory (OUT/IN) | `/Person/alice/KNOWS/OUT/` |
| Relationship Target | Symlink | `/Person/alice/KNOWS/OUT/james → ../../../james` |
| Relationship Properties | Hidden JSON file | `/Person/alice/KNOWS/OUT/.james.json` |

---

## 5. Detailed Specifications

### 5.1 Node Properties File

Each node has a `.properties.json` file containing all node properties plus the stable elementId.

**Location:** `/[Label]/[node-name]/.properties.json`

**Structure:**

```json
{
  "_elementId": "4:abc123:0",
  "name": "Alice",
  "age": 30,
  "email": "alice@example.com"
}
```

**Rules:**

- The `_elementId` field is required and must match the database elementId
- All other fields are node properties from the graph database
- Property values must be JSON-serializable (strings, numbers, booleans, arrays, objects)
- The file uses a leading dot to keep directory listings clean

### 5.2 Relationship Structure

Relationships are represented as a combination of directories, symlinks, and property files.

#### 5.2.1 Relationship Type Directory

Each relationship type used by a node gets its own directory within the node directory.

**Location:** `/[Label]/[node-name]/[REL_TYPE]/`

**Example:**

```
/Person/alice/
├── KNOWS/
├── WORKS_AT/
└── LIVES_IN/
```

#### 5.2.2 Direction Subdirectories

Each relationship type directory contains `OUT/` and `IN/` subdirectories to indicate relationship direction.

| Directory | Meaning | Contains |
|-----------|---------|----------|
| `OUT/` | Outgoing relationships | Relationships where this node is the start node |
| `IN/` | Incoming relationships | Relationships where this node is the end node |

**Example:**

```
/Person/alice/KNOWS/
├── OUT/          # Alice KNOWS these people
│   ├── james
│   └── .james.json
└── IN/           # These people KNOW Alice
    ├── bob
    └── .bob.json
```

#### 5.2.3 Relationship Symlinks

The actual relationship is represented as a symlink pointing to the target node directory.

**Location:** `/[Label]/[node-name]/[REL_TYPE]/[OUT|IN]/[target-name]`

**Symlink Target:** Relative path to the target node directory

**Example:**

```bash
# Alice knows James
/Person/alice/KNOWS/OUT/james → ../../../james

# Following the symlink
$ cat /Person/alice/KNOWS/OUT/james/.properties.json
# Returns James's properties
```

#### 5.2.4 Relationship Properties

Relationship properties are stored in hidden JSON files alongside the symlinks.

**Canonical Location (OUT side):**

```
/Person/alice/KNOWS/OUT/.james.json
```

```json
{
  "_elementId": "5:abc123:7",
  "since": 2020,
  "strength": "close"
}
```

**Reference Location (IN side):**

```
/Person/james/KNOWS/IN/.alice.json
```

```json
{
  "_ref": "5:abc123:7"
}
```

**Canonical Ownership Rule:**

- Relationship properties are stored canonically on the OUT side
- The IN side contains only a `_ref` field pointing to the canonical elementId
- This prevents data duplication and sync conflicts
- Tools should follow `_ref` to resolve full relationship properties

### 5.3 Naming Configuration

Node directory names can be configured via a `.lpgfs.yaml` file at the filesystem root.

**Location:** `/.lpgfs.yaml`

**Structure:**

```yaml
naming:
  default: elementId

  overrides:
    nodes:
      Person:
        property: "username"
      Product:
        property: "sku"
      Order:
        property: "orderId"
    relationships:
      KNOWS: elementId  # explicit default

sanitization:
  # Characters to replace in property values used as filenames
  replace:
    "/": "_"
    "\\": "_"
    "\0": "_"

collision:
  # Strategy when property values collide
  strategy: "suffix_elementId"  # or "fail"
```

**Naming Strategies:**

| Strategy | Example Filename | Pros | Cons |
|----------|------------------|------|------|
| elementId | `4_abc123_0/` | Guaranteed unique, stable | Not human-readable |
| property | `alice/` | Human-readable, git-friendly | Must be unique, changes require rename |

**Collision Handling:**

- `suffix_elementId`: Creates `alice_4abc1230/` when collision detected
- `fail`: Raises error, requires manual resolution

---

## 6. Traversal Examples

The following examples demonstrate how graph traversals map to filesystem operations.

### 6.1 Basic Navigation

```bash
# Get Alice's properties
cat /Person/alice/.properties.json

# List Alice's outgoing KNOWS relationships
ls /Person/alice/KNOWS/OUT/

# Get James's age via traversal (Alice → James)
cat /Person/alice/KNOWS/OUT/james/.properties.json | jq .age

# Get the KNOWS relationship properties
cat /Person/alice/KNOWS/OUT/.james.json
```

### 6.2 Multi-Hop Traversal

```bash
# Find where Alice's friend James works
cat /Person/alice/KNOWS/OUT/james/WORKS_AT/OUT/*/.properties.json

# Chain: Alice → KNOWS → James → WORKS_AT → Acme
cat /Person/alice/KNOWS/OUT/james/WORKS_AT/OUT/acme/.properties.json
```

### 6.3 Reverse Traversal

```bash
# Who knows Alice? (incoming KNOWS)
ls /Person/alice/KNOWS/IN/

# Get properties of people who know Alice
for person in /Person/alice/KNOWS/IN/*; do
  cat "$person/.properties.json"
done
```

### 6.4 Finding Patterns

```bash
# Find all WORKS_AT relationships
find . -type d -name "WORKS_AT"

# Find all nodes with age > 30
grep -r '"age":' --include='.properties.json' | \
  jq -s '[.[] | select(.age > 30)]'

# Find relationships created in 2020
grep -r '"since": 2020' --include='*.json'
```

---

## 7. Cross-Label Relationships

Relationships can connect nodes of different labels. The symlink path simply crosses label directories.

**Example: Person WORKS_AT Company**

```
/Person/alice/WORKS_AT/OUT/acme → ../../../Company/acme
```

**Directory structure:**

```
/
├── Person/
│   └── alice/
│       ├── .properties.json
│       └── WORKS_AT/
│           └── OUT/
│               ├── acme → ../../../Company/acme
│               └── .acme.json
└── Company/
    └── acme/
        ├── .properties.json
        └── WORKS_AT/
            └── IN/
                ├── alice → ../../../Person/alice
                └── .alice.json  # Contains _ref
```

---

## 8. Edge Cases and Special Handling

### 8.1 Multiple Relationships of Same Type

When multiple relationships of the same type exist between the same nodes (e.g., multiple TRANSFERRED relationships between accounts), use a suffix strategy.

```
/Account/checking/TRANSFERRED/OUT/
├── savings_1               # First transfer
├── .savings_1.json         # {"_elementId": "...", "amount": 100}
├── savings_2               # Second transfer
└── .savings_2.json         # {"_elementId": "...", "amount": 250}
```

### 8.2 Self-Referential Relationships

A node can have a relationship to itself.

```
/Person/alice/MANAGES/OUT/
├── alice → ../../../alice  # Alice manages herself (edge case)
└── .alice.json
```

### 8.3 Nodes with No Relationships

Nodes without relationships simply have no relationship type directories.

```
/Person/newuser/
└── .properties.json        # Only properties, no relationships
```

### 8.4 Property Value Sanitization

When using property values as filenames, certain characters must be sanitized.

| Character | Replacement | Reason |
|-----------|-------------|--------|
| `/` | `_` | Path separator |
| `\` | `_` | Escape character |
| `\0` | `_` | Null byte |
| `:` | `_` | Windows path issues |
| `*?\"<>\|` | `_` | Filesystem restrictions |

---

## 9. Data Flow

### 9.1 Read Operations

The filesystem is **read-only** and operates as a live view of the database:

```
┌─────────────┐      ┌─────────────┐      ┌─────────────┐
│  User       │ ---> │  LPGFS      │ ---> │  Database   │
│  (ls, cat)  │      │  (Query)    │      │  (Source)   │
└─────────────┘      └─────────────┘      └─────────────┘
                            │
                            ▼
                     ┌─────────────┐
                     │  Cache      │
                     │  (Optional) │
                     └─────────────┘
```

- All data originates from the database
- Filesystem reflects current database state (subject to cache TTL)
- No data is persisted to disk
- Database modifications are immediately visible after cache expiration

### 9.2 Cache Behavior

- Cached data expires based on `--cache-ttl` setting
- Cache is in-memory only
- Unmounting clears all cached data
- No cache invalidation from database (polling-based freshness)

---

## 10. File Format Reference

### 10.1 .properties.json (Node)

```json
{
  "_elementId": "<database-element-id>",
  "<property1>": "<value>",
  "<property2>": "<value>"
}
```

### 10.2 Relationship Properties (Canonical - OUT side)

```json
{
  "_elementId": "<relationship-element-id>",
  "<property1>": "<value>",
  "<property2>": "<value>"
}
```

### 10.3 Relationship Reference (IN side)

```json
{
  "_ref": "<relationship-element-id>"
}
```

### 10.4 .lpgfs.yaml (Configuration)

```yaml
naming:
  default: elementId | property
  overrides:
    nodes:
      <Label>:
        property: "<property-name>"
    relationships:
      <REL_TYPE>: elementId | property

sanitization:
  replace:
    "<char>": "<replacement>"

collision:
  strategy: suffix_elementId | fail
```

---

## 11. Tooling Integration

### 11.1 Standard Unix Tools

| Tool | Use Case | Example |
|------|----------|---------|
| `ls` | List relationships/nodes | `ls Person/alice/KNOWS/OUT/` |
| `cat` | Read properties | `cat Person/alice/.properties.json` |
| `find` | Search structure | `find . -name 'WORKS_AT' -type d` |
| `grep` | Search content | `grep -r '"age": 30'` |
| `jq` | JSON processing | `cat .properties.json \| jq .name` |
| `tree` | Visualize structure | `tree -L 3 Person/` |
| `wc` | Count nodes/relationships | `ls Person/ \| wc -l` |

### 11.2 Programmatic Access

Any language with filesystem and JSON support can traverse the graph:

```python
# Python example
import os, json
from pathlib import Path

def get_friends(person_name):
    knows_dir = Path(f'Person/{person_name}/KNOWS/OUT')
    friends = []
    for link in knows_dir.iterdir():
        if not link.name.startswith('.'):
            props = json.loads(
                (link / '.properties.json').read_text()
            )
            friends.append(props)
    return friends
```

### 11.3 Shell Scripting

Complex queries can be composed using shell pipelines:

```bash
# Find all people over 30 who work at companies founded before 2000
for person in /mnt/graph/Person/*/; do
  age=$(cat "$person/.properties.json" | jq -r '.age')
  if [ "$age" -gt 30 ]; then
    for company in "$person/WORKS_AT/OUT/"*/; do
      founded=$(cat "$company/.properties.json" | jq -r '.founded')
      if [ "$founded" -lt 2000 ]; then
        echo "$(basename $person) works at $(basename $company)"
      fi
    done
  fi
done
```

---

## 12. Implementation Architecture

LPGFS is implemented as a **virtual filesystem** using FUSE (Filesystem in Userspace). The graph database remains the single source of truth — no data is copied to disk. Filesystem operations are translated to database queries on-demand.

### 12.1 Architecture Overview

```
┌─────────────────────────┐
│  User/Application       │  ← ls, cat, find, etc.
└───────────┬─────────────┘
            │ POSIX syscalls
            ▼
┌─────────────────────────┐
│  Linux VFS              │
└───────────┬─────────────┘
            │
            ▼
┌─────────────────────────┐
│  FUSE Kernel Module     │
└───────────┬─────────────┘
            │ /dev/fuse
            ▼
┌─────────────────────────┐
│  LPGFS Daemon           │  ← Your implementation
│  (Node.js / Bun / Rust) │
└───────────┬─────────────┘
            │ Bolt protocol
            ▼
┌─────────────────────────┐
│  Graph Database         │  ← Neo4j, Memgraph, etc.
│  (Source of Truth)      │
└─────────────────────────┘
```

### 12.2 FUSE Operations Mapping

The LPGFS daemon implements FUSE callbacks that translate filesystem operations to Cypher queries.

| FUSE Operation | Filesystem Command | Cypher Query |
|----------------|-------------------|--------------|
| `readdir(path)` | `ls /Person/` | `MATCH (n:Person) RETURN n.username, elementId(n)` |
| `readdir(path)` | `ls /Person/alice/` | `MATCH (n:Person {username:'alice'})-[r]-() RETURN DISTINCT type(r)` |
| `readdir(path)` | `ls /Person/alice/KNOWS/OUT/` | `MATCH (n:Person {username:'alice'})-[r:KNOWS]->(m) RETURN m, elementId(r)` |
| `getattr(path)` | `stat /Person/alice` | Determine if path is dir, file, or symlink |
| `readlink(path)` | `readlink .../OUT/james` | Return relative path `../../../james` |
| `read(path)` | `cat .../. properties.json` | `MATCH (n:Person {username:'alice'}) RETURN properties(n), elementId(n)` |
| `read(path)` | `cat .../.james.json` | `MATCH ()-[r]->() WHERE elementId(r)='...' RETURN properties(r)` |

> **Note:** Write operations (create, update, delete) are not supported in the current version. The filesystem is read-only.

### 12.3 Path Resolution

The daemon must parse filesystem paths and determine the context:

```typescript
interface PathContext {
  type: 'root' | 'label' | 'node' | 'reltype' | 'direction' | 'target' | 'properties';
  label?: string;           // e.g., "Person"
  nodeName?: string;        // e.g., "alice"
  relType?: string;         // e.g., "KNOWS"
  direction?: 'OUT' | 'IN';
  targetName?: string;      // e.g., "james"
  isPropertiesFile?: boolean;
  isRelPropertiesFile?: boolean;
}

// Examples:
// /Person                         → { type: 'label', label: 'Person' }
// /Person/alice                   → { type: 'node', label: 'Person', nodeName: 'alice' }
// /Person/alice/.properties.json  → { type: 'properties', ..., isPropertiesFile: true }
// /Person/alice/KNOWS             → { type: 'reltype', ..., relType: 'KNOWS' }
// /Person/alice/KNOWS/OUT         → { type: 'direction', ..., direction: 'OUT' }
// /Person/alice/KNOWS/OUT/james   → { type: 'target', ..., targetName: 'james' }
// /Person/alice/KNOWS/OUT/.james.json → { type: 'properties', ..., isRelPropertiesFile: true }
```

### 12.4 Caching Strategy

To avoid excessive database queries, implement a caching layer:

| Cache Type | TTL | Invalidation |
|------------|-----|--------------|
| Label list | 60s | On any write operation |
| Node existence | 30s | On node create/delete |
| Node properties | 10s | On property write |
| Relationship list | 10s | On relationship create/delete |
| Symlink targets | 60s | On relationship delete |

**Cache key examples:**

```
labels                          → ["Person", "Company"]
nodes:Person                    → ["alice", "james", "bob"]
props:4:abc:0                   → {"name": "Alice", "age": 30}
rels:4:abc:0:KNOWS:OUT          → [{"name": "james", "elementId": "..."}]
```

### 12.5 Implementation Stack

**Recommended:**

| Component | Technology | Rationale |
|-----------|------------|-----------|
| FUSE bindings | `fuse-native` (Node.js) | Mature, well-documented |
| Runtime | Node.js or Bun | JavaScript ecosystem, async I/O |
| DB Driver | `neo4j-driver` | Official, supports Bolt protocol |
| Config parsing | `yaml` | For .lpgfs.yaml |
| Caching | `lru-cache` | In-memory with TTL |

**Alternative (higher performance):**

| Component | Technology | Rationale |
|-----------|------------|-----------|
| FUSE bindings | `fuser` (Rust) | Better performance, type safety |
| Runtime | Rust | No GC pauses, lower latency |
| DB Driver | `neo4rs` | Async Rust driver |

### 12.6 Daemon Lifecycle

```bash
# Mount the filesystem
lpgfs mount ./mnt --db neo4j://localhost:7687 --config .lpgfs.yaml

# Filesystem is now available
ls ./mnt/Person/

# Unmount
lpgfs unmount ./mnt
# or
fusermount -u ./mnt
```

**Daemon responsibilities:**

1. Parse configuration file
2. Establish database connection pool
3. Register FUSE handlers
4. Mount filesystem at specified path
5. Handle signals (SIGTERM, SIGINT) for clean unmount
6. Maintain cache and connection health

### 12.7 Mount Options

```bash
lpgfs mount <mountpoint> [options]
```

| Option | Description | Default |
|--------|-------------|---------|
| `--db <uri>` | Database connection URI | `neo4j://localhost:7687` |
| `--config <path>` | Path to `.lpgfs.yaml` | `./.lpgfs.yaml` |
| `--cache-ttl <seconds>` | Cache time-to-live | `10` |
| `--allow-other` | Allow other users to access mount | `false` |
| `--debug` | Verbose logging of FUSE operations | `false` |
| `--foreground` | Run in foreground (don't daemonize) | `false` |
| `--user <name>` | Database username | - |
| `--password <pass>` | Database password | - |

> **Note:** The filesystem is read-only. All write operations return `EROFS` (Read-only filesystem).

**Example:**

```bash
lpgfs mount /mnt/graph \
  --db neo4j://prod-server:7687 \
  --config ./prod.lpgfs.yaml \
  --cache-ttl 30 \
  --allow-other
```

### 12.8 Error Handling

Filesystem operations must return appropriate POSIX error codes:

| Scenario | Error Code | Meaning |
|----------|------------|---------|
| Node not found | `ENOENT` | No such file or directory |
| Invalid path | `ENOENT` | No such file or directory |
| Database timeout | `EIO` | I/O error |
| Database connection lost | `EIO` | I/O error (with reconnect attempt) |
| Any write operation | `EROFS` | Read-only filesystem |

---

## 13. Future Considerations

- **Write operations** — Support for creating nodes (`mkdir`), relationships (`ln -s`), and updating properties (`echo >`)
- Index directories for property-based lookups (e.g., `/indexes/Person/age/30/`)
- Database change streams for real-time cache invalidation
- Schema validation based on graph constraints
- Compression for large property values
- Multi-database support (mount multiple graphs at different paths)
- Access control integration with database permissions
- Snapshot/export mode for offline access
- Query logging and profiling for performance optimization

---

## Appendix A: Complete Example

A social network with Person and Company nodes:

```
my-graph/
├── .lpgfs.yaml
├── Person/
│   ├── alice/
│   │   ├── .properties.json
│   │   │   # {"_elementId": "4:abc:0", "name": "Alice", "age": 30}
│   │   ├── KNOWS/
│   │   │   ├── OUT/
│   │   │   │   ├── james → ../../../james
│   │   │   │   ├── .james.json
│   │   │   │   │   # {"_elementId": "5:abc:7", "since": 2020}
│   │   │   │   ├── bob → ../../../bob
│   │   │   │   └── .bob.json
│   │   │   │       # {"_elementId": "5:abc:8", "since": 2018}
│   │   │   └── IN/
│   │   │       ├── carol → ../../../carol
│   │   │       └── .carol.json
│   │   │           # {"_ref": "5:abc:9"}
│   │   └── WORKS_AT/
│   │       └── OUT/
│   │           ├── acme → ../../../Company/acme
│   │           └── .acme.json
│   │               # {"_elementId": "5:abc:10", "role": "Engineer"}
│   ├── james/
│   │   ├── .properties.json
│   │   │   # {"_elementId": "4:abc:1", "name": "James", "age": 28}
│   │   └── KNOWS/
│   │       └── IN/
│   │           ├── alice → ../../../alice
│   │           └── .alice.json
│   │               # {"_ref": "5:abc:7"}
│   ├── bob/
│   │   └── ...
│   └── carol/
│       └── ...
└── Company/
    └── acme/
        ├── .properties.json
        │   # {"_elementId": "4:xyz:0", "name": "Acme Corp", "founded": 1990}
        └── WORKS_AT/
            └── IN/
                ├── alice → ../../../Person/alice
                └── .alice.json
                    # {"_ref": "5:abc:10"}
```

---

*— End of Document —*
