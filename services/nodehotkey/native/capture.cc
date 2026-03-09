#include <napi.h>

#ifdef _WIN32

#include <windows.h>
#include <wincodec.h>
#include <d3d11.h>
#include <dxgi1_2.h>
#include <dwmapi.h>
#include <wrl/client.h>

#include <cstdint>
#include <cstdio>
#include <cstring>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <vector>

#pragma comment(lib, "d3d11.lib")
#pragma comment(lib, "dxgi.lib")
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "windowscodecs.lib")
#pragma comment(lib, "user32.lib")

using Microsoft::WRL::ComPtr;

namespace {

struct Bounds {
  LONG left;
  LONG top;
  LONG width;
  LONG height;
};

struct FrozenFrame {
  int32_t id;
  Bounds bounds;
  uint64_t captured_at;
  std::vector<uint8_t> pixels;
};

std::unordered_map<int32_t, FrozenFrame> g_sessions;
int32_t g_next_session_id = 1;

class ComInitGuard {
 public:
  ComInitGuard() : hr_(CoInitializeEx(nullptr, COINIT_MULTITHREADED)) {}
  ~ComInitGuard() {
    if (SUCCEEDED(hr_)) CoUninitialize();
  }

 private:
  HRESULT hr_;
};

uint64_t CurrentUnixMs() {
  FILETIME ft;
  GetSystemTimeAsFileTime(&ft);
  ULARGE_INTEGER uli;
  uli.LowPart = ft.dwLowDateTime;
  uli.HighPart = ft.dwHighDateTime;
  return (uli.QuadPart - 116444736000000000ULL) / 10000ULL;
}

std::string HrMessage(const char* what, HRESULT hr) {
  char buffer[128];
  std::snprintf(buffer, sizeof(buffer), "%s (HRESULT=0x%08lx)", what, static_cast<unsigned long>(hr));
  return std::string(buffer);
}

void ThrowIfFailed(HRESULT hr, const char* what) {
  if (FAILED(hr)) throw std::runtime_error(HrMessage(what, hr));
}

bool BoundsContain(const Bounds& bounds, LONG x, LONG y) {
  return x >= bounds.left && x < bounds.left + bounds.width && y >= bounds.top && y < bounds.top + bounds.height;
}

struct OutputSelection {
  ComPtr<IDXGIAdapter1> adapter;
  ComPtr<IDXGIOutput1> output;
  Bounds bounds;
};

struct AcquiredFrame {
  DXGI_OUTDUPL_FRAME_INFO info{};
  ComPtr<IDXGIResource> resource;
};

OutputSelection FindOutputAtPoint(LONG x, LONG y) {
  ComPtr<IDXGIFactory1> factory;
  ThrowIfFailed(CreateDXGIFactory1(IID_PPV_ARGS(&factory)), "CreateDXGIFactory1 failed");

  for (UINT adapter_index = 0;; ++adapter_index) {
    ComPtr<IDXGIAdapter1> adapter;
    if (factory->EnumAdapters1(adapter_index, &adapter) == DXGI_ERROR_NOT_FOUND) break;

    for (UINT output_index = 0;; ++output_index) {
      ComPtr<IDXGIOutput> output;
      if (adapter->EnumOutputs(output_index, &output) == DXGI_ERROR_NOT_FOUND) break;

      DXGI_OUTPUT_DESC desc{};
      ThrowIfFailed(output->GetDesc(&desc), "IDXGIOutput::GetDesc failed");
      Bounds bounds{
        desc.DesktopCoordinates.left,
        desc.DesktopCoordinates.top,
        desc.DesktopCoordinates.right - desc.DesktopCoordinates.left,
        desc.DesktopCoordinates.bottom - desc.DesktopCoordinates.top
      };
      if (!BoundsContain(bounds, x, y)) continue;

      ComPtr<IDXGIOutput1> output1;
      ThrowIfFailed(output.As(&output1), "IDXGIOutput1 unavailable");
      return OutputSelection{ adapter, output1, bounds };
    }
  }

  throw std::runtime_error("No monitor found for point");
}

std::vector<uint8_t> CaptureOutputBgra(const OutputSelection& selection, uint32_t* out_width, uint32_t* out_height) {
  ComPtr<ID3D11Device> device;
  ComPtr<ID3D11DeviceContext> context;
  D3D_FEATURE_LEVEL feature_level = D3D_FEATURE_LEVEL_11_0;
  ThrowIfFailed(
    D3D11CreateDevice(
      selection.adapter.Get(),
      D3D_DRIVER_TYPE_UNKNOWN,
      nullptr,
      D3D11_CREATE_DEVICE_BGRA_SUPPORT,
      &feature_level,
      1,
      D3D11_SDK_VERSION,
      &device,
      nullptr,
      &context
    ),
    "D3D11CreateDevice failed"
  );

  ComPtr<IDXGIOutputDuplication> duplication;
  ThrowIfFailed(selection.output->DuplicateOutput(device.Get(), &duplication), "DuplicateOutput failed");

  AcquiredFrame acquired{};
  bool frame_acquired = false;
  for (int attempt = 0; attempt < 4; ++attempt) {
    DXGI_OUTDUPL_FRAME_INFO frame_info{};
    ComPtr<IDXGIResource> resource;
    HRESULT hr = duplication->AcquireNextFrame(250, &frame_info, &resource);
    if (hr == DXGI_ERROR_WAIT_TIMEOUT) {
      continue;
    }
    ThrowIfFailed(hr, "AcquireNextFrame failed");

    const bool has_desktop_update = frame_info.LastPresentTime.QuadPart != 0;
    const bool final_attempt = attempt == 3;
    if (has_desktop_update || final_attempt) {
      acquired.info = frame_info;
      acquired.resource = resource;
      frame_acquired = true;
      break;
    }

    duplication->ReleaseFrame();
  }

  if (!frame_acquired || !acquired.resource) {
    throw std::runtime_error("AcquireNextFrame returned no desktop image");
  }

  ComPtr<ID3D11Texture2D> source_texture;
  ThrowIfFailed(acquired.resource.As(&source_texture), "Failed to query frame texture");

  D3D11_TEXTURE2D_DESC desc{};
  source_texture->GetDesc(&desc);

  D3D11_TEXTURE2D_DESC staging_desc = desc;
  staging_desc.BindFlags = 0;
  staging_desc.MiscFlags = 0;
  staging_desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
  staging_desc.Usage = D3D11_USAGE_STAGING;

  ComPtr<ID3D11Texture2D> staging_texture;
  ThrowIfFailed(device->CreateTexture2D(&staging_desc, nullptr, &staging_texture), "CreateTexture2D failed");
  context->CopyResource(staging_texture.Get(), source_texture.Get());
  context->Flush();

  D3D11_MAPPED_SUBRESOURCE mapped{};
  ThrowIfFailed(context->Map(staging_texture.Get(), 0, D3D11_MAP_READ, 0, &mapped), "Map failed");

  const uint32_t width = desc.Width;
  const uint32_t height = desc.Height;
  std::vector<uint8_t> pixels(static_cast<size_t>(width) * static_cast<size_t>(height) * 4);
  for (uint32_t row = 0; row < height; ++row) {
    const uint8_t* source_row = static_cast<const uint8_t*>(mapped.pData) + static_cast<size_t>(row) * mapped.RowPitch;
    uint8_t* dest_row = pixels.data() + static_cast<size_t>(row) * static_cast<size_t>(width) * 4;
    std::memcpy(dest_row, source_row, static_cast<size_t>(width) * 4);
  }

  context->Unmap(staging_texture.Get(), 0);
  duplication->ReleaseFrame();

  *out_width = width;
  *out_height = height;
  return pixels;
}

std::vector<uint8_t> CropBgra(const std::vector<uint8_t>& pixels, uint32_t source_width, uint32_t source_height, const RECT& rect) {
  const LONG crop_width = rect.right - rect.left;
  const LONG crop_height = rect.bottom - rect.top;
  if (crop_width <= 0 || crop_height <= 0) throw std::runtime_error("Crop rectangle has zero area");
  if (rect.left < 0 || rect.top < 0 || rect.right > static_cast<LONG>(source_width) || rect.bottom > static_cast<LONG>(source_height)) {
    throw std::runtime_error("Crop rectangle is outside captured monitor bounds");
  }

  std::vector<uint8_t> cropped(static_cast<size_t>(crop_width) * static_cast<size_t>(crop_height) * 4);
  for (LONG row = 0; row < crop_height; ++row) {
    const uint8_t* source_row =
      pixels.data() + (static_cast<size_t>(rect.top + row) * source_width + static_cast<size_t>(rect.left)) * 4;
    uint8_t* dest_row = cropped.data() + static_cast<size_t>(row) * static_cast<size_t>(crop_width) * 4;
    std::memcpy(dest_row, source_row, static_cast<size_t>(crop_width) * 4);
  }
  return cropped;
}

std::vector<uint8_t> EncodePngBgra(const std::vector<uint8_t>& pixels, uint32_t width, uint32_t height) {
  ComPtr<IWICImagingFactory> factory;
  ThrowIfFailed(
    CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&factory)),
    "CoCreateInstance(IWICImagingFactory) failed"
  );

  ComPtr<IStream> stream;
  ThrowIfFailed(CreateStreamOnHGlobal(nullptr, TRUE, &stream), "CreateStreamOnHGlobal failed");

  ComPtr<IWICBitmapEncoder> encoder;
  ThrowIfFailed(factory->CreateEncoder(GUID_ContainerFormatPng, nullptr, &encoder), "CreateEncoder failed");
  ThrowIfFailed(encoder->Initialize(stream.Get(), WICBitmapEncoderNoCache), "Encoder initialize failed");

  ComPtr<IWICBitmapFrameEncode> frame;
  ComPtr<IPropertyBag2> props;
  ThrowIfFailed(encoder->CreateNewFrame(&frame, &props), "CreateNewFrame failed");
  ThrowIfFailed(frame->Initialize(props.Get()), "Frame initialize failed");
  ThrowIfFailed(frame->SetSize(width, height), "SetSize failed");

  WICPixelFormatGUID format = GUID_WICPixelFormat32bppBGRA;
  ThrowIfFailed(frame->SetPixelFormat(&format), "SetPixelFormat failed");
  if (!IsEqualGUID(format, GUID_WICPixelFormat32bppBGRA)) {
    throw std::runtime_error("Unexpected WIC pixel format conversion");
  }

  ThrowIfFailed(
    frame->WritePixels(height, width * 4, static_cast<UINT>(pixels.size()),
                       const_cast<BYTE*>(reinterpret_cast<const BYTE*>(pixels.data()))),
    "WritePixels failed"
  );
  ThrowIfFailed(frame->Commit(), "Frame commit failed");
  ThrowIfFailed(encoder->Commit(), "Encoder commit failed");

  HGLOBAL global = nullptr;
  ThrowIfFailed(GetHGlobalFromStream(stream.Get(), &global), "GetHGlobalFromStream failed");
  const SIZE_T size = GlobalSize(global);
  void* data = GlobalLock(global);
  if (!data || size == 0) {
    if (data) GlobalUnlock(global);
    throw std::runtime_error("Failed to lock encoded PNG buffer");
  }

  std::vector<uint8_t> encoded(size);
  std::memcpy(encoded.data(), data, size);
  GlobalUnlock(global);
  return encoded;
}

