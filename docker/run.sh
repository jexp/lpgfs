#!/bin/bash
# Test LPGFS in Docker connecting to host Neo4j

set -e

echo "Building Docker image..."
docker build --platform=linux/amd64 -f docker/Dockerfile -t lpgfs-test .

echo ""
echo "Running container with FUSE support..."
echo ""
echo "Inside container, you can run:"
echo "  node dist/cli/index.js mount ~/graph-mount --db neo4j://host.docker.internal:7687 --user neo4j --password <YOUR_PASSWORD> --foreground"
echo ""
echo "Or explore the mounted filesystem:"
echo "  ls ~/graph-mount/"
echo ""
echo "To exit: Ctrl+C (unmounts) then Ctrl+D or 'exit'"
echo ""

docker run -it --rm \
  --platform=linux/amd64 \
  --privileged \
  --cap-add SYS_ADMIN \
  lpgfs-test
