// See ZNHost.h. The JS thread is an NSThread with its own run loop: tasks are run-loop blocks, timers are run-loop
// timers, so JS work never needs a lock beyond what zn::Runtime already has (its pending batch).
#import "ZNHost.h"

#import <QuartzCore/QuartzCore.h>
#import <os/log.h>

#include <bit>
#include <cstring>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <vector>

#include "zn/engine.h"

#include <atomic>
#include "zn/runtime.h"
#include "zn/storage.h"

static os_log_t znLog() {
  static os_log_t log = os_log_create("dev.zeronative", "zn");
  return log;
}

static NSString* toNS(std::string_view s) {
  return [[NSString alloc] initWithBytes:s.data() length:s.size() encoding:NSUTF8StringEncoding] ?: @"";
}

static std::string toStd(NSString* s) { return s ? std::string(s.UTF8String) : std::string(); }

/// An app-private folder excluded from backups (Application Support/<name>), made if missing.
static std::string privateDir(NSString* name) {
  NSURL* base = [NSFileManager.defaultManager URLsForDirectory:NSApplicationSupportDirectory
                                                     inDomains:NSUserDomainMask].firstObject;
  NSURL* dir = [base URLByAppendingPathComponent:name isDirectory:YES];
  [NSFileManager.defaultManager createDirectoryAtURL:dir withIntermediateDirectories:YES attributes:nil error:nil];
  [dir setResourceValue:@YES forKey:NSURLIsExcludedFromBackupKey error:nil];
  return toStd(dir.path);
}

@interface ZNHost ()
- (void)post:(void (^)(void))task;
- (void)post:(void (^)(void))task forGeneration:(uint64_t)generation;
- (void)post:(void (^)(void))task afterMs:(double)ms;
- (void)applyOnMain;
- (zn::Runtime*)runtime;
@end

namespace {

class IosPlatform final : public zn::Platform {
 public:
  explicit IosPlatform(ZNHost* host) : host_(host) {}

  void scheduleTimer(uint32_t handle, double delayMs) override {
    ZNHost* host = host_;
    [host post:^{ host.runtime->fireTimer(handle); } afterMs:delayMs];
  }

  void requestApply() override {
    ZNHost* host = host_;
    dispatch_async(dispatch_get_main_queue(), ^{ [host applyOnMain]; });
  }

  void log(int level, std::string_view message) override {
    const os_log_type_t type = level >= 3 ? OS_LOG_TYPE_ERROR : level == 2 ? OS_LOG_TYPE_DEFAULT : OS_LOG_TYPE_INFO;
    NSString* text = toNS(message);
    os_log_with_type(znLog(), type, "%{public}@", text);
    if (host_.onLog) host_.onLog(level, text);
  }

  void callNative(std::string_view module, std::string_view method, std::string_view argsJson, uint32_t callbackId,
                  std::optional<std::span<const uint8_t>> bytes) override {
    ZNHost* host = host_;
    NSString* m = toNS(module);
    NSString* fn = toNS(method);
    // Copied: the span points into a JS ArrayBuffer that JS may change or free after this call.
    NSData* data = bytes ? [NSData dataWithBytes:bytes->data() length:bytes->size()] : nil;
    if (host.onNativeCall && host.onNativeCall(m, fn, toNS(argsJson), callbackId, data)) return;
    // Answered later, never inside the call (JS is running).
    NSString* message = [NSString stringWithFormat:@"no native module \"%@\" in this app (iOS)", m];
    [host answerCall:callbackId generation:host.runtimeGeneration ok:NO valueJson:nil code:@"unavailable"
             message:message];
  }

  void cancelNative(uint32_t callbackId) override {
    if (host_.onCancelCall) host_.onCancelCall(callbackId);
  }

  std::string flowStoreDir() override {
    static std::string dir = privateDir(@"zn");
    return dir;
  }

  std::string storageDir() override {
    static std::string dir = privateDir(@"zn-storage");
    return dir;
  }

  double nowMs() override { return CACurrentMediaTime() * 1000.0; }

