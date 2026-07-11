import React, { useRef, useState } from 'react';
import { useVoiceInput } from '../voice/useVoiceInput.js';
import { VoiceBars } from '../voice/VoiceBars.jsx';
import { SettingsSection, SettingsGroup, SettingsDivider } from './SectionUI';
import { Field, FieldLabel } from '@/components/ui/field';
import { Button } from '@/components/ui/button';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from '@/components/ui/input-group';

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
    <SettingsSection
      title="Transcription"
      description={(
        <>
          Voice input uses AssemblyAI streaming transcription. Get a key from{' '}
          <a
            href="#"
            className="text-primary underline underline-offset-2 hover:opacity-80"
            onClick={(e) => { e.preventDefault(); window.api.openExternal('https://www.assemblyai.com/dashboard/signup'); }}
          >assemblyai.com</a>
          . The key is encrypted on this machine using your OS keychain.
        </>
      )}
    >
      <SettingsGroup>
        <Field>
          <FieldLabel htmlFor="transcription-key">AssemblyAI API key</FieldLabel>
          <InputGroup>
            <InputGroupInput
              id="transcription-key"
              type={showKey ? 'text' : 'password'}
              value={apiKey}
              onChange={(e) => update({ apiKey: e.target.value })}
              spellCheck={false}
              autoComplete="off"
              autoCorrect="off"
            />
            <InputGroupAddon align="inline-end">
              <InputGroupButton onClick={() => setShowKey((v) => !v)}>
                {showKey ? 'Hide' : 'Show'}
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
        </Field>
      </SettingsGroup>

      <SettingsDivider />

      <SettingsGroup title="Test microphone">
        <p className="text-xs text-muted-foreground">
          Verifies your key works AND grants the browser microphone permission so
          the first click in the chat composer is instant.
        </p>

        <div className="flex flex-col gap-1">
          <Button
            type="button"
            size="sm"
            className="w-fit"
            onClick={onTest}
            disabled={!apiKey || (!voiceAvailable && !isConnecting && !isRecording)}
          >
            {isRecording && <VoiceBars volumeRef={volumeRef} isRecording={isRecording} />}
            <span>{buttonLabel}</span>
          </Button>
          {!apiKey && (
            <p className="text-xs text-muted-foreground">Enter your AssemblyAI key first.</p>
          )}
          {apiKey && !voiceAvailable && !isConnecting && !isRecording && (
            <p className="text-xs text-muted-foreground">Checking key…</p>
          )}
          {testError && <p className="text-xs text-destructive">{testError}</p>}
        </div>

        <div className="min-h-[60px] rounded-md border border-border bg-muted/40 px-3 py-2.5 text-[13px] leading-normal">
          {(finalText || partial) ? (
            <div className="text-foreground">
              <span>{finalText}</span>
              {finalText && partial ? ' ' : ''}
              <span className="italic text-muted-foreground">{partial}</span>
            </div>
          ) : (
            <div className="italic text-muted-foreground">
              Click and speak. We'll show what we hear.
            </div>
          )}
        </div>
      </SettingsGroup>
    </SettingsSection>
  );
}
