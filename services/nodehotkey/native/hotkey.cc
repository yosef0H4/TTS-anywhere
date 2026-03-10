#include <napi.h>

#ifdef _WIN32

#include <windows.h>

#include <condition_variable>
#include <cstdint>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>

namespace {

constexpr UINT kShutdownMessage = WM_APP + 0x40;
constexpr unsigned int kModAlt = 0x0001;
constexpr unsigned int kModControl = 0x0002;
constexpr unsigned int kModShift = 0x0004;
constexpr unsigned int kModWin = 0x0008;
constexpr unsigned int kSupportedMods = kModAlt | kModControl | kModShift | kModWin;

struct SessionSpec {
  std::string label;
  unsigned int modifiers = 0;
  unsigned int vk = 0;
  unsigned int release_vk = 0;
};

struct SessionEvent {
  enum class Type {
    TriggerDown,
    TriggerUp
  };

  Type type;
  LONG x;
  LONG y;
};

struct SessionState {
  int32_t id = 0;
  SessionSpec spec;
  bool running = false;
  bool held = false;
  Napi::ThreadSafeFunction callback;
};

Napi::Object SessionEventToJs(Napi::Env env, const SessionEvent& payload) {
  Napi::Object event = Napi::Object::New(env);
  event.Set("type", payload.type == SessionEvent::Type::TriggerDown ? "triggerDown" : "triggerUp");
  Napi::Object point = Napi::Object::New(env);
  point.Set("x", Napi::Number::New(env, payload.x));
  point.Set("y", Napi::Number::New(env, payload.y));
  event.Set("point", point);
  return event;
}

class HotkeyManager {
 public:
  static HotkeyManager& Instance() {
    static HotkeyManager manager;
    return manager;
  }

  void Init(Napi::Env env) {
    std::scoped_lock lock(mutex_);
    if (cleanup_registered_) return;
    cleanup_registered_ = true;
    env.AddCleanupHook(
      [](void* data) {
        static_cast<HotkeyManager*>(data)->Shutdown();
      },
      this
    );
  }

  int32_t CreateSession(const SessionSpec& spec, Napi::ThreadSafeFunction callback) {
    EnsureThread();
    std::scoped_lock lock(mutex_);
    const int32_t id = next_session_id_++;
    auto session = std::make_shared<SessionState>();
    session->id = id;
    session->spec = spec;
    session->callback = std::move(callback);
    sessions_[id] = session;
    return id;
  }

  void DestroySession(int32_t id) {
    std::shared_ptr<SessionState> removed;
    {
      std::scoped_lock lock(mutex_);
      auto it = sessions_.find(id);
      if (it == sessions_.end()) return;
      it->second->running = false;
      it->second->held = false;
      removed = std::move(it->second);
      sessions_.erase(it);
    }
    if (removed) {
      removed->callback.Release();
    }
  }

  void StartSession(int32_t id) {
    EnsureThread();
    std::scoped_lock lock(mutex_);
    auto session = FindSessionLocked(id);
    if (!session) throw std::runtime_error("Invalid hotkey session id");
    session->running = true;
    session->held = false;
  }

  void StopSession(int32_t id) {
    std::scoped_lock lock(mutex_);
    auto session = FindSessionLocked(id);
    if (!session) return;
    session->running = false;
    session->held = false;
  }

  void SetSessionSpec(int32_t id, const SessionSpec& spec) {
    std::scoped_lock lock(mutex_);
    auto session = FindSessionLocked(id);
    if (!session) throw std::runtime_error("Invalid hotkey session id");
    session->spec = spec;
    session->held = false;
  }

  POINT GetCursor() const {
    POINT point{};
    GetCursorPos(&point);
    return point;
  }

  bool IsVkDown(int vk) const {
    return (GetAsyncKeyState(vk) & 0x8000) != 0;
  }

