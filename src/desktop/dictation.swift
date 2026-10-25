// The Mac app's ear (issue #150): hears the microphone and recognizes the words on this Mac, never
// online. Built by tools/desktop/dictation.mjs into Contents/MacOS/vanilla-dictation; started by
// src/desktop/dictation.ts, one process per dictation.
//
//   vanilla-dictation --lang de-CH            listens until stdin says "stop" or closes
//   vanilla-dictation --lang de-CH --file a   recognizes an audio file instead (checks, no microphone;
//                                             VANILLA_DICTATION_FILE=a does the same for the whole app;
//                                             VANILLA_DICTATION_LEGACY=1 takes the path before macOS 26)
//
// stdout: one JSON object per line (DictationEvent in src/types/desktop.ts): "preparing", "listening",
// "level" {level: 0..1, about 20 a second while the microphone is open}, "heard" {text, partial}
// (`text` is settled and only grows, `partial` follows it and may still change), one "ended" {error?}.
// macOS 26 and later recognize with SpeechAnalyzer,
// which never sends audio away and loads a language's model from Apple once. Older macOS use
// SFSpeechRecognizer, only where the language's model is on the Mac (requiresOnDeviceRecognition).
import AVFoundation
import Foundation
@preconcurrency import Speech

setvbuf(stdout, nil, _IOLBF, 0)

/// The audio thread's levels and the recognizer's words are written at the same time: one line at a time.
let lines = NSLock()

func emit(_ kind: String, _ fields: [String: Any] = [:]) {
  var data = try! JSONSerialization.data(withJSONObject: fields.merging(["kind": kind]) { _, k in k })
  data.append(0x0A)
  lines.withLock { FileHandle.standardOutput.write(data) }
}

func end(_ error: String? = nil) -> Never {
  emit("ended", error.map { ["error": $0] } ?? [:])
  exit(0)
}

func argument(_ name: String) -> String? {
  guard let i = CommandLine.arguments.firstIndex(of: name), i + 1 < CommandLine.arguments.count else { return nil }
  return CommandLine.arguments[i + 1]
}

let lang = argument("--lang") ?? "de-CH"
/// VANILLA_DICTATION_FILE: the app started with it dictates this file, so a check drives the chat without a microphone.
let file = argument("--file") ?? ProcessInfo.processInfo.environment["VANILLA_DICTATION_FILE"]

/// Resolves once the app says stop: a line "stop", or stdin closing because the app went away.
func stopRequested() async {
  await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
    DispatchQueue.global().async {
      while let line = readLine() { if line.trimmingCharacters(in: .whitespaces) == "stop" { break } }
      done.resume()
    }
  }
}

func microphoneAllowed() async -> Bool {
  switch AVCaptureDevice.authorizationStatus(for: .audio) {
  case .authorized: return true
  case .notDetermined: return await AVCaptureDevice.requestAccess(for: .audio)
  default: return false
  }
}

/// The microphone's buffers as one channel, converted to `format` (at the device's rate when nil),
/// until stopped. An audio interface hands over many channels (a Focusrite Vocaster One: ten, the
/// voice on the fifth, the computer's playback on others), and AVAudioConverter turns such a
/// discrete layout into silence, also with `downmix`. So each buffer gives its loudest channel.
final class Microphone {
  let engine = AVAudioEngine()
  /// Set on the audio thread, read on the stop's.
  private let lock = NSLock()
  private var sounded = false
  private var started = Date.distantFuture

  /// The microphone gave only digital silence for longer than a click and its second click.
  var silent: Bool { lock.withLock { !sounded } && Date().timeIntervalSince(started) > 1 }

