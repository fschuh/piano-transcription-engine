import assert from "node:assert/strict";
import test from "node:test";

import {
  BrowserOnlineAmtRecognizer,
  ONLINE_AMT_WASM_THREADS,
} from "../dist/browser/index.js";

class FakeWorker {
  messages = [];
  transfers = [];
  onmessage = null;
  onerror = null;
  terminated = false;

  postMessage(message, transfer = []) {
    this.messages.push(message);
    this.transfers.push(transfer);
  }

  terminate() {
    this.terminated = true;
  }

  emit(data) {
    this.onmessage?.({ data });
  }

  fail(message) {
    this.onerror?.({ message });
  }
}

class FakeConnectable {
  connections = [];
  disconnectCount = 0;

  connect(target) {
    this.connections.push(target);
    return target;
  }

  disconnect() {
    this.disconnectCount += 1;
  }
}

class FakePort {
  messages = [];
  onmessage = null;

  postMessage(message) {
    this.messages.push(message);
  }

  emit(data) {
    this.onmessage?.({ data });
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function fakeStream() {
  const track = {
    stopCount: 0,
    stop() {
      this.stopCount += 1;
    },
  };
  return {
    track,
    stream: {
      getTracks: () => [track],
    },
  };
}

function installBrowserFakes({ getUserMedia, sampleRate = 16_000 }) {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const originalAudioContext = Object.getOwnPropertyDescriptor(globalThis, "AudioContext");
  const originalAudioWorkletNode = Object.getOwnPropertyDescriptor(
    globalThis,
    "AudioWorkletNode",
  );
  const state = {
    mediaConstraints: [],
    contexts: [],
    workletNodes: [],
  };

  class FakeAudioContext {
    constructor(options) {
      this.options = options;
      this.sampleRate = sampleRate;
      this.currentTime = 0;
      this.destination = { kind: "destination" };
      this.modules = [];
      this.sources = [];
      this.gains = [];
      this.resumeCount = 0;
      this.closeCount = 0;
      this.audioWorklet = {
        addModule: async (url) => {
          this.modules.push(url);
        },
      };
      state.contexts.push(this);
    }

    createMediaStreamSource(stream) {
      const source = new FakeConnectable();
      source.stream = stream;
      this.sources.push(source);
      return source;
    }

    createGain() {
      const gain = new FakeConnectable();
      gain.gain = { value: 1 };
      this.gains.push(gain);
      return gain;
    }

    async resume() {
      this.resumeCount += 1;
    }

    async close() {
      this.closeCount += 1;
    }
  }

  class FakeAudioWorkletNode extends FakeConnectable {
    constructor(context, name, options) {
      super();
      this.context = context;
      this.name = name;
      this.options = options;
      this.port = new FakePort();
      state.workletNodes.push(this);
    }
  }

  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      mediaDevices: {
        getUserMedia: (constraints) => {
          state.mediaConstraints.push(constraints);
          return getUserMedia(constraints);
        },
      },
    },
  });
  Object.defineProperty(globalThis, "AudioContext", {
    configurable: true,
    value: FakeAudioContext,
  });
  Object.defineProperty(globalThis, "AudioWorkletNode", {
    configurable: true,
    value: FakeAudioWorkletNode,
  });

  return {
    state,
    restore() {
      for (const [name, descriptor] of [
        ["navigator", originalNavigator],
        ["AudioContext", originalAudioContext],
        ["AudioWorkletNode", originalAudioWorkletNode],
      ]) {
        if (descriptor === undefined) delete globalThis[name];
        else Object.defineProperty(globalThis, name, descriptor);
      }
    },
  };
}

function callbacks() {
  const lifecycle = [];
  const results = [];
  return {
    lifecycle,
    results,
    value: {
      onLifecycle: (value) => lifecycle.push({ ...value }),
      onResult: (value) => results.push(value),
    },
  };
}

