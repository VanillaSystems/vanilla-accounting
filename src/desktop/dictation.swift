// The Mac app's ear (issue #150): hears the microphone and recognizes the words on this Mac, never
// online. Built by tools/desktop/dictation.mjs into Contents/MacOS/vanilla-dictation; started by
// src/desktop/dictation.ts, one process per dictation.
//
//   vanilla-dictation --lang de-CH            listens until stdin says "stop" or closes
//   vanilla-dictation --lang de-CH --file a   recognizes an audio file instead (checks, no microphone;
//                                             VANILLA_DICTATION_FILE=a does the same for the whole app;
//                                             VANILLA_DICTATION_LEGACY=1 takes the path before macOS 26)
//
// stdout: one JSON object per line, {"kind":"preparing"|"listening"|"heard"|"ended", "text"?, "error"?}
// (DictationEvent in src/types/desktop.ts). macOS 26 and later recognize with SpeechAnalyzer,
// which never sends audio away and loads a language's model from Apple once. Older macOS use
// SFSpeechRecognizer, only where the language's model is on the Mac (requiresOnDeviceRecognition).
import AVFoundation
import Foundation
@preconcurrency import Speech

setvbuf(stdout, nil, _IOLBF, 0)

func emit(_ kind: String, text: String? = nil, error: String? = nil) {
  var o: [String: String] = ["kind": kind]
  if let text { o["text"] = text }
  if let error { o["error"] = error }
  let data = try! JSONSerialization.data(withJSONObject: o)
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write("\n".data(using: .utf8)!)
}

func end(_ error: String? = nil) -> Never {
  emit("ended", error: error)
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
  nonisolated(unsafe) private var sounded = false
  private var started = Date.distantFuture

  /// The microphone gave only digital silence for longer than a click and its second click.
  var silent: Bool { !sounded && Date().timeIntervalSince(started) > 1 }

  func start(as format: AVAudioFormat?, _ deliver: @escaping (AVAudioPCMBuffer) -> Void) throws {
    let input = engine.inputNode
    let native = input.outputFormat(forBus: 0)
    let mono = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: native.sampleRate, channels: 1, interleaved: false)!
    let target = format ?? mono
    let converter = target == mono ? nil : AVAudioConverter(from: mono, to: target)
    input.installTap(onBus: 0, bufferSize: 4096, format: native) { [self] buffer, _ in
      guard let one = loudestChannel(of: buffer, as: mono) else { return }
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

  private func hand(_ buffer: AVAudioPCMBuffer, _ deliver: (AVAudioPCMBuffer) -> Void) {
    if !sounded, hasSound(buffer) { sounded = true }
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
  let transcriber = SpeechTranscriber(locale: locale, transcriptionOptions: [], reportingOptions: [.volatileResults], attributeOptions: [])
  do {
    if let install = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
      emit("preparing")
      try await install.downloadAndInstall()
    }
  } catch {
    end("notInstalled")
  }

  var finished = ""
  var volatile = ""
  let results = Task {
    for try await result in transcriber.results {
      let text = String(result.text.characters)
      if result.isFinal { finished += text; volatile = "" } else { volatile = text }
      emit("heard", text: finished + volatile)
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
        emit("heard", text: result.bestTranscription.formattedString)
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
