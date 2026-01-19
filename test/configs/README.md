# LPGFS Configuration Test Scenarios

This directory contains test configuration files for verifying LPGFS naming strategies and collision handling.

## Prerequisites

1. Neo4j database running with test data from `../seed.cypher`
2. LPGFS built: `npm run build`
3. Mount point created: `mkdir -p /tmp/lpgfs-test`

## Test Configurations

### 1. elementId-default.yaml

**Strategy:** Use database elementIds for all node names.

```bash
./dist/cli/index.js mount /tmp/lpgfs-test \
  --db neo4j://localhost:7687 \
  --user neo4j --password password \
  --config test/configs/elementId-default.yaml \
  --foreground --debug
```

**Expected Results:**
```bash
# Node names are sanitized elementIds (colons replaced with underscores)
ls /tmp/lpgfs-test/Person/
# Output: 4_abc_0  4_abc_1  4_abc_2  4_abc_3  4_abc_4

# Properties still accessible via elementId names
cat /tmp/lpgfs-test/Person/4_abc_0/.properties.json | jq .username
# Output: "alice" (or whichever node has that elementId)
```

**Verification:**
- [ ] All nodes listed with sanitized elementId format
- [ ] No collisions possible (elementIds are unique)
- [ ] Properties accessible for all nodes

---

### 2. property-default.yaml

**Strategy:** Use property values for node names (username for Person, name for Company).

```bash
./dist/cli/index.js mount /tmp/lpgfs-test \
  --db neo4j://localhost:7687 \
  --user neo4j --password password \
  --config test/configs/property-default.yaml \
  --foreground --debug
```

**Expected Results:**
```bash
ls /tmp/lpgfs-test/Person/
# Output: alice  bob  carol  james  newuser

ls /tmp/lpgfs-test/Company/
# Output: Acme Corp  Globex Inc

# Access by human-readable name
cat /tmp/lpgfs-test/Person/alice/.properties.json | jq .age
# Output: 30
```

**Verification:**
- [ ] Person nodes named by username property
- [ ] Company nodes named by name property
- [ ] All properties accessible
- [ ] Relationship traversal works

---

### 3. mixed-naming.yaml

**Strategy:** Person uses property naming, Company uses elementId (default).

```bash
./dist/cli/index.js mount /tmp/lpgfs-test \
  --db neo4j://localhost:7687 \
  --user neo4j --password password \
  --config test/configs/mixed-naming.yaml \
  --foreground --debug
```

**Expected Results:**
```bash
ls /tmp/lpgfs-test/Person/
# Output: alice  bob  carol  james  newuser (property naming)

ls /tmp/lpgfs-test/Company/
# Output: 4_def_0  4_def_1 (elementId naming)

# Cross-label relationships use target's naming
readlink /tmp/lpgfs-test/Person/alice/WORKS_AT/OUT/*
# Output: symlink to ../../../../Company/4_def_0 (or similar)
```

**Verification:**
- [ ] Person nodes use property naming
- [ ] Company nodes use elementId naming
- [ ] Cross-label symlinks point to correct names

---

### 4. collision-fail.yaml

**Strategy:** Property naming with 'fail' collision strategy.

```bash
# First, test with unique data (should work)
./dist/cli/index.js mount /tmp/lpgfs-test \
  --db neo4j://localhost:7687 \
  --user neo4j --password password \
  --config test/configs/collision-fail.yaml \
  --foreground --debug
```

**Test Collision Behavior:**

To test collision failure, temporarily add a duplicate node:

```cypher
// In Neo4j Browser - create duplicate username
CREATE (dup:Person {username: 'alice', name: 'Alice Duplicate'});
```

Then mount and access:

```bash
ls /tmp/lpgfs-test/Person/
# Should error or show collision error in debug logs
```

Clean up after testing:
```cypher
MATCH (p:Person {name: 'Alice Duplicate'}) DELETE p;
```

**Verification:**
- [ ] Works normally when all usernames unique
- [ ] Fails/errors when collision exists
- [ ] Error message indicates collision

---

### 5. collision-suffix.yaml

