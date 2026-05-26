import { useState, useRef, useEffect, useCallback } from 'react';

// Registered inline as a Blob URL so we don't need a separate static file.
const WORKLET_SRC = /* js */ `
class PcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(4096);
    this.offset = 0;
  }
  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;
    let i = 0;
    while (i < input.length) {
      const remaining = this.buffer.length - this.offset;
      const toCopy = Math.min(remaining, input.length - i);
      this.buffer.set(input.subarray(i, i + toCopy), this.offset);
      this.offset += toCopy;
      i += toCopy;
      if (this.offset >= this.buffer.length) {
        this.port.postMessage(this.buffer.slice());
        this.offset = 0;
      }
    }
    return true;
  }
}
registerProcessor('pcm-processor', PcmProcessor);
`;

// Reusable voice input hook using AssemblyAI real-time transcription.
//
// Performance: prefetches a token on mount and caches it for 50s (server TTL is
// 60s). On click, consumes the cached token instantly and kicks off a
// background refresh so the next click is also instant. Without this, every
// click would pay the renderer→main→AssemblyAI round-trip.
export function useVoiceInput({ getToken, onTranscript, onPartialTranscript, onError, onVolumeChange }) {
  const [isConnecting, setIsConnecting] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [voiceAvailable, setVoiceAvailable] = useState(false);
  const wsRef = useRef(null);
  const streamRef = useRef(null);
  const audioCtxRef = useRef(null);
  const workletRef = useRef(null);
  const sourceRef = useRef(null);
  const cleaningUpRef = useRef(false);
  const connectingRef = useRef(false);

  const tokenRef = useRef(null);
  const tokenTimeRef = useRef(0);
  const TOKEN_MAX_AGE = 50_000;

  const fetchVoiceToken = useCallback(async () => {
    const result = await getToken();
    if (!result.error) {
      tokenRef.current = result.token;
      tokenTimeRef.current = Date.now();
      setVoiceAvailable(true);
    } else {
      setVoiceAvailable(false);
    }
    return result;
  }, [getToken]);

  useEffect(() => {
    fetchVoiceToken();
  }, [fetchVoiceToken]);

  const getReadyToken = useCallback(async () => {
    if (tokenRef.current && Date.now() - tokenTimeRef.current < TOKEN_MAX_AGE) {
      const token = tokenRef.current;
      tokenRef.current = null;
      fetchVoiceToken();
      return { token };
    }
    return fetchVoiceToken();
  }, [fetchVoiceToken]);

  const cleanup = useCallback(() => {
    if (cleaningUpRef.current) return;
    cleaningUpRef.current = true;

    if (workletRef.current) {
      workletRef.current.disconnect();
      workletRef.current = null;
    }
    if (sourceRef.current) {
      sourceRef.current.disconnect();
      sourceRef.current = null;
    }
    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (wsRef.current) {
      if (wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'Terminate' }));
      }
      wsRef.current.close();
      wsRef.current = null;
    }

    connectingRef.current = false;
    setIsConnecting(false);
    setIsRecording(false);
    cleaningUpRef.current = false;
  }, []);

  useEffect(() => cleanup, [cleanup]);

  const startRecording = useCallback(async () => {
    if (connectingRef.current || cleaningUpRef.current) return;
    connectingRef.current = true;
    setIsConnecting(true);

    try {
      const result = await getReadyToken();
      if (result.error) {
        onError?.(result.error);
        cleanup();
        return;
      }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const audioCtx = new AudioContext({ sampleRate: 16000 });
      audioCtxRef.current = audioCtx;

      const blob = new Blob([WORKLET_SRC], { type: 'application/javascript' });
      const workletUrl = URL.createObjectURL(blob);
      await audioCtx.audioWorklet.addModule(workletUrl);
      URL.revokeObjectURL(workletUrl);

      const ws = new WebSocket(
        `wss://streaming.assemblyai.com/v3/ws?token=${result.token}&sample_rate=16000&encoding=pcm_s16le`,
      );
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;

      ws.onopen = () => {
        const source = audioCtx.createMediaStreamSource(stream);
        sourceRef.current = source;

        const workletNode = new AudioWorkletNode(audioCtx, 'pcm-processor');
        workletRef.current = workletNode;

        workletNode.port.onmessage = (e) => {
          if (ws.readyState !== WebSocket.OPEN) return;
          const float32 = e.data;
          const int16 = new Int16Array(float32.length);
          let sum = 0;
          for (let i = 0; i < float32.length; i++) {
            const s = Math.max(-1, Math.min(1, float32[i]));
            int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
            sum += s * s;
          }
          ws.send(int16.buffer);
          if (onVolumeChange) onVolumeChange(Math.sqrt(sum / float32.length));
        };

        source.connect(workletNode);
        workletNode.connect(audioCtx.destination);
        setIsConnecting(false);
        setIsRecording(true);
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'Turn') {
            const text = data.transcript?.trim();
            if (data.end_of_turn) {
              if (text) onTranscript(text);
              onPartialTranscript?.('');
            } else {
              onPartialTranscript?.(text || '');
            }
          }
        } catch {
          // ignore parse errors
        }
      };

      ws.onerror = () => {
        onError?.('Voice connection error');
        cleanup();
      };

      ws.onclose = () => {
        cleanup();
      };
    } catch (err) {
      if (err.name === 'NotAllowedError') {
        onError?.('Microphone permission denied');
      } else {
        onError?.('Failed to start voice input');
      }
      cleanup();
    }
  }, [getReadyToken, onTranscript, onPartialTranscript, onError, onVolumeChange, cleanup]);

  const stopRecording = useCallback(() => {
    cleanup();
  }, [cleanup]);

  return { voiceAvailable, isConnecting, isRecording, startRecording, stopRecording };
}
