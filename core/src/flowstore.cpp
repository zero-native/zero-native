#include "zn/flowstore.h"

#include <dirent.h>
#include <fcntl.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>

#include <atomic>
#include <cerrno>
#include <cstring>

namespace zn {
namespace {

constexpr uint32_t kMagic = 0x53464E5A;  // "ZNFS" read as little-endian bytes
constexpr uint32_t kFormatVersion = 1;
constexpr size_t kHeaderSize = 64;
constexpr size_t kSlotHeader = 16;  // seq u64 | length u32 | crc u32
constexpr const char* kSuffix = ".znfs";

uint32_t le32(const uint8_t* p) {
  uint32_t v;
  std::memcpy(&v, p, 4);
  return v;
}
void put32(uint8_t* p, uint32_t v) { std::memcpy(p, &v, 4); }

bool validKey(std::string_view key) {
  if (key.empty() || key.size() > 64) return false;
  for (char c : key) {
    const bool ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '.' ||
                    c == '_' || c == '-';
    if (!ok) return false;
  }
  return key != "." && key != "..";
}

void fail(std::string* error, std::string message) {
  if (error) *error = std::move(message);
}

uint8_t* slotAt(uint8_t* map, uint32_t slotSize, int index) { return map + kHeaderSize + slotSize * index; }

/**
 * Makes the file [size] bytes long with real disk blocks behind every byte, so later stores into the mapping can't fail.
 * ftruncate alone leaves holes: a store into a hole needs a new block, and on a full disk that is a SIGBUS (a crash),
 * not an error. Keeps the bytes already there. Returns 0, or an errno value (ENOSPC when the disk is full).
 */
int reserve(int fd, size_t size) {
  int rc;
  do {
    rc = posix_fallocate(fd, 0, static_cast<off_t>(size));
  } while (rc == EINTR);
  if (rc != EOPNOTSUPP && rc != ENOSYS && rc != EINVAL) return rc;
  // The file system can't reserve: write each block back with its own bytes (zeros in a hole), which fills the holes.
  if (ftruncate(fd, static_cast<off_t>(size)) != 0) return errno;
  uint8_t block[4096];
  for (size_t at = 0; at < size; at += sizeof block) {
    const size_t n = size - at < sizeof block ? size - at : sizeof block;
    const ssize_t got = pread(fd, block, n, static_cast<off_t>(at));
    if (got < 0) return errno;
    if (static_cast<size_t>(got) < n) std::memset(block + got, 0, n - static_cast<size_t>(got));
    if (pwrite(fd, block, n, static_cast<off_t>(at)) != static_cast<ssize_t>(n)) return errno ? errno : EIO;
  }
  return 0;
}

std::string reserveError(const char* what, int rc) {
  return std::string(what) + (rc == ENOSPC ? "the disk is full" : std::strerror(rc));
}

uint64_t loadSeq(const uint8_t* slot) {
  // seq is 8-byte aligned (64-byte header, slot sizes are multiples of 8).
  return __atomic_load_n(reinterpret_cast<const uint64_t*>(slot), __ATOMIC_ACQUIRE);
}

/** True (and the payload length) if the slot's length is sane and its crc matches. */
bool validSlot(const uint8_t* slot, uint32_t slotSize, uint32_t* length) {
  const uint32_t len = le32(slot + 8);
  if (len > slotSize - kSlotHeader) return false;
  uint32_t crc = crc32(slot + 8, 4);
  crc = crc32(slot + kSlotHeader, len, crc);
  if (crc != le32(slot + 12)) return false;
  *length = len;
  return true;
}

}  // namespace

uint32_t crc32(const uint8_t* data, size_t length, uint32_t crc) {
  static uint32_t table[256];
  static bool ready = false;
  if (!ready) {
    for (uint32_t i = 0; i < 256; i++) {
      uint32_t c = i;
      for (int k = 0; k < 8; k++) c = (c & 1) ? 0xEDB88320u ^ (c >> 1) : c >> 1;
      table[i] = c;
    }
    ready = true;
  }
  crc = ~crc;
  for (size_t i = 0; i < length; i++) crc = table[(crc ^ data[i]) & 0xFF] ^ (crc >> 8);
  return ~crc;
}

FlowStore::FlowStore(std::string dir, uint32_t defaultSlotSize)
    : dir_(std::move(dir)), defaultSlotSize_((defaultSlotSize + 7) & ~7u) {}

FlowStore::~FlowStore() {
  for (auto& [_, f] : files_) close(f);
}

std::string FlowStore::path(const std::string& key) const { return dir_ + "/" + key + kSuffix; }

void FlowStore::close(File& f) {
  if (f.map) munmap(f.map, f.size);
  if (f.fd >= 0) ::close(f.fd);
  f = File{};
}

FlowStore::File* FlowStore::open(const std::string& key, bool create, std::string* error) {
  auto it = files_.find(key);
  if (it != files_.end()) return &it->second;

  const std::string p = path(key);
  int fd = ::open(p.c_str(), O_RDWR | O_CLOEXEC | (create ? O_CREAT : 0), 0600);
  if (fd < 0) {
    if (create) fail(error, "can't open " + p + ": " + std::strerror(errno));
    return nullptr;
  }
  struct stat st{};
  fstat(fd, &st);
  File f;
  f.fd = fd;
  if (st.st_size == 0) {
    // New file: header + two empty slots.
    f.slotSize = defaultSlotSize_;
    f.size = kHeaderSize + 2 * static_cast<size_t>(f.slotSize);
    if (const int rc = reserve(fd, f.size)) {
      fail(error, reserveError("can't make the file: ", rc));
      // Back to empty: a sized file with no header would read as "broken" instead of "missing".
      if (ftruncate(fd, 0) != 0) unlink(p.c_str());
      ::close(fd);
      return nullptr;
    }
    f.reserved = true;
  } else {
    f.size = static_cast<size_t>(st.st_size);
  }
  void* m = mmap(nullptr, f.size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
  if (m == MAP_FAILED) {
    fail(error, std::string("can't map the file: ") + std::strerror(errno));
    ::close(fd);
    return nullptr;
  }
  f.map = static_cast<uint8_t*>(m);
  if (st.st_size == 0) {
    put32(f.map, kMagic);
    put32(f.map + 4, kFormatVersion);
    put32(f.map + 8, f.slotSize);
  } else {
    f.slotSize = le32(f.map + 8);
    const bool ok = le32(f.map) == kMagic && le32(f.map + 4) == kFormatVersion && f.slotSize > kSlotHeader &&
                    f.slotSize <= kMaxSlotSize && f.size >= kHeaderSize + 2 * static_cast<size_t>(f.slotSize);
    if (!ok) f.slotSize = 0;  // unknown or damaged header: read() reports Broken, write() starts over
  }
  // Which slot is current: the valid one with the higher seq.
  if (f.slotSize) {
    for (int i = 0; i < 2; i++) {
      const uint8_t* s = slotAt(f.map, f.slotSize, i);
      uint32_t len;
      const uint64_t seq = loadSeq(s);
      if (seq != 0 && validSlot(s, f.slotSize, &len) && (f.current < 0 || seq > f.seq)) {
        f.current = i;
        f.seq = seq;
      }
    }
  }
  return &files_.emplace(key, f).first->second;
}

bool FlowStore::grow(const std::string& key, File& f, uint32_t need, std::string* error) {
  uint32_t slot = f.slotSize ? f.slotSize : defaultSlotSize_;
  while (slot - kSlotHeader < need) slot *= 2;
  if (slot > kMaxSlotSize) {
    fail(error, "payload of " + std::to_string(need) + " bytes is over the " + std::to_string(kMaxSlotSize - kSlotHeader) +
                    "-byte limit; keep flow state small (big data goes in Storage, referenced by id)");
    return false;
  }
  // New file with the bigger slots, holding the current good state in slot A; then rename it over the old one.
  const std::string tmp = path(key) + ".grow";
  int fd = ::open(tmp.c_str(), O_RDWR | O_CREAT | O_TRUNC | O_CLOEXEC, 0600);
  if (fd < 0) return fail(error, std::string("can't grow: ") + std::strerror(errno)), false;
  const size_t size = kHeaderSize + 2 * static_cast<size_t>(slot);
  if (const int rc = reserve(fd, size)) {
    fail(error, reserveError("can't grow: ", rc));
    ::close(fd);
    unlink(tmp.c_str());
    return false;
  }
  void* m = mmap(nullptr, size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
  if (m == MAP_FAILED) {
    fail(error, std::string("can't grow: ") + std::strerror(errno));
    ::close(fd);
    unlink(tmp.c_str());
    return false;
  }
  auto* map = static_cast<uint8_t*>(m);
  put32(map, kMagic);
  put32(map + 4, kFormatVersion);
  put32(map + 8, slot);
  int current = -1;
  if (f.current >= 0) {
    const uint8_t* src = slotAt(f.map, f.slotSize, f.current);
    std::memcpy(slotAt(map, slot, 0), src, kSlotHeader + le32(src + 8));
    current = 0;
  }
  if (rename(tmp.c_str(), path(key).c_str()) != 0) {
    fail(error, std::string("can't grow: ") + std::strerror(errno));
    munmap(map, size);
    ::close(fd);
    unlink(tmp.c_str());
    return false;
  }
  const uint64_t seq = f.seq;
  close(f);
  f.fd = fd;
  f.map = map;
  f.size = size;
  f.slotSize = slot;
  f.current = current;
  f.seq = seq;
  f.reserved = true;
  return true;
}

bool FlowStore::write(std::string_view keyView, std::string_view payload, std::string* error) {
  if (!validKey(keyView)) return fail(error, "invalid key (use letters, digits, '.', '_', '-'; 1–64 chars)"), false;
  const std::string key(keyView);
  File* f = open(key, /* create */ true, error);
  if (!f) return false;
  if (!f->reserved && f->slotSize) {
    // A file made before reserve() existed (or only read so far) may have holes: fill them once, before any store.
    // On a full disk this fails here, cleanly, and the good state stays as it is.
    if (const int rc = reserve(f->fd, f->size)) return fail(error, reserveError("can't reserve the file: ", rc)), false;
    f->reserved = true;
  }
  const uint32_t need = static_cast<uint32_t>(payload.size());
  if (f->slotSize == 0 || need > f->slotSize - kSlotHeader) {
    if (!grow(key, *f, need, error)) return false;
  }
  const int target = f->current == 0 ? 1 : 0;
  uint8_t* s = slotAt(f->map, f->slotSize, target);
  // Mark the target slot not-newest first (a torn write must never look newer than the current slot), then fill it.
  __atomic_store_n(reinterpret_cast<uint64_t*>(s), uint64_t{0}, __ATOMIC_RELEASE);
  std::memcpy(s + kSlotHeader, payload.data(), payload.size());
  put32(s + 8, need);
  uint32_t crc = crc32(s + 8, 4);
  crc = crc32(s + kSlotHeader, need, crc);
  put32(s + 12, crc);
  std::atomic_thread_fence(std::memory_order_release);
  const uint64_t seq = f->seq + 1;
  __atomic_store_n(reinterpret_cast<uint64_t*>(s), seq, __ATOMIC_RELEASE);
  f->current = target;
  f->seq = seq;
  return true;
}

FlowStore::ReadResult FlowStore::read(std::string_view keyView) {
  ReadResult r;
  if (!validKey(keyView)) return r;
  File* f = open(std::string(keyView), /* create */ false, nullptr);
  if (!f) return r;
  if (f->current < 0) {
    r.status = ReadStatus::Broken;
    return r;
  }
  const uint8_t* s = slotAt(f->map, f->slotSize, f->current);
  r.status = ReadStatus::Ok;
  r.payload.assign(reinterpret_cast<const char*>(s + kSlotHeader), le32(s + 8));
  return r;
}

bool FlowStore::remove(std::string_view keyView) {
  if (!validKey(keyView)) return false;
  const std::string key(keyView);
  auto it = files_.find(key);
  if (it != files_.end()) {
    close(it->second);
    files_.erase(it);
  }
  return unlink(path(key).c_str()) == 0;
}

std::vector<std::string> FlowStore::list() {
  std::vector<std::string> keys;
  DIR* d = opendir(dir_.c_str());
  if (!d) return keys;
  const size_t suffix = std::strlen(kSuffix);
  while (dirent* e = readdir(d)) {
    const std::string name = e->d_name;
    if (name.size() > suffix && name.compare(name.size() - suffix, suffix, kSuffix) == 0) {
      keys.push_back(name.substr(0, name.size() - suffix));
    }
  }
  closedir(d);
  return keys;
}

}  // namespace zn
