import { EventEmitter } from 'eventemitter3';
import WebSocket from 'isomorphic-ws';

const baseEndpoint = "wss://api.retellai.com";
class AudioWsClient extends EventEmitter {
  constructor(audioWsConfig) {
    super();
    this.ws = void 0;
    this.pingTimeout = null;
    this.pingInterval = null;
    this.wasDisconnected = false;
    this.pingIntervalTime = 5000;
    // let endpoint = (audioWsConfig.customEndpoint || baseEndpoint) ;//+ audioWsConfig.callId;
    let endpoint = (audioWsConfig.customEndpoint || baseEndpoint) + "/" +audioWsConfig.callId;
    console.log("Endpoint for audio ws is  " + endpoint);
    endpoint += "?enable_update=true";
    endpoint += `&template_id=${audioWsConfig.template_id}`
    console.log("Endpoint for audio ws is with template id  " + endpoint);
    this.ws = new WebSocket(endpoint);
    this.ws.binaryType = "arraybuffer";
    this.ws.onopen = () => {
      this.emit("open");
      this.startPingPong();
    };
    this.ws.onmessage = event => {
      if (typeof event.data === "string") {
        if (event.data === "pong") {
          if (this.wasDisconnected) {
            this.emit("reconnect");
            this.wasDisconnected = false;
          }
          this.adjustPingFrequency(5000);
        } else if (event.data === "clear") {
          this.emit("clear");
        } else {
          try {
            const update = JSON.parse(event.data);
            this.emit("update", update);
          } catch (err) {
            console.log(err);
          }
        }
      } else if (event.data instanceof ArrayBuffer) {
        const audio = new Uint8Array(event.data);
        this.emit("audio", audio);
      } else {
        console.log("error", "Got unknown message from server.");
      }
    };
    this.ws.onclose = event => {
      this.stopPingPong();
      this.emit("close", event.code, event.reason);
    };
    this.ws.onerror = event => {
      this.stopPingPong();
      this.emit("error", event.error);
    };
  }
  startPingPong() {
    this.pingInterval = setInterval(() => this.sendPing(), this.pingIntervalTime);
    this.resetPingTimeout();
  }
  sendPing() {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send("ping");
    }
  }
  adjustPingFrequency(newInterval) {
    if (this.pingIntervalTime !== newInterval) {
      if (this.pingInterval != null) {
        clearInterval(this.pingInterval);
      }
      this.pingIntervalTime = newInterval;
      this.startPingPong();
    }
  }
  resetPingTimeout() {
    if (this.pingTimeout != null) {
      clearTimeout(this.pingTimeout);
    }
    this.pingTimeout = setTimeout(() => {
      if (this.pingIntervalTime === 5000) {
        this.adjustPingFrequency(1000);
        this.pingTimeout = setTimeout(() => {
          this.emit("disconnect");
          this.wasDisconnected = true;
        }, 3000);
      }
    }, this.pingIntervalTime);
  }
  stopPingPong() {
    if (this.pingInterval != null) {
      clearInterval(this.pingInterval);
    }
    if (this.pingTimeout != null) {
      clearTimeout(this.pingTimeout);
    }
  }
  send(audio) {
    if (this.ws.readyState === 1) {
      this.ws.send(audio);
    }
  }
  close() {
    this.ws.close();
  }
}
function convertUint8ToFloat32(array) {
  const targetArray = new Float32Array(array.byteLength / 2);
  const sourceDataView = new DataView(array.buffer);
  for (let i = 0; i < targetArray.length; i++) {
    targetArray[i] = sourceDataView.getInt16(i * 2, true) / Math.pow(2, 16 - 1);
  }
  return targetArray;
}
function convertFloat32ToUint8(array) {
  const buffer = new ArrayBuffer(array.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < array.length; i++) {
    const value = array[i] * 32768;
    view.setInt16(i * 2, value, true);
  }
  return new Uint8Array(buffer);
}

