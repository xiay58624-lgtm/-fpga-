#pragma once

#include <array>
#include <string>
#include <vector>

namespace plate_detector {

enum class ProfileId {
    LegacyV5 = 0,
    V5Focus720 = 1,
    Yolo26P3Lite384 = 2,
    Yolo26P3Fp16 = 3,
    V5Shuffle720 = 4,
    Pose26_1280x720_Fp = 5,
    Pose26_1280x720_FullInt8 = 6,
    Pose26_1280x720_KptFp16 = 7,
    Pose26_1280x720_P4UpstreamFp16 = 8,
};

enum class Family {
    YoloV5,
    Yolo26,
};

enum class TensorLayout {
    Nchw,
    Nhwc,
};

struct Profile {
    ProfileId id;
    const char *key;
    const char *display_name;
    const char *family_name;
    const char *model_file;
    int input_width;
    int input_height;
    Family family;
    const char *output_contract;
    bool custom_decoder;
    bool require_float_outputs;
    const char *sha256;
};

struct TensorView {
    const float *data = nullptr;
    std::vector<int> dims;
    TensorLayout layout = TensorLayout::Nchw;
    // Quantized outputs stay in their RKNN-native buffer. The decoder
    // dequantizes one value on demand instead of requesting a float tensor.
    const void *raw_data = nullptr;
    bool quantized = false;
    bool uint8 = false;
    int zero_point = 0;
    float scale = 1.0f;
};

struct Detection {
    float left = 0.0f;
    float top = 0.0f;
    float right = 0.0f;
    float bottom = 0.0f;
    float confidence = 0.0f;
    int class_id = -1;
    int head = -1;
    std::array<float, 8> landmarks{};
};

struct DecodeStats {
    int score_candidates = 0;
    int decoded_candidates = 0;
    int nms_kept = 0;
};

const std::vector<Profile> &profiles();
const Profile &profile(ProfileId id);
ProfileId profileFromInt(int value);
int profileToInt(ProfileId id);

bool validateContract(ProfileId id, int input_width, int input_height,
                      const std::vector<TensorView> &outputs,
                      std::string &error);

bool decode(ProfileId id, const std::vector<TensorView> &outputs,
            float minimum_score, std::vector<Detection> &detections,
            DecodeStats &stats, std::string &error,
            const std::array<float, 3> *head_thresholds = nullptr);

} // namespace plate_detector