  LRESULT HandleKeyboard(int code, WPARAM w_param, const KBDLLHOOKSTRUCT* info) {
    if (code != HC_ACTION || info == nullptr) {
      return CallNextHookEx(hook_, code, w_param, reinterpret_cast<LPARAM>(info));
    }
    if ((info->flags & LLKHF_INJECTED) != 0) {
      return CallNextHookEx(hook_, code, w_param, reinterpret_cast<LPARAM>(info));
    }

    const bool is_key_down = w_param == WM_KEYDOWN || w_param == WM_SYSKEYDOWN;
    const bool is_key_up = w_param == WM_KEYUP || w_param == WM_SYSKEYUP;
    if (!is_key_down && !is_key_up) {
      return CallNextHookEx(hook_, code, w_param, reinterpret_cast<LPARAM>(info));
    }

    bool suppress = false;

    std::scoped_lock lock(mutex_);
    for (const auto& entry : sessions_) {
      const auto& session = entry.second;
      if (!session->running) continue;

      const bool is_trigger_key = info->vkCode == session->spec.vk;
      if (is_key_down && is_trigger_key && AreRequiredModifiersDown(session->spec.modifiers)) {
        suppress = true;
        if (!session->held) {
          session->held = true;
          QueueEventLocked(*session, SessionEvent::Type::TriggerDown);
        }
        continue;
      }

      if (!session->held) continue;

      if (ShouldSuppressWhileHeld(session->spec, static_cast<int>(info->vkCode))) {
        suppress = true;
      }

      if (is_key_up && info->vkCode == session->spec.release_vk) {
        session->held = false;
        QueueEventLocked(*session, SessionEvent::Type::TriggerUp);
      }
    }

    if (suppress) return 1;
    return CallNextHookEx(hook_, code, w_param, reinterpret_cast<LPARAM>(info));
  }

  void Shutdown() {
    std::thread thread_to_join;
    std::vector<std::shared_ptr<SessionState>> to_release;
    {
      std::unique_lock lock(mutex_);
      if (thread_started_) {
        if (thread_id_ != 0) {
          PostThreadMessageW(thread_id_, kShutdownMessage, 0, 0);
        }
        thread_to_join = std::move(thread_);
        thread_started_ = false;
        thread_id_ = 0;
        hook_ = nullptr;
      }
      for (auto& entry : sessions_) {
        entry.second->running = false;
        entry.second->held = false;
        to_release.push_back(entry.second);
      }
      sessions_.clear();
    }

    if (thread_to_join.joinable()) {
      thread_to_join.join();
    }
    for (const auto& session : to_release) {
      session->callback.Release();
    }
  }

 private:
  HotkeyManager() = default;
  ~HotkeyManager() = default;
  HotkeyManager(const HotkeyManager&) = delete;
  HotkeyManager& operator=(const HotkeyManager&) = delete;

  static bool IsModifierVkDown(int modifier_vk) {
    return (GetAsyncKeyState(modifier_vk) & 0x8000) != 0;
  }

  static bool AreRequiredModifiersDown(unsigned int modifiers) {
    const unsigned int required = modifiers & kSupportedMods;
    if ((required & kModControl) != 0 && !IsModifierVkDown(VK_CONTROL)) return false;
    if ((required & kModShift) != 0 && !IsModifierVkDown(VK_SHIFT)) return false;
    if ((required & kModAlt) != 0 && !IsModifierVkDown(VK_MENU)) return false;
    if ((required & kModWin) != 0) {
      const bool left_down = IsModifierVkDown(VK_LWIN);
      const bool right_down = IsModifierVkDown(VK_RWIN);
      if (!left_down && !right_down) return false;
    }
    return true;
  }

  static bool MatchesModifierVk(unsigned int modifiers, int vk_code) {
    if ((modifiers & kModControl) != 0 && (vk_code == VK_CONTROL || vk_code == VK_LCONTROL || vk_code == VK_RCONTROL)) {
      return true;
    }
    if ((modifiers & kModShift) != 0 && (vk_code == VK_SHIFT || vk_code == VK_LSHIFT || vk_code == VK_RSHIFT)) {
      return true;
    }
    if ((modifiers & kModAlt) != 0 && (vk_code == VK_MENU || vk_code == VK_LMENU || vk_code == VK_RMENU)) {
      return true;
    }
    if ((modifiers & kModWin) != 0 && (vk_code == VK_LWIN || vk_code == VK_RWIN)) {
      return true;
    }
    return false;
  }

