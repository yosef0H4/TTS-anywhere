from __future__ import annotations

import os


def apply_torchvision_patch() -> None:
    import torch

    if hasattr(torch.library, "_original_register_fake"):
        original_register_fake = torch.library._original_register_fake
    else:
        torch.library._original_register_fake = torch.library.register_fake
        original_register_fake = torch.library.register_fake

    def patched_register_fake(name, func=None):
        if name == "torchvision::nms":
            if func is None:
                def noop_decorator(f):
                    return f
                return noop_decorator
            return func
        return original_register_fake(name, func)

    torch.library.register_fake = patched_register_fake


if os.getenv("TORCHVISION_PATCH", "0") == "1":
    apply_torchvision_patch()
