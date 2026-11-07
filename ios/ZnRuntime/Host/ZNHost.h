// The iOS host for the shared C++ core (ARCHITECTURE.md §8, §20): one zn::Runtime per process on its own JS thread
// ("zn-js"), implementing zn::Platform. Swift talks to it through this Objective-C interface (the bridging header).
// The counterpart of android/runtime's jni_bridge.cpp + ZnRuntime.kt.
//
// Threads: every engine call runs on the JS thread. The main thread never waits for JS: batches come to it through
// `onApply`, events go to JS through `dispatchEvent...` (posted, never run in place).
#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface ZNHost : NSObject

/// The process's host. Created on first use; lives until the process ends (one runtime per process, §8.2).
@property (class, readonly, strong) ZNHost* shared;

/// Main thread: a batch to apply (bytes as written by core/src/batch.cpp). Set before `evalFile`.
@property (nonatomic, copy, nullable) void (^onApply)(NSData* batch);
/// Main thread: JS threw and nothing caught it, hung, or didn't start (zn::Platform::jsError).
@property (nonatomic, copy, nullable) void (^onJsError)(NSString* kind, NSString* where, NSString* details);
/// Any thread: a log line from JS or the core. level: 0 debug, 1 info, 2 warn, 3 error.
@property (nonatomic, copy, nullable) void (^onLog)(NSInteger level, NSString* message);
/// JS thread: a native module call. Return YES if the call was taken; the answer must then come later through
/// `answerCall:...`. With no handler, or NO, the call is rejected with "unavailable".
@property (nonatomic, copy, nullable) BOOL (^onNativeCall)
    (NSString* module, NSString* method, NSString* argsJson, uint32_t callbackId);

/// JS thread, before the main script: a global string for JS (ZnRuntime's `__zn_constants`).
- (void)setGlobalString:(NSString*)name value:(NSString*)value;

/// Runs a bytecode file (the bundle's main.hbc), mapped read-only. `done` runs on the main thread.
- (void)evalFile:(NSString*)path done:(void (^)(BOOL ok, NSString* result, double millis))done;

/// Posts an event to JS (instance 0 = app-level events, ZnAppEvent.kt). Never runs JS in place.
- (void)dispatchEvent:(uint32_t)instance event:(uint16_t)event;
- (void)dispatchEvent:(uint32_t)instance event:(uint16_t)event string:(NSString*)payload;
- (void)dispatchEvent:(uint32_t)instance event:(uint16_t)event number:(double)payload;
- (void)dispatchEvent:(uint32_t)instance event:(uint16_t)event boolean:(BOOL)payload;

/// The answer to a call taken by `onNativeCall`. `valueJson` is JSON text (or nil for null) when `ok`; else `code`
/// ("invalid_args", "failed", "unavailable", or the module's own) and `message`. Any thread.
- (void)answerCall:(uint32_t)callbackId ok:(BOOL)ok valueJson:(nullable NSString*)valueJson
              code:(nullable NSString*)code message:(nullable NSString*)message;

@end

NS_ASSUME_NONNULL_END
