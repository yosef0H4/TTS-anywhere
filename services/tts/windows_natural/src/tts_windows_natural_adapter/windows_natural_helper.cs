using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Threading;
using System.Web.Script.Serialization;
using System.Xml.Linq;
using Microsoft.CognitiveServices.Speech;
using Microsoft.CognitiveServices.Speech.Audio;
using NAudio.CoreAudioApi;
using NAudio.Wave;

namespace WindowsNaturalHelper
{
    public sealed class VoiceRecord
    {
        public string id { get; set; }
        public string name { get; set; }
        public string language { get; set; }
        public string gender { get; set; }
        public string source { get; set; }
        public string path { get; set; }
        public string backend { get; set; }
        public string compatibilityMode { get; set; }
        public bool compatible { get; set; }
        public string error { get; set; }
        public string packageVersion { get; set; }
    }

    internal static class Program
    {
        private const string HelperVersion = "0.2.0";
        private const int PackageArchitectureX64 = 4;
        private const int CaptureSampleRate = 44100;
        private const int CaptureChannels = 2;
        private static readonly Guid IInspectableGuid = new Guid("AF86E2E0-B12D-4C6A-9C5A-D7AA65101E90");
        private static readonly Guid IExtensionFactoryStaticsGuid = new Guid("836DA1ED-5BE8-5365-8452-6AF327AA427B");
        private static readonly Guid IAppExtensionStaticsGuid = new Guid("150A3C23-A709-5FA0-96E2-40620654AE81");
        private static readonly Guid IAppExtensionStatics2Guid = new Guid("9F506EC0-08C1-5C39-A439-A9F4150DA1AB");
        private static readonly Guid ISpeechSynthesizerExtensionGuid = new Guid("9BCE424E-5D0E-5A50-B770-F246CF3F5640");
        private static readonly Guid ISpeechSynthesizerExtensionStaticsGuid = new Guid("B0EE6BF6-E804-5DD8-A5F1-8FA934DC7B06");
        private static readonly string[] SpeechPackageFamilies =
        {
            "MicrosoftWindows.60719896.Speion_cw5n1h2txyewy",
            "MicrosoftWindows.Client.Core_cw5n1h2txyewy",
            "MicrosoftWindows.Client.CoreAI_cw5n1h2txyewy",
        };
        private static readonly string[] SpeechSynthesizerExtensionCandidates =
        {
            @"C:\Windows\SystemApps\MicrosoftWindows.Client.Core_cw5n1h2txyewy\SpeechSynthesizerExtension.dll",
            @"C:\Windows\SystemApps\MicrosoftWindows.Client.CoreAI_cw5n1h2txyewy\SpeechSynthesizerExtension.dll",
            @"C:\Windows\SystemApps\MicrosoftWindows.60719896.Speion_cw5n1h2txyewy\SpeechSynthesizerExtension.dll",
        };

        public static int Main(string[] args)
        {
            try
            {
                if (args.Length == 0)
                {
                    Console.Error.WriteLine("missing command");
                    return 2;
                }

                var command = args[0];
                if (string.Equals(command, "list-voices", StringComparison.OrdinalIgnoreCase))
                {
                    return ListVoices(args.Skip(1).ToArray());
                }
                if (string.Equals(command, "synthesize", StringComparison.OrdinalIgnoreCase))
                {
                    return Synthesize(args.Skip(1).ToArray());
                }
                if (string.Equals(command, "list-render-devices", StringComparison.OrdinalIgnoreCase))
                {
                    return ListRenderDevices();
                }

                Console.Error.WriteLine("unsupported command");
                return 2;
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine(ex.ToString());
                return 1;
            }
        }

        private static int ListVoices(string[] args)
        {
            var roots = new List<string>();
            var probe = false;
            for (var i = 0; i < args.Length; i++)
            {
                if (args[i] == "--voice-root" && i + 1 < args.Length)
                {
                    roots.Add(args[++i]);
                }
                else if (args[i] == "--probe-synthesis")
                {
                    probe = true;
                }
            }

            var voices = new List<VoiceRecord>();
            foreach (var root in roots)
            {
                if (!Directory.Exists(root))
                {
                    continue;
                }
                voices.AddRange(LoadVoices(root, probe));
            }

            var serializer = new JavaScriptSerializer();
            Console.WriteLine(serializer.Serialize(new Dictionary<string, object>
            {
                { "helper_version", HelperVersion },
                { "voices", voices }
            }));
            return 0;
        }