  void jsError(std::string_view kind, std::string_view where, std::string_view details) override {
    NSString* k = toNS(kind);
    NSString* w = toNS(where);
    NSString* d = toNS(details);
    os_log_error(znLog(), "%{public}@ [%{public}@]: %{public}@", w, k, d);
    ZNHost* host = host_;
    dispatch_async(dispatch_get_main_queue(), ^{
      if (host.onJsError) host.onJsError(k, w, d);
    });
  }

 private:
  __unsafe_unretained ZNHost* host_;  // the host is never deallocated (one per process)
};

}  // namespace

@implementation ZNHost {
  NSThread* _thread;
  CFRunLoopRef _jsLoop;
  dispatch_semaphore_t _ready;
  std::unique_ptr<IosPlatform> _platform;
  std::unique_ptr<zn::Runtime> _runtime;
  /// Which runtime a posted task is for: `restartRuntime` adds one, and tasks posted for the old runtime (its timers,
  /// events and call answers) are dropped.
  std::atomic<uint64_t> _generation;
  /// JS thread: the generation of the runtime that runs now (`_generation` changes first, on the caller's thread).
  uint64_t _runtimeGeneration;
}

+ (NSInteger)bytecodeVersion {
  return zn::hermesBytecodeVersion();
}

+ (NSInteger)hostApiVersion {
  return zn::kHostApiVersion;
}

+ (NSInteger)hostApiOldest {
  return zn::kHostApiOldest;
}

+ (ZNHost*)shared {
  static ZNHost* host;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ host = [[ZNHost alloc] init]; });
  return host;
}

- (instancetype)init {
  if ((self = [super init])) {
    _ready = dispatch_semaphore_create(0);
    _thread = [[NSThread alloc] initWithTarget:self selector:@selector(jsMain) object:nil];
    _thread.name = @"zn-js";
    _thread.stackSize = 8 << 20;  // Hermes recursion; the iOS default for secondary threads is 512 KB
    _thread.qualityOfService = NSQualityOfServiceUserInitiated;
    [_thread start];
    dispatch_semaphore_wait(_ready, DISPATCH_TIME_FOREVER);  // the run loop exists; a few µs
    _platform = std::make_unique<IosPlatform>(self);
    [self post:^{ [self makeRuntime:0]; }];
  }
  return self;
}

/// JS thread.
- (void)makeRuntime:(uint64_t)generation {
  _runtimeGeneration = generation;
  _runtime = std::make_unique<zn::Runtime>(*_platform, zn::createHermesEngine);
  // A JS task that runs longer is stopped (step 3.9); Android's ZnRuntime.jsTimeLimitMs: 3 s debug, 2 s release.
#ifndef NDEBUG  // CMake defines NDEBUG in Release (the Swift side uses DEBUG)
  _runtime->setTimeLimit(3000);
#else
  _runtime->setTimeLimit(2000);
#endif
}

- (void)restartRuntime:(void (^)(void))done {
  // First: anything posted from now on is for the new runtime.
  const uint64_t generation = _generation.fetch_add(1) + 1;
  void (^task)(void) = ^{
    const double t0 = CACurrentMediaTime();
    self->_runtime.reset();
    [self makeRuntime:generation];
    os_log(znLog(), "JS runtime replaced in %.1f ms", (CACurrentMediaTime() - t0) * 1000.0);
    dispatch_async(dispatch_get_main_queue(), done);
  };
  CFRunLoopPerformBlock(_jsLoop, kCFRunLoopDefaultMode, task);
  CFRunLoopWakeUp(_jsLoop);
}

- (void)jsMain {
  _jsLoop = CFRunLoopGetCurrent();
  // A port keeps the run loop alive when it has no tasks or timers.
  [NSRunLoop.currentRunLoop addPort:[NSMachPort port] forMode:NSDefaultRunLoopMode];
  dispatch_semaphore_signal(_ready);
  while (true) {
    @autoreleasepool {
      CFRunLoopRunInMode(kCFRunLoopDefaultMode, 1e10, false);
    }
  }
}

- (uint64_t)runtimeGeneration {
  return _runtimeGeneration;
}

