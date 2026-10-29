// JNI bridge between dev.zeronative.runtime.ZnNative (Kotlin) and the shared C++ core.
//
// Threads: every call into the runtime except takeBatch arrives on the JS thread ("zn-js"); takeBatch arrives on
// the main thread. The platform callbacks below (scheduleTimer, requestApply, log) are made on the JS thread and
// go to static methods of ZnNative, which hand them to ZnRuntime.
#include <android/asset_manager.h>
#include <android/asset_manager_jni.h>
#include <android/log.h>
#include <jni.h>

#include <ctime>
#include <memory>
#include <string>
#include <vector>

#include "zn/runtime.h"

namespace {

constexpr const char* kTag = "zn";
constexpr const char* kJsTag = "zn-js";

JavaVM* g_vm = nullptr;
jclass g_nativeClass = nullptr;  // global ref to dev/zeronative/runtime/ZnNative
jmethodID g_scheduleTimer = nullptr;
jmethodID g_requestApply = nullptr;
jmethodID g_callNative = nullptr;
jmethodID g_cancelNative = nullptr;
jmethodID g_jsError = nullptr;

JNIEnv* env() {
  JNIEnv* e = nullptr;
  // The JS thread is a Java HandlerThread, so it is already attached.
  g_vm->GetEnv(reinterpret_cast<void**>(&e), JNI_VERSION_1_6);
  return e;
}

class AndroidPlatform final : public zn::Platform {
 public:
  void scheduleTimer(uint32_t handle, double delayMs) override {
    env()->CallStaticVoidMethod(g_nativeClass, g_scheduleTimer, static_cast<jint>(handle),
                                static_cast<jdouble>(delayMs));
  }
  void requestApply() override { env()->CallStaticVoidMethod(g_nativeClass, g_requestApply); }
  void log(int level, std::string_view message) override {
    static constexpr int kPriority[] = {ANDROID_LOG_DEBUG, ANDROID_LOG_INFO, ANDROID_LOG_WARN, ANDROID_LOG_ERROR};
    const int prio = kPriority[level < 0 ? 0 : (level > 3 ? 3 : level)];
    __android_log_print(prio, kJsTag, "%.*s", static_cast<int>(message.size()), message.data());
  }
  void callNative(std::string_view module, std::string_view method, std::string_view argsJson,
                  uint32_t callbackId) override {
    JNIEnv* e = env();
    // Module and method names are ASCII; the arguments go as UTF-8 bytes (JNI's own string encoding is not real
    // UTF-8 for emoji and other characters outside the basic plane).
    jstring m = e->NewStringUTF(std::string(module).c_str());
    jstring fn = e->NewStringUTF(std::string(method).c_str());
    jbyteArray args = e->NewByteArray(static_cast<jsize>(argsJson.size()));
    e->SetByteArrayRegion(args, 0, static_cast<jsize>(argsJson.size()), reinterpret_cast<const jbyte*>(argsJson.data()));
    e->CallStaticVoidMethod(g_nativeClass, g_callNative, m, fn, args, static_cast<jint>(callbackId));
    e->DeleteLocalRef(m);
    e->DeleteLocalRef(fn);
    e->DeleteLocalRef(args);
  }
  std::string flowDir;  // FlowStore folder, given by Kotlin (noBackupFilesDir/zn)
  std::string flowStoreDir() override { return flowDir; }
  void cancelNative(uint32_t callbackId) override {
    env()->CallStaticVoidMethod(g_nativeClass, g_cancelNative, static_cast<jint>(callbackId));
  }
  double nowMs() override {
    timespec ts{};
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return static_cast<double>(ts.tv_sec) * 1000.0 + static_cast<double>(ts.tv_nsec) / 1e6;
  }
  void jsError(std::string_view where, std::string_view details) override {
    zn::Platform::jsError(where, details);  // logcat, as before
    // As UTF-8 bytes, like callNative: error text may hold emoji, which JNI's own string encoding can't take.
    std::string text = std::string(where) + "\n" + std::string(details);
    JNIEnv* e = env();
    jbyteArray bytes = e->NewByteArray(static_cast<jsize>(text.size()));
    e->SetByteArrayRegion(bytes, 0, static_cast<jsize>(text.size()), reinterpret_cast<const jbyte*>(text.data()));
    e->CallStaticVoidMethod(g_nativeClass, g_jsError, bytes);
    e->DeleteLocalRef(bytes);
  }
};

// The runtime and its platform live together; ZnNative holds a pointer to this as a Long.
struct Holder {
  explicit Holder(std::string flowDir) { platform.flowDir = std::move(flowDir); }
  AndroidPlatform platform;
  zn::Runtime runtime{platform, [](zn::HostApi& host) { return zn::createHermesEngine(host); }};
};

Holder* holder(jlong handle) { return reinterpret_cast<Holder*>(handle); }

std::string toStdString(JNIEnv* e, jstring value) {
  if (value == nullptr) return {};
  const char* chars = e->GetStringUTFChars(value, nullptr);
  std::string result(chars);
  e->ReleaseStringUTFChars(value, chars);
  return result;
}

// Result format understood by ZnNative.kt: "ok:<value>" or "error:<message>".
jstring toResult(JNIEnv* e, const zn::EvalResult& result) {
  std::string text = (result.ok ? "ok:" : "error:") + result.value;
  return e->NewStringUTF(text.c_str());
}

}  // namespace

