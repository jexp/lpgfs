# LPGFS Manual Integration Tests

This document contains manual test scripts to verify LPGFS functionality using standard Unix tools.

## Prerequisites

### 1. Install FUSE Libraries

**Linux:**
```bash
sudo apt-get install libfuse-dev
```

**macOS:**
```bash
# Install macFUSE from https://osxfuse.github.io/
# Or via Homebrew:
brew install macfuse
```

### 2. Start Neo4j Database

Ensure Neo4j is running and accessible at `neo4j://localhost:7687`.

```bash
# Docker example:
docker run -d \
  --name neo4j \
  -p 7474:7474 -p 7687:7687 \
  -e NEO4J_AUTH=neo4j/password \
  neo4j:5
```

### 3. Seed Test Data

Load the test dataset from `test/seed.cypher`:

```bash
# Using cypher-shell (requires Neo4j tools installed)
cat test/seed.cypher | cypher-shell -u neo4j -p password

# Or using Neo4j Browser at http://localhost:7474
# Copy and paste the contents of seed.cypher
```

### 4. Build LPGFS

```bash
npm install
npm run build
```

### 5. Create Mount Point

```bash
mkdir -p /tmp/lpgfs-test
```

### 6. Create Test Config

Create a test config file at `.lpgfs.yaml`:

```yaml
naming:
  default: property
  overrides:
    nodes:
      Person:
        property: "username"
      Company:
        property: "name"

sanitization:
  replace:
    "/": "_"
    "\\": "_"
    "\0": "_"

collision:
  strategy: "suffix_elementId"
```

---

## Test 1: Mount and Unmount

### Mount the Filesystem

```bash
# Mount in foreground with debug logging
./dist/cli/index.js mount /tmp/lpgfs-test \
  --db neo4j://localhost:7687 \
  --user neo4j \
  --password password \
  --config .lpgfs.yaml \
  --foreground \
  --debug
```

**Expected:** Mount succeeds with log messages showing:
- Config loaded
- Database connected
- FUSE mounted

### Verify Mount

In a separate terminal:

```bash
mount | grep lpgfs
# or
df /tmp/lpgfs-test
```

### Unmount

```bash
# Using lpgfs command
./dist/cli/index.js unmount /tmp/lpgfs-test

# Or using system unmount
fusermount -u /tmp/lpgfs-test  # Linux
umount /tmp/lpgfs-test          # macOS
```

---

## Test 2: Root Directory Listing

```bash
ls /tmp/lpgfs-test/
```

**Expected Output:**
```
Company  Person
```

Note: `.lpgfs.yaml` should also appear in the listing.

```bash
ls -la /tmp/lpgfs-test/
```

**Expected:** Shows `.lpgfs.yaml` and `Person`, `Company` directories.

---

## Test 3: Label Directory Listing

```bash
ls /tmp/lpgfs-test/Person/
```

**Expected Output (with property naming):**
```
alice  bob  carol  james  newuser
```

```bash
ls /tmp/lpgfs-test/Company/
```

**Expected Output:**
```
Acme Corp  Globex Inc
```

---

## Test 4: Node Properties (PRD Section 6.1)

### Read Alice's Properties

```bash
cat /tmp/lpgfs-test/Person/alice/.properties.json
```

**Expected Output:**
```json
{
  "_elementId": "4:...:0",
  "username": "alice",
  "name": "Alice",
  "age": 30,
  "email": "alice@example.com"
}
```

### Parse with jq

```bash
cat /tmp/lpgfs-test/Person/alice/.properties.json | jq .age
```

**Expected Output:**
```
30
```

---

## Test 5: Node Directory Contents

```bash
ls /tmp/lpgfs-test/Person/alice/
```

**Expected Output:**
```
KNOWS  MANAGES  TRANSFERRED  WORKS_AT
```

Note: `.properties.json` is hidden; use `ls -la` to see it.

```bash
ls -la /tmp/lpgfs-test/Person/alice/
```

**Expected:** Shows `.properties.json` plus relationship type directories.

---

## Test 6: Relationship Type Directories

```bash
ls /tmp/lpgfs-test/Person/alice/KNOWS/
```

**Expected Output:**
```
IN  OUT
```

---

## Test 7: Outgoing Relationships (PRD Section 6.1)

```bash
ls /tmp/lpgfs-test/Person/alice/KNOWS/OUT/
```

**Expected Output:**
```
bob  james
```

With hidden files:

```bash
ls -la /tmp/lpgfs-test/Person/alice/KNOWS/OUT/
```

**Expected:** Shows `bob`, `james` (symlinks), `.bob.json`, `.james.json` (files).

---

## Test 8: Relationship Properties (OUT side)

