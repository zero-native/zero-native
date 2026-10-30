#include "zn/utf8.h"

namespace zn::utf8 {
namespace {

constexpr char kReplacement[] = "\xEF\xBF\xBD";  // U+FFFD

// Reads one sequence starting at p[i]. Returns its length if it is valid, or 0 and sets `bad` to the number of bytes
// that form the bad part (at least 1).
size_t sequence(const uint8_t* p, size_t n, size_t i, size_t* bad) {
  const uint8_t b = p[i];
  size_t need;
  uint8_t lo = 0x80, hi = 0xBF;
  if (b >= 0xC2 && b <= 0xDF) {
    need = 1;
  } else if (b >= 0xE0 && b <= 0xEF) {
    need = 2;
    if (b == 0xE0) lo = 0xA0;  // overlong
    if (b == 0xED) hi = 0x9F;  // surrogates
  } else if (b >= 0xF0 && b <= 0xF4) {
    need = 3;
    if (b == 0xF0) lo = 0x90;  // overlong
    if (b == 0xF4) hi = 0x8F;  // above U+10FFFF
  } else {
    *bad = 1;  // a lone continuation byte, C0, C1 or F5–FF
    return 0;
  }
  size_t j = i + 1;
  for (size_t got = 0; got < need; got++, j++) {
    if (j >= n || p[j] < lo || p[j] > hi) {
      *bad = j - i;  // the lead byte and the good continuation bytes before the break
      return 0;
    }
    lo = 0x80;
    hi = 0xBF;
  }
  return j - i;
}

}  // namespace

bool valid(const uint8_t* p, size_t n) {
  size_t i = 0;
  while (i < n) {
    if (p[i] < 0x80) {
      i++;
      continue;
    }
    size_t bad = 0;
    const size_t len = sequence(p, n, i, &bad);
    if (len == 0) return false;
    i += len;
  }
  return true;
}

std::string sanitize(const uint8_t* p, size_t n) {
  std::string out;
  out.reserve(n + 8);
  size_t i = 0;
  while (i < n) {
    if (p[i] < 0x80) {
      out.push_back(static_cast<char>(p[i]));
      i++;
      continue;
    }
    size_t bad = 0;
    const size_t len = sequence(p, n, i, &bad);
    if (len > 0) {
      out.append(reinterpret_cast<const char*>(p + i), len);
      i += len;
    } else {
      out += kReplacement;
      i += bad;
    }
  }
  return out;
}

}  // namespace zn::utf8
