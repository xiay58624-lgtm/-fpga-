#!/bin/bash

# 获取脚本所在的绝对路径
ROOT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"

# --- Runtime bundle paths ---
# Use RK3568_APP_BIN/RK3568_MODEL_DIR for an explicit override. Otherwise use
# the normal app/ tree and fall back to the versioned deployment bundle.
APP_BUNDLE_DIR="${RK3568_BUNDLE_DIR:-${ROOT_DIR}}"
APP_BIN="${RK3568_APP_BIN:-${APP_BUNDLE_DIR}/app/output/RK3568_PCIe_YOLO}"
MODEL_DIR_DEFAULT="${APP_BUNDLE_DIR}/app/model"
if [ -z "${RK3568_APP_BIN:-}" ] && [ ! -f "${APP_BIN}" ] && \
   [ -f "${ROOT_DIR}/deploy-v10.0/app/output/RK3568_PCIe_YOLO" ]; then
    APP_BUNDLE_DIR="${ROOT_DIR}/deploy-v10.0"
    APP_BIN="${APP_BUNDLE_DIR}/app/output/RK3568_PCIe_YOLO"
    MODEL_DIR_DEFAULT="${APP_BUNDLE_DIR}/app/model"
fi
DRIVER_ROOT="${RK3568_DRIVER_ROOT:-${ROOT_DIR}}"
if [ -f "${APP_BUNDLE_DIR}/driver/pango_pci_driver.ko" ]; then
    DRIVER_ROOT="${APP_BUNDLE_DIR}"
fi
DRIVER_KO="${RK3568_DRIVER_KO:-${DRIVER_ROOT}/driver/pango_pci_driver.ko}"

# --- 环境变量配置 ---
# 解决中文字体显示问题 (文泉驿正黑)
export QT_QPA_FONTDIR=/usr/share/fonts/truetype/wqy
# 模型目录（放置检测模型和可选 OCR profiles）
export RK3568_MODEL_DIR="${RK3568_MODEL_DIR:-${MODEL_DIR_DEFAULT}}"
export RK3568_ENV_MODEL_SET="${RK3568_ENV_MODEL_SET:-bdd}"
# This deployment bundle is for the three environment models. Keep the mode
# independent of an older GUI settings file left on the board.
export RK3568_ALGO_MODE="${RK3568_ALGO_MODE:-1}"
# This RK node is a passive perception/display endpoint. Vehicle commands and
# legacy cloud reports belong to the external upper computer.
export RK3568_DISPLAY_ONLY="${RK3568_DISPLAY_ONLY:-0}"
export RK3568_UI_720P="${RK3568_UI_720P:-1}"
# Start the ADAS operator view without leaving the board at the login dialog.
# Set RK3568_AUTO_LOGIN=0 before launching to restore the normal login flow.
export RK3568_AUTO_LOGIN="${RK3568_AUTO_LOGIN:-1}"
export RK3568_AUTO_CAPTURE="${RK3568_AUTO_CAPTURE:-1}"
# 管理员认证文件（放在工程目录，断电重启也能保留）
export RK3568_AUTH_PATH=${APP_BUNDLE_DIR}/app/config/admin_auth.json
# GUI 运行参数文件（设置页修改后自动保存，程序启动时自动导入）
export RK3568_RUNTIME_SETTINGS_PATH=/userdata/rk3568/runtime_settings.json
export RK3568_PLATE_RECOGNIZER_PROFILE=${RK3568_PLATE_RECOGNIZER_PROFILE:-0}
# 云后端地址配置文件（GUI 设置页保存，普通用户/管理员/开发者共用）
export RK3568_BACKEND_CONFIG_PATH=/userdata/rk3568/backend_config.json
mkdir -p "${APP_BUNDLE_DIR}/app/config" /userdata/rk3568 2>/dev/null
# DATALOG 默认目录（报表/图片/配置）
export RK3568_DATALOG_DIR=${APP_BUNDLE_DIR}/app/DATALOG
export RK3568_REPORT_DIR_CSV=${RK3568_DATALOG_DIR}/report/csv
export RK3568_REPORT_DIR_JSON=${RK3568_DATALOG_DIR}/report/json
export RK3568_REPORT_DIR_EXCEL=${RK3568_DATALOG_DIR}/report/excel
export RK3568_IMAGE_DIR=${RK3568_DATALOG_DIR}/image
mkdir -p "${RK3568_REPORT_DIR_CSV}" "${RK3568_REPORT_DIR_JSON}" "${RK3568_REPORT_DIR_EXCEL}" "${RK3568_IMAGE_DIR}" 2>/dev/null

