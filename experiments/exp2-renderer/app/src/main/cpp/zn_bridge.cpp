#include <jni.h>
#include <string>
#include <vector>
#include <memory>
#include <ctime>
#include <android/log.h>
#include <hermes/hermes.h>
#include <jsi/jsi.h>

#define LOG_TAG "zn"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, LOG_TAG, __VA_ARGS__)
#define LOGW(...) __android_log_print(ANDROID_LOG_WARN, LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

namespace {

JavaVM* g_vm = nullptr;
jclass g_bridgeClass = nullptr;
jmethodID g_onFlushMethod = nullptr;
jmethodID g_onJsErrorMethod = nullptr;
jmethodID g_postTimerMethod = nullptr;
jmethodID g_clearTimerMethod = nullptr;

std::unique_ptr<facebook::hermes::HermesRuntime> g_runtime = nullptr;

JNIEnv* getJniEnv() {
    if (!g_vm) return nullptr;
    JNIEnv* env = nullptr;
    jint res = g_vm->GetEnv(reinterpret_cast<void**>(&env), JNI_VERSION_1_6);
    if (res == JNI_OK) return env;
    if (res == JNI_EDETACHED) {
        if (g_vm->AttachCurrentThread(&env, nullptr) == JNI_OK) {
            return env;
        }
    }
    return nullptr;
}

void reportJsError(const std::string& msg) {
    LOGE("Hermes JS Error: %s", msg.c_str());
    JNIEnv* env = getJniEnv();
    if (env && g_onJsErrorMethod && g_bridgeClass) {
        jstring jMsg = env->NewStringUTF(msg.c_str());
        env->CallStaticVoidMethod(g_bridgeClass, g_onJsErrorMethod, jMsg);
        env->DeleteLocalRef(jMsg);
    }
}

class MemoryBuffer : public facebook::jsi::Buffer {
public:
    explicit MemoryBuffer(std::vector<uint8_t> data) : data_(std::move(data)) {}
    size_t size() const override { return data_.size(); }
    const uint8_t* data() const override { return data_.data(); }
private:
    std::vector<uint8_t> data_;
};

} // namespace

extern "C" {

JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM* vm, void* /* reserved */) {
    g_vm = vm;
    LOGI("JNI_OnLoad initialized");
    return JNI_VERSION_1_6;
}