const workletCode = `
class captureAndPlaybackProcessor extends AudioWorkletProcessor {
    audioData = [];
    index = 0;
  
    constructor() {
      super();
      //set listener to receive audio data, data is float32 array.
      this.port.onmessage = (e) => {
        if (e.data === "clear") {
          // Clear all buffer.
          this.audioData = [];
          this.index = 0;
        } else if (e.data.length > 0) {
          this.audioData.push(this.convertUint8ToFloat32(e.data));
        }
      };
    }
  
    convertUint8ToFloat32(array) {
      const targetArray = new Float32Array(array.byteLength / 2);
    
      // A DataView is used to read our 16-bit little-endian samples out of the Uint8Array buffer
      const sourceDataView = new DataView(array.buffer);
    
      // Loop through, get values, and divide by 32,768
      for (let i = 0; i < targetArray.length; i++) {
        targetArray[i] = sourceDataView.getInt16(i * 2, true) / Math.pow(2, 16 - 1);
      }
      return targetArray;
    }
  
    convertFloat32ToUint8(array) {
      const buffer = new ArrayBuffer(array.length * 2);
      const view = new DataView(buffer);
    
      for (let i = 0; i < array.length; i++) {
        const value = array[i] * 32768;
        view.setInt16(i * 2, value, true); // true for little-endian
      }
    
      return new Uint8Array(buffer);
    }
  
    process(inputs, outputs, parameters) {
      // Capture
      const input = inputs[0];
      const inputChannel1 = input[0];
      const inputChannel2 = input[1];
      this.port.postMessage(this.convertFloat32ToUint8(inputChannel1));
  
      // Playback
      const output = outputs[0];
      const outputChannel1 = output[0];
      const outputChannel2 = output[1];
      // start playback.
      for (let i = 0; i < outputChannel1.length; ++i) {
        if (this.audioData.length > 0) {
          outputChannel1[i] = this.audioData[0][this.index];
          outputChannel2[i] = this.audioData[0][this.index];
          this.index++;
          if (this.index == this.audioData[0].length) {
            this.audioData.shift();
            this.index = 0;
          }
        } else {
          outputChannel1[i] = 0;
          outputChannel2[i] = 0;
        }
      }
  
      return true;
    }
  }
  
  registerProcessor(
    "capture-and-playback-processor",
    captureAndPlaybackProcessor,
  );
`;

