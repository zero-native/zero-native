#include <jni.h>
#include <string>
#include <vector>
#include <memory>
#include <android/log.h>
#include <hermes/hermes.h>
#include <jsi/jsi.h>

#define LOG_TAG "zn_smoke"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

class MemoryBuffer : public facebook::jsi::Buffer {
public:
    MemoryBuffer(const uint8_t* data, size_t size) : data_(data, data + size) {}
    size_t size() const override { return data_.size(); }
    const uint8_t* data() const override { return data_.data(); }
private:
    std::vector<uint8_t> data_;
};

extern "C" JNIEXPORT jstring JNICALL
Java_dev_zeronative_exp1_ZnBridge_evalSmokeBytecode(
    JNIEnv* env, jclass /* clazz */, jbyteArray bytecodeArray) {
    if (!bytecodeArray) {
        return env->NewStringUTF("Error: null bytecode");
    }

    try {
        jsize len = env->GetArrayLength(bytecodeArray);
        jbyte* bytes = env->GetByteArrayElements(bytecodeArray, nullptr);
        auto buffer = std::make_shared<MemoryBuffer>(reinterpret_cast<const uint8_t*>(bytes), static_cast<size_t>(len));
        env->ReleaseByteArrayElements(bytecodeArray, bytes, JNI_ABORT);

        auto runtime = facebook::hermes::makeHermesRuntime();
        facebook::jsi::Value result = runtime->evaluateJavaScript(buffer, "smoke.hbc");

        std::string resStr;
        if (result.isNumber()) {
            double num = result.asNumber();
            if (num == static_cast<int64_t>(num)) {
                resStr = std::to_string(static_cast<int64_t>(num));
            } else {
                resStr = std::to_string(num);
            }
        } else if (result.isString()) {
            resStr = result.asString(*runtime).utf8(*runtime);
        } else if (result.isBool()) {
            resStr = result.getBool() ? "true" : "false";
        } else {
            resStr = "evaluated";
        }

        LOGI("Hermes smoke eval result: %s", resStr.c_str());
        return env->NewStringUTF(resStr.c_str());
    } catch (const facebook::jsi::JSError& e) {
        LOGE("Hermes JSError: %s", e.getMessage().c_str());
        return env->NewStringUTF((std::string("JSError: ") + e.getMessage()).c_str());
    } catch (const std::exception& e) {
        LOGE("Hermes eval exception: %s", e.what());
        return env->NewStringUTF((std::string("Exception: ") + e.what()).c_str());
    }
}