FrozenFrame CaptureFrozenAtPoint(LONG x, LONG y) {
  OutputSelection selection = FindOutputAtPoint(x, y);
  uint32_t width = 0;
  uint32_t height = 0;
  std::vector<uint8_t> pixels = CaptureOutputBgra(selection, &width, &height);

  FrozenFrame frame{};
  frame.id = g_next_session_id++;
  frame.bounds = Bounds{ selection.bounds.left, selection.bounds.top, static_cast<LONG>(width), static_cast<LONG>(height) };
  frame.captured_at = CurrentUnixMs();
  frame.pixels = std::move(pixels);
  return frame;
}

Napi::Object BoundsToObject(Napi::Env env, const Bounds& bounds) {
  Napi::Object obj = Napi::Object::New(env);
  obj.Set("left", Napi::Number::New(env, bounds.left));
  obj.Set("top", Napi::Number::New(env, bounds.top));
  obj.Set("width", Napi::Number::New(env, bounds.width));
  obj.Set("height", Napi::Number::New(env, bounds.height));
  return obj;
}

RECT ReadCropRect(const Napi::Object& rect) {
  const LONG x = rect.Get("x").As<Napi::Number>().Int32Value();
  const LONG y = rect.Get("y").As<Napi::Number>().Int32Value();
  const LONG width = rect.Get("width").As<Napi::Number>().Int32Value();
  const LONG height = rect.Get("height").As<Napi::Number>().Int32Value();
  return RECT{ x, y, x + width, y + height };
}

