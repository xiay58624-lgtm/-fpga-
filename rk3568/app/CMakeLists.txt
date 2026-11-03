cmake_minimum_required(VERSION 3.10)
project(RK3568_PCIe_YOLO LANGUAGES CXX C)

include(CTest)

# --- 1. 编译选项配置 ---
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# 开启 Qt 自动工具（必须在 find_package 之前或之后立即设置）
set(CMAKE_AUTOMOC ON)
set(CMAKE_AUTOUIC ON)
set(CMAKE_AUTORCC ON)

# --- 2. 查找依赖包 ---
find_package(Qt5 COMPONENTS Widgets Gui Core Network REQUIRED)
find_package(OpenCV REQUIRED COMPONENTS core imgproc imgcodecs videoio)

# --- 3. 搜索底层库 (显式指定 Sysroot 路径防止混淆) ---
# 搜索 RKNN 运行时库
find_library(RKNN_LIB rknnrt PATHS ${CMAKE_SYSROOT}/usr/lib)

# RGA is optional. Builds made from older board sysroots keep the OpenCV
# preprocessing fallback instead of failing configuration.
find_path(RGA_INCLUDE_DIR
    NAMES im2d.h
    PATHS
        ${CMAKE_SYSROOT}/usr/include/rga
        ${CMAKE_SYSROOT}/usr/include
    NO_DEFAULT_PATH
)
find_library(RGA_LIB
    NAMES rga
    PATHS
        ${CMAKE_SYSROOT}/usr/lib/aarch64-linux-gnu
        ${CMAKE_SYSROOT}/usr/lib
    NO_DEFAULT_PATH
)

# 显式收敛 OpenCV 链接范围，避免 OpenCV 聚合变量把 gdal 等重依赖带进来
find_library(OPENCV_CORE_LIB
    NAMES opencv_core
    PATHS ${CMAKE_SYSROOT}/usr/lib/aarch64-linux-gnu ${CMAKE_SYSROOT}/usr/lib
    NO_DEFAULT_PATH
)
find_library(OPENCV_IMGPROC_LIB
    NAMES opencv_imgproc
    PATHS ${CMAKE_SYSROOT}/usr/lib/aarch64-linux-gnu ${CMAKE_SYSROOT}/usr/lib
    NO_DEFAULT_PATH
)
find_library(OPENCV_VIDEOIO_LIB
    NAMES opencv_videoio
    PATHS ${CMAKE_SYSROOT}/usr/lib/aarch64-linux-gnu ${CMAKE_SYSROOT}/usr/lib
    NO_DEFAULT_PATH
)
find_library(OPENCV_IMGCODECS_LIB
    NAMES opencv_imgcodecs
    PATHS ${CMAKE_SYSROOT}/usr/lib/aarch64-linux-gnu ${CMAKE_SYSROOT}/usr/lib
    NO_DEFAULT_PATH
)
# 搜索数学库 (显式指定之前同步的 aarch64 目录)
# 增加 NAMES 匹配 libblas.so.3 确保能直接找到你刚同步的真身
find_library(BLAS_LIB 
    NAMES blas libblas.so.3 
    PATHS ${CMAKE_SYSROOT}/usr/lib/aarch64-linux-gnu 
    NO_DEFAULT_PATH
)

find_library(LAPACK_LIB 
    NAMES lapack liblapack.so.3 
    PATHS ${CMAKE_SYSROOT}/usr/lib/aarch64-linux-gnu 
    NO_DEFAULT_PATH
)

# 打印搜索结果，方便在 cmake .. 阶段排查
message(STATUS "--------------------------------------------")
message(STATUS "OpenCV core:    ${OPENCV_CORE_LIB}")
message(STATUS "OpenCV imgproc: ${OPENCV_IMGPROC_LIB}")
message(STATUS "OpenCV videoio: ${OPENCV_VIDEOIO_LIB}")
message(STATUS "OpenCV imgcodecs: ${OPENCV_IMGCODECS_LIB}")
message(STATUS "RKNN Library:   ${RKNN_LIB}")
message(STATUS "RGA Include:    ${RGA_INCLUDE_DIR}")
message(STATUS "RGA Library:    ${RGA_LIB}")
message(STATUS "BLAS Library:   ${BLAS_LIB}")
message(STATUS "LAPACK Library: ${LAPACK_LIB}")
message(STATUS "--------------------------------------------")

