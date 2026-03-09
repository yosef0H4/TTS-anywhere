{
  "targets": [
    {
      "target_name": "nodehotkey_capture",
      "sources": [
        "native/capture.cc"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "dependencies": [
        "<!(node -p \"require('node-addon-api').gyp\")"
      ],
      "defines": [
        "NAPI_CPP_EXCEPTIONS"
      ],
      "conditions": [
        [
          "OS=='win'",
          {
            "libraries": [
              "-ld3d11",
              "-ldxgi",
              "-ldwmapi",
              "-lole32",
              "-lwindowscodecs",
              "-luser32"
            ],
            "msvs_settings": {
              "VCCLCompilerTool": {
                "ExceptionHandling": 1,
                "AdditionalOptions": [
                  "/std:c++20"
                ]
              }
            }
          }
        ]
      ]
    }
  ]
}
