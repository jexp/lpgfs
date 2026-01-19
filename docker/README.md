# Docker Setup for LPGFS

Use this Docker setup to run LPGFS on macOS (where native FUSE has compatibility issues) or for easy testing on any platform.

## Quick Start

```bash
# From project root
./docker/run.sh
```

Inside the container:
```bash
node dist/cli/index.js mount ~/graph-mount \
  --db neo4j://host.docker.internal:7687 \
  --user neo4j \
  --password YOUR_PASSWORD \
  --foreground
```

## Exploring the Mounted Filesystem

Open another terminal:
```bash
# Get container ID
docker ps

# Exec into container
docker exec -it <container-id> bash

# Explore
ls ~/graph-mount/
cat ~/graph-mount/Person/alice/.properties.json
```

## Connecting to Neo4j

**From Docker to host machine:**
- Use `host.docker.internal:7687` (macOS/Windows)
- Or use your host IP: `192.168.x.x:7687`

**Neo4j must allow remote connections:**
- Check `neo4j.conf`: `dbms.connector.bolt.listen_address=0.0.0.0:7687`
- Or if Neo4j in Docker: use Docker networking

## Files

- `Dockerfile` - Container setup with FUSE support
- `run.sh` - Build and run script
- `.dockerignore` - Excludes node_modules from context

## Requirements

- Docker Desktop (or equivalent)
- Neo4j accessible from container