# --- 4. 包含目录配置 ---
include_directories(
    inc
    ${OpenCV_INCLUDE_DIRS}
    ${CMAKE_SYSROOT}/usr/include # 确保下载的 rknn_api.h 能被搜到
)

# --- 5. 源文件列表 ---
# 注意：必须把含有 Q_OBJECT 宏的头文件加入 SRC_LIST，
# 否则 AUTOMOC 可能无法识别并生成对应的 moc_xxx.cpp 文件，导致 vtable 错误。
set(SRC_LIST
    src/main.cpp
    src/MainWindow.cpp
    src/GpuVideoWidget.cpp
    src/CaptureThread.cpp
    src/RoadInferenceWorker.cpp
    src/AdasModelSet.cpp
    src/OverlayPatch.cpp
    src/yolo.cpp
    src/PlateDetectorProfiles.cpp
    src/PlateRecognizerProfiles.cpp
    src/generic_yolo.cpp
    src/adas_yolo.cpp
    src/nav_yolo.cpp
    src/BusinessDialog.cpp
    src/PerfDialog.cpp
    src/LoginDialog.cpp
    src/UserWindow.cpp
    src/UserBusinessStore.cpp
    src/UserMessageConfig.cpp
    src/UserMessageCloudSync.cpp
    src/TtsWavPlayer.cpp
    src/BackendSettings.cpp
    src/RuntimeSettings.cpp
    src/PlateCategory.cpp
    src/PlateEvaluator.cpp
    src/DriverStatusCollector.cpp
    src/DriverStatusDialog.cpp
    src/ApiServer.cpp
    src/BackendClient.cpp
    src/VehicleClient.cpp
    inc/MainWindow.h
    inc/GpuVideoWidget.h
    inc/InferenceTimingPolicy.h
    inc/CaptureThread.h
    inc/RoadInferenceWorker.h
    inc/AdasModelSet.h
    inc/AdasOutputContract.h
    inc/AdasDecisionPolicy.h
    inc/AsyncRoadWorker.h
    inc/OverlayPatch.h
    inc/PlateDetectorProfiles.h
    inc/PlateRecognizerProfiles.h
    inc/generic_yolo.h
    inc/adas_yolo.h
    inc/nav_yolo.h
    inc/BusinessDialog.h
    inc/PerfDialog.h
    inc/LoginDialog.h
    inc/UserWindow.h
    inc/UserBusinessStore.h
    inc/UserMessageConfig.h
    inc/UserMessageCloudSync.h
    inc/TtsWavPlayer.h
    inc/BackendSettings.h
    inc/RuntimeSettings.h
    inc/PlateCategory.h
    inc/PlateEvaluator.h
    inc/DriverStatusCollector.h
    inc/DriverStatusDialog.h
    inc/ApiServer.h
    inc/BackendClient.h
    inc/VehicleClient.h
)

# --- 6. 生成目标 ---
add_executable(${PROJECT_NAME} ${SRC_LIST})

if(RGA_INCLUDE_DIR AND RGA_LIB)
    target_include_directories(${PROJECT_NAME} PRIVATE ${RGA_INCLUDE_DIR})
    target_compile_definitions(${PROJECT_NAME} PRIVATE RK3568_HAVE_RGA=1)
endif()

# --- 7. 链接库配置 ---
target_link_libraries(${PROJECT_NAME}
    Qt5::Widgets
    Qt5::Gui
    Qt5::Core
    Qt5::Network
    ${OPENCV_CORE_LIB}
    ${OPENCV_IMGPROC_LIB}
    ${OPENCV_VIDEOIO_LIB}
    ${OPENCV_IMGCODECS_LIB}
    ${RKNN_LIB}
    $<$<BOOL:${RGA_LIB}>:${RGA_LIB}>
    ${BLAS_LIB}     # 解决 OpenCV 的底层数学依赖
    ${LAPACK_LIB}   # 解决 OpenCV 的底层数学依赖
    pthread         # 多线程支持
    dl              # 动态库加载支持
)

# 尽量避免目标板运行时再依赖宿主机交叉链带来的 libstdc++/libgcc 共享库版本。
target_link_options(${PROJECT_NAME} PRIVATE
    -static-libstdc++
    -static-libgcc
)

