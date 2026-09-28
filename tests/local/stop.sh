#!/bin/sh
STATE=${TB_LOCAL_STATE:-/tmp/taskboard-local}
for p in postgrest gateway; do
  [ -f "$STATE/$p.pid" ] && kill "$(cat "$STATE/$p.pid")" 2>/dev/null
  rm -f "$STATE/$p.pid"
done
exit 0