Napi::Value CaptureMonitorAtPointWrapped(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  ComInitGuard com_guard;
  const LONG x = info[0].As<Napi::Number>().Int32Value();
  const LONG y = info[1].As<Napi::Number>().Int32Value();
  FrozenFrame frame = CaptureFrozenAtPoint(x, y);
  RECT rect{ 0, 0, frame.bounds.width, frame.bounds.height };
  std::vector<uint8_t> cropped = CropBgra(frame.pixels, static_cast<uint32_t>(frame.bounds.width), static_cast<uint32_t>(frame.bounds.height), rect);
  std::vector<uint8_t> encoded = EncodePngBgra(cropped, static_cast<uint32_t>(frame.bounds.width), static_cast<uint32_t>(frame.bounds.height));
  return Napi::Buffer<uint8_t>::Copy(env, encoded.data(), encoded.size());
}

Napi::Value BeginFrozenMonitorCaptureAtPointWrapped(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  ComInitGuard com_guard;
  const LONG x = info[0].As<Napi::Number>().Int32Value();
  const LONG y = info[1].As<Napi::Number>().Int32Value();
  FrozenFrame frame = CaptureFrozenAtPoint(x, y);
  const int32_t id = frame.id;
  const Bounds bounds = frame.bounds;
  const uint64_t captured_at = frame.captured_at;
  g_sessions.emplace(id, std::move(frame));

  Napi::Object obj = Napi::Object::New(env);
  obj.Set("id", Napi::Number::New(env, id));
  obj.Set("bounds", BoundsToObject(env, bounds));
  obj.Set("capturedAt", Napi::Number::New(env, static_cast<double>(captured_at)));
  return obj;
}