**Strategy:** Property naming with 'suffix_elementId' collision strategy.

```bash
./dist/cli/index.js mount /tmp/lpgfs-test \
  --db neo4j://localhost:7687 \
  --user neo4j --password password \
  --config test/configs/collision-suffix.yaml \
  --foreground --debug
```

**Test Collision Handling:**

Temporarily add a duplicate node:

```cypher
CREATE (dup:Person {username: 'alice', name: 'Alice Clone'});
```

```bash
ls /tmp/lpgfs-test/Person/
# Output: alice  alice_4_xyz_1  bob  carol  james  newuser
# One alice keeps original name, other gets suffix
```

Clean up:
```cypher
MATCH (p:Person {name: 'Alice Clone'}) DELETE p;
```

**Verification:**
- [ ] First occurrence keeps base name
- [ ] Subsequent occurrences get _<elementId> suffix
- [ ] Both nodes accessible by their unique names

---

### 6. name-property.yaml

**Strategy:** Use 'name' property (includes spaces) instead of 'username'.

```bash
./dist/cli/index.js mount /tmp/lpgfs-test \
  --db neo4j://localhost:7687 \
  --user neo4j --password password \
  --config test/configs/name-property.yaml \
  --foreground --debug
```

**Expected Results:**
```bash
ls /tmp/lpgfs-test/Person/
# Output: Alice  Bob  Carol  James  New User

# Access with quotes for space handling
cat "/tmp/lpgfs-test/Person/New User/.properties.json"
# Output: {username: "newuser", name: "New User", ...}

ls /tmp/lpgfs-test/Company/
# Output: Acme Corp  Globex Inc
```

**Verification:**
- [ ] Names with spaces work correctly
- [ ] Can access using quoted paths
- [ ] Tab completion works (shell-dependent)

---

### 7. custom-sanitization.yaml

**Strategy:** Replace spaces with dashes instead of preserving them.

```bash
./dist/cli/index.js mount /tmp/lpgfs-test \
  --db neo4j://localhost:7687 \
  --user neo4j --password password \
  --config test/configs/custom-sanitization.yaml \
  --foreground --debug
```

**Expected Results:**
```bash
ls /tmp/lpgfs-test/Person/
# Output: Alice  Bob  Carol  James  New-User (space → dash)

ls /tmp/lpgfs-test/Company/
# Output: Acme-Corp  Globex-Inc

# No quotes needed
cat /tmp/lpgfs-test/Person/New-User/.properties.json
```

**Verification:**
- [ ] Spaces replaced with dashes
- [ ] No quotes needed for access
- [ ] Shell scripts work without special handling

---

## Quick Test Script

Run all configs in sequence:

```bash
#!/bin/bash
MOUNT=/tmp/lpgfs-test
CONFIGS=test/configs

for config in $CONFIGS/*.yaml; do
  echo "=== Testing: $(basename $config) ==="

  ./dist/cli/index.js mount $MOUNT \
    --db neo4j://localhost:7687 \
    --user neo4j --password password \
    --config "$config" \
    --foreground &

  PID=$!
  sleep 2

  echo "Person nodes:"
  ls $MOUNT/Person/ 2>/dev/null || echo "(failed)"

  echo "Company nodes:"
  ls $MOUNT/Company/ 2>/dev/null || echo "(failed)"

  kill $PID 2>/dev/null
  sleep 1
  fusermount -u $MOUNT 2>/dev/null || umount $MOUNT 2>/dev/null

  echo ""
done
```

## Summary Checklist

| Config | Strategy | Expected Behavior | Pass/Fail |
|--------|----------|-------------------|-----------|
| elementId-default | elementId | Sanitized IDs as names | [ ] |
| property-default | property | Human-readable names | [ ] |
| mixed-naming | mixed | Person=property, Company=elementId | [ ] |
| collision-fail | fail | Errors on duplicate | [ ] |
| collision-suffix | suffix | Appends elementId on duplicate | [ ] |
| name-property | name | Uses 'name' not 'username' | [ ] |
| custom-sanitization | dash spaces | Space→dash replacement | [ ] |
