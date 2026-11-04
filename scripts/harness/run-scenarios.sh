#!/bin/sh
# usage: run-scenarios.sh <label> <bundle> [scenarios...]   (default: S2 S3)
cd /home/claude/ovlive/scripts/harness
L=$1; B=$2; shift 2
O=/tmp/results/$L.jsonl
run() { echo "{\"scenario\":\"$1\",\"result\":$(node min-heap.mjs $B $2 "$3")}" >> $O; }
for S in "$@"; do
  case $S in
    S1) run S1_kv78_steady        kv78  '{"messages":800,"rowsPerMessage":150,"pool":60000}' ;;
    S2) run S2_kv78_big_batches   kv78  '{"messages":60,"rowsPerMessage":150,"pool":60000,"bigMessages":12,"bigRows":10000}' ;;
    S3) run S3_bison_kv6_kv17     bison '{"messages":800,"rowsPerMessage":60,"pool":60000,"kv17Every":10}' ;;
  esac
done
echo "{\"done\":\"$L\"}" >> $O