- (zn::Runtime*)runtime {
  return _runtime.get();
}

- (void)post:(void (^)(void))task {
  const uint64_t generation = _generation.load();
  CFRunLoopPerformBlock(_jsLoop, kCFRunLoopDefaultMode, ^{
    if (self->_generation.load() == generation) task();
  });
  CFRunLoopWakeUp(_jsLoop);
}

/// Runs [task] only if the runtime of [generation] still runs then (a call's answer).
- (void)post:(void (^)(void))task forGeneration:(uint64_t)generation {
  CFRunLoopPerformBlock(_jsLoop, kCFRunLoopDefaultMode, ^{
    if (self->_generation.load() == generation) task();
  });
  CFRunLoopWakeUp(_jsLoop);
}

- (void)post:(void (^)(void))task afterMs:(double)ms {
  const uint64_t generation = _generation.load();
  CFRunLoopTimerRef timer = CFRunLoopTimerCreateWithHandler(
      kCFAllocatorDefault, CFAbsoluteTimeGetCurrent() + ms / 1000.0, 0, 0, 0,
      ^(CFRunLoopTimerRef) {
        if (self->_generation.load() == generation) task();
      });
  CFRunLoopAddTimer(_jsLoop, timer, kCFRunLoopDefaultMode);
  CFRelease(timer);
  CFRunLoopWakeUp(_jsLoop);
}

- (void)applyOnMain {
  if (!_runtime) return;
  std::vector<uint8_t> bytes = _runtime->takeBatch();  // UI thread side of the batch (runtime.h)
  if (bytes.empty() || !self.onApply) return;
  self.onApply([NSData dataWithBytes:bytes.data() length:bytes.size()]);
}

- (void)setGlobalString:(NSString*)name value:(NSString*)value {
  std::string n = toStd(name), v = toStd(value);
  [self post:^{ self->_runtime->setGlobalString(n, v); }];
}

- (void)evalFile:(NSString*)path done:(void (^)(BOOL, NSString*, double))done {
  NSString* p = [path copy];
  [self post:^{
    const double t0 = CACurrentMediaTime();
    NSError* error = nil;
    // Mapped read-only, like an uncompressed APK asset on Android: no copy, pages shared with the file cache.
    NSData* data = [NSData dataWithContentsOfFile:p options:NSDataReadingMappedIfSafe error:&error];
    zn::EvalResult result;
    if (data == nil) {
      result = {false, "can't read " + toStd(p) + ": " + toStd(error.localizedDescription)};
    } else {
      std::shared_ptr<const void> owner((__bridge_retained const void*)data, [](const void* d) { CFRelease(d); });
      zn::Bytes bytes{static_cast<const uint8_t*>(data.bytes), data.length, owner};
      result = self->_runtime->evalBytecode(bytes, toStd(p.lastPathComponent));
    }
    const double ms = (CACurrentMediaTime() - t0) * 1000.0;
    NSString* value = toNS(result.value);
    const BOOL ok = result.ok;
    dispatch_async(dispatch_get_main_queue(), ^{ done(ok, value, ms); });
  }];
}

- (void)dispatchEvent:(uint32_t)instance event:(uint16_t)event {
  [self post:^{ self->_runtime->dispatchEvent(instance, event, zn::Value::null()); }];
}

- (void)dispatchEvent:(uint32_t)instance event:(uint16_t)event string:(NSString*)payload {
  std::string s = toStd(payload);
  [self post:^{ self->_runtime->dispatchEvent(instance, event, zn::Value::string(s)); }];
}

- (void)dispatchEvent:(uint32_t)instance event:(uint16_t)event number:(double)payload {
  [self post:^{ self->_runtime->dispatchEvent(instance, event, zn::Value::number(payload)); }];
}

- (void)dispatchEvent:(uint32_t)instance event:(uint16_t)event boolean:(BOOL)payload {
  [self post:^{ self->_runtime->dispatchEvent(instance, event, zn::Value::boolean(payload)); }];
}

