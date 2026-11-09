// See ZNHost.h. The JS thread is an NSThread with its own run loop: tasks are run-loop blocks, timers are run-loop
// timers, so JS work never needs a lock beyond what zn::Runtime already has (its pending batch).
#import "ZNHost.h"

#import <QuartzCore/QuartzCore.h>
#import <os/log.h>

#include <memory>
#include <string>

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
    [host answerCall:callbackId ok:NO valueJson:nil code:@"unavailable" message:message];
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
    [self post:^{
      self->_runtime = std::make_unique<zn::Runtime>(*self->_platform, zn::createHermesEngine);
      // A JS task that runs longer is stopped (step 3.9); Android's ZnRuntime.jsTimeLimitMs: 3 s debug, 2 s release.
#ifndef NDEBUG  // CMake defines NDEBUG in Release (the Swift side uses DEBUG)
      self->_runtime->setTimeLimit(3000);
#else
      self->_runtime->setTimeLimit(2000);
#endif
    }];
  }
  return self;
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

- (zn::Runtime*)runtime {
  return _runtime.get();
}

- (void)post:(void (^)(void))task {
  CFRunLoopPerformBlock(_jsLoop, kCFRunLoopDefaultMode, task);
  CFRunLoopWakeUp(_jsLoop);
}

- (void)post:(void (^)(void))task afterMs:(double)ms {
  CFRunLoopTimerRef timer = CFRunLoopTimerCreateWithHandler(
      kCFAllocatorDefault, CFAbsoluteTimeGetCurrent() + ms / 1000.0, 0, 0, 0,
      ^(CFRunLoopTimerRef) { task(); });
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
  [self post:^{
    NSString* text = payload();
    if (text) self->_runtime->dispatchEvent(instance, event, zn::Value::string(toStd(text)));
  }];
}

- (void)answerCall:(uint32_t)callbackId valueJson:(NSString*)valueJson bytes:(NSData*)bytes {
  // App event 9 (CALL_RESULT_BYTES, calls.ts): [u32 LE head size][head: the same JSON as event 7][body bytes].
  NSString* head = [NSString stringWithFormat:@"{\"id\":%u,\"ok\":true,\"value\":%@}", callbackId, valueJson ?: @"null"];
  const std::string h = toStd(head);
  std::vector<uint8_t> buffer(4 + h.size() + bytes.length);
  const uint32_t size = static_cast<uint32_t>(h.size());
  for (int i = 0; i < 4; i++) buffer[i] = static_cast<uint8_t>(size >> (8 * i));
  memcpy(buffer.data() + 4, h.data(), h.size());
  if (bytes.length) memcpy(buffer.data() + 4 + h.size(), bytes.bytes, bytes.length);
  auto shared = std::make_shared<std::vector<uint8_t>>(std::move(buffer));
  [self post:^{ self->_runtime->dispatchBytes(0, 9, std::move(*shared)); }];
}

- (void)answerCall:(uint32_t)callbackId ok:(BOOL)ok valueJson:(NSString*)valueJson code:(NSString*)code
           message:(NSString*)message {
  NSString* json;
  if (ok) {
    json = [NSString stringWithFormat:@"{\"id\":%u,\"ok\":true,\"value\":%@}", callbackId, valueJson ?: @"null"];
  } else {
    NSDictionary* body = @{@"id" : @(callbackId), @"ok" : @NO, @"code" : code ?: @"failed", @"error" : message ?: @""};
    json = [[NSString alloc] initWithData:[NSJSONSerialization dataWithJSONObject:body options:0 error:nil]
                                 encoding:NSUTF8StringEncoding];
  }
  [self dispatchEvent:0 event:7 string:json];  // CALL_RESULT (ZnAppEvent.kt)
}

@end

@implementation ZNStorage

static zn::Storage& nativeStorage() {
  static zn::Storage storage(privateDir(@"zn-storage"), [](int level, std::string_view message) {
    os_log(znLog(), "storage (%d): %{public}@", level, toNS(message));
  });
  return storage;
}

+ (BOOL)set:(NSString*)store key:(NSString*)key string:(NSString*)value {
  std::string v = toStd(value);
  std::vector<uint8_t> tagged;
  tagged.reserve(v.size() + 1);
  tagged.push_back(static_cast<uint8_t>(zn::StoredType::String));
  tagged.insert(tagged.end(), v.begin(), v.end());
  return nativeStorage().set(toStd(store), toStd(key), tagged);
}

+ (NSString*)string:(NSString*)store key:(NSString*)key {
  auto blob = nativeStorage().get(toStd(store), toStd(key));
  if (!blob || blob->empty() || (*blob)[0] != static_cast<uint8_t>(zn::StoredType::String)) return nil;
  return [[NSString alloc] initWithBytes:blob->data() + 1 length:blob->size() - 1 encoding:NSUTF8StringEncoding];
}

+ (BOOL)remove:(NSString*)store key:(NSString*)key {
  return nativeStorage().remove(toStd(store), toStd(key));
}

+ (void)flush:(NSString*)store {
  nativeStorage().flush(toStd(store));
}

@end
