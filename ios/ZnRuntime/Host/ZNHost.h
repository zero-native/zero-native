// The iOS host for the shared C++ core (ARCHITECTURE.md §8, §20): one zn::Runtime per process on its own JS thread
// ("zn-js"), implementing zn::Platform. Swift talks to it through this Objective-C interface (the bridging header).
// The counterpart of android/runtime's jni_bridge.cpp + ZnRuntime.kt.
//
// Threads: every engine call runs on the JS thread. The main thread never waits for JS: batches come to it through
// `onApply`, events go to JS through `dispatchEvent...` (posted, never run in place).
#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface ZNHost : NSObject

/// What this app's engine runs, for OTA's capability check (docs/ota.md §3.2, ZnCapabilities): the Hermes bytecode
/// format, and the host API range of this native side (core/include/zn/engine.h).
@property (class, readonly) NSInteger bytecodeVersion;
@property (class, readonly) NSInteger hostApiVersion;
@property (class, readonly) NSInteger hostApiOldest;

/// The process's host. Created on first use; lives until the process ends (one runtime per process, §8.2).
@property (class, readonly, strong) ZNHost* shared;

/// Main thread: a batch to apply (bytes as written by core/src/batch.cpp). Set before `evalFile`.
@property (nonatomic, copy, nullable) void (^onApply)(NSData* batch);
/// Main thread: JS threw and nothing caught it, hung, or didn't start (zn::Platform::jsError).
@property (nonatomic, copy, nullable) void (^onJsError)(NSString* kind, NSString* where, NSString* details);
/// Any thread: a log line from JS or the core. level: 0 debug, 1 info, 2 warn, 3 error.
@property (nonatomic, copy, nullable) void (^onLog)(NSInteger level, NSString* message);
/// JS thread: a native module call. `bytes`: binary input from JS (an ArrayBuffer or typed array), copied, or nil.
/// Return YES if the call was taken; the answer must then come later through `answerCall:...`. With no handler, or NO,
/// the call is rejected with "unavailable". Must not block.
@property (nonatomic, copy, nullable) BOOL (^onNativeCall)
    (NSString* module, NSString* method, NSString* argsJson, uint32_t callbackId, NSData* _Nullable bytes);
/// JS thread: which runtime runs now (`restartRuntime` replaces it). Read it when a call comes and pass it with the
/// call's answer, so an answer that comes after the runtime was replaced is dropped: the new runtime numbers its calls
/// from 1 again, and an old answer must not settle a new call with the same id (2026-11-12; Android: 8a311b2).
@property (nonatomic, readonly) uint64_t runtimeGeneration;
/// JS thread: JS gave up on a call (AbortSignal, or its screen closed). Its answer will be dropped by JS anyway.
@property (nonatomic, copy, nullable) void (^onCancelCall)(uint32_t callbackId);

/// JS thread, before the main script: a global string for JS (ZnRuntime's `__zn_constants`).
- (void)setGlobalString:(NSString*)name value:(NSString*)value;

/// Runs a bytecode file (the bundle's main.hbc), mapped read-only. `done` runs on the main thread.
/// Replaces the JS runtime with a new, empty one (an OTA update applied in place, ZnOta.swift): the old one is
/// deleted on the JS thread, with its timers; events and call answers posted for it are dropped. Then [done] runs on
/// the main thread; set globals and evalFile again.
- (void)restartRuntime:(void (^)(void))done;
- (void)evalFile:(NSString*)path done:(void (^)(BOOL ok, NSString* result, double millis))done;

/// Posts an event to JS (instance 0 = app-level events, ZnAppEvent.kt). Never runs JS in place.
- (void)dispatchEvent:(uint32_t)instance event:(uint16_t)event;
- (void)dispatchEvent:(uint32_t)instance event:(uint16_t)event string:(NSString*)payload;
- (void)dispatchEvent:(uint32_t)instance event:(uint16_t)event number:(double)payload;
- (void)dispatchEvent:(uint32_t)instance event:(uint16_t)event boolean:(BOOL)payload;
/// Posts an event whose string payload is made on the JS thread, when JS gets to it: for "only the newest value"
/// events (a module event sent often), [payload] takes whatever is newest then. nil: nothing is sent. Unlike the
/// others, it goes to the runtime that runs then, even a new one (`restartRuntime`): [payload] always runs, so a
/// module's "newest value" slot is always emptied (as Android's dispatchLatest).
- (void)dispatchEvent:(uint32_t)instance event:(uint16_t)event stringFrom:(NSString* _Nullable (^)(void))payload;