# 业务配置文件（停车场计费 / ETC）
export RK3568_BUSINESS_PATH=${RK3568_REPORT_DIR_JSON}/business.json
mkdir -p "${APP_BUNDLE_DIR}/app/config" 2>/dev/null

# 性能开关：默认启用更快的 RGB565->BGR 转换；若画面异常可在运行前设置为 0 关闭
export RK3568_FAST_RGB565=${RK3568_FAST_RGB565:-1}
# Safe inference defaults. These can still be overridden before running:
#   RK3568_PLATE_INFER_STRIDE=1 ./run.sh
#   RK3568_PCIE_INFERENCE_STRATEGY=0 ./run.sh  # speed; 1 preserves small objects
export RK3568_ENV_INFER_STRIDE=${RK3568_ENV_INFER_STRIDE:-1}
export RK3568_ENV_WANT_FLOAT=${RK3568_ENV_WANT_FLOAT:-1}
export RK3568_ENV_OVERLAY_MAX_AGE_MS=${RK3568_ENV_OVERLAY_MAX_AGE_MS:-700}
export RK3568_PLATE_INFER_STRIDE=${RK3568_PLATE_INFER_STRIDE:-1}
export RK3568_PLATE_SIG_FORCE=${RK3568_PLATE_SIG_FORCE:-0}
export RK3568_PLATE_OCR_PERIOD=${RK3568_PLATE_OCR_PERIOD:-2}
export RK3568_PLATE_OCR_FAST_PERIOD=${RK3568_PLATE_OCR_FAST_PERIOD:-1}
export RK3568_PLATE_BOX_HOLD_RUNS=${RK3568_PLATE_BOX_HOLD_RUNS:-1}
# Keep offline cloud reports bounded by bytes as well as item count. Violation
# reports contain base64 JPEGs, so a count-only limit can still fill eMMC.
export RK3568_REPORT_QUEUE_MAX_BYTES=${RK3568_REPORT_QUEUE_MAX_BYTES:-33554432}
# PCIe display always uses the newest frame. Detection overlays older than
# this limit are discarded instead of being painted onto a moving image.
export RK3568_PCIE_OVERLAY_MAX_AGE_MS=${RK3568_PCIE_OVERLAY_MAX_AGE_MS:-350}
unset RK3568_PLATE_SLIDING_MODE_OVERRIDE
export RK3568_PLATE_SLIDING_MODE=2
unset RK3568_PLATE_SLIDING_CONF RK3568_PLATE_SLIDING_MAX_SIDE
# V1 half-sampled capture uses one DMA operation per 1280-pixel RGB565 row.
export RK3568_DMA_WAIT_IRQ=${RK3568_DMA_WAIT_IRQ:-0}
export RK3568_DMA_SPIN=${RK3568_DMA_SPIN:-2500}
# One ioctl asks the V1 driver to collect all 720 rows and copy one frame.
# Set to 0 only to compare against the legacy two-ioctl-per-row path.
export RK3568_V1_BATCH=${RK3568_V1_BATCH:-1}
# The V1 protocol is pull-driven, so the host producer must not run unbounded.
export RK3568_V1_TARGET_FPS=${RK3568_V1_TARGET_FPS:-30}

run_root_sh() {
    if [ "$(id -u)" -eq 0 ]; then
        sh -c "$1"
        return $?
    fi
    if command -v sudo >/dev/null 2>&1; then
        sudo sh -c "$1"
        return $?
    fi
    echo "skip root command: sudo not found"
    return 1
}

