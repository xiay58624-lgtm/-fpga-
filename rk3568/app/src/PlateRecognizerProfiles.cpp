#include "PlateRecognizerProfiles.h"

#include <algorithm>
#include <initializer_list>
#include <sstream>

namespace plate_recognizer {
namespace {

const std::vector<Profile> kProfiles = {
    {ProfileId::PlateColor, "plate_color", "plate_color.rknn（当前颜色+文字）",
     "plate_color.rknn", "ocr_text_78x1x21_color_5", true, true},
    {ProfileId::LegacyPlateRecColor, "legacy_plate_rec_color",
     "plate_rec_color.rknn（旧版）", "plate_rec_color.rknn",
     "ocr_text_21x78_color_5", false, false},
    {ProfileId::DeployV12_20260812, "deploy_v12_20260812",
     "ocr_v12_deploy_20260812.rknn（新模型）",
     "plate_ocr_v12_deploy_20260812.rknn", "ocr_text_78x1x21_color_5", true,
     true},
};

bool hasShape(const TensorView &view, std::initializer_list<int> shape) {
    if (view.dims.size() != shape.size()) return false;
    return std::equal(view.dims.begin(), view.dims.end(), shape.begin());
}

} // namespace

const std::vector<Profile> &profiles() {
    return kProfiles;
}

const Profile &profile(ProfileId id) {
    for (const Profile &candidate : kProfiles) {
        if (candidate.id == id) return candidate;
    }
    return kProfiles.front();
}

ProfileId profileFromInt(int value) {
    for (const Profile &candidate : kProfiles) {
        if (profileToInt(candidate.id) == value) return candidate.id;
    }
    return ProfileId::PlateColor;
}

int profileToInt(ProfileId id) {
    return static_cast<int>(id);
}

const char *textLayoutName(TextLayout layout) {
    return layout == TextLayout::ClassMajor78x1x21
        ? "class_major_78x1x21"
        : "time_major_21x78";
}

bool validateContract(ProfileId id, int input_width, int input_height,
                      int input_channels, const std::vector<TensorView> &outputs,
                      Contract &contract, std::string &error) {
    error.clear();
    const Profile &selected = profile(id);
    if (input_width != 168 || input_height != 48 || input_channels != 3) {
        std::ostringstream message;
        message << "recognizer input must be 168x48x3, got "
                << input_width << "x" << input_height << "x" << input_channels;
        error = message.str();
        return false;
    }
    if (outputs.size() != 2) {
        error = "recognizer must expose exactly two outputs: text and color";
        return false;
    }

    int textIndex = -1;
    int colorIndex = -1;
    for (std::size_t index = 0; index < outputs.size(); ++index) {
        if (outputs[index].elements == 78u * 21u && textIndex < 0) {
            textIndex = static_cast<int>(index);
        } else if (outputs[index].elements == 5u && colorIndex < 0) {
            colorIndex = static_cast<int>(index);
        }
    }
    if (textIndex < 0 || colorIndex < 0) {
        error = "recognizer outputs must contain 78x21 text and 5-class color";
        return false;
    }

    TextLayout layout = selected.new_charset
        ? TextLayout::ClassMajor78x1x21
        : TextLayout::TimeMajor21x78;
    const TensorView &text = outputs[static_cast<std::size_t>(textIndex)];
    if (hasShape(text, {1, 78, 1, 21}) || hasShape(text, {78, 1, 21})) {
        layout = TextLayout::ClassMajor78x1x21;
    } else if (hasShape(text, {1, 21, 78}) || hasShape(text, {21, 78}) ||
               hasShape(text, {1, 1, 21, 78})) {
        layout = TextLayout::TimeMajor21x78;
    } else if (text.dims.empty()) {
        // Flat output is valid for the verified deploy model. Its profile
        // records the layout because RKNN may omit singleton dimensions.
        layout = selected.new_charset
            ? TextLayout::ClassMajor78x1x21
            : TextLayout::TimeMajor21x78;
    }

    contract.text_output_index = textIndex;
    contract.color_output_index = colorIndex;
    contract.input_width = input_width;
    contract.input_height = input_height;
    contract.input_channels = input_channels;
    contract.text_layout = layout;
    return true;
}

} // namespace plate_recognizer