test("uses injected assets and worker while preserving capture, lifecycle, and reset behavior", async () => {
  const { stream, track } = fakeStream();
  const browser = installBrowserFakes({ getUserMedia: async () => stream });
  const worker = new FakeWorker();
  const observed = callbacks();
  const recognizer = new BrowserOnlineAmtRecognizer({
    modelUrl: "https://assets.example/model.onnx",
    workletUrl: "https://assets.example/capture.js",
    createWorker: () => worker,
  });

  try {
    recognizer.setTarget([67, 60, 60, 61.5, Number.NaN]);
    const startedAt = performance.now();
    const starting = recognizer.start(7, observed.value);
    assert.deepEqual(observed.lifecycle, [{
      state: "initializing",
      inputSource: "microphone",
      input: "loading",
      analysis: "loading",
    }]);
    assert.deepEqual(worker.messages, [{
      type: "initialize",
      modelUrl: "https://assets.example/model.onnx",
      numThreads: ONLINE_AMT_WASM_THREADS,
      graphOptimizationLevel: "all",
      enableCpuMemArena: true,
      enableMemPattern: true,
      executionMode: "sequential",
    }]);
    assert.deepEqual(browser.state.mediaConstraints, [{
      audio: {
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
      video: false,
    }]);

    worker.emit({ type: "initialized", loadTimeMs: 12 });
    await starting;
    assert.deepEqual(observed.lifecycle.map(({ state, input, analysis }) => ({
      state,
      input,
      analysis,
    })), [
      { state: "initializing", input: "loading", analysis: "loading" },
      { state: "initializing", input: "loading", analysis: "ready" },
      { state: "initializing", input: "ready", analysis: "ready" },
      { state: "listening", input: "ready", analysis: "ready" },
    ]);

    const context = browser.state.contexts[0];
    const capture = browser.state.workletNodes[0];
    const source = context.sources[0];
    const gain = context.gains[0];
    assert.deepEqual(context.options, { latencyHint: "interactive", sampleRate: 16_000 });
    assert.deepEqual(context.modules, ["https://assets.example/capture.js"]);
    assert.equal(context.resumeCount, 1);
    assert.equal(capture.name, "online-amt-capture");
    assert.deepEqual(capture.options, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1,
    });
    assert.deepEqual(source.connections, [capture]);
    assert.deepEqual(capture.connections, [gain]);
    assert.deepEqual(gain.connections, [context.destination]);
    assert.equal(gain.gain.value, 0);

    recognizer.setGeneration(8);
    const audio = new ArrayBuffer(512 * Float32Array.BYTES_PER_ELEMENT);
    capture.port.emit({ type: "audio", audio, audioTimeMs: 250 });
    const audioMessage = worker.messages.at(-1);
    assert.equal(audioMessage.type, "audio");
    assert.equal(audioMessage.audio, audio);
    assert.equal(audioMessage.generation, 8);
    assert.deepEqual(audioMessage.targetPitches, [60, 67]);
    assert.ok(audioMessage.capturedAtMs >= startedAt + 250);
    assert.ok(audioMessage.capturedAtMs <= performance.now() + 250);
    assert.deepEqual(worker.transfers.at(-1), [audio]);

    const result = {
      type: "result",
      generation: 8,
      onsets: [],
      recognizedActivePitches: [],
      targetPitchEvidence: [],
      processingTimeMs: 3,
      capturedAtMs: 400,
    };
    worker.emit(result);
    assert.deepEqual(observed.results, [result]);

    const messagesBeforePause = worker.messages.length;
    recognizer.pause(9);
    assert.deepEqual(worker.messages.at(-1), { type: "reset" });
    assert.deepEqual(capture.port.messages.at(-1), { type: "pause" });
    capture.port.emit({ type: "audio", audio: new ArrayBuffer(4), audioTimeMs: 300 });
    assert.equal(worker.messages.length, messagesBeforePause + 1);
    assert.equal(observed.lifecycle.at(-1).state, "paused");

    recognizer.resume(10);
    assert.deepEqual(worker.messages.at(-1), { type: "reset" });
    assert.deepEqual(capture.port.messages.at(-1), { type: "resume" });
    assert.equal(observed.lifecycle.at(-1).state, "listening");
    capture.port.emit({ type: "audio", audio: new ArrayBuffer(4), audioTimeMs: 320 });
    assert.equal(worker.messages.at(-1).generation, 10);

    recognizer.flush();
    assert.deepEqual(worker.messages.at(-1), { type: "reset" });
    assert.deepEqual(capture.port.messages.at(-1), { type: "flush" });

    recognizer.stop();
    assert.deepEqual(capture.port.messages.at(-1), { type: "pause" });
    assert.equal(source.disconnectCount, 1);
    assert.equal(capture.disconnectCount, 1);
    assert.equal(gain.disconnectCount, 1);
    assert.equal(track.stopCount, 1);
    assert.equal(context.closeCount, 1);
    assert.deepEqual(worker.messages.at(-1), { type: "stop" });
    assert.equal(worker.terminated, true);
  } finally {
    recognizer.stop();
    browser.restore();
  }
});