if(BUILD_TESTING)
    add_executable(latest_road_scheduling_tests tests/LatestRoadSchedulingTests.cpp)
    target_link_libraries(latest_road_scheduling_tests Qt5::Core ${OPENCV_CORE_LIB} pthread)
    add_test(NAME road_per_source_latest COMMAND latest_road_scheduling_tests)

    add_executable(overlay_patch_tests
        tests/OverlayPatchTests.cpp
        src/OverlayPatch.cpp
        inc/OverlayPatch.h
    )
    target_include_directories(overlay_patch_tests PRIVATE inc)
    target_link_libraries(overlay_patch_tests
        ${OPENCV_CORE_LIB}
        ${OPENCV_IMGPROC_LIB}
    )
    add_test(NAME overlay_patch_local_composition COMMAND overlay_patch_tests)

    add_executable(plate_detector_profiles_tests
        tests/PlateDetectorProfilesTests.cpp
        src/PlateDetectorProfiles.cpp
        inc/PlateDetectorProfiles.h
    )
    target_include_directories(plate_detector_profiles_tests PRIVATE inc)
    add_test(NAME plate_detector_profiles_contract COMMAND plate_detector_profiles_tests)

    add_executable(plate_recognizer_profiles_tests
        tests/PlateRecognizerProfilesTests.cpp
        src/PlateRecognizerProfiles.cpp
        inc/PlateRecognizerProfiles.h
    )
    target_include_directories(plate_recognizer_profiles_tests PRIVATE inc)
    add_test(NAME plate_recognizer_profiles_contract COMMAND plate_recognizer_profiles_tests)

    add_executable(plate_sliding_tests
        tests/PlateSlidingTests.cpp
        inc/PlateSliding.h
    )
    target_include_directories(plate_sliding_tests PRIVATE inc)
    add_test(NAME plate_sliding_geometry COMMAND plate_sliding_tests)

    add_executable(plate_text_validation_tests
        tests/PlateTextValidationTests.cpp
        inc/PlateTextValidation.h
    )
    target_include_directories(plate_text_validation_tests PRIVATE inc)
    add_test(NAME plate_text_validation COMMAND plate_text_validation_tests)

    add_executable(plate_consensus_tests
        tests/PlateConsensusTests.cpp
        inc/PlateConsensus.h
    )
    target_include_directories(plate_consensus_tests PRIVATE inc)
    add_test(NAME plate_consensus_state COMMAND plate_consensus_tests)

    add_executable(plate_postprocess_tests
        tests/PlatePostprocessTests.cpp
        inc/yolov5_ztopt_3out_postprocess.hpp
        inc/structures.hpp
    )
    target_include_directories(plate_postprocess_tests PRIVATE inc)
    add_test(NAME plate_postprocess_threshold_semantics COMMAND plate_postprocess_tests)

    add_executable(plate_category_tests
        tests/PlateCategoryTests.cpp
        src/PlateCategory.cpp
        inc/PlateCategory.h
    )
    target_include_directories(plate_category_tests PRIVATE inc)
    target_link_libraries(plate_category_tests Qt5::Core)
    add_test(NAME plate_category_rules COMMAND plate_category_tests)

    add_executable(plate_authenticity_tests
        tests/PlateAuthenticityTests.cpp
        inc/PlateAuthenticity.h
    )
    target_include_directories(plate_authenticity_tests PRIVATE inc)
    add_test(NAME plate_authenticity_rules COMMAND plate_authenticity_tests)

    add_executable(plate_color_arbitration_tests
        tests/PlateColorArbitrationTests.cpp
        inc/PlateColorArbitration.h
    )
    target_include_directories(plate_color_arbitration_tests PRIVATE inc)
    add_test(NAME plate_color_arbitration_rules COMMAND plate_color_arbitration_tests)

    add_executable(plate_ocr_policy_tests
        tests/PlateOcrPolicyTests.cpp
        inc/PlateOcrPolicy.h
    )
    target_include_directories(plate_ocr_policy_tests PRIVATE inc)
    add_test(NAME plate_ocr_policy_rules COMMAND plate_ocr_policy_tests)

    add_executable(latest_frame_policy_tests
        tests/LatestFramePolicyTests.cpp
        inc/LatestFramePolicy.h
        inc/PlateDisplayPolicy.h
    )
    target_include_directories(latest_frame_policy_tests PRIVATE inc)
    add_test(NAME latest_frame_policy COMMAND latest_frame_policy_tests)
endif()