- (void)dispatchEvent:(uint32_t)instance event:(uint16_t)event stringFrom:(NSString* (^)(void))payload {
  // Not through `post`: dropped there after a restart, [payload] never ran, the module's slot stayed full and that
  // event never reached JS again (2026-11-12).
  CFRunLoopPerformBlock(_jsLoop, kCFRunLoopDefaultMode, ^{
    NSString* text = payload();
    if (text && self->_runtime) self->_runtime->dispatchEvent(instance, event, zn::Value::string(toStd(text)));
  });
  CFRunLoopWakeUp(_jsLoop);
}

- (void)answerCall:(uint32_t)callbackId generation:(uint64_t)generation valueJson:(NSString*)valueJson
             bytes:(NSData*)bytes {
  // App event 9 (CALL_RESULT_BYTES, calls.ts): [u32 LE head size][head: the same JSON as event 7][body bytes].
  NSString* head = [NSString stringWithFormat:@"{\"id\":%u,\"ok\":true,\"value\":%@}", callbackId, valueJson ?: @"null"];
  const std::string h = toStd(head);
  std::vector<uint8_t> buffer(4 + h.size() + bytes.length);
  const uint32_t size = static_cast<uint32_t>(h.size());
  for (int i = 0; i < 4; i++) buffer[i] = static_cast<uint8_t>(size >> (8 * i));
  memcpy(buffer.data() + 4, h.data(), h.size());
  if (bytes.length) memcpy(buffer.data() + 4 + h.size(), bytes.bytes, bytes.length);
  auto shared = std::make_shared<std::vector<uint8_t>>(std::move(buffer));
  [self post:^{ self->_runtime->dispatchBytes(0, 9, std::move(*shared)); } forGeneration:generation];
}

- (void)answerCall:(uint32_t)callbackId generation:(uint64_t)generation ok:(BOOL)ok
         valueJson:(NSString*)valueJson code:(NSString*)code message:(NSString*)message {
  NSString* json;
  if (ok) {
    json = [NSString stringWithFormat:@"{\"id\":%u,\"ok\":true,\"value\":%@}", callbackId, valueJson ?: @"null"];
  } else {
    NSDictionary* body = @{@"id" : @(callbackId), @"ok" : @NO, @"code" : code ?: @"failed", @"error" : message ?: @""};
    json = [[NSString alloc] initWithData:[NSJSONSerialization dataWithJSONObject:body options:0 error:nil]
                                 encoding:NSUTF8StringEncoding];
  }
  const std::string s = toStd(json);
  [self post:^{ self->_runtime->dispatchEvent(0, 7, zn::Value::string(s)); } forGeneration:generation];  // CALL_RESULT
}

@end

@implementation ZNStorage

static zn::Storage& nativeStorage() {
  static zn::Storage storage(privateDir(@"zn-storage"), [](int level, std::string_view message) {
    os_log(znLog(), "storage (%d): %{public}@", level, toNS(message));
  });
  return storage;
}

/// One zn::Storage is not thread-safe (storage.h: its map of open stores), and module methods run on the "zn-call"
/// queue, several at once: every nativeStorage() call holds this, as Android's g_storageMutex. Each takes microseconds.
static std::mutex& storageMutex() {
  static std::mutex m;
  return m;
}

static_assert(std::endian::native == std::endian::little, "storage numbers are stored little-endian");

/// [s] as UTF-8, all of it (UTF8String stops at a NUL, and is NULL for a lone surrogate: JS would keep both).
static std::string utf8Of(NSString* s) {
  NSData* d = [s dataUsingEncoding:NSUTF8StringEncoding allowLossyConversion:YES];
  return d ? std::string(static_cast<const char*>(d.bytes), d.length) : std::string();
}