  func start(as format: AVAudioFormat?, _ deliver: @escaping (AVAudioPCMBuffer) -> Void) throws {
    let input = engine.inputNode
    let native = input.outputFormat(forBus: 0)
    let mono = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: native.sampleRate, channels: 1, interleaved: false)!
    let target = format ?? mono
    let converter = target == mono ? nil : AVAudioConverter(from: mono, to: target)
    input.installTap(onBus: 0, bufferSize: 4096, format: native) { [self] buffer, _ in
      guard let one = loudestChannel(of: buffer, as: mono) else { return }
      report(levels(of: one))
      guard let converter else { return hand(one, deliver) }
      let capacity = AVAudioFrameCount(Double(one.frameLength) * target.sampleRate / mono.sampleRate) + 1
      guard let out = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { return }
      var given = false
      var error: NSError?
      converter.convert(to: out, error: &error) { _, status in
        if given { status.pointee = .noDataNow; return nil }
        given = true
        status.pointee = .haveData
        return one
      }
      if error == nil, out.frameLength > 0 { hand(out, deliver) }
    }
    engine.prepare()
    try engine.start()
    started = Date()
  }

  /// A tap's buffer holds a tenth of a second or more: its slices are told one after the other, so
  /// the button moves about twenty times a second, as the voice did.
  private let levelQueue = DispatchQueue(label: "level")
  private func report(_ levels: [Int]) {
    for (i, level) in levels.enumerated() {
      let exact = NSDecimalNumber(mantissa: UInt64(level), exponent: -2, isNegative: false)
      levelQueue.asyncAfter(deadline: .now() + levelSlice * Double(i)) { emit("level", ["level": exact]) }
    }
  }

  private func hand(_ buffer: AVAudioPCMBuffer, _ deliver: (AVAudioPCMBuffer) -> Void) {
    if !lock.withLock({ sounded }), hasSound(buffer) { lock.withLock { sounded = true } }
    deliver(buffer)
  }

  func stop() {
    engine.inputNode.removeTap(onBus: 0)
    engine.stop()
  }
}

/// The channel of `buffer` with the most energy, as a buffer of `mono`.
func loudestChannel(of buffer: AVAudioPCMBuffer, as mono: AVAudioFormat) -> AVAudioPCMBuffer? {
  guard let channels = buffer.floatChannelData, let one = AVAudioPCMBuffer(pcmFormat: mono, frameCapacity: buffer.frameLength) else { return nil }
  let frames = Int(buffer.frameLength)
  let energy = (0..<Int(buffer.format.channelCount)).map { c in (0..<frames).reduce(Float(0)) { $0 + channels[c][$1] * channels[c][$1] } }
  let loudest = energy.indices.max { energy[$0] < energy[$1] } ?? 0
  one.floatChannelData![0].update(from: channels[loudest], count: frames)
  one.frameLength = buffer.frameLength
  return one
}

let levelSlice = 0.05

/// The loudness of each 50 ms of a mono buffer in percent: 0 at -50 dBFS and below, 100 at -10 dBFS
/// and above, so a voice near the microphone fills most of it and the room's noise hardly moves it.
func levels(of buffer: AVAudioPCMBuffer) -> [Int] {
  guard let f = buffer.floatChannelData?[0] else { return [] }
  let frames = Int(buffer.frameLength)
  let slice = max(1, Int(buffer.format.sampleRate * levelSlice))
  return stride(from: 0, to: frames, by: slice).map { start in
    let n = min(slice, frames - start)
    let rms = sqrt((start..<start + n).reduce(Float(0)) { $0 + f[$1] * f[$1] } / Float(n))
    let db = 20 * log10(Double(max(rms, 1e-9)))
    return Int((min(max((db + 50) / 40, 0), 1) * 100).rounded())
  }
}

/// Whether a buffer holds anything but zeros: a working microphone's noise is enough.
func hasSound(_ buffer: AVAudioPCMBuffer) -> Bool {
  let frames = Int(buffer.frameLength)
  if let f = buffer.floatChannelData { return (0..<frames).contains { f[0][$0] != 0 } }
  if let i = buffer.int16ChannelData { return (0..<frames).contains { i[0][$0] != 0 } }
  return true
}

