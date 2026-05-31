from __future__ import annotations

import json
import subprocess
from typing import Any


POWERSHELL_PROBE = r"""
$ErrorActionPreference = 'Stop'

Add-Type @"
using System;
using System.Runtime.InteropServices;

public static class WindowsNaturalDynDep
{
    [StructLayout(LayoutKind.Explicit)]
    public struct PACKAGE_VERSION
    {
        [FieldOffset(0)] public ulong Version;
        [FieldOffset(0)] public ushort Revision;
        [FieldOffset(2)] public ushort Build;
        [FieldOffset(4)] public ushort Minor;
        [FieldOffset(6)] public ushort Major;
    }

    [DllImport("kernelbase.dll", CharSet=CharSet.Unicode, ExactSpelling=true)]
    public static extern int TryCreatePackageDependency(
        IntPtr user,
        string packageFamilyName,
        PACKAGE_VERSION minVersion,
        uint architectures,
        uint lifetimeKind,
        string lifetimeArtifact,
        uint options,
        out IntPtr packageDependencyId);

    [DllImport("kernelbase.dll", CharSet=CharSet.Unicode, ExactSpelling=true)]
    public static extern int AddPackageDependency(
        string packageDependencyId,
        int rank,
        uint options,
        out IntPtr packageDependencyContext,
        out IntPtr packageFullName);

    [DllImport("kernelbase.dll", ExactSpelling=true)]
    public static extern void RemovePackageDependency(IntPtr packageDependencyContext);

    [DllImport("kernelbase.dll", CharSet=CharSet.Unicode, ExactSpelling=true)]
    public static extern int DeletePackageDependency(string packageDependencyId);

    [DllImport("kernel32.dll", ExactSpelling=true)]
    public static extern IntPtr LocalFree(IntPtr hMem);

    [DllImport("combase.dll", ExactSpelling=true)]
    public static extern int RoInitialize(uint initType);

    [DllImport("combase.dll", ExactSpelling=true)]
    public static extern void RoUninitialize();

    [DllImport("combase.dll", ExactSpelling=true, CharSet=CharSet.Unicode)]
    public static extern int RoActivateInstance(string activatableClassId, out IntPtr instance);

    [DllImport("combase.dll", ExactSpelling=true)]
    public static extern int RoGetActivationFactory(IntPtr activatableClassId, ref Guid iid, out IntPtr factory);

    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    public static extern IntPtr LoadLibrary(string lpFileName);

    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    public static extern IntPtr LoadLibraryEx(string lpFileName, IntPtr hFile, uint dwFlags);

    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool SetDllDirectory(string lpPathName);

    [DllImport("kernel32.dll", CharSet=CharSet.Ansi, SetLastError=true)]
    public static extern IntPtr GetProcAddress(IntPtr hModule, string procName);

    [DllImport("kernel32.dll", SetLastError=true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool FreeLibrary(IntPtr hModule);

    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
    public struct ACTCTX
    {
        public uint cbSize;
        public uint dwFlags;
        public string lpSource;
        public ushort wProcessorArchitecture;
        public ushort wLangId;
        public string lpAssemblyDirectory;
        public string lpResourceName;
        public string lpApplicationName;
        public IntPtr hModule;
    }

    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    public static extern IntPtr CreateActCtx(ref ACTCTX actctx);

    [DllImport("kernel32.dll", SetLastError=true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool ActivateActCtx(IntPtr hActCtx, out IntPtr lpCookie);

    [DllImport("kernel32.dll", SetLastError=true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool DeactivateActCtx(uint dwFlags, IntPtr lpCookie);

    [DllImport("kernel32.dll", SetLastError=true)]
    public static extern void ReleaseActCtx(IntPtr hActCtx);

    [DllImport("combase.dll", ExactSpelling=true, CharSet=CharSet.Unicode)]
    public static extern int WindowsCreateString(string sourceString, int length, out IntPtr hstring);

    [DllImport("combase.dll", ExactSpelling=true)]
    public static extern int WindowsDeleteString(IntPtr hstring);
}

[UnmanagedFunctionPointer(CallingConvention.StdCall)]
public delegate int DllGetActivationFactoryDelegate(IntPtr activatableClassId, out IntPtr factory);
"@

function Convert-HResultHex([int] $Value) {
    return ('0x{0:X8}' -f ($Value -band 0xFFFFFFFF))
}

function Invoke-PackageDependencyProbe([string] $PackageFamilyName, [string] $ActivatableClassId) {
    $version = New-Object WindowsNaturalDynDep+PACKAGE_VERSION
    $depIdPtr = [IntPtr]::Zero
    $createHr = [WindowsNaturalDynDep]::TryCreatePackageDependency(
        [IntPtr]::Zero,
        $PackageFamilyName,
        $version,
        4,
        0,
        $null,
        0,
        [ref] $depIdPtr
    )

    $packageDependencyId = $null
    if ($depIdPtr -ne [IntPtr]::Zero) {
        $packageDependencyId = [Runtime.InteropServices.Marshal]::PtrToStringUni($depIdPtr)
        [void] [WindowsNaturalDynDep]::LocalFree($depIdPtr)
    }

    $packageDependencyContext = [IntPtr]::Zero
    $resolvedFullName = $null
    $addHr = $null
    if ($packageDependencyId) {
        $packageFullNamePtr = [IntPtr]::Zero
        $addHr = [WindowsNaturalDynDep]::AddPackageDependency(
            $packageDependencyId,
            0,
            0,
            [ref] $packageDependencyContext,
            [ref] $packageFullNamePtr
        )
        if ($packageFullNamePtr -ne [IntPtr]::Zero) {
            $resolvedFullName = [Runtime.InteropServices.Marshal]::PtrToStringUni($packageFullNamePtr)
            [void] [WindowsNaturalDynDep]::LocalFree($packageFullNamePtr)
        }
    }

    $roInitHr = [WindowsNaturalDynDep]::RoInitialize(1)
    $instance = [IntPtr]::Zero
    $activateHr = [WindowsNaturalDynDep]::RoActivateInstance($ActivatableClassId, [ref] $instance)
    if ($instance -ne [IntPtr]::Zero) {
        [void] [Runtime.InteropServices.Marshal]::Release($instance)
    }
    [WindowsNaturalDynDep]::RoUninitialize()

    if ($packageDependencyContext -ne [IntPtr]::Zero) {
        [WindowsNaturalDynDep]::RemovePackageDependency($packageDependencyContext)
    }

    $deleteHr = $null
    if ($packageDependencyId) {
        $deleteHr = [WindowsNaturalDynDep]::DeletePackageDependency($packageDependencyId)
    }

    return @{
        package_family_name = $PackageFamilyName
        create_hr = (Convert-HResultHex $createHr)
        package_dependency_id = $packageDependencyId
        add_hr = if ($addHr -ne $null) { Convert-HResultHex $addHr } else { $null }
        resolved_full_name = $resolvedFullName
        ro_initialize_hr = (Convert-HResultHex $roInitHr)
        activate_class_id = $ActivatableClassId
        activate_hr = (Convert-HResultHex $activateHr)
        delete_hr = if ($deleteHr -ne $null) { Convert-HResultHex $deleteHr } else { $null }
    }
}

function Invoke-RoProbeForClass([string] $ActivatableClassId) {
    $roInitHr = [WindowsNaturalDynDep]::RoInitialize(1)

    $instance = [IntPtr]::Zero
    $activateHr = [WindowsNaturalDynDep]::RoActivateInstance($ActivatableClassId, [ref] $instance)
    if ($instance -ne [IntPtr]::Zero) {
        [void] [Runtime.InteropServices.Marshal]::Release($instance)
    }

    $factory = [IntPtr]::Zero
    $classHString = [IntPtr]::Zero
    $createStringHr = [WindowsNaturalDynDep]::WindowsCreateString(
        $ActivatableClassId,
        $ActivatableClassId.Length,
        [ref] $classHString
    )
    $factoryHr = $null
    if ($createStringHr -ge 0) {
        $activationFactoryIid = [Guid]'00000035-0000-0000-C000-000000000046'
        $factoryHr = [WindowsNaturalDynDep]::RoGetActivationFactory(
            $classHString,
            [ref] $activationFactoryIid,
            [ref] $factory
        )
        if ($factory -ne [IntPtr]::Zero) {
            [void] [Runtime.InteropServices.Marshal]::Release($factory)
        }
        [void] [WindowsNaturalDynDep]::WindowsDeleteString($classHString)
    }

    [WindowsNaturalDynDep]::RoUninitialize()

    return @{
        class_id = $ActivatableClassId
        ro_initialize_hr = Convert-HResultHex $roInitHr
        activate_hr = Convert-HResultHex $activateHr
        windows_create_string_hr = Convert-HResultHex $createStringHr
        get_activation_factory_hr = if ($factoryHr -ne $null) { Convert-HResultHex $factoryHr } else { $null }
    }
}

function Invoke-PackageDependencySetProbe([string[]] $PackageFamilyNames, [string[]] $ActivatableClassIds) {
    $contexts = @()
    $dependencyIds = @()
    $packages = @()

    try {
        foreach ($packageFamilyName in $PackageFamilyNames) {
            $version = New-Object WindowsNaturalDynDep+PACKAGE_VERSION
            $depIdPtr = [IntPtr]::Zero
            $createHr = [WindowsNaturalDynDep]::TryCreatePackageDependency(
                [IntPtr]::Zero,
                $packageFamilyName,
                $version,
                4,
                0,
                $null,
                0,
                [ref] $depIdPtr
            )

            $packageDependencyId = $null
            if ($depIdPtr -ne [IntPtr]::Zero) {
                $packageDependencyId = [Runtime.InteropServices.Marshal]::PtrToStringUni($depIdPtr)
                [void] [WindowsNaturalDynDep]::LocalFree($depIdPtr)
                $dependencyIds += $packageDependencyId
            }

            $packageDependencyContext = [IntPtr]::Zero
            $resolvedFullName = $null
            $addHr = $null
            if ($packageDependencyId) {
                $packageFullNamePtr = [IntPtr]::Zero
                $addHr = [WindowsNaturalDynDep]::AddPackageDependency(
                    $packageDependencyId,
                    0,
                    0,
                    [ref] $packageDependencyContext,
                    [ref] $packageFullNamePtr
                )
                if ($packageDependencyContext -ne [IntPtr]::Zero) {
                    $contexts += $packageDependencyContext
                }
                if ($packageFullNamePtr -ne [IntPtr]::Zero) {
                    $resolvedFullName = [Runtime.InteropServices.Marshal]::PtrToStringUni($packageFullNamePtr)
                    [void] [WindowsNaturalDynDep]::LocalFree($packageFullNamePtr)
                }
            }

            $packages += @{
                package_family_name = $packageFamilyName
                create_hr = Convert-HResultHex $createHr
                package_dependency_id = $packageDependencyId
                add_hr = if ($addHr -ne $null) { Convert-HResultHex $addHr } else { $null }
                resolved_full_name = $resolvedFullName
            }
        }

        $classes = @()
        foreach ($classId in $ActivatableClassIds) {
            $classes += Invoke-RoProbeForClass $classId
        }

        return @{
            packages = $packages
            classes = $classes
        }
    }
    finally {
        foreach ($context in $contexts) {
            if ($context -ne [IntPtr]::Zero) {
                [WindowsNaturalDynDep]::RemovePackageDependency($context)
            }
        }
        foreach ($dependencyId in $dependencyIds) {
            if ($dependencyId) {
                [void] [WindowsNaturalDynDep]::DeletePackageDependency($dependencyId)
            }
        }
    }
}

function Invoke-DirectActivationFactoryProbe(
    [string] $DllPath,
    [string] $ActivatableClassId,
    [string] $DllSearchPath,
    [string] $ActCtxManifestPath,
    [bool] $UseLoadLibraryEx
) {
    $result = @{
        dll_path = $DllPath
        activatable_class_id = $ActivatableClassId
        dll_search_path = $DllSearchPath
        actctx_manifest_path = $ActCtxManifestPath
        use_load_library_ex = $UseLoadLibraryEx
        dll_exists = Test-Path $DllPath
        load_library = $null
        get_proc_address = $null
        windows_create_string_hr = $null
        dll_get_activation_factory_hr = $null
        release_hr = $null
        set_dll_directory = $null
        actctx_create = $null
        actctx_activate = $null
        errors = @()
    }

    if (-not $result.dll_exists) {
        $result.errors += "dll_missing"
        return $result
    }

    if ($DllSearchPath) {
        $setDirOk = [WindowsNaturalDynDep]::SetDllDirectory($DllSearchPath)
        $result.set_dll_directory = $setDirOk
        if (-not $setDirOk) {
            $result.errors += ("SetDllDirectory failed: " + [Runtime.InteropServices.Marshal]::GetLastWin32Error())
        }
    }

    $actCtx = [IntPtr]::Zero
    $cookie = [IntPtr]::Zero

    if ($ActCtxManifestPath) {
        if (-not (Test-Path $ActCtxManifestPath)) {
            $result.errors += "actctx_manifest_missing"
            return $result
        }

        $act = New-Object WindowsNaturalDynDep+ACTCTX
        $act.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf([type][WindowsNaturalDynDep+ACTCTX])
        $act.lpSource = $ActCtxManifestPath
        $act.lpAssemblyDirectory = [System.IO.Path]::GetDirectoryName($ActCtxManifestPath)
        $actCtx = [WindowsNaturalDynDep]::CreateActCtx([ref] $act)
        if ($actCtx -eq [IntPtr](-1)) {
            $result.actctx_create = "failed"
            $result.errors += ("CreateActCtx failed: " + [Runtime.InteropServices.Marshal]::GetLastWin32Error())
            return $result
        }
        $result.actctx_create = "ok"

        $actOk = [WindowsNaturalDynDep]::ActivateActCtx($actCtx, [ref] $cookie)
        $result.actctx_activate = $actOk
        if (-not $actOk) {
            $result.errors += ("ActivateActCtx failed: " + [Runtime.InteropServices.Marshal]::GetLastWin32Error())
            [WindowsNaturalDynDep]::ReleaseActCtx($actCtx)
            return $result
        }
    }

    if ($UseLoadLibraryEx) {
        $module = [WindowsNaturalDynDep]::LoadLibraryEx($DllPath, [IntPtr]::Zero, 0x00000008)
    }
    else {
        $module = [WindowsNaturalDynDep]::LoadLibrary($DllPath)
    }
    if ($module -eq [IntPtr]::Zero) {
        $loaderName = if ($UseLoadLibraryEx) { "LoadLibraryEx" } else { "LoadLibrary" }
        $result.load_library = "failed"
        $result.errors += ($loaderName + " failed: " + [Runtime.InteropServices.Marshal]::GetLastWin32Error())
        if ($ActCtxManifestPath -and $cookie -ne [IntPtr]::Zero) {
            [void] [WindowsNaturalDynDep]::DeactivateActCtx(0, $cookie)
            [WindowsNaturalDynDep]::ReleaseActCtx($actCtx)
        }
        return $result
    }

    try {
        $result.load_library = "ok"
        $proc = [WindowsNaturalDynDep]::GetProcAddress($module, "DllGetActivationFactory")
        if ($proc -eq [IntPtr]::Zero) {
            $result.get_proc_address = "failed"
            $result.errors += ("GetProcAddress failed: " + [Runtime.InteropServices.Marshal]::GetLastWin32Error())
            return $result
        }

        $result.get_proc_address = "ok"
        $delegate = [Runtime.InteropServices.Marshal]::GetDelegateForFunctionPointer(
            $proc,
            [DllGetActivationFactoryDelegate]
        )

        $classHString = [IntPtr]::Zero
        $createStringHr = [WindowsNaturalDynDep]::WindowsCreateString(
            $ActivatableClassId,
            $ActivatableClassId.Length,
            [ref] $classHString
        )
        $result.windows_create_string_hr = Convert-HResultHex $createStringHr
        if ($createStringHr -lt 0) {
            $result.errors += "WindowsCreateString failed"
            return $result
        }

        try {
            $factory = [IntPtr]::Zero
            $factoryHr = $delegate.Invoke($classHString, [ref] $factory)
            $result.dll_get_activation_factory_hr = Convert-HResultHex $factoryHr
            if ($factory -ne [IntPtr]::Zero) {
                [void] [Runtime.InteropServices.Marshal]::Release($factory)
            }
        }
        finally {
            [void] [WindowsNaturalDynDep]::WindowsDeleteString($classHString)
        }
    }
    finally {
        [void] [WindowsNaturalDynDep]::FreeLibrary($module)
        if ($DllSearchPath) {
            [void] [WindowsNaturalDynDep]::SetDllDirectory($null)
        }
        if ($ActCtxManifestPath -and $cookie -ne [IntPtr]::Zero) {
            [void] [WindowsNaturalDynDep]::DeactivateActCtx(0, $cookie)
            [WindowsNaturalDynDep]::ReleaseActCtx($actCtx)
        }
    }

    return $result
}

$voicePackages = Get-AppxPackage |
    Where-Object { $_.Name -like 'MicrosoftWindows.Voice.*' -and $_.InstallLocation } |
    Select-Object Name, PackageFamilyName, PackageFullName, Version, InstallLocation

$speechPackages = Get-AppxPackage |
    Where-Object { $_.Name -in @('MicrosoftWindows.60719896.Speion', 'MicrosoftWindows.Client.Core', 'MicrosoftWindows.Client.CoreAI') } |
    Select-Object Name, PackageFamilyName, PackageFullName, Version, InstallLocation

$directFactoryProbe1 = Invoke-DirectActivationFactoryProbe `
    'C:\Windows\SystemApps\SxS\MicrosoftWindows.60719896.Speion_cw5n1h2txyewy\SpeechSynthesizerExtension.dll' `
    'SpeechSynthesizerExtension.SpeechSynthesizerExtensionImpl' `
    $null `
    $null `
    $false

$directFactoryProbe2 = Invoke-DirectActivationFactoryProbe `
    'C:\Windows\SystemApps\SxS\MicrosoftWindows.60719896.Speion_cw5n1h2txyewy\SpeechSynthesizerExtension.dll' `
    'SpeechSynthesizerExtension.SpeechSynthesizerExtensionImpl' `
    'C:\Windows\SystemApps\SxS\MicrosoftWindows.60719896.Speion_cw5n1h2txyewy\SpeechSynthesizer' `
    $null `
    $false

$directFactoryProbe3 = Invoke-DirectActivationFactoryProbe `
    'C:\Windows\SystemApps\SxS\MicrosoftWindows.60719896.Speion_cw5n1h2txyewy\SpeechSynthesizerExtension.dll' `
    'SpeechSynthesizerExtension.SpeechSynthesizerExtensionImpl' `
    'C:\Windows\SystemApps\SxS\MicrosoftWindows.60719896.Speion_cw5n1h2txyewy\SpeechSynthesizer' `
    $null `
    $true

$directFactoryProbe4 = Invoke-DirectActivationFactoryProbe `
    'C:\Windows\SystemApps\SxS\MicrosoftWindows.60719896.Speion_cw5n1h2txyewy\SpeechSynthesizerExtension.dll' `
    'SpeechSynthesizerExtension.SpeechSynthesizerExtensionImpl' `
    'C:\Windows\SystemApps\SxS\MicrosoftWindows.60719896.Speion_cw5n1h2txyewy\SpeechSynthesizer' `
    'C:\Windows\SystemApps\SxS\MicrosoftWindows.60719896.Speion_cw5n1h2txyewy\SpeechSynthesizer\SpeechSynthesizer.manifest' `
    $true

$probeResult = @{
    narrator_voice_setting = (
        Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Narrator\NoRoam' -Name 'SpeechVoice' -ErrorAction SilentlyContinue
    ).SpeechVoice
    voice_packages = $voicePackages
    speech_packages = $speechPackages
    package_graph_probe = @(
        Invoke-PackageDependencyProbe 'MicrosoftWindows.60719896.Speion_cw5n1h2txyewy' 'SpeechSynthesizerExtension.SpeechSynthesizerExtensionImpl'
        Invoke-PackageDependencyProbe 'MicrosoftWindows.Client.Core_cw5n1h2txyewy' 'SpeechSynthesizerExtension.SpeechSynthesizerExtensionImpl'
    )
    package_graph_set_probe = Invoke-PackageDependencySetProbe `
        @(
            'MicrosoftWindows.UndockedDevKit_cw5n1h2txyewy',
            'MicrosoftWindows.60719896.Speion_cw5n1h2txyewy',
            'MicrosoftWindows.Client.Core_cw5n1h2txyewy',
            'MicrosoftWindows.Client.CoreAI_cw5n1h2txyewy'
        ) `
        @(
            'WindowsUdk.ApplicationModel.AppExtensions.ExtensionFactory',
            'WindowsUdk.Speech.SpeechSynthesizerExtension',
            'SpeechSynthesizerExtension.SpeechSynthesizerExtensionImpl',
            'Windows.ApplicationModel.AppExtensions.AppExtensionCatalog'
        )
    direct_factory_probe = @($directFactoryProbe1, $directFactoryProbe2, $directFactoryProbe3, $directFactoryProbe4)
}

$probeResult | ConvertTo-Json -Depth 6 -Compress
"""


def run_probe() -> dict[str, Any]:
    result = subprocess.run(
        ["powershell", "-NoProfile", "-Command", POWERSHELL_PROBE],
        capture_output=True,
        text=True,
        check=True,
    )
    return json.loads(result.stdout)