run_root_cmd() {
    if [ "$(id -u)" -eq 0 ]; then
        "$@"
        return $?
    fi
    if command -v sudo >/dev/null 2>&1; then
        sudo "$@"
        return $?
    fi
    return 1
}

detect_data_owner() {
    if [ -n "${SUDO_USER:-}" ] && [ "${SUDO_USER}" != "root" ] && id "${SUDO_USER}" >/dev/null 2>&1; then
        printf '%s\n' "${SUDO_USER}"
    elif [ "$(id -u)" -ne 0 ]; then
        id -un
    elif id linaro >/dev/null 2>&1; then
        printf '%s\n' "linaro"
    else
        stat -c '%U' "${ROOT_DIR}" 2>/dev/null || printf '%s\n' "root"
    fi
}

ensure_config_permissions() {
    local data_owner data_group
    data_owner="$(detect_data_owner)"
    data_group="$(id -gn "${data_owner}" 2>/dev/null || printf '%s' "${data_owner}")"
    case "${data_owner}:${data_group}" in
        *[!A-Za-z0-9_.:-]*)
            echo "警告: 无法确定安全的配置文件属主，跳过权限修复。"
            return 0
            ;;
    esac

    run_root_cmd mkdir -p "${ROOT_DIR}/app/config" /userdata/rk3568 >/dev/null 2>&1 || true
    run_root_cmd chown -R "${data_owner}:${data_group}" \
        "${ROOT_DIR}/app/config" /userdata/rk3568 >/dev/null 2>&1 || true
    run_root_cmd chmod 700 "${ROOT_DIR}/app/config" /userdata/rk3568 >/dev/null 2>&1 || true
    if [ -f "${RK3568_AUTH_PATH}" ]; then
        run_root_cmd chmod 600 "${RK3568_AUTH_PATH}" >/dev/null 2>&1 || true
    fi

    if [ ! -r "${RK3568_AUTH_PATH}" ] && [ -f "${RK3568_AUTH_PATH}" ]; then
        echo "警告: 当前用户仍无法读取认证文件: ${RK3568_AUTH_PATH}"
    else
        echo "配置文件属主: ${data_owner}:${data_group}"
    fi
}

set_perf_governors() {
    if [ "${RK3568_LOCK_PERF:-1}" = "0" ]; then
        echo "performance lock disabled: RK3568_LOCK_PERF=0"
        return 0
    fi
    echo "setting CPU/GPU/NPU governors to performance..."
    run_root_sh '
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
'
}
# 确保包含项目所需的动态库
ensure_config_permissions
set_perf_governors

# Keep one bounded runtime log and one rotated backup. Terminal output remains
# visible through tee, while startup/login failures survive the SSH session.
RK3568_LOG_DIR=${RK3568_LOG_DIR:-/userdata/rk3568/logs}
RK3568_LOG_FILE=${RK3568_LOG_DIR}/rk_gui.log
mkdir -p "${RK3568_LOG_DIR}" 2>/dev/null || true
if [ -f "${RK3568_LOG_FILE}" ]; then
    LOG_SIZE="$(stat -c %s "${RK3568_LOG_FILE}" 2>/dev/null || printf '0')"
    case "${LOG_SIZE}" in
        ""|*[!0-9]*) LOG_SIZE=0 ;;
    esac
    if [ "${LOG_SIZE}" -ge 5242880 ]; then
        mv -f "${RK3568_LOG_FILE}" "${RK3568_LOG_FILE}.1" 2>/dev/null || true
    fi
fi
if command -v tee >/dev/null 2>&1 && [ -d "${RK3568_LOG_DIR}" ]; then
    exec > >(tee -a "${RK3568_LOG_FILE}") 2>&1
fi

if [ -d "${ROOT_DIR}/app/lib" ]; then
    if [ -n "${LD_LIBRARY_PATH:-}" ]; then
        export LD_LIBRARY_PATH="${ROOT_DIR}/app/lib:${LD_LIBRARY_PATH}"
    else
        export LD_LIBRARY_PATH="${ROOT_DIR}/app/lib"
    fi