@available(macOS 26.0, *)
func analyze() async {
  guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: lang)) else { end("noOnDevice") }
  let transcriber = SpeechTranscriber(locale: locale, transcriptionOptions: [], reportingOptions: [.volatileResults, .fastResults], attributeOptions: [])
  do {
    if let install = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
      emit("preparing")
      try await install.downloadAndInstall()
    }
  } catch {
    end("notInstalled")
  }

  // Without .fastResults the volatile results come only once the speech has ended, so nothing would
  // show while the person speaks.
  var finished = ""
  let results = Task {
    for try await result in transcriber.results {
      let text = String(result.text.characters)
      if result.isFinal { finished += text }
      emit("heard", ["text": finished, "partial": result.isFinal ? "" : text])
    }
  }

  do {
    if let file {
      let analyzer = SpeechAnalyzer(modules: [transcriber])
      emit("listening")
      try await analyzer.start(inputAudioFile: AVAudioFile(forReading: URL(fileURLWithPath: file)), finishAfterFile: true)
    } else {
      let analyzer = SpeechAnalyzer(modules: [transcriber])
      let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber])
      let (input, feed) = AsyncStream<AnalyzerInput>.makeStream()
      let mic = Microphone()
      try mic.start(as: format) { feed.yield(AnalyzerInput(buffer: $0)) }
      try await analyzer.start(inputSequence: input)
      emit("listening")
      await stopRequested()
      mic.stop()
      feed.finish()
      try await analyzer.finalizeAndFinishThroughEndOfInput()
      if mic.silent { end("noSound") }
    }
    try await results.value
  } catch {
    FileHandle.standardError.write("\(error)\n".data(using: .utf8)!)
    end("failed")
  }
  end()
}

/// Before macOS 26: SFSpeechRecognizer, only with the language's model on this Mac. A Swiss locale
/// without one falls back to the language's main country (de-DE, fr-FR, it-IT).
func recognize() async {
  let status = await withCheckedContinuation { done in SFSpeechRecognizer.requestAuthorization { done.resume(returning: $0) } }
  guard status == .authorized else { end("speechDenied") }
  let fallback = ["de": "de-DE", "fr": "fr-FR", "it": "it-IT", "en": "en-US"][String(lang.prefix(2))]
  let candidates = [lang, fallback].compactMap { $0 }.compactMap { SFSpeechRecognizer(locale: Locale(identifier: $0)) }
  guard let recognizer = candidates.first(where: { $0.supportsOnDeviceRecognition && $0.isAvailable }) else { end("noOnDevice") }

  let request: SFSpeechRecognitionRequest
  let mic = Microphone()
  if let file {
    request = SFSpeechURLRecognitionRequest(url: URL(fileURLWithPath: file))
  } else {
    let live = SFSpeechAudioBufferRecognitionRequest()
    do { try mic.start(as: nil) { live.append($0) } } catch { end("failed") }
    request = live
  }
  request.requiresOnDeviceRecognition = true
  request.shouldReportPartialResults = true

  let error: String? = await withCheckedContinuation { done in
    var resumed = false
    let finish: (String?) -> Void = { e in if !resumed { resumed = true; done.resume(returning: e) } }
    nonisolated(unsafe) let task = recognizer.recognitionTask(with: request) { result, error in
      if let result {
        let text = result.bestTranscription.formattedString
        emit("heard", ["text": result.isFinal ? text : "", "partial": result.isFinal ? "" : text])
        if result.isFinal { finish(nil) }
      } else if let error {
        // 1110: nothing was said; a pause is no error.
        // 201: Siri and Dictation are off, so no model is on the Mac either.
        let code = (error as NSError).code
        if code == 1110 { return finish(nil) }
        if code == 201 { return finish("noOnDevice") }
        FileHandle.standardError.write("\(error)\n".data(using: .utf8)!)
        finish("failed")
      }
    }
    emit("listening")
    if file == nil {
      Task {
        await stopRequested()
        mic.stop()
        (request as? SFSpeechAudioBufferRecognitionRequest)?.endAudio()
        if mic.silent { task.cancel(); return finish("noSound") }
        DispatchQueue.global().asyncAfter(deadline: .now() + 3) { task.finish(); finish(nil) }
      }
    }
  }
  end(error)
}

Task {
  if file == nil, !(await microphoneAllowed()) { end("micDenied") }
  if #available(macOS 26.0, *), ProcessInfo.processInfo.environment["VANILLA_DICTATION_LEGACY"] == nil {
    await analyze()
  } else {
    await recognize()
  }
}
dispatchMain()
