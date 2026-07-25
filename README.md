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

## Markdown Mode

Markdown mode renders the graph as an [Obsidian](https://obsidian.md)-compatible, [OKF](https://github.com/google/open-knowledge-format) v0.1-conformant markdown vault instead of the classic label/node/relationship directory hierarchy: every node becomes a `.md` file with YAML frontmatter, and each label becomes a folder.

### Enabling markdown mode

Either pass the CLI flag, which overrides the config file:

```bash
node dist/cli/index.js mount ~/graph-mount \
  --db neo4j://host.docker.internal:7687 \
  --user neo4j \
  --password YOUR_PASSWORD \
  --mode markdown \
  --foreground
```

or set it in `.lpgfs.yaml`:

```yaml
mode:
  type: markdown
```

The default is `classic` (unchanged existing behavior). `--mode` accepts `classic` or `markdown` and always wins over `mode.type` in the config file when passed.

### Filesystem structure

```
/                           # Root: one directory per rendered label
├── index.md                # Generated OKF bundle index (see below)
├── log.md                  # Generated, date-grouped node-update log
├── Character/
│   ├── index.md            # Generated per-label concept listing
│   ├── Odysseus.md          # Node file: /<Label>/<name>.md
│   └── Penelope.md
└── Place/
    ├── index.md
    └── Ithaca.md
```

A node's filename comes from the existing naming subsystem (naming strategy, per-label overrides, sanitization, collision handling), so `mode.markdown.labels` and `naming.overrides.nodes` compose the same way they do in classic mode. Multi-label nodes render once, under their first configured (or first alphabetical) label — REQ-F-014 — so a `Character`+`Hero` node never appears twice.

**Current limitation:** `index.md`, `log.md`, and each label's `index.md` are fully readable by path today (`cat`/`open`/any tool that opens the file directly works, and `getattr` reports the correct size) but are **not yet listed by `readdir`** — `ls /` and `ls /<Label>/` only show label directories and node files, not the generated index/log files. Listing them in `readdir` is tracked as a follow-up task. Also note that in markdown mode the root `/.lpgfs.yaml` config file (present in classic mode) is not currently exposed.

### Configuration

```yaml
mode:
  type: markdown
  markdown:
    # Allow-list of labels to render. Unset or empty = every label.
    labels: [Character, Place, Creature, Event]

    # 'wikilink' (default): quoted Obsidian-native "[[Label/name]]" links.
    # 'markdown': bundle-relative absolute links, e.g. /Label/name.md.
    linkStyle: wikilink

    # Render incoming relationships under `in_<TYPE>` frontmatter keys.
    # Default false: only outgoing relationships are rendered.
    includeIncoming: false

    # Which node properties compose the markdown body, in order.
    # Present properties are concatenated; a single present property
    # renders bare, multiple properties each get a `## <property>` heading.
    textProperties:
      default: [summary, text, content]
      overrides:
        Character: [description, story]

    # Ordered fallback lists mapping node properties to the canonical OKF
    # frontmatter keys `title`/`timestamp`/`tags`. The first property
    # present on a node wins and is emitted under the canonical key
    # instead of its original name (not duplicated); a node matching none
    # of a field's list simply omits that key. Setting a list to `[]`
    # disables that field's mapping.
    fields:
      title: [title, name]
      timestamp: [updated, lastUpdated, modified, created]
      tags: [tags, categories]
      overrides:
        title:
          Character: [name]
```

`labels`, `linkStyle`, `includeIncoming`, `textProperties`, and `fields` all default to the values shown above (`DEFAULT_MARKDOWN_MODE_CONFIG` in `src/types/index.ts`) except `labels`, which defaults to unset (all labels). Any subset of `mode.markdown` may be omitted — omitted keys fall back to their default.

Frontmatter key order is deterministic: `type` (and `type_property`, see below, when present), then mapped `title`/`timestamp`/`tags`, then remaining properties alphabetically, then per-relationship-type link keys alphabetically (`in_<TYPE>` keys sort alongside outgoing `<TYPE>` keys by their full key name).

### OKF conformance and Obsidian compatibility

Every rendered `.md` file carries `type: <Label>` as the first frontmatter key — OKF's one required field. If a node also has a literal property named `type`, the **label wins** the `type` key and the property value is preserved under `type_property` instead of being dropped, so no data is lost:

```yaml
---
type: Character
type_property: Sorceress
title: Enchantress of Aeaea
...
---
```

The reserved bundle filenames `index.md` and `log.md` are never used for a node file: a node whose sanitized display name would collide with `index` or `log` gets the configured collision suffix instead. Obsidian-illegal filename/wikilink characters (`[`, `]`, `#`, `^`, `|`) are sanitized in addition to the base sanitization map.

`linkStyle: wikilink` (the default) emits quoted `"[[Label/name]]"` links, which Obsidian resolves natively (graph view, backlinks, Dataview). `linkStyle: markdown` emits OKF's recommended bundle-relative absolute form, `/Label/name.md`.

The generated root `/index.md` includes `okf_version: "0.1"` and a `## <Label>` section per rendered label linking to that label's own `index.md`; per-label `/<Label>/index.md` files list every concept with a short derived description (mapped `title` plus a truncated text property, where available) and intentionally carry **no** frontmatter, per OKF's rules for reserved listing files. The generated `/log.md` groups nodes with a resolvable mapped `timestamp` under `## YYYY-MM-DD` headings, newest first; nodes without any of the configured timestamp fallback properties are simply omitted, and if no node in the whole mount resolves a timestamp, `/log.md` renders a one-line explanatory stub rather than being absent.

See `test/fixtures/odyssey/` for a complete 20-file example vault (and the `.lpgfs.yaml` used to render it) alongside `import.cypher`, the Cypher script that recreates the same graph in Neo4j.

### Bulk-importing an existing vault (`lpgfs-import-vault`)

> **Status:** this tool is designed but not yet shipped in this branch (tracked as a separate task landing in parallel); the section below describes its intended behavior so the two pieces of work agree on the contract. If the bin name or flags below differ once merged, treat that as a follow-up correction rather than a sign this section is wrong about the feature's purpose.

A standalone CLI, `lpgfs-import-vault`, mirrors an existing Obsidian-style markdown vault into a Neo4j graph — the inverse of markdown-mode rendering. It runs entirely outside the FUSE layer (writes go straight through the driver, no mount required), so it is not subject to the mount's read-only restriction.

```bash
npx lpgfs-import-vault <vaultDir> --db neo4j://localhost:7687 --user neo4j --password YOUR_PASSWORD
npx lpgfs-import-vault <vaultDir> --db neo4j://localhost:7687 --user neo4j --password YOUR_PASSWORD --dry-run
```

Behavior:

- Each subdirectory under `<vaultDir>` becomes a label; each `<name>.md` file becomes a node with that label and its naming property set from the filename (`.md` stripped). Reserved bundle files (`index.md`, `log.md`, at any level) are skipped, not imported as nodes.
- Frontmatter keys become node properties (`type`/`type_property` are consumed for label/clash resolution, not written back as plain properties). Per-relationship-type link keys become relationships, in whichever link style (`wikilink` or `markdown`) the vault uses.
- Body text writes back onto the label's configured text property when there is exactly one; a body with `## <property>` headings writes each section back onto its named property.
- Writes are idempotent (`MERGE` on label + naming property, not `CREATE`) — safe to re-run against the same vault.
- `--dry-run` prints what would be written without executing it against the database.

**Round-trip limitation:** mapped fields (`title`, `timestamp`, `tags`) are written back under their canonical key, not the original source property they came from (e.g. a node originally using `lastUpdated` re-imports as `timestamp`). Re-rendering an imported node therefore matches the original content except for this canonical-key rename — a documented, accepted limitation rather than a bug.

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
