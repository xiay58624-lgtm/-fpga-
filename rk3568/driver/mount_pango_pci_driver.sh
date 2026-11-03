#!/bin/bash
set -euo pipefail

ROOT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
KO_PATH="${KO_PATH:-${ROOT_DIR}/pango_pci_driver.ko}"
DEV_NAME="${DEV_NAME:-pango_pci_driver}"
VENDOR_ID="${VENDOR_ID:-0755}"
DEVICE_ID="${DEVICE_ID:-0755}"
MAX_DMESG_LINES="${MAX_DMESG_LINES:-80}"
FORCE_MPS_256="${FORCE_MPS_256:-1}"

run_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
    return
  fi
  if command -v sudo >/dev/null 2>&1; then
    sudo "$@"
    return
  fi
  echo "需要 root 权限执行：$*"
  exit 1
}

set_perf_governors() {
  if [ "${RK3568_LOCK_PERF:-1}" = "0" ]; then
    echo "performance lock disabled: RK3568_LOCK_PERF=0"
    return 0
  fi
  echo "setting CPU/GPU/NPU governors to performance..."
  run_root sh -c '
for p in /sys/devices/system/cpu/cpufreq/policy*; do
  [ -d "$p" ] || continue
  max="$(cat "$p/cpuinfo_max_freq" 2>/dev/null || cat "$p/scaling_max_freq" 2>/dev/null)"
  [ -n "$max" ] || continue
  if grep -qw performance "$p/scaling_available_governors" 2>/dev/null; then
    echo performance > "$p/scaling_governor" 2>/dev/null || true
  fi
  echo "$max" > "$p/scaling_max_freq" 2>/dev/null || true
  echo "$max" > "$p/scaling_min_freq" 2>/dev/null || true
done

for d in /sys/class/devfreq/*gpu* /sys/class/devfreq/*npu* /sys/class/devfreq/fde60000.gpu /sys/class/devfreq/fde40000.npu; do
  [ -d "$d" ] || continue
  if [ -f "$d/available_governors" ] && grep -qw performance "$d/available_governors" 2>/dev/null; then
    echo performance > "$d/governor" 2>/dev/null || true
  fi
  max=""
  if [ -f "$d/available_frequencies" ]; then
    for f in $(cat "$d/available_frequencies" 2>/dev/null); do
      case "$f" in
        ""|*[!0-9]*) continue ;;
      esac
      if [ -z "$max" ] || [ "$f" -gt "$max" ]; then
        max="$f"
      fi
    done
  fi
  [ -n "$max" ] || max="$(cat "$d/max_freq" 2>/dev/null || true)"
  [ -n "$max" ] || continue
  echo "$max" > "$d/max_freq" 2>/dev/null || true
  echo "$max" > "$d/min_freq" 2>/dev/null || true
done
' || true
}

is_loaded() {
  lsmod | awk '{print $1}' | grep -q "^${DEV_NAME}$"
}

set_pcie_mps_256() {
  local bdf="$1"
  if ! command -v setpci >/dev/null 2>&1; then
    echo "setpci 不存在，跳过 MPS 设置（可安装 pciutils：sudo apt install -y pciutils）"
    return 0
  fi
  local cur
  cur="$(run_root setpci -s "${bdf}" CAP_EXP+8.w 2>/dev/null || true)"
  if [ -z "${cur}" ]; then
    echo "读取 DevCtl 失败：${bdf}"
    return 0
  fi
  local new
  new="$(printf "%04x" $(( (0x${cur} & ~0xE0) | 0x20 )))"
  run_root setpci -s "${bdf}" CAP_EXP+8.w="${new}" || true
  local after
  after="$(run_root setpci -s "${bdf}" CAP_EXP+8.w 2>/dev/null || true)"
  echo "MPS 设置：${bdf} DevCtl ${cur} -> ${after}"
}

find_upstream_port() {
  local ep_bdf="$1"
  local sys_path=""
  if [ -d "/sys/bus/pci/devices/${ep_bdf}" ]; then
    sys_path="/sys/bus/pci/devices/${ep_bdf}"
  elif [ -d "/sys/bus/pci/devices/0000:${ep_bdf}" ]; then
    sys_path="/sys/bus/pci/devices/0000:${ep_bdf}"
  fi
  if [ -z "${sys_path}" ]; then
    return 0
  fi
  local cur
  cur="$(readlink -f "${sys_path}" 2>/dev/null || true)"
  while [ -n "${cur}" ] && [ "${cur}" != "/" ]; do
    cur="$(dirname "${cur}")"
    local base
    base="$(basename "${cur}")"
    if echo "${base}" | grep -Eq '^[0-9a-fA-F]{4}:[0-9a-fA-F]{2}:[0-9a-fA-F]{2}\.[0-7]$'; then
      if [ "${base}" != "${ep_bdf}" ]; then
        echo "${base}"
        return 0
      fi
    fi
  done
  return 0
}

echo "==== pango_pci_driver 挂载与诊断 ===="
echo "KO_PATH=${KO_PATH}"
echo "DEV_NAME=${DEV_NAME}"
echo "PCI ID=${VENDOR_ID}:${DEVICE_ID}"
echo

set_perf_governors

BDF="${1:-}"
if [ -z "${BDF}" ]; then
  if command -v lspci >/dev/null 2>&1; then
    WANT_ID="${VENDOR_ID}:${DEVICE_ID}"
    BDF="$(lspci -Dn 2>/dev/null | awk -v want="${WANT_ID}" '{for(i=1;i<=NF;i++) if($i==want) {print $1; exit}}')"
  fi
fi
if [ -z "${BDF}" ]; then
  BDF="$(
    { dmesg 2>/dev/null | grep -E "${DEV_NAME} [0-9]{4}:[0-9]{2}:[0-9]{2}\.[0-9]" || true; } \
      | tail -n 1 \
      | awk '{for(i=1;i<=NF;i++) if($i ~ /^[0-9]{4}:[0-9]{2}:[0-9]{2}\.[0-9]$/) {print $i; exit}}'
  )"
fi

if [ -n "${BDF}" ]; then
  echo "PCI 设备：${BDF}"
else
  echo "未自动定位到 PCI 设备（可能未安装 lspci 或未枚举到 ${VENDOR_ID}:${DEVICE_ID}）"
fi
echo

echo "---- 内核与模块信息 ----"
echo "uname -a: $(uname -a)"
if [ -f "${KO_PATH}" ]; then
  echo "ko 文件存在：YES"
  if command -v modinfo >/dev/null 2>&1; then
    echo "modinfo:"
    modinfo "${KO_PATH}" | sed -n '1,40p'
  fi
else
  echo "ko 文件存在：NO"
  exit 1
fi
echo

echo "---- PCIe 参数 ----"
if [ -n "${BDF}" ] && command -v lspci >/dev/null 2>&1; then
  lspci -s "${BDF}" -nn
  echo
  echo "lspci -vv（关键信息）："
  lspci -s "${BDF}" -vv 2>/dev/null | egrep -i "LnkCap:|LnkSta:|DevCap:|DevCtl:|DevCtl2:|MaxPayload|MaxReadReq|MSI:|MSI-X:" || true
  echo
  SYS_PCI_PATH=""
  if [ -d "/sys/bus/pci/devices/${BDF}" ]; then
    SYS_PCI_PATH="/sys/bus/pci/devices/${BDF}"
  elif [ -d "/sys/bus/pci/devices/0000:${BDF}" ]; then
    SYS_PCI_PATH="/sys/bus/pci/devices/0000:${BDF}"
  fi
  if [ -n "${SYS_PCI_PATH}" ]; then
    echo "sysfs:"
    echo "  ${SYS_PCI_PATH}/irq: $(cat ${SYS_PCI_PATH}/irq 2>/dev/null || echo N/A)"
    echo "  enable: $(cat ${SYS_PCI_PATH}/enable 2>/dev/null || echo N/A)"
  fi
else
  echo "跳过（缺少 BDF 或 lspci）"
  if ! command -v lspci >/dev/null 2>&1; then
    echo "提示：可安装 pciutils 获取 lspci：sudo apt install -y pciutils"
  fi
fi
echo

echo "---- 加载驱动 ----"
if is_loaded; then
  echo "检测到驱动已加载，尝试卸载..."
  run_root rmmod "${DEV_NAME}" || true
  if is_loaded; then
    echo "错误：卸载失败（lsmod 仍存在 ${DEV_NAME}）"
    exit 1
  fi
  echo "卸载成功"
fi

echo "开始加载驱动..."
run_root insmod "${KO_PATH}"
if is_loaded; then
  echo "驱动加载完成：YES"
else
  echo "驱动加载完成：UNKNOWN（lsmod 未显示，但可能已注册字符设备/中断）"
fi
echo

if [ "${FORCE_MPS_256}" = "1" ] && [ -n "${BDF}" ]; then
  echo "---- PCIe MPS 优化（尝试设置为 256B）----"
  UP_BDF="$(find_upstream_port "${BDF}")"
  if [ -n "${UP_BDF}" ]; then
    set_pcie_mps_256 "${UP_BDF}"
  else
    echo "未找到上游端口 BDF，跳过 Root Port MPS 设置"
  fi
  set_pcie_mps_256 "${BDF}"
  echo
fi

echo "---- 设备节点 ----"
if [ -e "/dev/${DEV_NAME}" ]; then
  echo "/dev/${DEV_NAME}：存在"
else
  echo "/dev/${DEV_NAME}：不存在（尝试等待 udev 创建设备节点）"
  sleep 1
fi
if ls /dev/pango* >/dev/null 2>&1; then
  echo "/dev/pango*:"
  ls -l /dev/pango* || true
  run_root chmod 666 /dev/pango* || true
  echo "/dev/pango*（权限调整后）:"
  ls -l /dev/pango* || true
fi
echo

echo "---- 中断挂载检查 ----"
IRQ_LINE="$(cat /proc/interrupts 2>/dev/null | grep -n "${DEV_NAME}" || true)"
if [ -n "${IRQ_LINE}" ]; then
  echo "request_irq：成功（/proc/interrupts 存在 ${DEV_NAME}）"
  echo "${IRQ_LINE}"
  echo "提示：计数为 0 表示目前还没有触发过中断，触发后应递增"
else
  echo "request_irq：未检测到（/proc/interrupts 未出现 ${DEV_NAME}）"
  echo "提示：确认设备是否产生中断；或驱动 probe 是否成功执行到了 request_irq"
fi
echo

echo "---- dmesg（最近 ${MAX_DMESG_LINES} 行，过滤关键字）----"
if command -v dmesg >/dev/null 2>&1; then
  dmesg | tail -n "${MAX_DMESG_LINES}" | egrep -i "pango|pci|msi|interrupt|irq" || true
else
  echo "系统没有 dmesg 命令"
fi
echo

echo "==== 完成 ===="