fi

# Qt Widgets and QOpenGLWidget share one top-level backing store. The tested
# RK3568 xcb_egl/Mali stack moves the entire maximized window while composing,
# so stable raster composition is the production default. Hardware GL remains
# opt-in for diagnostics or a future native EGL video surface.
GUI_OPENGL_MODE="${RK3568_GUI_OPENGL:-0}"
case "${GUI_OPENGL_MODE}" in
    0|off|false)
        export RK3568_GUI_OPENGL=0
        export QT_XCB_GL_INTEGRATION=none
        export QT_OPENGL=software
        export LIBGL_ALWAYS_SOFTWARE=1
        ;;
    *)
        unset QT_OPENGL
        unset LIBGL_ALWAYS_SOFTWARE
        export QT_XCB_GL_INTEGRATION="${RK3568_QT_XCB_GL_INTEGRATION:-xcb_egl}"
        MALI_USER_LIB_DIR="${RK3568_MALI_LIB_DIR:-/usr/lib/aarch64-linux-gnu/mali}"
        if [ -f "${MALI_USER_LIB_DIR}/libEGL.so.1" ]; then
            if [ -n "${LD_LIBRARY_PATH:-}" ]; then
                export LD_LIBRARY_PATH="${MALI_USER_LIB_DIR}:${LD_LIBRARY_PATH}"
            else
                export LD_LIBRARY_PATH="${MALI_USER_LIB_DIR}"
            fi
        fi
        ;;
esac
# Bound glibc's per-thread allocation arenas. The GUI, OpenCV and RKNN use
# several worker threads; unrestricted arenas retain avoidable memory on a
# 2/4 GB embedded target even after temporary frame buffers are released.
export MALLOC_ARENA_MAX=${MALLOC_ARENA_MAX:-2}
if [ -z "${XDG_RUNTIME_DIR}" ]; then
    export XDG_RUNTIME_DIR="/tmp/runtime-${USER}"
    mkdir -p "${XDG_RUNTIME_DIR}" 2>/dev/null
    chmod 700 "${XDG_RUNTIME_DIR}" 2>/dev/null
fi

echo -e "\033[0;32m==== RK3568 PCIe YOLO 自动化启动脚本 ====\033[0m"

# 1. 检查并自动修复程序执行权限
if [ -f "$APP_BIN" ]; then
    echo "正在检查并修复程序执行权限..."
    chmod +x "$APP_BIN"
    echo "程序路径: $APP_BIN"
    if command -v md5sum >/dev/null 2>&1; then
        echo "程序MD5: $(md5sum "$APP_BIN" | awk '{print $1}')"
    fi
    if command -v strings >/dev/null 2>&1; then
        if strings "$APP_BIN" 2>/dev/null | grep -q "RK3568 PCIe 智能监控终端"; then
            echo "登录模块: 已集成"
        else
            echo -e "\033[1;33m登录模块: 未检测到（请确认已替换最新二进制）\033[0m"
        fi
    fi
else
    echo -e "\033[0;31m错误: 找不到可执行文件 $APP_BIN\033[0m"
    echo "请确认是否已运行 ./build.sh 并成功生成 output 目录。"
    exit 1
fi

# 2. 检查并加载 PCIe 驱动
MOUNT_SH="${ROOT_DIR}/driver/mount_pango_pci_driver.sh"
FILE_DRIVER_VERSION=""
REQUIRED_V1_BATCH_DRIVER_VERSION="1.1.0"
if command -v modinfo >/dev/null 2>&1 && [ -f "$DRIVER_KO" ]; then
    FILE_DRIVER_VERSION="$(modinfo -F version "$DRIVER_KO" 2>/dev/null || true)"
elif command -v readelf >/dev/null 2>&1 && [ -f "$DRIVER_KO" ]; then
    FILE_DRIVER_VERSION="$(readelf -p .modinfo "$DRIVER_KO" 2>/dev/null | sed -n 's/.*version=\([0-9][0-9.]*\).*/\1/p' | head -n 1)"