  static bool ShouldSuppressWhileHeld(const SessionSpec& spec, int vk_code) {
    if (vk_code == static_cast<int>(spec.release_vk)) return true;
    return MatchesModifierVk(spec.modifiers & kSupportedMods, vk_code);
  }

  void QueueEventLocked(SessionState& session, SessionEvent::Type type) {
    POINT point{};
    GetCursorPos(&point);
    auto* payload = new SessionEvent{type, point.x, point.y};
    const napi_status status = session.callback.NonBlockingCall(
      payload,
      [](Napi::Env env, Napi::Function callback, SessionEvent* payload) {
        Napi::Object event = SessionEventToJs(env, *payload);
        callback.Call({event});
        delete payload;
      }
    );
    if (status != napi_ok) {
      delete payload;
    }
  }

  std::shared_ptr<SessionState> FindSessionLocked(int32_t id) {
    auto it = sessions_.find(id);
    return it == sessions_.end() ? nullptr : it->second;
  }

  void EnsureThread() {
    std::unique_lock lock(mutex_);
    if (thread_started_) return;

    thread_started_ = true;
    init_done_ = false;
    init_error_.clear();
    thread_ = std::thread([this]() { ThreadMain(); });

    init_cv_.wait(lock, [this]() { return init_done_; });
    if (init_error_.empty()) return;

    lock.unlock();
    if (thread_.joinable()) thread_.join();
    lock.lock();
    thread_started_ = false;
    thread_id_ = 0;
    throw std::runtime_error(init_error_);
  }

  void PublishInitResultLocked(std::string error) {
    init_error_ = std::move(error);
    init_done_ = true;
    init_cv_.notify_all();
  }

  void ThreadMain() {
    MSG warmup{};
    PeekMessageW(&warmup, nullptr, WM_USER, WM_USER, PM_NOREMOVE);

    {
      std::scoped_lock lock(mutex_);
      thread_id_ = GetCurrentThreadId();
    }

    HMODULE module_handle = nullptr;
    GetModuleHandleExW(
      GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
      reinterpret_cast<LPCWSTR>(&KeyboardProc),
      &module_handle
    );

    HHOOK local_hook = SetWindowsHookExW(WH_KEYBOARD_LL, &KeyboardProc, module_handle, 0);
    {
      std::scoped_lock lock(mutex_);
      hook_ = local_hook;
      PublishInitResultLocked(local_hook == nullptr ? "SetWindowsHookExW failed for nodehotkey_hotkey" : "");
    }

    if (local_hook == nullptr) {
      return;
    }

    MSG msg{};
    while (GetMessageW(&msg, nullptr, 0, 0) > 0) {
      if (msg.message == kShutdownMessage) break;
      TranslateMessage(&msg);
      DispatchMessageW(&msg);
    }

    UnhookWindowsHookEx(local_hook);

    std::scoped_lock lock(mutex_);
    if (hook_ == local_hook) {
      hook_ = nullptr;
    }
  }

  static LRESULT CALLBACK KeyboardProc(int code, WPARAM w_param, LPARAM l_param) {
    return Instance().HandleKeyboard(code, w_param, reinterpret_cast<const KBDLLHOOKSTRUCT*>(l_param));
  }

  mutable std::mutex mutex_;
  std::condition_variable init_cv_;
  std::unordered_map<int32_t, std::shared_ptr<SessionState>> sessions_;
  std::thread thread_;
  HHOOK hook_ = nullptr;
  DWORD thread_id_ = 0;
  int32_t next_session_id_ = 1;
  bool thread_started_ = false;
  bool init_done_ = false;
  bool cleanup_registered_ = false;
  std::string init_error_;
};

SessionSpec ReadSpec(const Napi::Object& value) {
  SessionSpec spec;
  spec.label = value.Get("label").ToString().Utf8Value();
  spec.modifiers = value.Get("modifiers").ToNumber().Uint32Value();
  spec.vk = value.Get("vk").ToNumber().Uint32Value();
  spec.release_vk = value.Get("releaseVk").ToNumber().Uint32Value();
  return spec;
}

Napi::Value CreateHotkeySession(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsObject() || !info[1].IsFunction()) {
    throw Napi::TypeError::New(env, "Expected (spec, callback)");
  }

