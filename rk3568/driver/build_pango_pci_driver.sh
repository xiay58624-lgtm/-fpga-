#!/bin/bash
set -euo pipefail

ROOT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
KO_NAME="pango_pci_driver.ko"
REPO_DIR="$(cd "${ROOT_DIR}/.." && pwd)"
DEFAULT_KERNEL_DIR="/root/code/kernel"
DEFAULT_TOOLCHAIN_DIR="/root/code/toolchain"

KERNELDIR="${KERNELDIR:-}"
ARCH="${ARCH:-}"
CROSS_COMPILE="${CROSS_COMPILE:-}"
JOBS="${JOBS:-}"
TOOLCHAIN_DIR="${TOOLCHAIN_DIR:-}"

if [ -z "${JOBS}" ]; then
  if command -v nproc >/dev/null 2>&1; then
    JOBS="$(nproc)"
  else
    JOBS="4"
  fi
fi

if [ -z "${KERNELDIR}" ]; then
  if [ -f "${DEFAULT_KERNEL_DIR}/Makefile" ]; then
    KERNELDIR="${DEFAULT_KERNEL_DIR}"
  elif [ -f "${REPO_DIR}/kernel/Makefile" ]; then
    KERNELDIR="${REPO_DIR}/kernel"
  elif [ -f "${REPO_DIR}/linux/Makefile" ]; then
    KERNELDIR="${REPO_DIR}/linux"
  elif [ -d "/lib/modules/$(uname -r)/build" ]; then
    KERNELDIR="/lib/modules/$(uname -r)/build"
  elif [ -d "/usr/src/linux-headers-$(uname -r)" ]; then
    KERNELDIR="/usr/src/linux-headers-$(uname -r)"
  elif [ -d "/usr/src/linux-headers-6.1-rockchip" ]; then
    KERNELDIR="/usr/src/linux-headers-6.1-rockchip"
  fi
fi

if [ -z "${TOOLCHAIN_DIR}" ]; then
  if [ -x "${DEFAULT_TOOLCHAIN_DIR}/bin/aarch64-none-linux-gnu-gcc" ]; then
    TOOLCHAIN_DIR="${DEFAULT_TOOLCHAIN_DIR}"
  else
    TOOLCHAIN_DIR="${REPO_DIR}/toolchain"
  fi
fi

if [ -z "${CROSS_COMPILE}" ] && [ -d "${TOOLCHAIN_DIR}/bin" ] && [ -x "${TOOLCHAIN_DIR}/bin/aarch64-none-linux-gnu-gcc" ]; then
  export PATH="${TOOLCHAIN_DIR}/bin:${PATH}"
  CROSS_COMPILE="aarch64-none-linux-gnu-"
fi
if [ -z "${ARCH}" ] && [ -n "${CROSS_COMPILE}" ]; then
  ARCH="arm64"
fi

if [ -z "${KERNELDIR}" ] || [ ! -d "${KERNELDIR}" ]; then
  echo "错误：未找到可用的内核 headers 目录。"
  echo "请先准备目标板(6.1.99)对应的内核源码/构建目录，并通过环境变量指定："
  echo "  KERNELDIR=/path/to/kernel/build  ./build_pango_pci_driver.sh"
  echo
  echo "提示：如果你把内核 headers 解压到 /root/code/kernel/，脚本会自动使用：${DEFAULT_KERNEL_DIR}"
  exit 1
fi

echo "==== 编译 pango_pci_driver.ko ===="
echo "PWD=${ROOT_DIR}"
echo "KERNELDIR=${KERNELDIR}"
echo "ARCH=${ARCH:-<default>}"
echo "CROSS_COMPILE=${CROSS_COMPILE:-<default>}"
echo "JOBS=${JOBS}"
echo

cd "${ROOT_DIR}"

EXTRA_ARGS=()
if [ -n "${ARCH}" ]; then EXTRA_ARGS+=("ARCH=${ARCH}"); fi
if [ -n "${CROSS_COMPILE}" ]; then EXTRA_ARGS+=("CROSS_COMPILE=${CROSS_COMPILE}"); fi

echo "---- 清理旧产物 ----"
make clean || true
echo

echo "---- 开始编译 ----"
make -j "${JOBS}" -C "${KERNELDIR}" M="${ROOT_DIR}" modules "${EXTRA_ARGS[@]}"
echo

if [ -f "${ROOT_DIR}/${KO_NAME}" ]; then
  echo "编译成功：${ROOT_DIR}/${KO_NAME}"
  if command -v modinfo >/dev/null 2>&1; then
    echo
    echo "modinfo（关键字段）："
    modinfo "${ROOT_DIR}/${KO_NAME}" | sed -n '1,30p'
  fi
else
  echo "编译失败：未生成 ${KO_NAME}"
  exit 1
fi
