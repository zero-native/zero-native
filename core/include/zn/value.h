// Small typed values that cross the JS ↔ native boundary (ARCHITECTURE.md §7.2).
// Only these kinds exist on purpose: no objects, no functions, no engine types.
#pragma once

#include <cstdint>
#include <string>
#include <utility>
#include <variant>

namespace zn {

class Value {
 public:
  enum class Kind : uint8_t { Null = 0, Bool = 1, Number = 2, String = 3 };

  Value() = default;
  static Value null() { return Value(); }
  static Value boolean(bool b) { return Value(b); }
  static Value number(double d) { return Value(d); }
  static Value string(std::string s) { return Value(std::move(s)); }

  Kind kind() const { return static_cast<Kind>(data_.index()); }
  bool isNull() const { return kind() == Kind::Null; }
  bool asBool() const { return std::get<bool>(data_); }
  double asNumber() const { return std::get<double>(data_); }
  const std::string& asString() const { return std::get<std::string>(data_); }

  bool operator==(const Value& other) const { return data_ == other.data_; }

 private:
  explicit Value(bool b) : data_(b) {}
  explicit Value(double d) : data_(d) {}
  explicit Value(std::string s) : data_(std::move(s)) {}

  std::variant<std::monostate, bool, double, std::string> data_;
};

}  // namespace zn
