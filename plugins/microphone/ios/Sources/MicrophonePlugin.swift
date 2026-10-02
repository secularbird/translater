import AVFoundation
import Tauri
import UIKit
import WebKit

class MicrophonePlugin: Plugin {
    private var engine: AVAudioEngine?
    private var observers: [NSObjectProtocol] = []
    private var sessionId = UUID()

    override func load(webview: WKWebView) {
        for name in [UIApplication.didEnterBackgroundNotification, AVAudioSession.interruptionNotification, AVAudioSession.routeChangeNotification] {
            observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] notification in
                guard let self = self, self.engine != nil else { return }
                if notification.name == AVAudioSession.routeChangeNotification {
                    let reason = notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt
                    guard reason == AVAudioSession.RouteChangeReason.oldDeviceUnavailable.rawValue
                        || reason == AVAudioSession.RouteChangeReason.newDeviceAvailable.rawValue else { return }
                }
                // Input sample rates can change when a headset is removed. Restart explicitly.
                self.release()
                self.trigger("error", data: ["message": notification.name == UIApplication.didEnterBackgroundNotification
                    ? "应用进入后台，录音已暂停。" : "音频路由变化或录音被系统打断，请重新开始。"])
            })
        }
    }

    private func permission() -> String {
        switch AVAudioSession.sharedInstance().recordPermission {
        case .granted: return "granted"
        case .denied: return "denied"
        default: return "prompt"
        }
    }

    @objc override func checkPermissions(_ invoke: Invoke) {
        invoke.resolve(["microphone": permission()])
    }

    @objc override func requestPermissions(_ invoke: Invoke) {
        AVAudioSession.sharedInstance().requestRecordPermission { granted in
            invoke.resolve(["microphone": granted ? "granted" : "denied"])
        }
    }

    @objc func start(_ invoke: Invoke) {
        DispatchQueue.main.async { [self] in
            guard engine == nil else { invoke.reject("录音已经开始"); return }
            guard permission() == "granted" else { invoke.reject("麦克风权限未开启"); return }
            do {
                let session = AVAudioSession.sharedInstance()
                try session.setCategory(.playAndRecord, mode: .measurement, options: [.defaultToSpeaker, .allowBluetooth])
                try session.setActive(true)
                let next = AVAudioEngine()
                let input = next.inputNode
                let format = input.outputFormat(forBus: 0)
                guard format.sampleRate > 0, format.channelCount > 0 else {
                    try? session.setActive(false)
                    invoke.reject("未找到可用麦克风"); return
                }
                let id = UUID(); sessionId = id
                input.installTap(onBus: 0, bufferSize: 4096, format: format) { [weak self] buffer, _ in
                    guard let samples = buffer.floatChannelData?[0] else { return }
                    var pcm = Data(capacity: Int(buffer.frameLength) * 2)
                    for index in 0..<Int(buffer.frameLength) {
                        let sample = max(-1, min(1, samples[index]))
                        var value = Int16(sample * (sample < 0 ? 32768 : 32767)).littleEndian
                        withUnsafeBytes(of: &value) { pcm.append(contentsOf: $0) }
                    }
                    let encoded = pcm.base64EncodedString()
                    DispatchQueue.main.async {
                        guard let self = self, self.engine != nil, self.sessionId == id else { return }
                        self.trigger("audio", data: ["pcm": encoded, "sampleRate": format.sampleRate])
                    }
                }
                engine = next
                next.prepare()
                try next.start()
                invoke.resolve()
            } catch {
                release(); invoke.reject(error.localizedDescription)
            }
        }
    }

    @objc func stop(_ invoke: Invoke) {
        DispatchQueue.main.async { [self] in release(); invoke.resolve() }
    }

    @objc func status(_ invoke: Invoke) {
        DispatchQueue.main.async { [self] in invoke.resolve(["recording": engine?.isRunning == true]) }
    }

    private func release() {
        sessionId = UUID()
        if let current = engine {
            current.stop()
            current.inputNode.removeTap(onBus: 0)
        }
        engine = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    deinit { observers.forEach { NotificationCenter.default.removeObserver($0) } }
}

@_cdecl("init_plugin_microphone")
func initPlugin() -> Plugin { MicrophonePlugin() }
