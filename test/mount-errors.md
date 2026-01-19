# LPGFS Mount Error Scenarios Test

Manual tests for mount failure scenarios to verify error handling.

## Prerequisites

```bash
npm install
npm run build
```

## Test Scenarios

### 1. Mount with Neo4j Stopped

**Test:** Attempt mount when Neo4j is not running.

```bash
# Stop Neo4j if running
docker stop neo4j  # or equivalent

# Attempt mount
mkdir -p /tmp/lpgfs-test
npm run build && node dist/index.js mount /tmp/lpgfs-test --db neo4j://localhost:7687 --user neo4j --password password --debug --foreground
```

**Expected Error:**
```
Cannot connect to database at neo4j://localhost:7687
Error: <connection details>

Troubleshooting checklist:
- Ensure Neo4j is running (docker ps, systemctl status neo4j, etc.)
- Verify host and port are correct (default: localhost:7687)
- Check credentials are valid (default: neo4j/password)
- Test network connectivity (telnet localhost 7687, nc -zv localhost 7687)
```

**Verification:**
- [ ] Clear error message about database connectivity
- [ ] Includes connection URI in error
- [ ] Provides troubleshooting steps
- [ ] No segfault or stack trace
- [ ] Mount directory remains unmounted

---

### 2. Mount with Wrong Credentials

**Test:** Attempt mount with incorrect username/password.

```bash
# Start Neo4j (if not already running)
docker start neo4j

# Attempt mount with wrong password
mkdir -p /tmp/lpgfs-test
npm run build && node dist/index.js mount /tmp/lpgfs-test --db neo4j://localhost:7687 --user neo4j --password wrongpassword --debug --foreground
```

**Expected Error:**
```
Cannot connect to database at neo4j://localhost:7687
Error: <auth failure details>

Troubleshooting checklist:
- Ensure Neo4j is running (docker ps, systemctl status neo4j, etc.)
- Verify host and port are correct (default: localhost:7687)
- Check credentials are valid (default: neo4j/password)
- Test network connectivity (telnet localhost 7687, nc -zv localhost 7687)
```

**Verification:**
- [ ] Clear error message about database connectivity
- [ ] No password leaked in error message
- [ ] Provides troubleshooting steps
- [ ] No segfault or stack trace
- [ ] Mount directory remains unmounted

---

### 3. Mount with Invalid Mountpoint

**Test:** Attempt mount to non-existent directory.

```bash
# Try mounting to a path that doesn't exist
npm run build && node dist/index.js mount /tmp/nonexistent/lpgfs --db neo4j://localhost:7687 --user neo4j --password password --debug --foreground
```

**Expected Error:**
```
Mount point does not exist: /tmp/nonexistent/lpgfs
```

**Verification:**
- [ ] Clear error message about mountpoint
- [ ] Error occurs before database connection attempt
- [ ] No segfault or stack trace

---

### 4. Mount without macFUSE Installed

**Test:** Attempt mount without FUSE libraries installed.

**Note:** This test requires temporarily uninstalling macFUSE/FUSE. Risky, skip if inconvenient.

**macOS:**
```bash
# Check current installation
ls -la /Library/Filesystems/macfuse.fs

# If testing uninstalled state:
# (uninstall macFUSE via uninstaller, then reinstall after test)
```

**Linux:**
```bash
# Check current installation
ls -la /dev/fuse

# For testing, you could try in a clean Docker container without fuse-utils
docker run -it --rm node:20 bash
# Then install project and attempt mount
```

**Expected Error:**
```
macFUSE not found. Install from https://osxfuse.github.io/
(or similar platform-specific message)
```

**Verification:**
- [ ] Clear error message about missing FUSE libraries
- [ ] Includes installation instructions with URL
- [ ] Error occurs before attempting mount
- [ ] No segfault or cryptic native module errors

---

### 5. Send SIGINT During Mount

**Test:** Send interrupt signal while mount is in progress.

```bash
# Start Neo4j
docker start neo4j

# Start mount in foreground and immediately press Ctrl+C
mkdir -p /tmp/lpgfs-test
npm run build && node dist/index.js mount /tmp/lpgfs-test --db neo4j://localhost:7687 --user neo4j --password password --debug --foreground

# Press Ctrl+C within 1-2 seconds
```

**Expected Behavior:**
```
[lpgfs] Received signal: SIGINT
[lpgfs] Shutting down daemon...
[lpgfs] Attempting to unmount /tmp/lpgfs-test...
[lpgfs] Cleanup complete
```

**Verification:**
- [ ] Graceful shutdown message logged
- [ ] No segfault or crash
- [ ] No hanging processes (check with `ps aux | grep lpgfs`)
- [ ] Mount directory remains unmounted
- [ ] Database connection closed properly

---

### 6. Try Mounting Already Mounted Directory

**Test:** Attempt to mount to a directory that's already a mountpoint.

```bash
# Start Neo4j
docker start neo4j

# First mount (in background terminal)
mkdir -p /tmp/lpgfs-test
npm run build && node dist/index.js mount /tmp/lpgfs-test --db neo4j://localhost:7687 --user neo4j --password password --debug --foreground &

# Wait 2 seconds for mount to complete
sleep 2

# Verify mount succeeded
ls /tmp/lpgfs-test

# Try mounting again (in second terminal)
node dist/index.js mount /tmp/lpgfs-test --db neo4j://localhost:7687 --user neo4j --password password --debug --foreground
```

**Expected Error:**
```
Error: FUSE mount failed
(or similar fuse-native error about busy mountpoint)
```

**Verification:**
- [ ] Clear error about mount failure
- [ ] First mount remains functional
- [ ] Second mount process exits cleanly
- [ ] No segfault or crash

**Cleanup:**
```bash
# Stop first mount with Ctrl+C or:
pkill -f "node dist/index.js mount"
fusermount -u /tmp/lpgfs-test  # Linux
umount /tmp/lpgfs-test         # macOS
```

---

## Summary Checklist

All test scenarios should:
- [ ] Produce clear, actionable error messages
- [ ] Never segfault or crash with stack trace
- [ ] Clean up resources (connections, file descriptors)
- [ ] Leave mountpoint in clean state (unmounted)
- [ ] Exit with non-zero code on error
- [ ] Log errors even without --debug flag (for critical failures)

## Troubleshooting

If tests fail with segfault:
1. Check Node.js version: `node --version` (should be 18 or 20, not 22+)
2. Verify FUSE libraries installed: `ls /Library/Filesystems/macfuse.fs` (macOS) or `ls /dev/fuse` (Linux)
3. Run with `--debug --foreground` flags to see detailed logs
4. Check for zombie processes: `ps aux | grep lpgfs`
5. Force unmount if stuck: `fusermount -u /tmp/lpgfs-test` or `umount /tmp/lpgfs-test`

If mount hangs:
- Mount operations timeout after 5 seconds
- If hanging longer, check Neo4j connectivity manually: `telnet localhost 7687`
- Check FUSE module loaded: `lsmod | grep fuse` (Linux) or `kextstat | grep fuse` (macOS)

## Notes

- All tests should complete within 5-10 seconds
- Error messages should include context (URI, path, etc.)
- No sensitive data (passwords) should appear in error output
- Exit codes: 0 = success, 1 = error