        private static int Synthesize(string[] args)
        {
            string voiceId = null;
            string text = null;
            string textFile = null;
            string outPath = null;
            var roots = new List<string>();
            for (var i = 0; i < args.Length; i++)
            {
                if (args[i] == "--voice-id" && i + 1 < args.Length)
                {
                    voiceId = args[++i];
                }
                else if (args[i] == "--text" && i + 1 < args.Length)
                {
                    text = args[++i];
                }
                else if (args[i] == "--text-file" && i + 1 < args.Length)
                {
                    textFile = args[++i];
                }
                else if (args[i] == "--out" && i + 1 < args.Length)
                {
                    outPath = args[++i];
                }
                else if (args[i] == "--voice-root" && i + 1 < args.Length)
                {
                    roots.Add(args[++i]);
                }
            }

            if (!string.IsNullOrWhiteSpace(textFile))
            {
                text = File.ReadAllText(textFile);
            }

            if (string.IsNullOrWhiteSpace(voiceId) || string.IsNullOrWhiteSpace(text) || string.IsNullOrWhiteSpace(outPath))
            {
                Console.Error.WriteLine("missing required synthesis args");
                return 2;
            }

            string lastError = "voice not found";
            foreach (var root in roots)
            {
                foreach (var voice in LoadVoices(root, false))
                {
                    if (!string.Equals(voice.id, voiceId, StringComparison.Ordinal))
                    {
                        continue;
                    }
                    try
                    {
                        RunSynthesis(root, voice, text, outPath);
                        return 0;
                    }
                    catch (Exception ex)
                    {
                        lastError = ex.Message;
                    }
                }
            }

            Console.Error.WriteLine(lastError);
            return 1;
        }

        private static int SpeakDirect(string[] args)
        {
            string voiceId = null;
            string text = null;
            string renderDeviceId = null;
            var muteRender = false;
            var delayMs = 0;
            var roots = new List<string>();
            for (var i = 0; i < args.Length; i++)
            {
                if (args[i] == "--voice-id" && i + 1 < args.Length)
                {
                    voiceId = args[++i];
                }
                else if (args[i] == "--text" && i + 1 < args.Length)
                {
                    text = args[++i];
                }
                else if (args[i] == "--voice-root" && i + 1 < args.Length)
                {
                    roots.Add(args[++i]);
                }
                else if (args[i] == "--render-device-id" && i + 1 < args.Length)
                {
                    renderDeviceId = args[++i];
                }
                else if (args[i] == "--mute-render")
                {
                    muteRender = true;
                }
                else if (args[i] == "--delay-ms" && i + 1 < args.Length)
                {
                    int.TryParse(args[++i], out delayMs);
                }
            }

            if (string.IsNullOrWhiteSpace(voiceId) || string.IsNullOrWhiteSpace(text))
            {
                Console.Error.WriteLine("missing required speak-direct args");
                return 2;
            }

            string lastError = "voice not found";
            foreach (var root in roots)
            {
                foreach (var voice in LoadVoices(root, false))
                {
                    if (!string.Equals(voice.id, voiceId, StringComparison.Ordinal))
                    {
                        continue;
                    }
                    try
                    {
                        if (delayMs > 0)
                        {
                            Thread.Sleep(delayMs);
                        }
                        RunInstalledSpeechDirect(root, voice.name, text, renderDeviceId ?? string.Empty, muteRender);
                        return 0;
                    }
                    catch (Exception ex)
                    {
                        lastError = ex.Message;
                    }
                }
            }

            Console.Error.WriteLine(lastError);
            return 1;
        }

        private static int ListRenderDevices()
        {
            var devices = new List<Dictionary<string, object>>();
            using (var enumerator = new MMDeviceEnumerator())
            {
                foreach (var state in new[] { DeviceState.Active, DeviceState.Disabled, DeviceState.NotPresent, DeviceState.Unplugged })
                {
                    foreach (var device in enumerator.EnumerateAudioEndPoints(DataFlow.Render, state))
                    {
                        devices.Add(new Dictionary<string, object>
                        {
                            { "id", device.ID },
                            { "friendly_name", device.FriendlyName },
                            { "state", state.ToString() }
                        });
                    }
                }
            }

            var serializer = new JavaScriptSerializer();
            Console.WriteLine(serializer.Serialize(new Dictionary<string, object>
            {
                { "devices", devices }
            }));
            return 0;
        }

        private static List<VoiceRecord> LoadVoices(string root, bool probe)
        {
            if (IsInstalledAppxVoiceRoot(root))
            {
                return LoadInstalledVoices(root, probe);
            }
            return LoadLegacyEmbeddedVoices(root, probe);
        }

