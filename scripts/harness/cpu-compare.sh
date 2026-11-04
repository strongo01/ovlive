#!/bin/sh
cd /home/claude/ovlive/scripts/harness
O=/tmp/results/cpu.jsonl; : > $O
for sc in "kv78|S1|{\"messages\":800,\"rowsPerMessage\":150,\"pool\":60000}" "kv78|S2|{\"messages\":60,\"rowsPerMessage\":150,\"pool\":60000,\"bigMessages\":12,\"bigRows\":10000}" "bison|S3|{\"messages\":800,\"rowsPerMessage\":60,\"pool\":60000,\"kv17Every\":10}"; do
  st=${sc%%|*}; rest=${sc#*|}; name=${rest%%|*}; params=${rest#*|}
  for b in old new; do for i in 1 2 3; do
    r=$(SKIP_RESTORE=1 node --expose-gc run-hub-session.mjs /tmp/hub-$b/hub.mjs $st "$params")
    echo "{\"scenario\":\"$name\",\"impl\":\"$b\",\"run\":$i,\"r\":$r}" >> $O
  done; done
done
echo '{"done":1}' >> $O
# sessiepiek zonder restore
O2=/tmp/results/peak.jsonl; : > $O2
for b in old new; do
  echo "{\"impl\":\"$b\",\"S1\":$(node min-heap.mjs /tmp/hub-$b/hub.mjs kv78 '{"messages":800,"rowsPerMessage":150,"pool":60000}'),\"S2\":$(node min-heap.mjs /tmp/hub-$b/hub.mjs kv78 '{"messages":60,"rowsPerMessage":150,"pool":60000,"bigMessages":12,"bigRows":10000}'),\"S3\":$(node min-heap.mjs /tmp/hub-$b/hub.mjs bison '{"messages":800,"rowsPerMessage":60,"pool":60000,"kv17Every":10}')}" >> $O2
done
echo '{"done":1}' >> $O2
