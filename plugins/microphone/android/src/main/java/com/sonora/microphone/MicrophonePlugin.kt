package com.sonora.microphone

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.util.Base64
import android.webkit.WebView
import android.view.WindowManager
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import app.tauri.annotation.Command
import app.tauri.annotation.Permission
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.atomic.AtomicBoolean

@TauriPlugin(permissions = [Permission(strings = [Manifest.permission.RECORD_AUDIO], alias = "microphone")])
class MicrophonePlugin(private val activity: Activity) : Plugin(activity) {
    private var recorder: AudioRecord? = null
    private var worker: Thread? = null
    private val running = AtomicBoolean(false)
    private var pausedWhileRecording = false
    private val observer = object : DefaultLifecycleObserver {
        override fun onPause(owner: LifecycleOwner) { pauseCapture() }
        override fun onStop(owner: LifecycleOwner) { pauseCapture() }
        override fun onResume(owner: LifecycleOwner) {
            if (pausedWhileRecording) {
                pausedWhileRecording = false
                val event = JSObject(); event.put("message", "应用进入后台，录音已暂停。")
                trigger("error", event)
            }
        }
    }

    override fun load(webView: WebView) {
        // Let Chromium observe the real keyboard viewport instead of Android
        // panning the entire native window behind the IME.
        activity.window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
        // Observe the Activity directly: generated Tauri lifecycle wiring can
        // vary by runtime version and WebView visibility events are unreliable.
        (activity as? LifecycleOwner)?.lifecycle?.addObserver(observer)
    }

    @Command
    fun insets(invoke: Invoke) {
        activity.runOnUiThread {
            val root = ViewCompat.getRootWindowInsets(activity.window.decorView)
            val bars = root?.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            val density = activity.resources.displayMetrics.density.toDouble()
            val result = JSObject()
            result.put("top", (bars?.top ?: 0) / density)
            result.put("right", (bars?.right ?: 0) / density)
            result.put("bottom", (bars?.bottom ?: 0) / density)
            result.put("left", (bars?.left ?: 0) / density)
            invoke.resolve(result)
        }
    }

    @Command
    fun start(invoke: Invoke) {
        if (running.get()) { invoke.reject("录音已经开始"); return }
        if (ContextCompat.checkSelfPermission(activity, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            invoke.reject("麦克风权限未开启"); return
        }
        try {
            val sampleRate = 16000
            val minBuffer = AudioRecord.getMinBufferSize(sampleRate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
            if (minBuffer <= 0) { invoke.reject("设备不支持 16 kHz 录音"); return }
            val audio = AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, sampleRate,
                AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, maxOf(minBuffer * 2, 6400))
            if (audio.state != AudioRecord.STATE_INITIALIZED) { audio.release(); invoke.reject("无法初始化麦克风"); return }
            recorder = audio
            audio.startRecording()
            pausedWhileRecording = false
            running.set(true)
            worker = Thread({
                val samples = ShortArray(1600)
                try {
                    while (running.get()) {
                        val count = audio.read(samples, 0, samples.size, AudioRecord.READ_BLOCKING)
                        if (!running.get()) break
                        if (count < 0) throw IllegalStateException("录音设备读取失败 ($count)")
                        if (count == 0) continue
                        val bytes = ByteBuffer.allocate(count * 2).order(ByteOrder.LITTLE_ENDIAN)
                        for (i in 0 until count) bytes.putShort(samples[i])
                        val event = JSObject()
                        event.put("pcm", Base64.encodeToString(bytes.array(), Base64.NO_WRAP))
                        event.put("sampleRate", sampleRate)
                        activity.runOnUiThread { if (running.get()) trigger("audio", event) }
                    }
                } catch (error: Exception) {
                    if (running.get()) activity.runOnUiThread {
                        val event = JSObject(); event.put("message", error.message ?: "录音失败")
                        trigger("error", event)
                        release()
                    }
                }
            }, "sonora-microphone").also { it.start() }
            invoke.resolve()
        } catch (error: Exception) {
            release(); invoke.reject(error.message ?: "无法开启麦克风")
        }
    }

    @Command
    fun stop(invoke: Invoke) { release(); invoke.resolve() }

    @Command
    fun status(invoke: Invoke) {
        val state = JSObject(); state.put("recording", running.get())
        invoke.resolve(state)
    }

    private fun release() {
        running.set(false)
        try { recorder?.stop() } catch (_: Exception) {}
        worker?.join(500)
        recorder?.release()
        recorder = null
        worker = null
    }

    private fun pauseCapture() {
        if (running.get()) {
            pausedWhileRecording = true
            release()
            val event = JSObject(); event.put("message", "应用进入后台，录音已暂停。")
            trigger("error", event)
        }
    }

    override fun onPause() { pauseCapture(); super.onPause() }
    override fun onDestroy(activity: AppCompatActivity) {
        activity.lifecycle.removeObserver(observer)
        release(); super.onDestroy(activity)
    }
}
