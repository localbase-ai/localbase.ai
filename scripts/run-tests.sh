#!/bin/bash
# Run tests in-process against the Express app

set -e

echo "Running tests..."
node --test --test-concurrency=1 test/**/*.test.js
