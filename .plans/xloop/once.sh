#!/bin/bash
docker sandbox run --credentials host claude --allow-dangerously-skip-permissions "@progress.txt @plans/xloop/prompt.md @plans/next.yml @AGENTS.md"
