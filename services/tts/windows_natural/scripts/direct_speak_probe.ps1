$ErrorActionPreference = 'Stop'

Add-Type @"
using System;
using System.Runtime.InteropServices;

public static class WindowsNaturalDirectProbe
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
    public static extern int TryCreatePackageDependency(IntPtr user, string packageFamilyName, PACKAGE_VERSION minVersion, uint architectures, uint lifetimeKind, string lifetimeArtifact, uint options, out IntPtr packageDependencyId);

    [DllImport("kernelbase.dll", CharSet=CharSet.Unicode, ExactSpelling=true)]
    public static extern int AddPackageDependency(string packageDependencyId, int rank, uint options, out IntPtr packageDependencyContext, out IntPtr packageFullName);

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

    [DllImport("combase.dll", ExactSpelling=true)]
    public static extern int RoGetActivationFactory(IntPtr activatableClassId, ref Guid iid, out IntPtr factory);

    [DllImport("combase.dll", ExactSpelling=true, CharSet=CharSet.Unicode)]
    public static extern int WindowsCreateString(string sourceString, int length, out IntPtr hstring);

    [DllImport("combase.dll", ExactSpelling=true)]
    public static extern int WindowsDeleteString(IntPtr hstring);
}

[UnmanagedFunctionPointer(CallingConvention.StdCall)]
public delegate int QueryInterfaceDelegate(IntPtr self, ref Guid iid, out IntPtr obj);

[UnmanagedFunctionPointer(CallingConvention.StdCall)]
public delegate uint ReleaseDelegate(IntPtr self);

[UnmanagedFunctionPointer(CallingConvention.StdCall)]
public delegate int GetInstanceDelegate(IntPtr self, IntPtr extensionName, IntPtr className, out IntPtr result);

[UnmanagedFunctionPointer(CallingConvention.StdCall)]
public delegate int IsExtensionAvailableDelegate(IntPtr self, IntPtr extensionName, IntPtr className, out byte result);

[UnmanagedFunctionPointer(CallingConvention.StdCall)]
public delegate int GetInstanceWithOptionsDelegate(IntPtr self, IntPtr extensionName, IntPtr className, int options, out IntPtr result);

[UnmanagedFunctionPointer(CallingConvention.StdCall)]
public delegate int SelectVoiceDelegate(IntPtr self, IntPtr voiceName);

[UnmanagedFunctionPointer(CallingConvention.StdCall)]
public delegate int SpeakTextDelegate(IntPtr self, IntPtr text, out byte result);

[UnmanagedFunctionPointer(CallingConvention.StdCall)]
public delegate int GetForVoicePathsAndDeviceIdDelegate(IntPtr self, uint voicePathsSize, IntPtr voicePaths, IntPtr audioDeviceId, out IntPtr result);

[UnmanagedFunctionPointer(CallingConvention.StdCall)]
public delegate int NoArgHResultDelegate(IntPtr self);

[UnmanagedFunctionPointer(CallingConvention.StdCall)]
public delegate int IntArgHResultDelegate(IntPtr self, int value);
"@

function Format-HResult([int] $Value) {
    return '0x{0:X8}' -f ($Value -band 0xffffffff)
}

function New-HString([string] $Value) {
    $hstring = [IntPtr]::Zero
    $hr = [WindowsNaturalDirectProbe]::WindowsCreateString($Value, $Value.Length, [ref] $hstring)
    if ($hr -lt 0) {
        throw "WindowsCreateString failed for '$Value': $(Format-HResult $hr)"
    }
    return $hstring
}

function Get-VTableDelegate([IntPtr] $Object, [int] $Slot, [type] $DelegateType) {
    $vtable = [Runtime.InteropServices.Marshal]::ReadIntPtr($Object)
    $functionPointer = [Runtime.InteropServices.Marshal]::ReadIntPtr($vtable, $Slot * [IntPtr]::Size)
    return [Runtime.InteropServices.Marshal]::GetDelegateForFunctionPointer($functionPointer, $DelegateType)
}

function Invoke-SpeechSynthesizer([IntPtr] $SpeechSynthesizer) {
    $selectVoice = Get-VTableDelegate $SpeechSynthesizer 6 ([SelectVoiceDelegate])
    $speakText = Get-VTableDelegate $SpeechSynthesizer 9 ([SpeakTextDelegate])

    foreach ($voiceName in @(
        'Microsoft Ryan (Natural) - English (United Kingdom)',
        'TTS_MS_en-GB_RyanNeural_11.0',
        'Microsoft Server Speech Text to Speech Voice (en-GB, RyanNeural)'
    )) {
        $voiceHString = New-HString $voiceName
        $selectHr = $selectVoice.Invoke($SpeechSynthesizer, $voiceHString)
        [void] [WindowsNaturalDirectProbe]::WindowsDeleteString($voiceHString)
        Write-Host "SelectVoice '$voiceName' $(Format-HResult $selectHr)"
        if ($selectHr -ge 0) {
            break
        }
    }

    $textHString = New-HString 'Ryan direct script test.'
    $speakResult = [byte] 0
    $speakHr = $speakText.Invoke($SpeechSynthesizer, $textHString, [ref] $speakResult)
    [void] [WindowsNaturalDirectProbe]::WindowsDeleteString($textHString)
    Write-Host "SpeakText $(Format-HResult $speakHr) result=$speakResult"
    Start-Sleep -Seconds 5
}

