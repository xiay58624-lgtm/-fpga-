#include "AdasOutputContract.h"
#include "AdasDecisionPolicy.h"
#include <fstream>
#include <iostream>
#include <limits>
#include <stdexcept>

static void require(bool value, const char *message) {
    if (!value) throw std::runtime_error(message);
}
static void unitTests() {
    using namespace adas_models;
    Scene vehicles;
    for (int c = 0; c < 7; ++c) vehicles.observe(0, c, 100, 640);
    require(!vehicles.red && !vehicles.green && !vehicles.yellow &&
        !vehicles.laneBlocked(4), "BDD class IDs leaked into road rules");
    Scene dash;
    dash.observe(1, 0, 100, 640);
    dash.observe(1, 0, 500, 640);
    require(!dash.laneBlocked(4) && !dash.laneBlocked(5), "dashed lane blocks change");
    Scene solidLeft, solidRight;
    solidLeft.observe(1, 1, 100, 640);
    solidRight.observe(1, 1, 500, 640);
    require(solidLeft.laneBlocked(4) && !solidLeft.laneBlocked(5), "left solid restriction");
    require(!solidRight.laneBlocked(4) && solidRight.laneBlocked(5), "right solid restriction");
    require(!solidLeft.laneBlocked(0) && !solidRight.laneBlocked(2), "solid blocks non-lane direction");
    Scene yellow;
    yellow.observe(2, 16, 100, 640);
    require(yellow.yellow && !yellow.red && !yellow.laneBlocked(4), "yellow treated as red");
    Scene signals;
    signals.observe(2, 1, 100, 640);
    signals.observe(2, 8, 100, 640);
    require(signals.red && signals.green, "red/green priority inputs lost");
    Scene otherSignals;
    for (int c : {5, 6, 14, 15}) otherSignals.observe(2, c, 100, 640);
    require(!otherSignals.red && !otherSignals.green, "pedestrian lights control car");

    std::vector<float> data(6 * 8400, 0);
    data[0] = 320; data[8400] = 320; data[2 * 8400] = 30; data[3 * 8400] = 60;
    data[4 * 8400] = 0.82f;
    auto detections = decodeProbabilities(data.data(), 6, 8400, 2, 0.25f);
    require(detections.size() == 1 && detections[0].classId == 0 &&
        std::abs(detections[0].confidence - 0.82f) < 1e-6f, "class/probability decode");
    require(decodeProbabilities(data.data(), 6, 8400, 2, 0.9f).empty(), "threshold ignored");
    auto rejected = [&](int channels, int count) {
        try { decodeProbabilities(data.data(), channels, count, 2, 0.25f); }
        catch (const std::runtime_error &) { return true; }
        return false;
    };
    require(rejected(11, 8400) && rejected(6, 6), "incompatible output accepted");
    for (float bad : {-0.01f, 9.0f, std::numeric_limits<float>::quiet_NaN(),
                      std::numeric_limits<float>::infinity()}) {
        data[4 * 8400] = bad;
        require(rejected(6, 8400), "bad probability was converted into detection");
    }
    data[4 * 8400] = 0.9f;
    data[2 * 8400] = std::numeric_limits<float>::infinity();
    require(decodeProbabilities(data.data(), 6, 8400, 2, 0.25f).empty(), "invalid box accepted");
}
int main(int argc, char **argv) {
    try {
        unitTests();
        if (argc == 3) {
            const int classes = std::stoi(argv[2]);
            std::vector<float> data((4 + classes) * 8400);
            std::ifstream input(argv[1], std::ios::binary);
            input.read(reinterpret_cast<char *>(data.data()), data.size() * sizeof(float));
            require(input.gcount() == static_cast<std::streamsize>(data.size() * sizeof(float)),
                    "incomplete saved output");
            const auto detections = adas_models::decodeProbabilities(data.data(),
                4 + classes, 8400, classes, 0.25f);
            require(!detections.empty(), "saved positive output decoded empty");
            std::cout << "{\"candidates\":" << detections.size()
                << ",\"top_class\":" << detections[0].classId
                << ",\"top_score\":" << detections[0].confidence << "}\n";
        } else {
            std::cout << "ADAS probability decoding and model-isolated road policy: PASS\n";
        }
        return 0;
    } catch (const std::exception &e) {
        std::cerr << e.what() << '\n';
        return 1;
    }
}
