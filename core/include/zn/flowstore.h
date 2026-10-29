// FlowStore (ARCHITECTURE.md §13.1–13.3): where flows save their state, so a payment survives the app being killed.
//
// One small file per key, memory-mapped:
//   file = header (64 B: u32 magic "ZNFS" | u32 formatVersion | u32 slotSize | reserved) + slot A + slot B
//   slot = u64 seq | u32 length | u32 crc32 (of the length bytes + payload) | payload (UTF-8 JSON)
// A write copies the payload into the slot that is NOT current, writes length and crc, and only then the new seq
// (current + 1) as one aligned 8-byte store after a release fence. The other slot keeps the previous good state the
// whole time. A read takes the valid slot (crc matches) with the higher seq.
//
// Durability: mmap stores are in the kernel's page cache as soon as they are made, so they survive the app being
// killed (SIGKILL, low-memory killer, crash) without fsync; a write costs microseconds. A power loss can tear a slot:
// the crc catches it and the read falls back to the other slot (safe, because restored flows only ever verify, never
// repeat, ARCHITECTURE §12.5).
//
// A payload bigger than the slot grows the file (new file with double the slot size holding the current state, then
// an atomic rename) up to kMaxSlotSize. Over that, the write fails and the good state is untouched (the flow must then
// not run its effect: write-ahead rule, §12.3).
//
// One thread only (the JS thread). POSIX (Android and iOS).
#pragma once

#include <cstdint>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

namespace zn {

class FlowStore {
 public:
  static constexpr uint32_t kDefaultSlotSize = 32 * 1024;
  static constexpr uint32_t kMaxSlotSize = 256 * 1024;

  enum class ReadStatus { Missing, Ok, Broken };
  struct ReadResult {
    ReadStatus status = ReadStatus::Missing;
    std::string payload;
  };

  /** [dir] must exist (Android: noBackupFilesDir/zn, so it is excluded from backups). */
  explicit FlowStore(std::string dir, uint32_t defaultSlotSize = kDefaultSlotSize);
  ~FlowStore();
  FlowStore(const FlowStore&) = delete;
  FlowStore& operator=(const FlowStore&) = delete;

  /** Saves [payload] under [key] (letters, digits, '.', '_', '-'; 1–64 chars). False (with [error]) if it can't. */
  bool write(std::string_view key, std::string_view payload, std::string* error = nullptr);

  /** Missing: never written. Broken: the file exists but neither slot is valid (move it to quarantine, §12.7). */
  ReadResult read(std::string_view key);

  /** Deletes the key's file. True if it existed. */
  bool remove(std::string_view key);

  /** Every key that has a file. */
  std::vector<std::string> list();

 private:
  struct File {
    int fd = -1;
    uint8_t* map = nullptr;
    size_t size = 0;
    uint32_t slotSize = 0;
    int current = -1;   // slot index holding the newest valid state, -1 = none
    uint64_t seq = 0;   // its seq
  };

  File* open(const std::string& key, bool create, std::string* error);
  bool grow(const std::string& key, File& f, uint32_t need, std::string* error);
  void close(File& f);
  std::string path(const std::string& key) const;

  std::string dir_;
  uint32_t defaultSlotSize_;
  std::unordered_map<std::string, File> files_;
};

/** CRC-32 (IEEE), the same one zip and PNG use. */
uint32_t crc32(const uint8_t* data, size_t length, uint32_t crc = 0);

}  // namespace zn