JNIEXPORT void JNICALL
Java_dev_zeronative_exp2_ZnBridge_nativeInit(JNIEnv* env, jclass clazz) {
    LOGI("nativeInit: initializing Hermes V1 runtime on zn-js thread");

    if (g_bridgeClass == nullptr) {
        jclass cls = env->FindClass("dev/zeronative/exp2/ZnBridge");
        if (cls) {
            g_bridgeClass = reinterpret_cast<jclass>(env->NewGlobalRef(cls));
            env->DeleteLocalRef(cls);
        } else {
            LOGE("Failed to find class dev/zeronative/exp2/ZnBridge");
            return;
        }
        g_onFlushMethod = env->GetStaticMethodID(g_bridgeClass, "onFlush", "(Ljava/lang/String;)V");
        g_onJsErrorMethod = env->GetStaticMethodID(g_bridgeClass, "onJsError", "(Ljava/lang/String;)V");
        g_postTimerMethod = env->GetStaticMethodID(g_bridgeClass, "postTimer", "(IJ)V");
        g_clearTimerMethod = env->GetStaticMethodID(g_bridgeClass, "clearTimer", "(I)V");
    }

    try {
        ::hermes::vm::RuntimeConfig config = ::hermes::vm::RuntimeConfig::Builder()
            .withMicrotaskQueue(true)
            .build();
        g_runtime = facebook::hermes::makeHermesRuntime(config);
        LOGI("HermesRuntime created with MicrotaskQueue = true");

        // 1. __zn_flush(opsJson: string)
        auto fnFlush = facebook::jsi::Function::createFromHostFunction(
            *g_runtime,
            facebook::jsi::PropNameID::forAscii(*g_runtime, "__zn_flush"),
            1,
            [](facebook::jsi::Runtime& rt, const facebook::jsi::Value& /* thisVal */,
               const facebook::jsi::Value* args, size_t count) -> facebook::jsi::Value {
                if (count < 1 || !args[0].isString()) return facebook::jsi::Value::undefined();
                std::string ops = args[0].asString(rt).utf8(rt);
                JNIEnv* curEnv = getJniEnv();
                if (curEnv && g_onFlushMethod && g_bridgeClass) {
                    jstring jOps = curEnv->NewStringUTF(ops.c_str());
                    curEnv->CallStaticVoidMethod(g_bridgeClass, g_onFlushMethod, jOps);
                    curEnv->DeleteLocalRef(jOps);
                }
                return facebook::jsi::Value::undefined();
            }
        );
        g_runtime->global().setProperty(*g_runtime, "__zn_flush", fnFlush);

        // 2. __zn_log(level: number, msg: string)
        auto fnLog = facebook::jsi::Function::createFromHostFunction(
            *g_runtime,
            facebook::jsi::PropNameID::forAscii(*g_runtime, "__zn_log"),
            2,
            [](facebook::jsi::Runtime& rt, const facebook::jsi::Value& /* thisVal */,
               const facebook::jsi::Value* args, size_t count) -> facebook::jsi::Value {
                int level = (count > 0 && args[0].isNumber()) ? static_cast<int>(args[0].asNumber()) : 1;
                std::string msg = (count > 1 && args[1].isString()) ? args[1].asString(rt).utf8(rt) : "";
                android_LogPriority prio = ANDROID_LOG_INFO;
                if (level == 0) prio = ANDROID_LOG_DEBUG;
                else if (level == 2) prio = ANDROID_LOG_WARN;
                else if (level >= 3) prio = ANDROID_LOG_ERROR;
                __android_log_print(prio, "zn", "%s", msg.c_str());
                return facebook::jsi::Value::undefined();
            }
        );
        g_runtime->global().setProperty(*g_runtime, "__zn_log", fnLog);

        // 3. __zn_setTimeout(id: number, delayMs: number)
        auto fnSetTimeout = facebook::jsi::Function::createFromHostFunction(
            *g_runtime,
            facebook::jsi::PropNameID::forAscii(*g_runtime, "__zn_setTimeout"),
            2,
            [](facebook::jsi::Runtime& /* rt */, const facebook::jsi::Value& /* thisVal */,
               const facebook::jsi::Value* args, size_t count) -> facebook::jsi::Value {
                if (count < 2) return facebook::jsi::Value::undefined();
                int id = static_cast<int>(args[0].asNumber());
                long delay = static_cast<long>(args[1].asNumber());
                JNIEnv* curEnv = getJniEnv();
                if (curEnv && g_postTimerMethod && g_bridgeClass) {
                    curEnv->CallStaticVoidMethod(g_bridgeClass, g_postTimerMethod, id, static_cast<jlong>(delay));
                }
                return facebook::jsi::Value::undefined();
            }
        );
        g_runtime->global().setProperty(*g_runtime, "__zn_setTimeout", fnSetTimeout);

        // 4. __zn_clearTimeout(id: number)
        auto fnClearTimeout = facebook::jsi::Function::createFromHostFunction(
            *g_runtime,
            facebook::jsi::PropNameID::forAscii(*g_runtime, "__zn_clearTimeout"),
            1,
            [](facebook::jsi::Runtime& /* rt */, const facebook::jsi::Value& /* thisVal */,
               const facebook::jsi::Value* args, size_t count) -> facebook::jsi::Value {
                if (count < 1) return facebook::jsi::Value::undefined();
                int id = static_cast<int>(args[0].asNumber());
                JNIEnv* curEnv = getJniEnv();
                if (curEnv && g_clearTimerMethod && g_bridgeClass) {
                    curEnv->CallStaticVoidMethod(g_bridgeClass, g_clearTimerMethod, id);
                }
                return facebook::jsi::Value::undefined();
            }
        );
        g_runtime->global().setProperty(*g_runtime, "__zn_clearTimeout", fnClearTimeout);

        // 5. __zn_now(): number (monotonic milliseconds)
        auto fnNow = facebook::jsi::Function::createFromHostFunction(
            *g_runtime,
            facebook::jsi::PropNameID::forAscii(*g_runtime, "__zn_now"),
            0,
            [](facebook::jsi::Runtime& /* rt */, const facebook::jsi::Value& /* thisVal */,
               const facebook::jsi::Value* /* args */, size_t /* count */) -> facebook::jsi::Value {
                struct timespec ts;
                clock_gettime(CLOCK_MONOTONIC, &ts);
                double ms = static_cast<double>(ts.tv_sec) * 1000.0 + static_cast<double>(ts.tv_nsec) / 1000000.0;
                return facebook::jsi::Value(ms);
            }
        );
        g_runtime->global().setProperty(*g_runtime, "__zn_now", fnNow);

        LOGI("Host functions successfully installed on JS global");
    } catch (const facebook::jsi::JSError& e) {
        reportJsError(std::string("Init JSError: ") + e.getMessage() + "\n" + e.getStack());
    } catch (const std::exception& e) {
        reportJsError(std::string("Init Exception: ") + e.what());
    }
}