class MokAudioClient extends EventEmitter {
  constructor(customEndpoint) {
    super();
    this.liveClient = void 0;
    this.audioContext = void 0;
    this.isCalling = false;
    this.stream = void 0;
    this.audioNode = void 0;
    this.customEndpoint = void 0;
    this.captureNode = null;
    this.audioData = [];
    this.audioDataIndex = 0;
    if (customEndpoint) this.customEndpoint = customEndpoint;
  }
  async startConversation(startConversationConfig) {
    try {
      await this.setupAudioPlayback(startConversationConfig.sampleRate, startConversationConfig.customStream);
      this.liveClient = new AudioWsClient({
        callId: startConversationConfig.callId,
        enableUpdate: startConversationConfig.enableUpdate,
        customEndpoint: this.customEndpoint.customEndpoint,
        template_id: startConversationConfig.template_id
      });
      this.handleAudioEvents();
      this.isCalling = true;
    } catch (err) {
      this.emit("error", err.message);
    }
  }
  stopConversation() {
    var _this$liveClient, _this$audioContext, _this$audioContext2, _this$stream;
    this.isCalling = false;
    (_this$liveClient = this.liveClient) == null || _this$liveClient.close();
    (_this$audioContext = this.audioContext) == null || _this$audioContext.suspend();
    (_this$audioContext2 = this.audioContext) == null || _this$audioContext2.close();
    if (this.isAudioWorkletSupported()) {
      var _this$audioNode;
      (_this$audioNode = this.audioNode) == null || _this$audioNode.disconnect();
      this.audioNode = null;
    } else {
      if (this.captureNode) {
        this.captureNode.disconnect();
        this.captureNode.onaudioprocess = null;
        this.captureNode = null;
        this.audioData = [];
        this.audioDataIndex = 0;
      }
    }
    this.liveClient = null;
    (_this$stream = this.stream) == null || _this$stream.getTracks().forEach(track => track.stop());
    this.audioContext = null;
    this.stream = null;
  }
  handleAudioEvents() {
    this.liveClient.on("open", () => {
      this.emit("conversationStarted");
    });
    this.liveClient.on("audio", audio => {
      this.playAudio(audio);
      this.emit("audio", audio);
    });
    this.liveClient.on("disconnect", () => {
      this.emit("disconnect");
    });
    this.liveClient.on("reconnect", () => {
      this.emit("reconnect");
    });
    this.liveClient.on("error", error => {
      this.emit("error", error);
      if (this.isCalling) {
        this.stopConversation();
      }
    });
    this.liveClient.on("close", (code, reason) => {
      if (this.isCalling) {
        this.stopConversation();
      }
      this.emit("conversationEnded", {
        code,
        reason
      });
    });
    this.liveClient.on("update", update => {
      this.emit("update", update);
    });
    this.liveClient.on("clear", () => {
      if (this.isAudioWorkletSupported()) {
        this.audioNode.port.postMessage("clear");
      } else {
        this.audioData = [];
        this.audioDataIndex = 0;
      }
    });
  }
  async setupAudioPlayback(sampleRate, customStream) {
    if (this.isAudioWorkletSupported()) {
      this.audioContext = new AudioContext({
        sampleRate: sampleRate
      });
      try {
        this.stream = customStream || (await navigator.mediaDevices.getUserMedia({
          audio: {
            sampleRate: sampleRate,
            echoCancellation: true,
            noiseSuppression: true,
            channelCount: 1
          }
        }));
      } catch (error) {
        throw new Error("User didn't give microphone permission");
      }
      console.log("Audio worklet starting");
      this.audioContext.resume();
      const blob = new Blob([workletCode], {
        type: "application/javascript"
      });
      const blobURL = URL.createObjectURL(blob);
      await this.audioContext.audioWorklet.addModule(blobURL);
      console.log("Audio worklet loaded");
      this.audioNode = new AudioWorkletNode(this.audioContext, "capture-and-playback-processor");
      console.log("Audio worklet setup");
      this.audioNode.port.onmessage = e => {
        if (this.liveClient != null) {
          this.liveClient.send(e.data);
        }
      };
      const source = this.audioContext.createMediaStreamSource(this.stream);
      source.connect(this.audioNode);
      this.audioNode.connect(this.audioContext.destination);
    } else {
      this.audioContext = new AudioContext({
        sampleRate: sampleRate
      });
      try {
        this.stream = customStream || (await navigator.mediaDevices.getUserMedia({
          audio: {
            sampleRate: sampleRate,
            echoCancellation: true,
            noiseSuppression: true,
            channelCount: 1
          }
        }));
      } catch (error) {
        throw new Error("User didn't give microphone permission");
      }
      const source = this.audioContext.createMediaStreamSource(this.stream);
      this.captureNode = this.audioContext.createScriptProcessor(2048, 1, 1);
      this.captureNode.onaudioprocess = audioProcessingEvent => {
        if (this.isCalling) {
          const pcmFloat32Data = audioProcessingEvent.inputBuffer.getChannelData(0);
          const pcmData = convertFloat32ToUint8(pcmFloat32Data);
          this.liveClient.send(pcmData);
          const outputBuffer = audioProcessingEvent.outputBuffer;
          const outputChannel = outputBuffer.getChannelData(0);
          for (let i = 0; i < outputChannel.length; ++i) {
            if (this.audioData.length > 0) {
              outputChannel[i] = this.audioData[0][this.audioDataIndex++];
              if (this.audioDataIndex === this.audioData[0].length) {
                this.audioData.shift();
                this.audioDataIndex = 0;
              }
            } else {
              outputChannel[i] = 0;
            }
          }
        }
      };
      source.connect(this.captureNode);
      this.captureNode.connect(this.audioContext.destination);
    }
  }
  isAudioWorkletSupported() {
    return /Chrome/.test(navigator.userAgent) && /Google Inc/.test(navigator.vendor);
  }
  playAudio(audio) {
    if (this.isAudioWorkletSupported()) {
      this.audioNode.port.postMessage(audio);
    } else {
      const float32Data = convertUint8ToFloat32(audio);
      this.audioData.push(float32Data);
    }
  }
}

export { MokAudioClient };