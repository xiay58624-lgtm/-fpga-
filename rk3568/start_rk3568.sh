#!/bin/bash
set -u
ROOT=/home/linaro/Desktop/rk3568
export RK3568_NAV_MODEL="${RK3568_NAV_MODEL:-${ROOT}/app/model/nav_video7_v4_rk3568_w8a8.rknn}"
export RK3568_AUTO_NAV="${RK3568_AUTO_NAV:-1}"
LOG=/tmp/rk3568_launcher.log
cd "$ROOT" || exit 1
# Stop only existing RK3568 GUI processes; avoid matching this launcher shell.
for pid in $(ps -eo pid=,args= | awk '$2 ~ /(^|\/)RK3568_PCIe_YOLO$/ {print $1}'); do
    [ "$pid" = "$$" ] && continue
    kill -TERM "$pid" 2>/dev/null || true
done
sleep 1
export DISPLAY=${DISPLAY:-:0}
export XAUTHORITY=${XAUTHORITY:-/home/linaro/.Xauthority}
echo "[$(date '+%F %T')] starting $ROOT/run.sh" | tee -a "$LOG"
exec "$ROOT/run.sh"
