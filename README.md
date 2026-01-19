# LPGFS - Labeled Property Graph Filesystem

A read-only virtual filesystem that presents a Neo4j graph database as a native filesystem hierarchy. Navigate your graph data using standard Unix tools like `ls`, `cat`, `readlink`, and `find`.

## Features

- Browse graph nodes as directories organized by label
- View node and relationship properties as JSON files
- Follow relationships via symbolic links
- Support for cross-label relationships
- Configurable naming strategies (elementId or property-based)
- In-memory caching with configurable TTL

## Requirements

- Node.js >= 18.0.0
- FUSE libraries installed on your system:
  - **Linux**: `sudo apt-get install libfuse-dev` (Debian/Ubuntu) or equivalent
  - **macOS**: Install [macFUSE](https://osxfuse.github.io/)
- Neo4j database (tested with Neo4j 5.x)

## Installation

```bash
npm install lpgfs
```

Or build from source:

```bash
git clone <repository>
cd lpgfs
npm install
npm run build
```

## Quick Start

1. **Create a mount directory:**

```bash
mkdir ~/graph-mount
```

2. **Mount the filesystem:**

```bash
lpgfs mount ~/graph-mount --db neo4j://localhost:7687 --user neo4j --password secret --foreground
```

3. **Explore your graph:**

```bash
# List all node labels
ls ~/graph-mount/

# List all Person nodes
ls ~/graph-mount/Person/

# View a node's properties
cat ~/graph-mount/Person/alice/.properties.json

# List relationships for a node
ls ~/graph-mount/Person/alice/

# Follow a relationship
ls ~/graph-mount/Person/alice/KNOWS/OUT/

# View relationship properties
cat ~/graph-mount/Person/alice/KNOWS/OUT/.james.json

# Follow the symlink to the target node
readlink ~/graph-mount/Person/alice/KNOWS/OUT/james
```

4. **Unmount when done:**

```bash
lpgfs unmount ~/graph-mount
# Or press Ctrl+C if running in foreground
```

## Filesystem Structure

```
/                           # Root: list of all node labels
├── .lpgfs.yaml             # Active configuration (read-only)
├── Person/                 # Label directory
│   ├── alice/              # Node directory
│   │   ├── .properties.json    # Node properties
│   │   ├── KNOWS/              # Relationship type
│   │   │   ├── OUT/            # Outgoing relationships
│   │   │   │   ├── james       # Symlink to target node
│   │   │   │   └── .james.json # Relationship properties
│   │   │   └── IN/             # Incoming relationships
│   │   │       └── carol       # Symlink from source node
│   │   └── WORKS_AT/
│   │       └── OUT/
│   │           └── acme    # Cross-label symlink to Company/acme
│   └── james/
└── Company/
    └── acme/
```

## CLI Reference

### Mount Command

```bash
lpgfs mount <mountpoint> [options]
```

**Options:**

| Option | Default | Description |
|--------|---------|-------------|
| `--db <uri>` | `neo4j://localhost:7687` | Database connection URI |
| `--user <name>` | - | Database username |
| `--password <pass>` | - | Database password |
| `--config <path>` | `./.lpgfs.yaml` | Path to configuration file |
| `--cache-ttl <seconds>` | `10` | Cache time-to-live in seconds |
| `--allow-other` | `false` | Allow other users to access mount |
| `--debug` | `false` | Enable verbose logging |
| `--foreground` | `false` | Run in foreground (required currently) |

### Unmount Command

```bash
lpgfs unmount <mountpoint>
```

## Configuration

Create a `.lpgfs.yaml` file to customize behavior:

```yaml
# Naming strategy for directories
naming:
  # Default: 'elementId' (stable, unique) or 'property' (human-readable)
  default: property
  overrides:
    nodes:
      Person:
        property: "username"    # Use username property for Person nodes
      Company:
        property: "name"        # Use name property for Company nodes

# Character sanitization for filenames
sanitization:
  replace:
    "/": "_"
    "\\": "_"
    ":": "_"
    "*": "_"
    "?": "_"
    '"': "_"
    "<": "_"
    ">": "_"
    "|": "_"

# Collision handling when property names clash
collision:
  strategy: suffix_elementId    # Append _<elementId> to duplicates
  # Or: strategy: fail          # Raise error on collision
```

### Naming Strategies

- **elementId** (default): Uses the Neo4j element ID (e.g., `4_abc123_0`). Guaranteed unique and stable.
- **property**: Uses a specified property value (e.g., `alice`). More human-readable but may require collision handling.

## Examples

### Multi-hop Traversal

Find friends of friends:

```bash
# Alice's friends
ls ~/graph-mount/Person/alice/KNOWS/OUT/

# Follow symlink to james, then see his friends
cat "$(readlink -f ~/graph-mount/Person/alice/KNOWS/OUT/james)/../KNOWS/OUT/"
```

### Reverse Traversal

Find who knows Alice:

```bash
ls ~/graph-mount/Person/alice/KNOWS/IN/
```

### Cross-label Relationships

Find where Alice works:

```bash
readlink ~/graph-mount/Person/alice/WORKS_AT/OUT/acme
# Output: ../../../../Company/Acme_Corp
```

### Query with Unix Tools

Find all nodes with a specific property:

```bash
grep -r "Engineer" ~/graph-mount/Person/*/.properties.json
```

List all relationship types in the graph:

```bash
find ~/graph-mount -mindepth 3 -maxdepth 3 -type d
```

## Edge Cases

### Multiple Relationships of Same Type

When multiple relationships of the same type exist between nodes, suffixes are added:

```bash
ls ~/graph-mount/Person/alice/TRANSFERRED/OUT/
# james        (first relationship)
# james_1      (second relationship)
# james_2      (third relationship)
```

### Self-referential Relationships

Nodes can have relationships to themselves:

```bash
ls ~/graph-mount/Person/alice/MANAGES/OUT/
# alice -> ../../../alice
```

### Nodes Without Relationships

Nodes with no relationships show only `.properties.json`:

```bash
ls ~/graph-mount/Person/newuser/
# .properties.json
```

## Limitations

- **Read-only**: All write operations return `EROFS` (Read-only filesystem)
- **No real-time updates**: Changes to the database require cache expiration or remount
- **Large graphs**: Performance depends on database query time and caching

## Development

```bash
# Type check
npm run tsc

# Run tests
npm test

# Build
npm run build
```

## License

MIT