```bash
cat /tmp/lpgfs-test/Person/alice/KNOWS/OUT/.james.json
```

**Expected Output:**
```json
{
  "_elementId": "5:...:...",
  "since": 2020,
  "strength": "close"
}
```

---

## Test 9: Symlink Resolution (PRD Section 6.1)

### Check Symlink Target

```bash
readlink /tmp/lpgfs-test/Person/alice/KNOWS/OUT/james
```

**Expected Output:**
```
../../../james
```

### Follow Symlink

```bash
cat /tmp/lpgfs-test/Person/alice/KNOWS/OUT/james/.properties.json
```

**Expected:** Shows James's properties.

---

## Test 10: Multi-Hop Traversal (PRD Section 6.2)

### Alice → KNOWS → James → WORKS_AT → Company

```bash
cat /tmp/lpgfs-test/Person/alice/KNOWS/OUT/james/WORKS_AT/OUT/*/.properties.json
```

Or explicitly:

```bash
# First check what company James works at
ls /tmp/lpgfs-test/Person/alice/KNOWS/OUT/james/WORKS_AT/OUT/

# Then read the company properties
cat "/tmp/lpgfs-test/Person/alice/KNOWS/OUT/james/WORKS_AT/OUT/Acme Corp/.properties.json"
```

**Expected:** Shows Acme Corp properties.

---

## Test 11: Reverse Traversal (PRD Section 6.3)

### Who Knows Alice?

```bash
ls /tmp/lpgfs-test/Person/alice/KNOWS/IN/
```

**Expected Output:**
```
carol
```

### Get Properties of People Who Know Alice

```bash
for person in /tmp/lpgfs-test/Person/alice/KNOWS/IN/*; do
  echo "=== $(basename $person) ==="
  cat "$person/.properties.json"
done
```

---

## Test 12: Incoming Relationship Properties (IN side)

```bash
cat /tmp/lpgfs-test/Person/alice/KNOWS/IN/.carol.json
```

**Expected Output:**
```json
{
  "_ref": "5:...:..."
}
```

Note: IN side contains only `_ref` pointing to canonical location.

---

## Test 13: Cross-Label Relationships (PRD Section 7)

### Alice WORKS_AT Acme

```bash
readlink /tmp/lpgfs-test/Person/alice/WORKS_AT/OUT/Acme\ Corp
```

**Expected Output:**
```
../../../../Company/Acme Corp
```

### Follow Cross-Label Symlink

```bash
cat "/tmp/lpgfs-test/Person/alice/WORKS_AT/OUT/Acme Corp/.properties.json"
```

**Expected:** Shows Acme Corp properties.

---

## Test 14: Company Incoming Relationships

```bash
ls "/tmp/lpgfs-test/Company/Acme Corp/WORKS_AT/IN/"
```

**Expected Output:**
```
alice  james
```

---

## Test 15: Finding Patterns (PRD Section 6.4)

### Find All WORKS_AT Relationships

```bash
find /tmp/lpgfs-test -type d -name "WORKS_AT"
```

### Find All Nodes with Age Property

```bash
grep -r '"age":' /tmp/lpgfs-test --include='.properties.json'
```

### Find Relationships Created in 2020

```bash
grep -r '"since": 2020' /tmp/lpgfs-test --include='*.json'
```

---

## Test 16: Tree Visualization

```bash
# Install tree if needed: apt-get install tree / brew install tree
tree -L 4 /tmp/lpgfs-test/Person/alice/
```

**Expected Output:**
```
/tmp/lpgfs-test/Person/alice/
├── .properties.json
├── KNOWS
│   ├── IN
│   │   ├── carol -> ../../../carol
│   │   └── .carol.json
│   └── OUT
│       ├── bob -> ../../../bob
│       ├── .bob.json
│       ├── james -> ../../../james
│       └── .james.json
├── MANAGES
│   ├── IN
│   │   ├── alice -> ../../../alice
│   │   └── .alice.json
│   └── OUT
│       ├── alice -> ../../../alice
│       └── .alice.json
├── TRANSFERRED
│   └── OUT
│       ├── james -> ../../../james
│       ├── .james.json
│       ├── james_1 -> ../../../james
│       ├── .james_1.json
│       ├── james_2 -> ../../../james
│       └── .james_2.json
└── WORKS_AT
    └── OUT
        ├── Acme Corp -> ../../../../Company/Acme Corp
        └── .Acme Corp.json
```

---

## Test 17: Edge Case - Multiple Relationships Same Type (PRD Section 8.1)

Alice has multiple TRANSFERRED relationships to James.

```bash
ls /tmp/lpgfs-test/Person/alice/TRANSFERRED/OUT/
```

**Expected Output:**
```
james  james_1  james_2
```

