#include "PlateCategory.h"

namespace {

bool isColor(const QString &color, const QString &code, const QString &chinese) {
    const QString value = color.trimmed().toLower();
    return value == code || value == code + "plate" || value == code + "_plate" ||
           value == chinese || value == chinese + QStringLiteral("色") ||
           value == chinese + QStringLiteral("牌");
}

} // namespace

QString normalizePlateForProtocol(const QString &plate) {
    const QString upper = plate.trimmed().toUpper().normalized(QString::NormalizationForm_C);
    QString normalized;
    normalized.reserve(upper.size());
    for (const QChar ch : upper) {
        if (ch.isSpace() || ch == '-' || ch == '_' || ch == '.' ||
            ch == QChar(0x00b7) || ch == QChar(0x2022)) {
            continue;
        }
        normalized.append(ch);
    }
    return normalized;
}

QString plateCategoryRuleVersion() {
    return QStringLiteral("rk3568.plate_category.v2");
}

PlateCategoryInfo classifyPlateCategory(const QString &plate, const QString &color) {
    const QString value = normalizePlateForProtocol(plate);
    if (value.isEmpty()) return {"unknown", "未知", "empty_plate"};

    if (value.startsWith("WJ")) return {"armed_police", "武警车", "prefix_wj"};
    if (value.startsWith("ZG") || value.startsWith("VA") ||
        value.startsWith("GS") || value.startsWith("CS") ||
        value.contains("军")) {
        return {"military", "军车", "military_prefix_or_text"};
    }
    if (value.contains("港")) return {"hong_kong", "香港车牌", "contains_hong_kong"};
    if (value.contains("澳")) return {"macau", "澳门车牌", "contains_macau"};
    if (value.contains("警")) return {"police", "警车", "contains_police"};
    if (value.contains("使")) return {"embassy", "使馆车", "contains_embassy"};
    if (value.contains("领")) return {"consular", "领馆车", "contains_consular"};
    if (value.contains("学")) return {"coach", "教练车牌", "contains_coach"};
    if (value.contains("挂")) return {"trailer", "挂车", "contains_trailer"};
    if (isColor(color, "yellow", "黄")) {
        return {"medium_large", "中大型车牌", "yellow_plate"};
    }
    if (value.size() >= 8 || isColor(color, "green", "绿")) {
        return {"new_energy", "新能源", value.size() >= 8 ? "plate_length_ge_8" : "green_plate"};
    }
    return {"fuel", "燃油车", "fallback_fuel"};
}

void insertPlateCategoryFields(QJsonObject &object,
                               const QString &plate,
                               const PlateCategoryInfo &category) {
    object.insert("plate_normalized", normalizePlateForProtocol(plate));
    object.insert("vehicle_type", category.name);
    object.insert("vehicle_type_code", category.code);
    object.insert("plate_category_code", category.code);
    object.insert("plate_category", category.name);
    object.insert("plate_category_rule", category.rule);
    object.insert("plate_category_rule_version", plateCategoryRuleVersion());
}