test("maps initialization failures and cleans up acquired resources", async () => {
  const { stream, track } = fakeStream();
  const browser = installBrowserFakes({ getUserMedia: async () => stream });
  const worker = new FakeWorker();
  const observed = callbacks();
  const recognizer = new BrowserOnlineAmtRecognizer({
    modelUrl: "/model.onnx",
    workletUrl: "/capture.js",
    createWorker: () => worker,
  });

  try {
    const starting = recognizer.start(1, observed.value);
    worker.fail("model initialization failed");
    await assert.rejects(starting, /model initialization failed/);
    await Promise.resolve();
    assert.equal(observed.lifecycle.at(-1).state, "error");
    assert.equal(observed.lifecycle.at(-1).input, "error");
    assert.equal(observed.lifecycle.at(-1).analysis, "error");
    assert.equal(observed.lifecycle.at(-1).error, "model initialization failed");
    assert.equal(track.stopCount, 1);
    assert.deepEqual(worker.messages.at(-1), { type: "stop" });
    assert.equal(worker.terminated, true);
  } finally {
    recognizer.stop();
    browser.restore();
  }
});

test("turns a post-initialization worker failure into a terminal lifecycle", async () => {
  const { stream, track } = fakeStream();
  const browser = installBrowserFakes({ getUserMedia: async () => stream });
  const worker = new FakeWorker();
  const observed = callbacks();
  const recognizer = new BrowserOnlineAmtRecognizer({
    modelUrl: "/model.onnx",
    workletUrl: "/capture.js",
    createWorker: () => worker,
  });

  try {
    const starting = recognizer.start(1, observed.value);
    worker.emit({ type: "initialized", loadTimeMs: 1 });
    await starting;
    const context = browser.state.contexts[0];

    worker.emit({ type: "error", message: "inference failed" });
    assert.deepEqual(observed.lifecycle.at(-1), {
      state: "error",
      inputSource: "microphone",
      input: "idle",
      analysis: "error",
      error: "inference failed",
    });
    assert.equal(track.stopCount, 1);
    assert.equal(context.closeCount, 1);
    assert.deepEqual(worker.messages.at(-1), { type: "stop" });
    assert.equal(worker.terminated, true);
  } finally {
    recognizer.stop();
    browser.restore();
  }
});

test("stops a pending start and discards its eventual microphone stream", async () => {
  const pendingStream = deferred();
  const { stream, track } = fakeStream();
  const browser = installBrowserFakes({ getUserMedia: () => pendingStream.promise });
  const worker = new FakeWorker();
  const observed = callbacks();
  const recognizer = new BrowserOnlineAmtRecognizer({
    modelUrl: "/model.onnx",
    workletUrl: "/capture.js",
    createWorker: () => worker,
  });

  try {
    const starting = recognizer.start(1, observed.value);
    worker.emit({ type: "initialized", loadTimeMs: 1 });
    recognizer.stop();
    pendingStream.resolve(stream);
    await starting;
    assert.equal(track.stopCount, 1);
    assert.equal(browser.state.contexts.length, 0);
    assert.deepEqual(worker.messages.at(-1), { type: "stop" });
    assert.equal(worker.terminated, true);
  } finally {
    recognizer.stop();
    browser.restore();
  }
});
