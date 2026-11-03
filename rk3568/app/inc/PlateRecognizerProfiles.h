#pragma once

#include <cstddef>
#include <string>
#include <vector>

namespace plate_recognizer {

enum class ProfileId {
    PlateColor = 0,
    LegacyPlateRecColor = 1,
    DeployV12_20260812 = 2,
};

enum class TextLayout {
    TimeMajor21x78,
    ClassMajor78x1x21,
};

struct TensorView {
    std::vector<int> dims;
    std::size_t elements = 0;
};

struct Contract {
    int text_output_index = -1;
    int color_output_index = -1;
    int input_width = 0;
    int input_height = 0;
    int input_channels = 0;
    // RKNN model input attribute. The deployment contract transports the
    // source image as uint8 NHWC even when the model's internal input
    // attribute is INT8.
    int input_type = 0;
    int input_qnt_type = 0;
    int input_zero_point = 0;
    float input_scale = 1.0f;
    int input_fl = 0;
    TextLayout text_layout = TextLayout::TimeMajor21x78;
};

struct Profile {
    ProfileId id;
    const char *key;
    const char *display_name;
    const char *model_file;
    const char *output_contract;
    bool input_bgr;
    bool new_charset;
};

const std::vector<Profile> &profiles();
const Profile &profile(ProfileId id);
ProfileId profileFromInt(int value);
int profileToInt(ProfileId id);

bool validateContract(ProfileId id, int input_width, int input_height,
                      int input_channels, const std::vector<TensorView> &outputs,
                      Contract &contract, std::string &error);

const char *textLayoutName(TextLayout layout);

} // namespace plate_recognizer
