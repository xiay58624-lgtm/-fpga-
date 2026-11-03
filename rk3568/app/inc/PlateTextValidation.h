#pragma once

#include <algorithm>
#include <cctype>
#include <string>
#include <utility>
#include <vector>

inline std::vector<std::string> plateUtf8Tokens(const std::string &text) {
    std::vector<std::string> tokens;
    for (size_t i = 0; i < text.size();) {
        const unsigned char lead = static_cast<unsigned char>(text[i]);
        size_t length = 0;
        if ((lead & 0x80U) == 0) length = 1;
        else if ((lead & 0xE0U) == 0xC0U) length = 2;
        else if ((lead & 0xF0U) == 0xE0U) length = 3;
        else if ((lead & 0xF8U) == 0xF0U) length = 4;
        else return {};
        if (i + length > text.size()) return {};
        for (size_t j = 1; j < length; ++j) {
            if ((static_cast<unsigned char>(text[i + j]) & 0xC0U) != 0x80U) return {};
        }

        std::string token = text.substr(i, length);
        i += length;
        if (token == " " || token == "\t" || token == "." || token == "-" ||
            token == ":" || token == u8"·") {
            continue;
        }
        if (length == 1) token[0] = static_cast<char>(std::toupper(lead));
        tokens.push_back(std::move(token));
    }
    return tokens;
}

inline bool plateTokenIn(const std::string &token,
                         const std::vector<std::string> &values) {
    return std::find(values.begin(), values.end(), token) != values.end();
}

inline bool plateAsciiLetter(const std::string &token) {
    return token.size() == 1 && token[0] >= 'A' && token[0] <= 'Z';
}

inline bool plateAsciiDigit(const std::string &token) {
    return token.size() == 1 && token[0] >= '0' && token[0] <= '9';
}

inline bool plateAsciiAlnum(const std::string &token) {
    return plateAsciiLetter(token) || plateAsciiDigit(token);
}

inline bool plateTextPlausible(const std::string &text) {
    const std::vector<std::string> tokens = plateUtf8Tokens(text);
    if (tokens.empty() || tokens.size() > 10) return false;

    static const std::vector<std::string> provinces = {
        u8"京", u8"沪", u8"津", u8"渝", u8"冀", u8"晋", u8"蒙", u8"辽",
        u8"吉", u8"黑", u8"苏", u8"浙", u8"皖", u8"闽", u8"赣", u8"鲁",
        u8"豫", u8"鄂", u8"湘", u8"粤", u8"桂", u8"琼", u8"川", u8"贵",
        u8"云", u8"藏", u8"陕", u8"甘", u8"青", u8"宁", u8"新"
    };
    static const std::vector<std::string> specialTails = {
        u8"学", u8"警", u8"港", u8"澳", u8"挂", u8"使", u8"领",
        u8"民", u8"航", u8"危", u8"险", u8"品", u8"深"
    };

    const auto bodyIsValid = [&](size_t begin, bool allowSpecialTail) {
        bool hasDigit = false;
        for (size_t i = begin; i < tokens.size(); ++i) {
            if (plateAsciiDigit(tokens[i])) hasDigit = true;
            if (plateAsciiAlnum(tokens[i])) continue;
            if (allowSpecialTail && i + 1 == tokens.size() &&
                plateTokenIn(tokens[i], specialTails)) {
                continue;
            }
            return false;
        }
        return hasDigit;
    };

    // Standard mainland, new-energy, police, learner, trailer, HK/Macau suffix.
    if ((tokens.size() == 7 || tokens.size() == 8) &&
        plateTokenIn(tokens[0], provinces) && plateAsciiLetter(tokens[1])) {
        return bodyIsValid(2, true);
    }

    // Foreign/temporary white plates in the evaluation set can contain only
    // Latin letters followed by digits (for example BY32116 or EP8339). Keep
    // this deliberately narrow so arbitrary OCR words cannot pass validation.
    size_t latinPrefix = 0;
    while (latinPrefix < tokens.size() && latinPrefix < 3 &&
           plateAsciiLetter(tokens[latinPrefix])) {
        ++latinPrefix;
    }
    const size_t digitCount = tokens.size() - latinPrefix;
    if (latinPrefix >= 2 && latinPrefix <= 3 &&
        digitCount >= 4 && digitCount <= 6) {
        bool digitsOnly = true;
        for (size_t i = latinPrefix; i < tokens.size(); ++i) {
            if (!plateAsciiDigit(tokens[i])) {
                digitsOnly = false;
                break;
            }
        }
        if (digitsOnly) return true;
    }

    // Armed-police and military-style Latin prefixes supported by the project.
    if (tokens.size() >= 7 && plateAsciiLetter(tokens[0]) &&
        plateAsciiLetter(tokens[1])) {
        const std::string prefix = tokens[0] + tokens[1];
        static const std::vector<std::string> militaryPrefixes = {
            "WJ", "ZG", "VA", "GS", "CS", "ZJ", "JS"
        };
        if (plateTokenIn(prefix, militaryPrefixes)) {
            size_t body = 2;
            if (body < tokens.size() && plateTokenIn(tokens[body], provinces)) ++body;
            return bodyIsValid(body, false);
        }
    }

    // Some OCR dictionaries expose these special regions as the first token.
    if (tokens.size() >= 6 &&
        (tokens[0] == u8"港" || tokens[0] == u8"澳" ||
         tokens[0] == u8"使" || tokens[0] == u8"领")) {
        return bodyIsValid(1, false);
    }

    // Keep compatibility with future OCR dictionaries containing the military
    // marker even though the currently deployed 78-class model has no such token.
    if (tokens.size() >= 6 &&
        std::find(tokens.begin(), tokens.end(), u8"军") != tokens.end()) {
        bool hasDigit = false;
        for (const std::string &token : tokens) {
            if (plateAsciiDigit(token)) hasDigit = true;
            if (plateAsciiAlnum(token) || token == u8"军" ||
                plateTokenIn(token, provinces)) {
                continue;
            }
            return false;
        }
        return hasDigit;
    }

    return false;
}