        private static List<VoiceRecord> LoadInstalledVoices(string root, bool probe)
        {
            var records = new List<VoiceRecord>();
            var tokensPath = Path.Combine(root, "Tokens.xml");
            if (!File.Exists(tokensPath))
            {
                return records;
            }

            var document = XDocument.Load(tokensPath);
            foreach (var token in document.Descendants().Where(x => x.Name.LocalName == "Token"))
            {
                var displayName = token.Elements().FirstOrDefault(x => x.Name.LocalName == "String" && string.IsNullOrEmpty((string)x.Attribute("name")));
                var gender = token.Elements().FirstOrDefault(x => x.Name.LocalName == "Attribute" && (string)x.Attribute("name") == "Gender");
                var language = token.Elements().FirstOrDefault(x => x.Name.LocalName == "Attribute" && (string)x.Attribute("name") == "Language");
                var voiceType = token.Elements().FirstOrDefault(x => x.Name.LocalName == "Attribute" && (string)x.Attribute("name") == "VoiceType");

                var voiceTypeValue = voiceType == null || voiceType.Attribute("value") == null
                    ? null
                    : voiceType.Attribute("value").Value;
                if (!string.Equals(voiceTypeValue, "Neural", StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                var name = displayName != null && displayName.Attribute("value") != null
                    ? displayName.Attribute("value").Value
                    : "";
                var languageValue = language != null && language.Attribute("value") != null
                    ? language.Attribute("value").Value
                    : "";
                var locale = HexLanguageToLocale(languageValue);
                var record = new VoiceRecord
                {
                    id = BuildVoiceId(name, locale),
                    name = name,
                    language = locale,
                    gender = gender != null && gender.Attribute("value") != null ? gender.Attribute("value").Value : "",
                    source = "narrator_local",
                    path = root,
                    backend = "installed-appx-current",
                    compatibilityMode = "direct_embedded_system_runtime",
                    compatible = true,
                    error = "",
                    packageVersion = ReadPackageVersion(root)
                };

                if (probe)
                {
                    try
                    {
                        ProbeInstalledVoice(root, record.name);
                    }
                    catch (Exception ex)
                    {
                        record.compatible = false;
                        record.error = ex.Message;
                        record.compatibilityMode = "direct_embedded_system_runtime_failed";
                    }
                }

                records.Add(record);
            }

            return records;
        }

        private static List<VoiceRecord> LoadLegacyEmbeddedVoices(string root, bool probe)
        {
            var records = new List<VoiceRecord>();
            var cfg = EmbeddedSpeechConfig.FromPaths(new[] { root });
            using (var synth = new SpeechSynthesizer(cfg, null))
            {
                var voicesResult = synth.GetVoicesAsync().Result;
                if (voicesResult.Reason != ResultReason.VoicesListRetrieved)
                {
                    return records;
                }

                foreach (var voice in voicesResult.Voices)
                {
                    var record = new VoiceRecord
                    {
                        id = BuildVoiceId(voice.Name, voice.Locale),
                        name = voice.Name,
                        language = voice.Locale,
                        gender = voice.Gender.ToString(),
                        source = "narrator_local",
                        path = root,
                        backend = "embedded-legacy-key",
                        compatibilityMode = "embedded_legacy_key",
                        compatible = true,
                        error = "",
                        packageVersion = ReadPackageVersion(root)
                    };

                    if (probe)
                    {
                        try
                        {
                            ProbeLegacyVoice(root, voice.Name);
                        }
                        catch (Exception ex)
                        {
                            record.compatible = false;
                            record.error = ex.Message;
                            record.compatibilityMode = "embedded_legacy_key_failed";
                        }
                    }

                    records.Add(record);
                }
            }

            return records;
        }

        private static void ProbeInstalledVoice(string root, string voiceName)
        {
            var tempFile = Path.Combine(Path.GetTempPath(), "windows-natural-probe-" + Guid.NewGuid().ToString("N") + ".wav");
            try
            {
                RunInstalledSynthesis(root, voiceName, "probe", tempFile);
                var fileInfo = new FileInfo(tempFile);
                if (!fileInfo.Exists || fileInfo.Length < 1024)
                {
                    throw new InvalidOperationException("Direct synthesis probe produced no audio.");
                }
            }
            finally
            {
                if (File.Exists(tempFile))
                {
                    File.Delete(tempFile);
                }
            }
        }

        private static void ProbeLegacyVoice(string root, string voiceName)
        {
            var tempFile = Path.Combine(Path.GetTempPath(), "windows-natural-probe-" + Guid.NewGuid().ToString("N") + ".wav");
            try
            {
                RunLegacySynthesis(root, voiceName, "probe", tempFile);
            }
            finally
            {
                if (File.Exists(tempFile))
                {
                    File.Delete(tempFile);
                }
            }
        }

        private static void RunSynthesis(string root, VoiceRecord voice, string text, string outPath)
        {
            if (string.Equals(voice.backend, "installed-appx-current", StringComparison.Ordinal))
            {
                RunInstalledSynthesis(root, voice.name, text, outPath);
                return;
            }

            RunLegacySynthesis(root, voice.name, text, outPath);
        }

        private static void RunInstalledSynthesis(string root, string voiceName, string text, string outPath)
        {
            using (WindowsUdkSpeech.Create())
            {
                RunSpeechSdkSynthesis(root, voiceName, text, outPath, ExtractInstalledAppxLicense());
            }
        }

        private static string ExtractInstalledAppxLicense()
        {
            foreach (var candidate in SpeechSynthesizerExtensionCandidates)
            {
                if (!File.Exists(candidate))
                {
                    continue;
                }

                var license = ExtractInstalledAppxLicenseFromBinary(candidate);
                if (!string.IsNullOrWhiteSpace(license))
                {
                    return license;
                }
            }

            throw new InvalidOperationException("Could not extract installed natural voice license from SpeechSynthesizerExtension.dll.");
        }

        private static string ExtractInstalledAppxLicenseFromBinary(string path)
        {
            var bytes = File.ReadAllBytes(path);
            var license = ExtractContainingNullTerminatedString(bytes, System.Text.Encoding.UTF8.GetBytes("2774316"), System.Text.Encoding.UTF8, 1);
            if (!string.IsNullOrWhiteSpace(license))
            {
                return license;
            }

            return ExtractContainingNullTerminatedString(bytes, System.Text.Encoding.Unicode.GetBytes("2774316"), System.Text.Encoding.Unicode, 2);
        }

        private static string ExtractLegacyKey()
        {
            foreach (var candidate in SpeechSynthesizerExtensionCandidates)
            {
                if (!File.Exists(candidate))
                {
                    continue;
                }

                var key = ExtractLegacyKeyFromBinary(candidate);
                if (!string.IsNullOrWhiteSpace(key))
                {
                    return key;
                }
            }

            throw new InvalidOperationException("Could not extract legacy embedded voice key from SpeechSynthesizerExtension.dll.");
        }

        private static string ExtractLegacyKeyFromBinary(string path)
        {
            var bytes = File.ReadAllBytes(path);
            var key = ExtractPrefixedNullTerminatedString(bytes, System.Text.Encoding.UTF8.GetBytes("Key:"), System.Text.Encoding.UTF8, 1);
            if (!string.IsNullOrWhiteSpace(key))
            {
                return key;
            }

            return ExtractPrefixedNullTerminatedString(bytes, System.Text.Encoding.Unicode.GetBytes("Key:"), System.Text.Encoding.Unicode, 2);
        }

        private static string ExtractContainingNullTerminatedString(byte[] bytes, byte[] markerBytes, System.Text.Encoding encoding, int terminatorWidth)
        {
            var markerIndex = IndexOf(bytes, markerBytes);
            if (markerIndex < 0)
            {
                return null;
            }

            var start = markerIndex;
            while (start - terminatorWidth >= 0 && !IsTerminatorAt(bytes, start - terminatorWidth, terminatorWidth))
            {
                start -= terminatorWidth;
            }

            var end = markerIndex + markerBytes.Length;
            while (end + terminatorWidth - 1 < bytes.Length)
            {
                if (IsTerminatorAt(bytes, end, terminatorWidth))
                {
                    break;
                }
                end += terminatorWidth;
            }

            if (end <= start)
            {
                return null;
            }

            return encoding.GetString(bytes, start, end - start);
        }

        private static string ExtractPrefixedNullTerminatedString(byte[] bytes, byte[] prefixBytes, System.Text.Encoding encoding, int terminatorWidth)
        {
            var start = IndexOf(bytes, prefixBytes);
            if (start < 0)
            {
                return null;
            }

            var end = start + prefixBytes.Length;
            while (end + terminatorWidth - 1 < bytes.Length)
            {
                if (IsTerminatorAt(bytes, end, terminatorWidth))
                {
                    break;
                }
                end += terminatorWidth;
            }

            if (end <= start)
            {
                return null;
            }

            return encoding.GetString(bytes, start, end - start);
        }

        private static bool IsTerminatorAt(byte[] bytes, int index, int width)
        {
            if (index < 0 || index + width > bytes.Length)
            {
                return true;
            }

            for (var offset = 0; offset < width; offset++)
            {
                if (bytes[index + offset] != 0)
                {
                    return false;
                }
            }
            return true;
        }

        private static int IndexOf(byte[] haystack, byte[] needle)
        {
            if (needle.Length == 0 || haystack.Length < needle.Length)
            {
                return -1;
            }

            for (var index = 0; index <= haystack.Length - needle.Length; index++)
            {
                var matched = true;
                for (var needleIndex = 0; needleIndex < needle.Length; needleIndex++)
                {
                    if (haystack[index + needleIndex] != needle[needleIndex])
                    {
                        matched = false;
                        break;
                    }
                }
                if (matched)
                {
                    return index;
                }
            }

            return -1;
        }

        private static void RunInstalledSpeechDirect(string root, string voiceName, string text, string renderDeviceId, bool muteRender)
        {
            using (var selectedDevice = OpenRenderDevice(renderDeviceId))
            using (var muteScope = muteRender ? RenderMuteScope.Create(selectedDevice) : null)
            using (var activation = WindowsUdkSpeech.Create())
            using (var speaker = activation.CreateForVoiceRoot(root, renderDeviceId))
            {
                speaker.SelectVoice(voiceName);
                var spoken = speaker.SpeakText(text);
                if (!spoken)
                {
                    throw new InvalidOperationException("Direct speech synthesis returned false.");
                }
            }
        }

        private static bool IsTruthy(string value)
        {
            if (string.IsNullOrWhiteSpace(value))
            {
                return false;
            }
            var normalized = value.Trim().ToLowerInvariant();
            return normalized == "1" || normalized == "true" || normalized == "yes" || normalized == "on";
        }

        private static MMDevice OpenRenderDevice(string renderDeviceId)
        {
            if (string.IsNullOrWhiteSpace(renderDeviceId))
            {
                return null;
            }

            var enumerator = new MMDeviceEnumerator();
            return enumerator.GetDevice(renderDeviceId);
        }

        private sealed class RenderMuteScope : IDisposable
        {
            private readonly MMDevice device;
            private readonly bool originalMute;
            private bool disposed;

            private RenderMuteScope(MMDevice device)
            {
                this.device = device;
                originalMute = device.AudioEndpointVolume.Mute;
                device.AudioEndpointVolume.Mute = true;
            }

            public static RenderMuteScope Create(MMDevice selectedDevice)
            {
                var device = selectedDevice;
                if (device == null)
                {
                    var enumerator = new MMDeviceEnumerator();
                    device = enumerator.GetDefaultAudioEndpoint(DataFlow.Render, Role.Multimedia);
                }
                return new RenderMuteScope(device);
            }

            public void Dispose()
            {
                if (disposed)
                {
                    return;
                }
                disposed = true;
                device.AudioEndpointVolume.Mute = originalMute;
                device.Dispose();
            }
        }

        private static void ConvertWaveToPcm16(string inputPath, string outPath)
        {
            using (var input = new FileStream(inputPath, FileMode.Open, FileAccess.Read, FileShare.Read))
            using (var reader = new BinaryReader(input))
            using (var output = new FileStream(outPath, FileMode.Create, FileAccess.Write, FileShare.None))
            using (var writer = new BinaryWriter(output))
            {
                var riff = new string(reader.ReadChars(4));
                if (riff != "RIFF")
                {
                    throw new InvalidOperationException("Invalid WAV header.");
                }

                reader.ReadInt32();
                var wave = new string(reader.ReadChars(4));
                if (wave != "WAVE")
                {
                    throw new InvalidOperationException("Invalid WAV type.");
                }

                short audioFormat = 0;
                short channels = 0;
                int sampleRate = 0;
                short bitsPerSample = 0;
                byte[] dataChunk = null;

                while (reader.BaseStream.Position + 8 <= reader.BaseStream.Length)
                {
                    var chunkId = new string(reader.ReadChars(4));
                    var chunkSize = reader.ReadInt32();
                    if (chunkSize < 0 || reader.BaseStream.Position + chunkSize > reader.BaseStream.Length)
                    {
                        throw new InvalidOperationException("Invalid WAV chunk size.");
                    }

                    if (chunkId == "fmt ")
                    {
                        audioFormat = reader.ReadInt16();
                        channels = reader.ReadInt16();
                        sampleRate = reader.ReadInt32();
                        reader.ReadInt32();
                        reader.ReadInt16();
                        bitsPerSample = reader.ReadInt16();
                        var remaining = chunkSize - 16;
                        if (remaining > 0)
                        {
                            reader.ReadBytes(remaining);
                        }
                    }
                    else if (chunkId == "data")
                    {
                        dataChunk = reader.ReadBytes(chunkSize);
                    }
                    else
                    {
                        reader.ReadBytes(chunkSize);
                    }

                    if ((chunkSize & 1) == 1 && reader.BaseStream.Position < reader.BaseStream.Length)
                    {
                        reader.ReadByte();
                    }
                }

                if (dataChunk == null || channels <= 0 || sampleRate <= 0 || bitsPerSample <= 0)
                {
                    throw new InvalidOperationException("Incomplete WAV capture.");
                }

                byte[] pcmData;
                if (audioFormat == 1 && bitsPerSample == 16)
                {
                    pcmData = dataChunk;
                }
                else if (audioFormat == 3 && bitsPerSample == 32)
                {
                    pcmData = ConvertFloat32ToPcm16(dataChunk);
                }
                else
                {
                    throw new InvalidOperationException("Unsupported capture WAV format: format=" + audioFormat + " bits=" + bitsPerSample);
                }

                writer.Write(new[] { 'R', 'I', 'F', 'F' });
                writer.Write(36 + pcmData.Length);
                writer.Write(new[] { 'W', 'A', 'V', 'E' });
                writer.Write(new[] { 'f', 'm', 't', ' ' });
                writer.Write(16);
                writer.Write((short)1);
                writer.Write(channels);
                writer.Write(sampleRate);
                writer.Write(sampleRate * channels * 2);
                writer.Write((short)(channels * 2));
                writer.Write((short)16);
                writer.Write(new[] { 'd', 'a', 't', 'a' });
                writer.Write(pcmData.Length);
                writer.Write(pcmData);
            }
        }

        private static byte[] ConvertFloat32ToPcm16(byte[] input)
        {
            var samples = input.Length / 4;
            var output = new byte[samples * 2];
            for (var index = 0; index < samples; index++)
            {
                var sample = BitConverter.ToSingle(input, index * 4);
                if (sample > 1f)
                {
                    sample = 1f;
                }
                else if (sample < -1f)
                {
                    sample = -1f;
                }

                var pcm = (short)Math.Round(sample * short.MaxValue);
                var bytes = BitConverter.GetBytes(pcm);
                output[index * 2] = bytes[0];
                output[index * 2 + 1] = bytes[1];
            }
            return output;
        }

        private static void RunLegacySynthesis(string root, string voiceName, string text, string outPath)
        {
            RunSpeechSdkSynthesis(root, voiceName, text, outPath, ExtractLegacyKey());
        }

        private static void RunSpeechSdkSynthesis(string root, string voiceName, string text, string outPath, string license)
        {
            var cfg = EmbeddedSpeechConfig.FromPaths(new[] { root });
            cfg.SetSpeechSynthesisOutputFormat(SpeechSynthesisOutputFormat.Riff24Khz16BitMonoPcm);
            cfg.SetSpeechSynthesisVoice(voiceName, license);
            using (var audio = AudioConfig.FromWavFileOutput(outPath))
            using (var synth = new SpeechSynthesizer(cfg, audio))
            {
                var result = synth.SpeakTextAsync(text).Result;
                if (result.Reason == ResultReason.Canceled)
                {
                    var details = SpeechSynthesisCancellationDetails.FromResult(result);
                    throw new InvalidOperationException(details.ErrorDetails);
                }
                if (result.Reason != ResultReason.SynthesizingAudioCompleted)
                {
                    throw new InvalidOperationException("Unexpected synthesis result: " + result.Reason);
                }
            }
        }

        private static bool IsInstalledAppxVoiceRoot(string root)
        {
            var normalized = root.Replace('/', '\\');
            return normalized.IndexOf("\\WindowsApps\\MicrosoftWindows.Voice.", StringComparison.OrdinalIgnoreCase) >= 0
                || normalized.StartsWith(@"C:\Program Files\WindowsApps\MicrosoftWindows.Voice.", StringComparison.OrdinalIgnoreCase);
        }

        private static string BuildVoiceId(string voiceName, string locale)
        {
            var name = voiceName;
            if (name.StartsWith("Microsoft ", StringComparison.OrdinalIgnoreCase))
            {
                name = name.Substring("Microsoft ".Length);
            }
            var marker = name.IndexOf(" (", StringComparison.Ordinal);
            if (marker >= 0)
            {
                name = name.Substring(0, marker);
            }
            name = name.Replace(" ", "");
            return "windows-natural:" + locale + ":" + name + "Neural";
        }

        private static string HexLanguageToLocale(string value)
        {
            if (string.IsNullOrWhiteSpace(value))
            {
                return "";
            }

            var normalized = value.Trim();
            int lcid;
            if (!int.TryParse(normalized, System.Globalization.NumberStyles.HexNumber, null, out lcid) &&
                !int.TryParse(normalized, out lcid))
            {
                return normalized;
            }

            try
            {
                return System.Globalization.CultureInfo.GetCultureInfo(lcid).Name;
            }
            catch
            {
                return normalized;
            }
        }

        private static string ReadPackageVersion(string root)
        {
            var manifest = Path.Combine(root, "AppxManifest.xml");
            if (!File.Exists(manifest))
            {
                return "";
            }
            var document = XDocument.Load(manifest);
            var identity = document.Descendants().FirstOrDefault(x => x.Name.LocalName == "Identity");
            if (identity == null)
            {
                return "";
            }
            var version = identity.Attribute("Version");
            return version == null ? "" : version.Value;
        }

        private sealed class WindowsUdkSpeech : IDisposable
        {
            private readonly List<IntPtr> contexts = new List<IntPtr>();
            private readonly List<string> dependencyIds = new List<string>();
            private bool roInitialized;

            public static WindowsUdkSpeech Create()
            {
                var speech = new WindowsUdkSpeech();
                speech.Initialize();
                return speech;
            }

            public SpeechSynthesizerProxy CreateForVoiceRoot(string root, string audioDeviceId)
            {
                var statics = ActivateFactory("SpeechSynthesizerExtension.SpeechSynthesizerExtensionImpl", ISpeechSynthesizerExtensionStaticsGuid);
                IntPtr rootString = IntPtr.Zero;
                IntPtr emptyDevice = IntPtr.Zero;
                IntPtr arrayPointer = IntPtr.Zero;
                IntPtr speaker = IntPtr.Zero;
                try
                {
                    rootString = CreateHString(root);
                    emptyDevice = CreateHString(audioDeviceId ?? string.Empty);
                    arrayPointer = Marshal.AllocHGlobal(IntPtr.Size);
                    Marshal.WriteIntPtr(arrayPointer, rootString);

                    var method = ComDelegateFactory.GetDelegate<GetForVoicePathsAndDeviceIdDelegate>(statics, 6);
                    var hr = method(statics, 1u, arrayPointer, emptyDevice, out speaker);
                    Marshal.ThrowExceptionForHR(hr);
                    return new SpeechSynthesizerProxy(speaker);
                }
                finally
                {
                    if (speaker == IntPtr.Zero && statics != IntPtr.Zero)
                    {
                        Marshal.Release(statics);
                    }
                    if (arrayPointer != IntPtr.Zero)
                    {
                        Marshal.FreeHGlobal(arrayPointer);
                    }
                    if (emptyDevice != IntPtr.Zero)
                    {
                        NativeMethods.WindowsDeleteString(emptyDevice);
                    }
                    if (rootString != IntPtr.Zero)
                    {
                        NativeMethods.WindowsDeleteString(rootString);
                    }
                }
            }

            private void Initialize()
            {
                foreach (var packageFamily in SpeechPackageFamilies)
                {
                    AddPackageDependency(packageFamily);
                }

                var roHr = NativeMethods.RoInitialize(1);
                if (roHr == unchecked((int)0x80010106) || roHr >= 0)
                {
                    roInitialized = true;
                }
                else
                {
                    Marshal.ThrowExceptionForHR(roHr);
                }

                var appExtensionStatics = ActivateFactory("WindowsUdk.ApplicationModel.AppExtensions.AppExtension", IAppExtensionStaticsGuid);
                try
                {
                    Marshal.ThrowExceptionForHR(ComDelegateFactory.GetDelegate<NoArgMethodDelegate>(appExtensionStatics, 6)(appExtensionStatics));
                    Marshal.ThrowExceptionForHR(ComDelegateFactory.GetDelegate<NoArgMethodDelegate>(appExtensionStatics, 7)(appExtensionStatics));
                    Marshal.ThrowExceptionForHR(ComDelegateFactory.GetDelegate<IntArgMethodDelegate>(appExtensionStatics, 8)(appExtensionStatics, 0x59));

                    IntPtr appExtensionStatics2;
                    var appExtensionStatics2Guid = IAppExtensionStatics2Guid;
                    Marshal.ThrowExceptionForHR(Marshal.QueryInterface(appExtensionStatics, ref appExtensionStatics2Guid, out appExtensionStatics2));
                    try
                    {
                        var addKnownPackage = ComDelegateFactory.GetDelegate<IntArgMethodDelegate>(appExtensionStatics2, 6);
                        foreach (var knownPackage in new[] { 0, 6, 7, 8, 9 })
                        {
                            Marshal.ThrowExceptionForHR(addKnownPackage(appExtensionStatics2, knownPackage));
                        }
                    }
                    finally
                    {
                        Marshal.Release(appExtensionStatics2);
                    }
                }
                finally
                {
                    Marshal.Release(appExtensionStatics);
                }
            }

            private static IntPtr ActivateFactory(string className, Guid iid)
            {
                var classString = CreateHString(className);
                try
                {
                    IntPtr factory;
                    Marshal.ThrowExceptionForHR(NativeMethods.RoGetActivationFactory(classString, ref iid, out factory));
                    return factory;
                }
                finally
                {
                    NativeMethods.WindowsDeleteString(classString);
                }
            }

            private void AddPackageDependency(string packageFamilyName)
            {
                var packageVersion = new NativeMethods.PackageVersion();
                IntPtr dependencyIdPointer;
                Marshal.ThrowExceptionForHR(NativeMethods.TryCreatePackageDependency(
                    IntPtr.Zero,
                    packageFamilyName,
                    packageVersion,
                    PackageArchitectureX64,
                    0,
                    null,
                    0,
                    out dependencyIdPointer));

                if (dependencyIdPointer == IntPtr.Zero)
                {
                    return;
                }

                string dependencyId = null;
                try
                {
                    dependencyId = Marshal.PtrToStringUni(dependencyIdPointer);
                }
                finally
                {
                    NativeMethods.LocalFree(dependencyIdPointer);
                }

                IntPtr context;
                IntPtr fullNamePointer;
                Marshal.ThrowExceptionForHR(NativeMethods.AddPackageDependency(dependencyId, 0, 0, out context, out fullNamePointer));
                if (fullNamePointer != IntPtr.Zero)
                {
                    NativeMethods.LocalFree(fullNamePointer);
                }

                if (context != IntPtr.Zero)
                {
                    contexts.Add(context);
                }
                if (!string.IsNullOrEmpty(dependencyId))
                {
                    dependencyIds.Add(dependencyId);
                }
            }

            private static IntPtr CreateHString(string value)
            {
                IntPtr hstring;
                Marshal.ThrowExceptionForHR(NativeMethods.WindowsCreateString(value ?? string.Empty, (value ?? string.Empty).Length, out hstring));
                return hstring;
            }

            public void Dispose()
            {
                foreach (var context in contexts)
                {
                    NativeMethods.RemovePackageDependency(context);
                }
                foreach (var dependencyId in dependencyIds)
                {
                    NativeMethods.DeletePackageDependency(dependencyId);
                }
                if (roInitialized)
                {
                    NativeMethods.RoUninitialize();
                }
            }
        }

        private sealed class SpeechSynthesizerProxy : IDisposable
        {
            private IntPtr instance;

            public SpeechSynthesizerProxy(IntPtr instance)
            {
                this.instance = instance;
            }

            public void SelectVoice(string voiceName)
            {
                EnsureNotDisposed();
                var hstring = NativeMethods.CreateHString(voiceName);
                try
                {
                    var method = ComDelegateFactory.GetDelegate<SelectVoiceDelegate>(instance, 6);
                    Marshal.ThrowExceptionForHR(method(instance, hstring));
                }
                finally
                {
                    NativeMethods.WindowsDeleteString(hstring);
                }
            }

            public bool SpeakText(string text)
            {
                EnsureNotDisposed();
                var hstring = NativeMethods.CreateHString(text);
                try
                {
                    var method = ComDelegateFactory.GetDelegate<SpeakTextDelegate>(instance, 9);
                    byte result;
                    Marshal.ThrowExceptionForHR(method(instance, hstring, out result));
                    return result != 0;
                }
                finally
                {
                    NativeMethods.WindowsDeleteString(hstring);
                }
            }

            private void EnsureNotDisposed()
            {
                if (instance == IntPtr.Zero)
                {
                    throw new ObjectDisposedException("SpeechSynthesizerProxy");
                }
            }

            public void Dispose()
            {
                if (instance != IntPtr.Zero)
                {
                    Marshal.Release(instance);
                    instance = IntPtr.Zero;
                }
            }
        }

        private static class NativeMethods
        {
            [StructLayout(LayoutKind.Explicit)]
            public struct PackageVersion
            {
                [FieldOffset(0)] public ulong Version;
                [FieldOffset(0)] public ushort Revision;
                [FieldOffset(2)] public ushort Build;
                [FieldOffset(4)] public ushort Minor;
                [FieldOffset(6)] public ushort Major;
            }

            [DllImport("kernelbase.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
            public static extern int TryCreatePackageDependency(
                IntPtr user,
                string packageFamilyName,
                PackageVersion minVersion,
                int architectures,
                int lifetimeKind,
                string lifetimeArtifact,
                int options,
                out IntPtr packageDependencyId);

            [DllImport("kernelbase.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
            public static extern int AddPackageDependency(
                string packageDependencyId,
                int rank,
                int options,
                out IntPtr packageDependencyContext,
                out IntPtr packageFullName);

            [DllImport("kernelbase.dll", ExactSpelling = true)]
            public static extern void RemovePackageDependency(IntPtr packageDependencyContext);

            [DllImport("kernelbase.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
            public static extern int DeletePackageDependency(string packageDependencyId);

            [DllImport("kernel32.dll", ExactSpelling = true)]
            public static extern IntPtr LocalFree(IntPtr hMem);

            [DllImport("combase.dll", ExactSpelling = true)]
            public static extern int RoInitialize(uint initType);

            [DllImport("combase.dll", ExactSpelling = true)]
            public static extern void RoUninitialize();

            [DllImport("combase.dll", ExactSpelling = true)]
            public static extern int RoGetActivationFactory(IntPtr activatableClassId, ref Guid iid, out IntPtr factory);

            [DllImport("combase.dll", ExactSpelling = true, CharSet = CharSet.Unicode)]
            public static extern int WindowsCreateString(string sourceString, int length, out IntPtr hstring);

            [DllImport("combase.dll", ExactSpelling = true)]
            public static extern int WindowsDeleteString(IntPtr hstring);

            public static IntPtr CreateHString(string value)
            {
                IntPtr hstring;
                Marshal.ThrowExceptionForHR(WindowsCreateString(value ?? string.Empty, (value ?? string.Empty).Length, out hstring));
                return hstring;
            }
        }

        private static class ComDelegateFactory
        {
            public static T GetDelegate<T>(IntPtr instance, int slot) where T : class
            {
                var vtable = Marshal.ReadIntPtr(instance);
                var functionPointer = Marshal.ReadIntPtr(vtable, slot * IntPtr.Size);
                return (T)(object)Marshal.GetDelegateForFunctionPointer(functionPointer, typeof(T));
            }
        }

        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        private delegate int NoArgMethodDelegate(IntPtr self);

        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        private delegate int IntArgMethodDelegate(IntPtr self, int value);

        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        private delegate int GetForVoicePathsAndDeviceIdDelegate(IntPtr self, uint voicePathsSize, IntPtr voicePaths, IntPtr audioDeviceId, out IntPtr result);

        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        private delegate int SelectVoiceDelegate(IntPtr self, IntPtr voiceName);

        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        private delegate int SpeakTextDelegate(IntPtr self, IntPtr text, out byte result);
    }
}
