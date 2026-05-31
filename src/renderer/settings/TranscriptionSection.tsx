import React, { useRef, useState } from 'react';
import { useVoiceInput } from '../voice/useVoiceInput.js';
import { VoiceBars } from '../voice/VoiceBars.jsx';

// Settings page for voice transcription. Two jobs:
//   1. Capture + store the AssemblyAI API key (encrypted in main).
//   2. Provide a "Test microphone" button that exercises the full streaming
//      pipeline. The first-click side-effect is what matters most: the browser
//      asks for mic permission HERE, persistently grants it for the Electron
//      origin, and the chat composer's mic skips the permission prompt forever
//      after.
export default function TranscriptionSection({ transcription, onTranscriptionChange }) {
  const apiKey = transcription?.apiKey ?? '';
  const [showKey, setShowKey] = useState(false);

  const update = (patch) => onTranscriptionChange?.({
    provider: 'assemblyai',
    apiKey,
    ...patch,
  });

  // Test-mic local state. Independent hook instance from the composer's —
  // each gets its own token cache.
  const volumeRef = useRef(0);
  const [partial, setPartial] = useState('');
  const [finalText, setFinalText] = useState('');
  const [testError, setTestError] = useState<any>(null);

  const { voiceAvailable, isConnecting, isRecording, startRecording, stopRecording } = useVoiceInput({
    getToken: () => window.api.voice.getToken(),
    onTranscript: (t) => {
      setFinalText((prev) => (prev ? prev + ' ' : '') + t);
      setPartial('');
    },
    onPartialTranscript: setPartial,
    onError: setTestError,
    onVolumeChange: (rms) => { volumeRef.current = rms; },
  });

  const onTest = () => {
    setTestError(null);
    if (isRecording || isConnecting) {
      stopRecording();
    } else {
      setFinalText('');
      setPartial('');
      startRecording();
    }
  };

  const buttonLabel = isConnecting
    ? 'Connecting…'
    : isRecording
      ? 'Stop'
      : 'Test microphone';

  return (
    <div className="settings-section">
      <h2 className="settings-section-title">Transcription</h2>
      <p className="settings-section-desc">
        Voice input uses AssemblyAI streaming transcription. Get a key from{' '}
        <a
          href="#"
          onClick={(e) => { e.preventDefault(); window.api.openExternal('https://www.assemblyai.com/dashboard/signup'); }}
        >assemblyai.com</a>
        . The key is encrypted on this machine using your OS keychain.
      </p>

      <div className="settings-field">
        <label className="settings-field-label" htmlFor="transcription-key">AssemblyAI API key</label>
        <div className="settings-input-row">
          <input
            id="transcription-key"
            className="settings-input"
            type={showKey ? 'text' : 'password'}
            value={apiKey}
            onChange={(e) => update({ apiKey: e.target.value })}
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
          />
          <button
            type="button"
            className="settings-input-toggle"
            onClick={() => setShowKey((v) => !v)}
          >
            {showKey ? 'Hide' : 'Show'}
          </button>
        </div>
      </div>

      <h3 className="settings-subsection-title" style={{ marginTop: 24 }}>Test microphone</h3>
      <p className="settings-tab-intro">
        Verifies your key works AND grants the browser microphone permission so
        the first click in the chat composer is instant.
      </p>

      <div className="transcription-test">
        <button
          type="button"
          className="settings-button"
          onClick={onTest}
          disabled={!apiKey || (!voiceAvailable && !isConnecting && !isRecording)}
        >
          {isRecording && <VoiceBars volumeRef={volumeRef} isRecording={isRecording} />}
          <span style={{ marginLeft: isRecording ? 8 : 0 }}>{buttonLabel}</span>
        </button>
        {!apiKey && (
          <p className="settings-field-hint">Enter your AssemblyAI key first.</p>
        )}
        {apiKey && !voiceAvailable && !isConnecting && !isRecording && (
          <p className="settings-field-hint">Checking key…</p>
        )}
        {testError && <p className="settings-field-hint" style={{ color: 'var(--fg-error)' }}>{testError}</p>}
      </div>

      <div className="transcription-result">
        {(finalText || partial) ? (
          <div className="transcription-result-text">
            <span>{finalText}</span>
            {finalText && partial ? ' ' : ''}
            <span className="transcription-partial">{partial}</span>
          </div>
        ) : (
          <div className="transcription-result-placeholder">
            Click and speak. We'll show what we hear.
          </div>
        )}
      </div>
    </div>
  );
}