/// [n] bytes of UTF-8 as text; a byte that isn't part of a valid sequence becomes U+FFFD (as Kotlin's
/// String(bytes, UTF_8) on Android), so text JS saved with a lone surrogate (Hermes writes it as 3 bytes) still reads.
static NSString* textOf(const uint8_t* b, size_t n) {
  NSString* s = [[NSString alloc] initWithBytes:b length:n encoding:NSUTF8StringEncoding];
  if (s) return s;
  std::vector<unichar> out;
  out.reserve(n);
  size_t i = 0;
  while (i < n) {
    const uint8_t c = b[i];
    uint32_t cp = 0;
    size_t len = 0;
    uint8_t lo = 0x80, hi = 0xBF;  // the allowed range of the second byte (Unicode table 3-7)
    if (c < 0x80) { cp = c; len = 1; }
    else if (c >= 0xC2 && c <= 0xDF) { cp = c & 0x1F; len = 2; }
    else if (c >= 0xE0 && c <= 0xEF) { cp = c & 0x0F; len = 3; if (c == 0xE0) lo = 0xA0; if (c == 0xED) hi = 0x9F; }
    else if (c >= 0xF0 && c <= 0xF4) { cp = c & 0x07; len = 4; if (c == 0xF0) lo = 0x90; if (c == 0xF4) hi = 0x8F; }
    size_t used = 1;
    bool ok = len > 0;
    for (size_t k = 1; ok && k < len; k++) {
      const uint8_t lowest = k == 1 ? lo : 0x80, highest = k == 1 ? hi : 0xBF;
      if (i + k >= n || b[i + k] < lowest || b[i + k] > highest) { ok = false; break; }
      cp = (cp << 6) | (b[i + k] & 0x3F);
      used = k + 1;
    }
    if (!ok) {
      out.push_back(0xFFFD);  // one per maximal bad part (as Java and Swift decode)
      i += used;
      continue;
    }
    if (cp >= 0x10000) {
      out.push_back(static_cast<unichar>(0xD800 + ((cp - 0x10000) >> 10)));
      out.push_back(static_cast<unichar>(0xDC00 + ((cp - 0x10000) & 0x3FF)));
    } else {
      out.push_back(static_cast<unichar>(cp));
    }
    i += len;
  }
  return [NSString stringWithCharacters:out.data() length:out.size()];
}

/// The store id and key as zn::Storage takes them, or false (logged) if JS would refuse them too (hermes_engine.cpp).
static bool storeArgs(NSString* store, NSString* key, std::string& id, std::string& k) {
  id = utf8Of(store);
  k = utf8Of(key);
  if (!zn::Storage::validId(id)) {
    os_log_error(znLog(), "ZNStorage: store id \"%{public}@\" must be 1-64 characters from A-Z a-z 0-9 . _ -", store);
    return false;
  }
  if (k.empty()) {
    os_log_error(znLog(), "ZNStorage: a key must be a non-empty string (store \"%{public}@\")", store);
    return false;
  }
  return true;
}

/// Saves [payload] under its type tag: [type][payload] (storage.h).
static BOOL put(NSString* store, NSString* key, zn::StoredType type, const void* payload, size_t size) {
  std::string id, k;
  if (!storeArgs(store, key, id, k)) return NO;
  std::vector<uint8_t> tagged(1 + size);
  tagged[0] = static_cast<uint8_t>(type);
  if (size) memcpy(tagged.data() + 1, payload, size);
  std::lock_guard<std::mutex> lock(storageMutex());
  return nativeStorage().set(id, k, tagged);
}

/// The tagged blob under [key], or nullopt if missing (or the arguments are bad).
static std::optional<std::vector<uint8_t>> blobOf(NSString* store, NSString* key) {
  std::string id, k;
  if (!storeArgs(store, key, id, k)) return std::nullopt;
  std::lock_guard<std::mutex> lock(storageMutex());
  return nativeStorage().get(id, k);
}

/// The type of [blob], checked the way JS reads it (fromStored): a number is 9 bytes, a boolean 2.
static ZNStoredType typeOf(const std::vector<uint8_t>& blob) {
  if (blob.empty()) return ZNStoredTypeUnknown;
  switch (blob[0]) {
    case static_cast<uint8_t>(zn::StoredType::String): return ZNStoredTypeString;
    case static_cast<uint8_t>(zn::StoredType::Number): return blob.size() == 9 ? ZNStoredTypeNumber : ZNStoredTypeUnknown;
    case static_cast<uint8_t>(zn::StoredType::Boolean): return blob.size() == 2 ? ZNStoredTypeBoolean : ZNStoredTypeUnknown;
    case static_cast<uint8_t>(zn::StoredType::Bytes): return ZNStoredTypeBytes;
    default: return ZNStoredTypeUnknown;
  }
}