$contexts = @()
$dependencyIds = @()
$roInitialized = $false

try {
    foreach ($packageFamilyName in @(
        'MicrosoftWindows.60719896.Speion_cw5n1h2txyewy',
        'MicrosoftWindows.Client.Core_cw5n1h2txyewy',
        'MicrosoftWindows.Client.CoreAI_cw5n1h2txyewy'
    )) {
        $version = New-Object WindowsNaturalDirectProbe+PACKAGE_VERSION
        $dependencyIdPointer = [IntPtr]::Zero
        $createHr = [WindowsNaturalDirectProbe]::TryCreatePackageDependency(
            [IntPtr]::Zero,
            $packageFamilyName,
            $version,
            4,
            0,
            $null,
            0,
            [ref] $dependencyIdPointer
        )
        Write-Host "TryCreatePackageDependency $packageFamilyName $(Format-HResult $createHr)"

        if ($dependencyIdPointer -eq [IntPtr]::Zero) {
            continue
        }

        $dependencyId = [Runtime.InteropServices.Marshal]::PtrToStringUni($dependencyIdPointer)
        [void] [WindowsNaturalDirectProbe]::LocalFree($dependencyIdPointer)
        $dependencyIds += $dependencyId

        $context = [IntPtr]::Zero
        $fullNamePointer = [IntPtr]::Zero
        $addHr = [WindowsNaturalDirectProbe]::AddPackageDependency($dependencyId, 0, 0, [ref] $context, [ref] $fullNamePointer)
        $fullName = if ($fullNamePointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::PtrToStringUni($fullNamePointer) } else { $null }
        if ($fullNamePointer -ne [IntPtr]::Zero) {
            [void] [WindowsNaturalDirectProbe]::LocalFree($fullNamePointer)
        }
        if ($context -ne [IntPtr]::Zero) {
            $contexts += $context
        }
        Write-Host "AddPackageDependency $packageFamilyName $(Format-HResult $addHr) $fullName"
    }

    $roHr = [WindowsNaturalDirectProbe]::RoInitialize(1)
    $roInitialized = $true
    Write-Host "RoInitialize $(Format-HResult $roHr)"

    $appExtensionClass = New-HString 'WindowsUdk.ApplicationModel.AppExtensions.AppExtension'
    $appExtensionStaticsIid = [Guid] '150A3C23-A709-5FA0-96E2-40620654AE81'
    $appExtensionStatics = [IntPtr]::Zero
    $appExtensionStaticsHr = [WindowsNaturalDirectProbe]::RoGetActivationFactory(
        $appExtensionClass,
        [ref] $appExtensionStaticsIid,
        [ref] $appExtensionStatics
    )
    [void] [WindowsNaturalDirectProbe]::WindowsDeleteString($appExtensionClass)
    Write-Host "RoGetActivationFactory AppExtension/IAppExtensionStatics $(Format-HResult $appExtensionStaticsHr) $appExtensionStatics"
    if ($appExtensionStaticsHr -ge 0 -and $appExtensionStatics -ne [IntPtr]::Zero) {
        $addUdk = Get-VTableDelegate $appExtensionStatics 6 ([NoArgHResultDelegate])
        $addExtensions = Get-VTableDelegate $appExtensionStatics 7 ([NoArgHResultDelegate])
        $addExtensionsWithOptions = Get-VTableDelegate $appExtensionStatics 8 ([IntArgHResultDelegate])
        Write-Host "AppExtension.AddUdkPackageToProcessPackageGraph $(Format-HResult ($addUdk.Invoke($appExtensionStatics)))"
        Write-Host "AppExtension.AddExtensionPackagesToProcessPackageGraph $(Format-HResult ($addExtensions.Invoke($appExtensionStatics)))"
        Write-Host "AppExtension.AddExtensionPackagesToProcessPackageGraphWithOptions $(Format-HResult ($addExtensionsWithOptions.Invoke($appExtensionStatics, 0x59)))"

        $queryAppExtension = Get-VTableDelegate $appExtensionStatics 0 ([QueryInterfaceDelegate])
        $appExtensionStatics2Iid = [Guid] '9F506EC0-08C1-5C39-A439-A9F4150DA1AB'
        $appExtensionStatics2 = [IntPtr]::Zero
        $appExtensionStatics2Hr = $queryAppExtension.Invoke($appExtensionStatics, [ref] $appExtensionStatics2Iid, [ref] $appExtensionStatics2)
        Write-Host "QueryInterface IAppExtensionStatics2 $(Format-HResult $appExtensionStatics2Hr) $appExtensionStatics2"
        if ($appExtensionStatics2Hr -ge 0 -and $appExtensionStatics2 -ne [IntPtr]::Zero) {
            $addKnownPackage = Get-VTableDelegate $appExtensionStatics2 6 ([IntArgHResultDelegate])
            foreach ($knownPackage in @(0, 6, 7, 8, 9)) {
                Write-Host "AppExtension.AddKnownPackageToProcessPackageGraph $knownPackage $(Format-HResult ($addKnownPackage.Invoke($appExtensionStatics2, $knownPackage)))"
            }
            [void] (Get-VTableDelegate $appExtensionStatics2 2 ([ReleaseDelegate])).Invoke($appExtensionStatics2)
        }
        [void] (Get-VTableDelegate $appExtensionStatics 2 ([ReleaseDelegate])).Invoke($appExtensionStatics)
    }

    $factoryClass = New-HString 'WindowsUdk.ApplicationModel.AppExtensions.ExtensionFactory'
    $extensionFactoryStaticsIid = [Guid] '836DA1ED-5BE8-5365-8452-6AF327AA427B'
    $extensionFactoryStatics = [IntPtr]::Zero
    $factoryHr = [WindowsNaturalDirectProbe]::RoGetActivationFactory(
        $factoryClass,
        [ref] $extensionFactoryStaticsIid,
        [ref] $extensionFactoryStatics
    )
    [void] [WindowsNaturalDirectProbe]::WindowsDeleteString($factoryClass)
    Write-Host "RoGetActivationFactory ExtensionFactory/IExtensionFactoryStatics $(Format-HResult $factoryHr) $extensionFactoryStatics"
    if ($factoryHr -lt 0) {
        throw "ExtensionFactory activation failed"
    }

    $classNameText = 'SpeechSynthesizerExtension.SpeechSynthesizerExtensionImpl'
    $isAvailable = Get-VTableDelegate $extensionFactoryStatics 6 ([IsExtensionAvailableDelegate])

    $extensionObject = [IntPtr]::Zero
    foreach ($extensionNameText in @(
        'SpeechSynthesizerExtension',
        'com.microsoft.windows.extensionpackage',
        'Global.SpeechSynthesizerExtension',
        'MicrosoftWindows.60719896.Speion'
    )) {
        $extensionName = New-HString $extensionNameText
        $className = New-HString $classNameText
        $available = [byte] 0
        $isAvailableHr = $isAvailable.Invoke($extensionFactoryStatics, $extensionName, $className, [ref] $available)
        Write-Host "ExtensionFactory.IsExtensionAvailable '$extensionNameText' $(Format-HResult $isAvailableHr) result=$available"
        [void] [WindowsNaturalDirectProbe]::WindowsDeleteString($extensionName)
        [void] [WindowsNaturalDirectProbe]::WindowsDeleteString($className)

        foreach ($candidate in @(
            @{ slot = 8; name = 'GetInstance'; options = $null },
            @{ slot = 9; name = 'GetInstanceWithOptions:AllowMicrosoft+DoNotUseCache+AllowRetail+AllowDocked'; options = 0x59 },
            @{ slot = 10; name = 'GetFactory'; options = $null },
            @{ slot = 11; name = 'GetFactoryWithOptions:AllowMicrosoft+DoNotUseCache+AllowRetail+AllowDocked'; options = 0x59 }
        )) {
            $extensionName = New-HString $extensionNameText
            $className = New-HString $classNameText
            if ($candidate.options -eq $null) {
                $method = Get-VTableDelegate $extensionFactoryStatics $candidate.slot ([GetInstanceDelegate])
                $getInstanceHr = $method.Invoke($extensionFactoryStatics, $extensionName, $className, [ref] $extensionObject)
            }
            else {
                $method = Get-VTableDelegate $extensionFactoryStatics $candidate.slot ([GetInstanceWithOptionsDelegate])
                $getInstanceHr = $method.Invoke($extensionFactoryStatics, $extensionName, $className, [int] $candidate.options, [ref] $extensionObject)
            }
            [void] [WindowsNaturalDirectProbe]::WindowsDeleteString($extensionName)
            [void] [WindowsNaturalDirectProbe]::WindowsDeleteString($className)
            Write-Host "ExtensionFactory.$($candidate.name) extension='$extensionNameText' slot=$($candidate.slot) $(Format-HResult $getInstanceHr) $extensionObject"
            if ($getInstanceHr -ge 0 -and $extensionObject -ne [IntPtr]::Zero) {
                break
            }
        }
        if ($extensionObject -ne [IntPtr]::Zero) {
            break
        }
    }
    if ($extensionObject -ne [IntPtr]::Zero) {
        $queryInterface = Get-VTableDelegate $extensionObject 0 ([QueryInterfaceDelegate])
        $speechSynthesizerExtensionIid = [Guid] '9BCE424E-5D0E-5A50-B770-F246CF3F5640'
        $speechSynthesizer = [IntPtr]::Zero
        $queryHr = $queryInterface.Invoke($extensionObject, [ref] $speechSynthesizerExtensionIid, [ref] $speechSynthesizer)
        Write-Host "QueryInterface ISpeechSynthesizerExtension $(Format-HResult $queryHr) $speechSynthesizer"
        if ($queryHr -ge 0 -and $speechSynthesizer -ne [IntPtr]::Zero) {
            Invoke-SpeechSynthesizer $speechSynthesizer
            [void] (Get-VTableDelegate $speechSynthesizer 2 ([ReleaseDelegate])).Invoke($speechSynthesizer)
        }
        [void] (Get-VTableDelegate $extensionObject 2 ([ReleaseDelegate])).Invoke($extensionObject)
    }

    $speechStaticsIid = [Guid] 'B0EE6BF6-E804-5DD8-A5F1-8FA934DC7B06'
    $speechStatics = [IntPtr]::Zero
    foreach ($speechClassName in @(
        'WindowsUdk.Speech.SpeechSynthesizerExtension',
        'SpeechSynthesizerExtension.SpeechSynthesizerExtensionImpl'
    )) {
        $speechClass = New-HString $speechClassName
        $speechStaticsHr = [WindowsNaturalDirectProbe]::RoGetActivationFactory(
            $speechClass,
            [ref] $speechStaticsIid,
            [ref] $speechStatics
        )
        [void] [WindowsNaturalDirectProbe]::WindowsDeleteString($speechClass)
        Write-Host "RoGetActivationFactory $speechClassName/ISpeechSynthesizerExtensionStatics $(Format-HResult $speechStaticsHr) $speechStatics"
        if ($speechStaticsHr -ge 0 -and $speechStatics -ne [IntPtr]::Zero) {
            break
        }
    }
    if ($speechStaticsHr -ge 0 -and $speechStatics -ne [IntPtr]::Zero) {
        $getForVoicePaths = Get-VTableDelegate $speechStatics 6 ([GetForVoicePathsAndDeviceIdDelegate])
        $ryanPackage = Get-AppxPackage MicrosoftWindows.Voice.en-GB.Ryan.1
        $voicePathHString = New-HString $ryanPackage.InstallLocation
        $voicePathArray = [Runtime.InteropServices.Marshal]::AllocHGlobal([IntPtr]::Size)
        [Runtime.InteropServices.Marshal]::WriteIntPtr($voicePathArray, $voicePathHString)
        $audioDeviceId = New-HString ''
        $speechSynthesizerFromPaths = [IntPtr]::Zero
        $getForVoicePathsHr = $getForVoicePaths.Invoke($speechStatics, 1, $voicePathArray, $audioDeviceId, [ref] $speechSynthesizerFromPaths)
        [void] [WindowsNaturalDirectProbe]::WindowsDeleteString($audioDeviceId)
        [void] [WindowsNaturalDirectProbe]::WindowsDeleteString($voicePathHString)
        [Runtime.InteropServices.Marshal]::FreeHGlobal($voicePathArray)
        Write-Host "GetForVoicePathsAndDeviceId Ryan $(Format-HResult $getForVoicePathsHr) $speechSynthesizerFromPaths"
        if ($getForVoicePathsHr -ge 0 -and $speechSynthesizerFromPaths -ne [IntPtr]::Zero) {
            Invoke-SpeechSynthesizer $speechSynthesizerFromPaths
            [void] (Get-VTableDelegate $speechSynthesizerFromPaths 2 ([ReleaseDelegate])).Invoke($speechSynthesizerFromPaths)
        }
        [void] (Get-VTableDelegate $speechStatics 2 ([ReleaseDelegate])).Invoke($speechStatics)
    }

    [void] (Get-VTableDelegate $extensionFactoryStatics 2 ([ReleaseDelegate])).Invoke($extensionFactoryStatics)
}
finally {
    if ($roInitialized) {
        [WindowsNaturalDirectProbe]::RoUninitialize()
    }
    foreach ($context in $contexts) {
        [WindowsNaturalDirectProbe]::RemovePackageDependency($context)
    }
    foreach ($dependencyId in $dependencyIds) {
        [void] [WindowsNaturalDirectProbe]::DeletePackageDependency($dependencyId)
    }
}
