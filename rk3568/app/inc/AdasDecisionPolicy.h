#pragma once
#include <algorithm>

namespace adas_models {
// Aggregate camera 4 only. Model-local class IDs must never be mixed.
struct Scene {
    bool red = false, green = false, yellow = false;
    bool solidLeft = false, solidRight = false;
    void observe(int modelId, int classId, float centerX, float imageWidth) {
        if (modelId == 1 && classId == 1) {
            if (centerX < imageWidth / 2) solidLeft = true;
            else solidRight = true;
        }
        if (modelId != 2) return;
        red = red || (classId >= 8 && classId <= 13);
        green = green || (classId >= 0 && classId <= 4) || classId == 7;
        yellow = yellow || classId == 16;
    }
    bool laneBlocked(int direction) const {
        return (direction == 4 && solidLeft) || (direction == 5 && solidRight);
    }
};
}