elif command -v strings >/dev/null 2>&1 && [ -f "$DRIVER_KO" ]; then
    FILE_DRIVER_VERSION="$(strings -a "$DRIVER_KO" 2>/dev/null | sed -n 's/^version=//p' | head -n 1)"
fi
echo "驱动文件接口: V1 legacy + 整帧批量扩展（ioctl 30）"
echo "驱动文件版本: ${FILE_DRIVER_VERSION:-legacy/unknown}"
if [ "${FILE_DRIVER_VERSION:-legacy/unknown}" != "${REQUIRED_V1_BATCH_DRIVER_VERSION}" ]; then
    echo -e "\033[1;33m提示: 当前 .ko 不含已确认的批量版本标识 ${REQUIRED_V1_BATCH_DRIVER_VERSION}；应用会回退逐行取帧，需重新编译驱动才能获得本次优化。\033[0m"
fi
if lsmod 2>/dev/null | awk '{print $1}' | grep -qx "pango_pci_driver"; then
    echo "提示: 检测到 pango_pci_driver 已加载，跳过重复挂载。"
    LOADED_DRIVER_VERSION="$(cat /sys/module/pango_pci_driver/version 2>/dev/null || true)"
    echo "已加载驱动版本: ${LOADED_DRIVER_VERSION:-legacy/unknown}"
    echo "驱动文件版本: ${FILE_DRIVER_VERSION:-legacy/unknown}"
    if [ "$LOADED_DRIVER_VERSION" != "$FILE_DRIVER_VERSION" ]; then
        echo -e "\033[1;33m已加载模块与当前 V1 驱动文件版本标识不一致，正在重载磁盘模块...\033[0m"
        if ! run_root_cmd rmmod pango_pci_driver; then
            echo -e "\033[0;31m错误: 旧驱动正在被占用，无法卸载。请先关闭仍在运行的 RK3568_PCIe_YOLO。\033[0m"
            exit 1
        fi
        if ! run_root_cmd insmod "$DRIVER_KO"; then
            echo -e "\033[0;31m错误: 新驱动加载失败，停止启动应用。\033[0m"
            exit 1
        fi
        LOADED_DRIVER_VERSION="$(cat /sys/module/pango_pci_driver/version 2>/dev/null || true)"
        if [ "$LOADED_DRIVER_VERSION" != "$FILE_DRIVER_VERSION" ]; then
            echo -e "\033[0;31m错误: 重载后模块版本标识仍与磁盘文件不一致。\033[0m"
            exit 1
        fi
        echo "驱动自动重载完成: ${LOADED_DRIVER_VERSION:-legacy/unknown}"
    fi
    run_root_cmd chmod 666 /dev/pango* 2>/dev/null || true
elif [ -e "/dev/pango_pci_driver" ] || ls /dev/pango* >/dev/null 2>&1; then
    echo "提示: 检测到 PANGU 设备节点已存在，跳过重复挂载。"
    sudo chmod 666 /dev/pango* 2>/dev/null || true
elif [ -f "$MOUNT_SH" ]; then
    echo "正在通过挂载脚本加载/诊断驱动..."
    chmod +x "$MOUNT_SH" 2>/dev/null || true
    KO_PATH="$DRIVER_KO" "$MOUNT_SH" || true
else
    if lsmod | grep -q "pango_pci_driver"; then
        echo "提示: pango_pci_driver 驱动已在内核中。"
    else
        if [ -f "$DRIVER_KO" ]; then
            echo "正在加载 PCIe 驱动..."
            sudo insmod "$DRIVER_KO"
            # 自动给设备节点读写权限，防止程序因权限问题打不开硬件
            sudo chmod 666 /dev/pango* 2>/dev/null
            echo "驱动加载完成。"
        else
            echo -e "\033[0;31m错误: 找不到驱动文件 $DRIVER_KO\033[0m"
            exit 1
        fi
    fi
fi