extern "C" JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM* vm, void* /* reserved */) {
  g_vm = vm;
  JNIEnv* e = env();
  jclass local = e->FindClass("dev/zeronative/runtime/ZnNative");
  if (local == nullptr) return JNI_ERR;
  g_nativeClass = static_cast<jclass>(e->NewGlobalRef(local));
  e->DeleteLocalRef(local);
  g_scheduleTimer = e->GetStaticMethodID(g_nativeClass, "onScheduleTimer", "(ID)V");
  g_requestApply = e->GetStaticMethodID(g_nativeClass, "onRequestApply", "()V");
  g_callNative = e->GetStaticMethodID(g_nativeClass, "onCallNative", "(Ljava/lang/String;Ljava/lang/String;[BI)V");
  g_cancelNative = e->GetStaticMethodID(g_nativeClass, "onCancelNative", "(I)V");
  g_jsError = e->GetStaticMethodID(g_nativeClass, "onJsError", "([B)V");
  if (g_scheduleTimer == nullptr || g_requestApply == nullptr || g_callNative == nullptr || g_cancelNative == nullptr ||
      g_jsError == nullptr) {
    return JNI_ERR;
  }
  return JNI_VERSION_1_6;
}

extern "C" JNIEXPORT jlong JNICALL
Java_dev_zeronative_runtime_ZnNative_createRuntime(JNIEnv* env, jclass /* clazz */, jstring flowDir) {
  auto* h = new Holder(toStdString(env, flowDir));
  __android_log_print(ANDROID_LOG_INFO, kTag, "runtime created (Hermes, microtask queue on)");
  return reinterpret_cast<jlong>(h);
}

extern "C" JNIEXPORT void JNICALL
Java_dev_zeronative_runtime_ZnNative_destroyRuntime(JNIEnv* /* env */, jclass /* clazz */, jlong handle) {
  delete holder(handle);
}

// Runs a bytecode asset. The asset is opened with AASSET_MODE_BUFFER: for an uncompressed asset (apps mark *.hbc as
// noCompress) Android maps it from the APK, so the bytecode is not copied into memory.
extern "C" JNIEXPORT jstring JNICALL
Java_dev_zeronative_runtime_ZnNative_evalAsset(JNIEnv* e, jclass /* clazz */, jlong handle, jobject assetManager,
                                               jstring jName) {
  const std::string name = toStdString(e, jName);
  AAssetManager* manager = AAssetManager_fromJava(e, assetManager);
  AAsset* asset = AAssetManager_open(manager, name.c_str(), AASSET_MODE_BUFFER);
  if (asset == nullptr) return toResult(e, {false, "asset not found: " + name});

  // The shared_ptr closes the asset when the engine no longer needs the bytes.
  std::shared_ptr<const void> owner(asset, [](const void* a) {
    AAsset_close(static_cast<AAsset*>(const_cast<void*>(a)));
  });
  zn::Bytes bytes{
      static_cast<const uint8_t*>(AAsset_getBuffer(asset)),
      static_cast<size_t>(AAsset_getLength(asset)),
      owner,
  };
  return toResult(e, holder(handle)->runtime.evalBytecode(bytes, name));
}

// Runs bytecode from a Java byte array (debug builds: a new build from `zn dev`). The bytes are copied once.
extern "C" JNIEXPORT jstring JNICALL
Java_dev_zeronative_runtime_ZnNative_evalBytes(JNIEnv* e, jclass /* clazz */, jlong handle, jbyteArray jBytes,
                                               jstring jName) {
  const std::string name = toStdString(e, jName);
  const jsize length = e->GetArrayLength(jBytes);
  auto copy = std::make_shared<std::vector<uint8_t>>(static_cast<size_t>(length));
  e->GetByteArrayRegion(jBytes, 0, length, reinterpret_cast<jbyte*>(copy->data()));
  zn::Bytes bytes{copy->data(), copy->size(), copy};
  return toResult(e, holder(handle)->runtime.evalBytecode(bytes, name));
}

// payloadKind: 0 null, 1 boolean (number != 0), 2 number, 3 string.
extern "C" JNIEXPORT void JNICALL
Java_dev_zeronative_runtime_ZnNative_dispatchEvent(JNIEnv* e, jclass /* clazz */, jlong handle, jint instance,
                                                   jint eventId, jint payloadKind, jdouble number, jstring text) {
  zn::Value payload;
  switch (payloadKind) {
    case 1: payload = zn::Value::boolean(number != 0); break;
    case 2: payload = zn::Value::number(number); break;
    case 3: payload = zn::Value::string(toStdString(e, text)); break;
    default: break;
  }
  holder(handle)->runtime.dispatchEvent(static_cast<uint32_t>(instance), static_cast<uint16_t>(eventId), payload);
}

extern "C" JNIEXPORT void JNICALL
Java_dev_zeronative_runtime_ZnNative_fireTimer(JNIEnv* /* env */, jclass /* clazz */, jlong handle, jint timer) {
  holder(handle)->runtime.fireTimer(static_cast<uint32_t>(timer));
}

// Main thread. Returns null when there is nothing to apply.
extern "C" JNIEXPORT jbyteArray JNICALL
Java_dev_zeronative_runtime_ZnNative_takeBatch(JNIEnv* e, jclass /* clazz */, jlong handle) {
  std::vector<uint8_t> bytes = holder(handle)->runtime.takeBatch();
  if (bytes.empty()) return nullptr;
  jbyteArray array = e->NewByteArray(static_cast<jsize>(bytes.size()));
  e->SetByteArrayRegion(array, 0, static_cast<jsize>(bytes.size()), reinterpret_cast<const jbyte*>(bytes.data()));
  return array;
}