JNIEXPORT jboolean JNICALL
Java_dev_zeronative_exp2_ZnBridge_nativeEvalBytecode(
    JNIEnv* env, jclass /* clazz */, jbyteArray bytecodeArray, jstring sourceUrl) {
    if (!g_runtime) {
        reportJsError("nativeEvalBytecode called but g_runtime is null");
        return JNI_FALSE;
    }
    if (!bytecodeArray) {
        reportJsError("nativeEvalBytecode: bytecodeArray is null");
        return JNI_FALSE;
    }

    try {
        jsize len = env->GetArrayLength(bytecodeArray);
        jbyte* bytes = env->GetByteArrayElements(bytecodeArray, nullptr);
        std::vector<uint8_t> vec(reinterpret_cast<const uint8_t*>(bytes), reinterpret_cast<const uint8_t*>(bytes) + len);
        env->ReleaseByteArrayElements(bytecodeArray, bytes, JNI_ABORT);

        const char* urlChars = env->GetStringUTFChars(sourceUrl, nullptr);
        std::string url(urlChars);
        env->ReleaseStringUTFChars(sourceUrl, urlChars);

        auto buffer = std::make_shared<MemoryBuffer>(std::move(vec));
        g_runtime->evaluateJavaScript(buffer, url);
        g_runtime->drainMicrotasks();
        return JNI_TRUE;
    } catch (const facebook::jsi::JSError& e) {
        reportJsError(std::string("Eval JSError: ") + e.getMessage() + "\n" + e.getStack());
        return JNI_FALSE;
    } catch (const std::exception& e) {
        reportJsError(std::string("Eval Exception: ") + e.what());
        return JNI_FALSE;
    }
}

JNIEXPORT void JNICALL
Java_dev_zeronative_exp2_ZnBridge_nativeDispatchEvent(
    JNIEnv* env, jclass /* clazz */, jint nodeId, jstring eventName, jstring payloadJson) {
    if (!g_runtime) return;

    try {
        facebook::jsi::Value fnVal = g_runtime->global().getProperty(*g_runtime, "__zn_event");
        if (!fnVal.isObject() || !fnVal.asObject(*g_runtime).isFunction(*g_runtime)) {
            LOGW("__zn_event is not defined on global");
            return;
        }

        const char* evtChars = env->GetStringUTFChars(eventName, nullptr);
        std::string evt(evtChars);
        env->ReleaseStringUTFChars(eventName, evtChars);

        const char* payloadChars = payloadJson ? env->GetStringUTFChars(payloadJson, nullptr) : nullptr;
        std::string payload = payloadChars ? payloadChars : "{}";
        if (payloadChars) env->ReleaseStringUTFChars(payloadJson, payloadChars);

        facebook::jsi::Function fn = fnVal.asObject(*g_runtime).asFunction(*g_runtime);
        fn.call(
            *g_runtime,
            facebook::jsi::Value(static_cast<double>(nodeId)),
            facebook::jsi::String::createFromUtf8(*g_runtime, evt),
            facebook::jsi::String::createFromUtf8(*g_runtime, payload)
        );
        g_runtime->drainMicrotasks();
    } catch (const facebook::jsi::JSError& e) {
        reportJsError(std::string("Event JSError: ") + e.getMessage() + "\n" + e.getStack());
    } catch (const std::exception& e) {
        reportJsError(std::string("Event Exception: ") + e.what());
    }
}

JNIEXPORT void JNICALL
Java_dev_zeronative_exp2_ZnBridge_nativeTimerFired(
    JNIEnv* /* env */, jclass /* clazz */, jint timerId) {
    if (!g_runtime) return;

    try {
        facebook::jsi::Value fnVal = g_runtime->global().getProperty(*g_runtime, "__zn_timerFired");
        if (fnVal.isObject() && fnVal.asObject(*g_runtime).isFunction(*g_runtime)) {
            facebook::jsi::Function fn = fnVal.asObject(*g_runtime).asFunction(*g_runtime);
            fn.call(*g_runtime, facebook::jsi::Value(static_cast<double>(timerId)));
        }
        g_runtime->drainMicrotasks();
    } catch (const facebook::jsi::JSError& e) {
        reportJsError(std::string("Timer JSError: ") + e.getMessage() + "\n" + e.getStack());
    } catch (const std::exception& e) {
        reportJsError(std::string("Timer Exception: ") + e.what());
    }
}

JNIEXPORT void JNICALL
Java_dev_zeronative_exp2_ZnBridge_nativeDestroy(JNIEnv* env, jclass /* clazz */) {
    LOGI("nativeDestroy: dropping Hermes runtime");
    g_runtime = nullptr;
    if (g_bridgeClass) {
        env->DeleteGlobalRef(g_bridgeClass);
        g_bridgeClass = nullptr;
    }
}

} // extern "C"
