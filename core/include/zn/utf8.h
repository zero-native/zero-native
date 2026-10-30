// UTF-8 checks for text that comes from outside (network bodies, files). Used by TextDecoder and fetch's text().
// The rules are the WHATWG Encoding standard's UTF-8 decoder: no overlong forms, no surrogates (U+D800–DFFF),
// nothing above U+10FFFF.
#pragma once

#include <cstddef>
#include <cstdint>
#include <string>

namespace zn::utf8 {

// True if the bytes are valid UTF-8.
bool valid(const uint8_t* data, size_t size);

// A copy where every bad sequence is replaced by U+FFFD, exactly like the web's TextDecoder (one U+FFFD per
// "maximal subpart"; the byte that broke a sequence is read again as the start of the next one).
std::string sanitize(const uint8_t* data, size_t size);

}  // namespace zn::utf8