+ (BOOL)set:(NSString*)store key:(NSString*)key string:(NSString*)value {
  const std::string v = utf8Of(value);
  return put(store, key, zn::StoredType::String, v.data(), v.size());
}

+ (BOOL)set:(NSString*)store key:(NSString*)key number:(double)value {
  return put(store, key, zn::StoredType::Number, &value, 8);
}

+ (BOOL)set:(NSString*)store key:(NSString*)key boolean:(BOOL)value {
  const uint8_t b = value ? 1 : 0;
  return put(store, key, zn::StoredType::Boolean, &b, 1);
}

+ (BOOL)set:(NSString*)store key:(NSString*)key data:(NSData*)value {
  return put(store, key, zn::StoredType::Bytes, value.bytes, value.length);
}

+ (NSString*)string:(NSString*)store key:(NSString*)key {
  auto blob = blobOf(store, key);
  if (!blob || typeOf(*blob) != ZNStoredTypeString) return nil;
  return textOf(blob->data() + 1, blob->size() - 1);
}

+ (NSNumber*)number:(NSString*)store key:(NSString*)key {
  auto blob = blobOf(store, key);
  if (!blob || typeOf(*blob) != ZNStoredTypeNumber) return nil;
  double d;
  memcpy(&d, blob->data() + 1, 8);
  return [NSNumber numberWithDouble:d];
}

+ (NSNumber*)boolean:(NSString*)store key:(NSString*)key {
  auto blob = blobOf(store, key);
  if (!blob || typeOf(*blob) != ZNStoredTypeBoolean) return nil;
  return (*blob)[1] != 0 ? @YES : @NO;
}

+ (NSData*)data:(NSString*)store key:(NSString*)key {
  auto blob = blobOf(store, key);
  if (!blob || typeOf(*blob) != ZNStoredTypeBytes) return nil;
  return [NSData dataWithBytes:blob->data() + 1 length:blob->size() - 1];
}

+ (ZNStoredType)storedType:(NSString*)store key:(NSString*)key {
  auto blob = blobOf(store, key);
  return blob ? typeOf(*blob) : ZNStoredTypeNone;
}

+ (BOOL)has:(NSString*)store key:(NSString*)key {
  std::string id, k;
  if (!storeArgs(store, key, id, k)) return NO;
  std::lock_guard<std::mutex> lock(storageMutex());
  return nativeStorage().has(id, k);
}

+ (BOOL)remove:(NSString*)store key:(NSString*)key {
  std::string id, k;
  if (!storeArgs(store, key, id, k)) return NO;
  std::lock_guard<std::mutex> lock(storageMutex());
  return nativeStorage().remove(id, k);
}

+ (NSArray<NSString*>*)keys:(NSString*)store {
  std::string id, k;
  if (!storeArgs(store, @"-", id, k)) return @[];
  std::vector<std::string> keys;
  {
    std::lock_guard<std::mutex> lock(storageMutex());
    keys = nativeStorage().keys(id);
  }
  NSMutableArray<NSString*>* out = [NSMutableArray arrayWithCapacity:keys.size()];
  for (const std::string& key : keys) [out addObject:textOf(reinterpret_cast<const uint8_t*>(key.data()), key.size())];
  return out;
}

+ (void)clear:(NSString*)store {
  std::string id, k;
  if (!storeArgs(store, @"-", id, k)) return;
  std::lock_guard<std::mutex> lock(storageMutex());
  nativeStorage().clear(id);
}

+ (void)flush:(NSString*)store {
  std::string id, k;
  if (!storeArgs(store, @"-", id, k)) return;
  std::lock_guard<std::mutex> lock(storageMutex());
  nativeStorage().flush(id);
}

@end
