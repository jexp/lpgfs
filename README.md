# LPGFS - Labeled Property Graph Filesystem

A read-only virtual filesystem that presents a Neo4j graph database as a native filesystem hierarchy. Navigate your graph data using standard Unix tools like `ls`, `cat`, `readlink`, and `find`.

## Features

- Browse graph nodes as directories organized by label
- View node and relationship properties as JSON files
- Follow relationships via symbolic links
- Support for cross-label relationships
- Configurable naming strategies (elementId or property-based)
- In-memory caching with configurable TTL

## Platform Support

LPGFS runs in Docker on all platforms:

- ✅ **Linux**: Docker
- ✅ **macOS**: Docker
- ✅ **Windows**: Docker

## Requirements

- Docker Desktop (or equivalent)
- Neo4j database accessible from Docker (tested with Neo4j 5.x)

## Quick Start

1. **Start the Docker container:**

```bash
./docker/run.sh
```

2. **Inside the container, mount the filesystem:**

```bash
node dist/cli/index.js mount ~/graph-mount \
  --db neo4j://host.docker.internal:7687 \
  --user neo4j \
  --password YOUR_PASSWORD \
  --foreground
```

3. **In another terminal, explore the filesystem:**

```bash
# Get the container ID
docker ps

# Exec into the container
docker exec -it <container-id> bash

# Now explore
ls ~/graph-mount/
cat ~/graph-mount/Person/alice/.properties.json | jq .
```

4. **Unmount:**
   - Press `Ctrl+C` in the mount terminal
   - Exit the container with `Ctrl+D` or `exit`

**Connection Notes:**
- Use `host.docker.internal:7687` to connect to Neo4j on your host (macOS/Windows)
- On Linux, use `--network=host` or your host IP address
- Ensure Neo4j allows remote connections: `dbms.connector.bolt.listen_address=0.0.0.0:7687` in neo4j.conf

## Filesystem Structure

The filesystem below is an example, the actual nodes etc depends on what's in your database.

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

## Troubleshooting

### Common Errors

**"Cannot connect to database"**
- Verify Neo4j is running: `neo4j status`
- Check connection URI matches your Neo4j configuration
- Verify credentials with: `cypher-shell -u <user> -p <password>`
- Test connection: `curl http://localhost:7474` (default HTTP port)
- **Docker**: Use `host.docker.internal:7687` and ensure Neo4j allows remote connections

**"Permission denied" errors**
- The Docker container runs with `--privileged` flag for FUSE support
- Ensure Docker has necessary permissions on your system

**Container doesn't start or exits immediately**
- Check Docker logs: `docker logs <container-id>`
- Ensure Docker Desktop is running
- Try rebuilding: `docker build --platform=linux/amd64 -f docker/Dockerfile -t lpgfs-test .`

**Mount hangs or times out**
- Check database connectivity before mounting
- Enable debug mode: `--debug` to see detailed logs
- Verify Neo4j is accessible from within container

**Empty .properties.json files**
- This was a bug in early versions, fixed in current version
- Rebuild: `npm run build` or rebuild Docker image

### Debug Mode

Add `--debug` flag for detailed logging:

```bash
node dist/cli/index.js mount ~/graph-mount \
  --db neo4j://host.docker.internal:7687 \
  --user neo4j \
  --password YOUR_PASSWORD \
  --foreground \
  --debug
```

This shows:
- Configuration loading
- Database connection attempts
- FUSE operation timings
- Error details and stack traces

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
