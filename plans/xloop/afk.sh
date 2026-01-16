#!/bin/bash
set -e

if [ -z "$1" ]; then
  echo "Usage: $0 <iterations>"
  exit 1
fi

for ((i=1; i<=$1; i++)); do
  docker sandbox run --credentials host claude --allow-dangerously-skip-permissions "@progress.txt @plans/xloop/prompt.md @plans/next.yml @AGENTS.md" 2>&1 | tee /tmp/docker_output.txt
  result=$(cat /tmp/docker_output.txt)

  if [[ "$result" == *"<promise>COMPLETE</promise>"* ]]; then
    echo "PRD complete after $i iterations."
    exit 0
  fi
done