```bash
cat /tmp/lpgfs-test/Person/alice/TRANSFERRED/OUT/.james.json
cat /tmp/lpgfs-test/Person/alice/TRANSFERRED/OUT/.james_1.json
cat /tmp/lpgfs-test/Person/alice/TRANSFERRED/OUT/.james_2.json
```

**Expected:** Each file has different `amount` and `description` values.

---

## Test 18: Edge Case - Self-Referential Relationship (PRD Section 8.2)

### Alice Manages Herself

```bash
ls /tmp/lpgfs-test/Person/alice/MANAGES/OUT/
```

**Expected Output:**
```
alice
```

```bash
readlink /tmp/lpgfs-test/Person/alice/MANAGES/OUT/alice
```

**Expected Output:**
```
../../../alice
```

### Bob Follows Himself

```bash
ls /tmp/lpgfs-test/Person/bob/FOLLOWS/OUT/
```

**Expected Output:**
```
bob
```

---

## Test 19: Edge Case - Node with No Relationships (PRD Section 8.3)

```bash
ls /tmp/lpgfs-test/Person/newuser/
```

**Expected Output (only properties, no relationship dirs):**
```
.properties.json
```

Or with `ls -la`:
```
.
..
.properties.json
```

---

## Test 20: Config File

```bash
cat /tmp/lpgfs-test/.lpgfs.yaml
```

**Expected:** Shows the active configuration in YAML format.

---

## Test 21: Write Operations Fail (Read-Only)

All write operations should return EROFS (Read-only filesystem).

```bash
echo "test" > /tmp/lpgfs-test/Person/alice/.properties.json
# Expected: Read-only file system error

mkdir /tmp/lpgfs-test/NewLabel
# Expected: Read-only file system error

rm /tmp/lpgfs-test/Person/alice/.properties.json
# Expected: Read-only file system error
```

---

## Test 22: Count Operations

```bash
# Count Person nodes
ls /tmp/lpgfs-test/Person/ | wc -l
```

**Expected:** `5` (alice, bob, carol, james, newuser)

```bash
# Count Company nodes
ls /tmp/lpgfs-test/Company/ | wc -l
```

**Expected:** `2` (Acme Corp, Globex Inc)

---

## Test 23: Stat Operations

```bash
stat /tmp/lpgfs-test/Person/alice
```

**Expected:** Shows directory attributes.

```bash
stat /tmp/lpgfs-test/Person/alice/.properties.json
```

**Expected:** Shows file attributes.

```bash
stat /tmp/lpgfs-test/Person/alice/KNOWS/OUT/james
```

**Expected:** Shows symlink attributes.

---

## Summary Checklist

| Test | Command | Pass/Fail |
|------|---------|-----------|
| Mount | `lpgfs mount` | [ ] |
| Root listing | `ls /` | [ ] |
| Label listing | `ls /Person/` | [ ] |
| Node properties | `cat .properties.json` | [ ] |
| Relationship dirs | `ls /Person/alice/` | [ ] |
| Direction dirs | `ls /Person/alice/KNOWS/` | [ ] |
| Outgoing rels | `ls /Person/alice/KNOWS/OUT/` | [ ] |
| Rel properties (OUT) | `cat .james.json` | [ ] |
| Symlink resolution | `readlink james` | [ ] |
| Multi-hop traversal | follow symlinks | [ ] |
| Reverse traversal | `ls KNOWS/IN/` | [ ] |
| Rel properties (IN) | `cat .alice.json` (_ref) | [ ] |
| Cross-label symlinks | WORKS_AT symlink | [ ] |
| find patterns | `find -name WORKS_AT` | [ ] |
| grep content | `grep age` | [ ] |
| tree visualization | `tree -L 4` | [ ] |
| Multiple rels same type | james, james_1, james_2 | [ ] |
| Self-referential | alice MANAGES alice | [ ] |
| No relationships | newuser | [ ] |
| Config file | `cat .lpgfs.yaml` | [ ] |
| Write fails | EROFS error | [ ] |
| Unmount | `lpgfs unmount` | [ ] |

---

## Troubleshooting

### Mount Fails with "FUSE not found"
- Ensure FUSE libraries are installed
- On macOS, ensure macFUSE extension is allowed in Security & Privacy

### Database Connection Errors
- Verify Neo4j is running: `curl http://localhost:7474`
- Check credentials: `--user neo4j --password password`

### Permission Denied
- Ensure mount point directory exists and is writable
- On Linux, may need to run with sudo or add user to fuse group

### Cache Issues
- Use `--cache-ttl 0` to disable caching during testing
- Remount to clear cache

### Debug Logging
- Always use `--debug` flag during testing
- Logs show all FUSE operations and database queries