  auto spec = ReadSpec(info[0].As<Napi::Object>());
  auto callback = Napi::ThreadSafeFunction::New(
    env,
    info[1].As<Napi::Function>(),
    "nodehotkey_hotkey_callback",
    0,
    1
  );
  const int32_t id = HotkeyManager::Instance().CreateSession(spec, std::move(callback));
  return Napi::Number::New(env, id);
}

Napi::Value DestroyHotkeySession(const Napi::CallbackInfo& info) {
  if (info.Length() < 1 || !info[0].IsNumber()) {
    throw Napi::TypeError::New(info.Env(), "Expected session id");
  }
  HotkeyManager::Instance().DestroySession(info[0].ToNumber().Int32Value());
  return info.Env().Undefined();
}

Napi::Value StartHotkeySession(const Napi::CallbackInfo& info) {
  if (info.Length() < 1 || !info[0].IsNumber()) {
    throw Napi::TypeError::New(info.Env(), "Expected session id");
  }
  HotkeyManager::Instance().StartSession(info[0].ToNumber().Int32Value());
  return info.Env().Undefined();
}

Napi::Value StopHotkeySession(const Napi::CallbackInfo& info) {
  if (info.Length() < 1 || !info[0].IsNumber()) {
    throw Napi::TypeError::New(info.Env(), "Expected session id");
  }
  HotkeyManager::Instance().StopSession(info[0].ToNumber().Int32Value());
  return info.Env().Undefined();
}

Napi::Value SetHotkeySessionSpec(const Napi::CallbackInfo& info) {
  if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsObject()) {
    throw Napi::TypeError::New(info.Env(), "Expected (sessionId, spec)");
  }
  auto spec = ReadSpec(info[1].As<Napi::Object>());
  HotkeyManager::Instance().SetSessionSpec(info[0].ToNumber().Int32Value(), spec);
  return info.Env().Undefined();
}

Napi::Value GetCursorPosition(const Napi::CallbackInfo& info) {
  POINT point = HotkeyManager::Instance().GetCursor();
  Napi::Object result = Napi::Object::New(info.Env());
  result.Set("x", Napi::Number::New(info.Env(), point.x));
  result.Set("y", Napi::Number::New(info.Env(), point.y));
  return result;
}

Napi::Value IsVirtualKeyDown(const Napi::CallbackInfo& info) {
  if (info.Length() < 1 || !info[0].IsNumber()) {
    throw Napi::TypeError::New(info.Env(), "Expected virtual key code");
  }
  const bool down = HotkeyManager::Instance().IsVkDown(info[0].ToNumber().Int32Value());
  return Napi::Boolean::New(info.Env(), down);
}

}  // namespace

Napi::Object InitModule(Napi::Env env, Napi::Object exports) {
  HotkeyManager::Instance().Init(env);
  exports.Set("createHotkeySession", Napi::Function::New(env, CreateHotkeySession));
  exports.Set("destroyHotkeySession", Napi::Function::New(env, DestroyHotkeySession));
  exports.Set("startHotkeySession", Napi::Function::New(env, StartHotkeySession));
  exports.Set("stopHotkeySession", Napi::Function::New(env, StopHotkeySession));
  exports.Set("setHotkeySessionSpec", Napi::Function::New(env, SetHotkeySessionSpec));
  exports.Set("getCursorPosition", Napi::Function::New(env, GetCursorPosition));
  exports.Set("isVirtualKeyDown", Napi::Function::New(env, IsVirtualKeyDown));
  return exports;
}

NODE_API_MODULE(nodehotkey_hotkey, InitModule)

#else

Napi::Object InitModule(Napi::Env env, Napi::Object exports) {
  return exports;
}

NODE_API_MODULE(nodehotkey_hotkey, InitModule)

#endif