Napi::Value CropFrozenCaptureWrapped(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  ComInitGuard com_guard;
  const int32_t id = info[0].As<Napi::Number>().Int32Value();
  auto iter = g_sessions.find(id);
  if (iter == g_sessions.end()) throw std::runtime_error("Frozen capture session not found");

  const RECT rect = ReadCropRect(info[1].As<Napi::Object>());
  std::vector<uint8_t> cropped = CropBgra(
    iter->second.pixels,
    static_cast<uint32_t>(iter->second.bounds.width),
    static_cast<uint32_t>(iter->second.bounds.height),
    rect
  );
  const uint32_t crop_width = static_cast<uint32_t>(rect.right - rect.left);
  const uint32_t crop_height = static_cast<uint32_t>(rect.bottom - rect.top);
  std::vector<uint8_t> encoded = EncodePngBgra(cropped, crop_width, crop_height);
  return Napi::Buffer<uint8_t>::Copy(env, encoded.data(), encoded.size());
}

void DisposeFrozenCaptureWrapped(const Napi::CallbackInfo& info) {
  const int32_t id = info[0].As<Napi::Number>().Int32Value();
  g_sessions.erase(id);
}

Napi::Value GetMonitorBoundsAtPointWrapped(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  ComInitGuard com_guard;
  const LONG x = info[0].As<Napi::Number>().Int32Value();
  const LONG y = info[1].As<Napi::Number>().Int32Value();
  const OutputSelection selection = FindOutputAtPoint(x, y);
  return BoundsToObject(env, selection.bounds);
}

Napi::Value GetForegroundWindowBoundsWrapped(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  HWND hwnd = GetForegroundWindow();
  if (!hwnd) throw std::runtime_error("No foreground window found");

  RECT rect{};
  const HRESULT dwm_hr = DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, &rect, sizeof(rect));
  if (FAILED(dwm_hr)) {
    if (!GetWindowRect(hwnd, &rect)) {
      throw std::runtime_error("Failed to read foreground window bounds");
    }
  }

  const LONG width = rect.right - rect.left;
  const LONG height = rect.bottom - rect.top;
  if (width <= 0 || height <= 0) {
    throw std::runtime_error("Foreground window has empty bounds");
  }

  return BoundsToObject(env, Bounds{ rect.left, rect.top, width, height });
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("captureMonitorAtPoint", Napi::Function::New(env, CaptureMonitorAtPointWrapped));
  exports.Set("beginFrozenMonitorCaptureAtPoint", Napi::Function::New(env, BeginFrozenMonitorCaptureAtPointWrapped));
  exports.Set("cropFrozenCapture", Napi::Function::New(env, CropFrozenCaptureWrapped));
  exports.Set("disposeFrozenCapture", Napi::Function::New(env, DisposeFrozenCaptureWrapped));
  exports.Set("getMonitorBoundsAtPoint", Napi::Function::New(env, GetMonitorBoundsAtPointWrapped));
  exports.Set("getForegroundWindowBounds", Napi::Function::New(env, GetForegroundWindowBoundsWrapped));
  return exports;
}

}  // namespace

NODE_API_MODULE(nodehotkey_capture, Init)

#else

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  return exports;
}

NODE_API_MODULE(nodehotkey_capture, Init)

#endif