/// The answer to a call taken by `onNativeCall`. `valueJson` is JSON text (or nil for null) when `ok`; else `code`
/// ("invalid_args", "failed", "unavailable", or the module's own) and `message`. `generation`: `runtimeGeneration`
/// when the call came; dropped if that runtime was replaced since. Any thread.
- (void)answerCall:(uint32_t)callbackId generation:(uint64_t)generation ok:(BOOL)ok
         valueJson:(nullable NSString*)valueJson code:(nullable NSString*)code message:(nullable NSString*)message;

/// A successful answer with binary data (app event 9: JS gets `{ value, bytes }`, bytes a Uint8Array). Any thread.
- (void)answerCall:(uint32_t)callbackId generation:(uint64_t)generation valueJson:(nullable NSString*)valueJson
             bytes:(NSData*)bytes;

@end

/// The type a stored value was saved with (core/include/zn/storage.h StoredType): the same numbers JS and Android use.
/// None: the key is missing. Unknown: written by something else (an empty value or another tag).
typedef NS_ENUM(uint8_t, ZNStoredType) {
  ZNStoredTypeNone = 0,
  ZNStoredTypeString = 1,
  ZNStoredTypeNumber = 2,
  ZNStoredTypeBoolean = 3,
  ZNStoredTypeBytes = 4,
  ZNStoredTypeUnknown = 255,
};

/// App storage from native code (docs/storage.md, ZnStorage.kt): the same stores JS uses through `storage` /
/// `createStorage(id)`, with the same value format ([type][payload]: a string as UTF-8, a number as a little-endian
/// float64, a boolean as one byte, bytes as they are), through its own zn::Storage on the same folder (MMKV keeps one
/// instance per store per process, with its own lock). So JS reads what Swift saves, with its type, and the other way.
/// A getter of another type answers nil, never a wrong value (Android's throws). A store id is 1-64 characters from
/// A-Z a-z 0-9 . _ - and a key isn't empty: otherwise set answers NO, getters nil, keys none (and it is logged).
/// Swift: ZnStorage.store(id) (ZnStorage.swift). Main thread only.
@interface ZNStorage : NSObject
+ (BOOL)set:(NSString*)store key:(NSString*)key string:(NSString*)value;
/// JS numbers are doubles: an integer is exact up to 2^53.
+ (BOOL)set:(NSString*)store key:(NSString*)key number:(double)value;
+ (BOOL)set:(NSString*)store key:(NSString*)key boolean:(BOOL)value;
/// Bytes: JS reads them as an ArrayBuffer (storage.getBytes).
+ (BOOL)set:(NSString*)store key:(NSString*)key data:(NSData*)value;
/// The string under [key], or nil if missing or not a string.
+ (nullable NSString*)string:(NSString*)store key:(NSString*)key;
/// The number under [key] (a double), or nil if missing or not a number.
+ (nullable NSNumber*)number:(NSString*)store key:(NSString*)key;
/// The boolean under [key] (@YES / @NO), or nil if missing or not a boolean.
+ (nullable NSNumber*)boolean:(NSString*)store key:(NSString*)key;
/// The bytes under [key], or nil if missing or not bytes.
+ (nullable NSData*)data:(NSString*)store key:(NSString*)key;
/// What [key] holds: None if missing.
+ (ZNStoredType)storedType:(NSString*)store key:(NSString*)key;
+ (BOOL)has:(NSString*)store key:(NSString*)key;
+ (BOOL)remove:(NSString*)store key:(NSString*)key;
/// Every key in the store, in no set order.
+ (NSArray<NSString*>*)keys:(NSString*)store;
/// Removes every key in the store.
+ (void)clear:(NSString*)store;
/// Forces the store to flash (survives a power cut too).
+ (void)flush:(NSString*)store;
@end

NS_ASSUME_NONNULL_END