# 3. 启动程序
echo -e "\033[0;32m正在启动程序...\033[0m"
echo "提示：底部“显示”下拉框支持：拼接原图 / 单路源1-4 / 自定义拼接"
echo "提示：车牌滑窗已移除；PCIe/SD 均使用单次整图或单路模型输入。"
echo "提示：PCIe 使用 V1 半采样协议，接收 1280x720 RGB565 拼图，四路源各 640x360。"
echo "提示：V1 整帧批量取帧默认开启；旧驱动不支持时自动退回逐行 ioctl。"
echo "提示：PCIe 采用最新帧显示和异步车牌推理；推理繁忙时丢弃过期任务，不阻塞画面。"
echo "提示：GUI OpenGL mode=${GUI_OPENGL_MODE} xcb=${QT_XCB_GL_INTEGRATION}；实板已确认 raster 可避免整个窗口上下抖动。"
echo "提示：可用 RK3568_GUI_OPENGL=1 临时测试 xcb_egl；生产环境保持默认 raster。"
echo "提示：实板测速后 PCIe RGB565 默认使用更快的 OpenCV；RK3568_RGB565_RGA=1 可强制复测 RGA。"
echo "提示：单路预览缩放和 GUI 颜色转换仍优先 RGA；RK3568_CAPTURE_RGA=0 可关闭全部采集显示 RGA。"
echo "提示：本机为感知/显示端，仅提供 /api/adas/frame、/api/adas/snapshot 和 /api/detections/latest。"
echo "提示：小车指令由外部上位机发送，本机不接受 /api/vehicle/command 或 /api/vehicle/stop。"
if [ "${RK3568_ALGO_MODE}" = "1" ]; then
    MODEL_MISSING=0
    env_model=bdd100k_yolo11n_640_7class_split_rk3568_int8.rknn
    if [ ! -f "${RK3568_MODEL_DIR}/${env_model}" ]; then
        MODEL_MISSING=1
    fi
else
    MODEL_MISSING=0
    if [ ! -f "${RK3568_MODEL_DIR}/plate_detect_mixed.rknn" ] || {
        [ ! -f "${RK3568_MODEL_DIR}/plate_color.rknn" ] &&
        [ ! -f "${RK3568_MODEL_DIR}/plate_rec_color.rknn" ] &&
        [ ! -f "${RK3568_MODEL_DIR}/plate_ocr_v12_deploy_20260812.rknn" ];
    }; then
        MODEL_MISSING=1
    fi
fi
if [ "${MODEL_MISSING}" -ne 0 ]; then
    echo -e "\033[0;31m错误：未在 ${RK3568_MODEL_DIR} 找到模型文件，推理无法运行。\033[0m"
    if [ "${RK3568_ALGO_MODE}" = "1" ]; then
        echo "环境模式需要 BDD、道路标线、交通信号灯三套 RKNN 模型。"
    else
        echo "车牌模式需要车牌检测与识别 RKNN 模型。"
    fi
    echo
    echo "当前目录内容："
    ls -la "${RK3568_MODEL_DIR}" 2>/dev/null || true
    echo
    echo "修复方法：把模型拷到上述目录，或设置 RK3568_MODEL_DIR=/path/to/model 后再运行。"
    exit 1
fi
echo "运行日志: ${RK3568_LOG_FILE}"
"$APP_BIN"
APP_EXIT_CODE=$?
echo "程序退出: code=${APP_EXIT_CODE} time=$(date '+%F %T')"
if [ "${APP_EXIT_CODE}" -eq 137 ]; then
    echo "检测到 SIGKILL(code=137)，高概率为内核 OOM；以下诊断已同时写入运行日志。"
    echo "---- memory snapshot ----"
    free -h 2>/dev/null || true
    grep -E '^(MemTotal|MemFree|MemAvailable|Buffers|Cached|SwapTotal|SwapFree|CmaTotal|CmaFree):' \
        /proc/meminfo 2>/dev/null || true
    echo "---- recent OOM kernel messages ----"
    dmesg -T 2>/dev/null | grep -Ei \
        'out of memory|oom-kill|killed process|memory cgroup out of memory' | tail -n 80 || true
fi
exit "${APP_EXIT_CODE}"
