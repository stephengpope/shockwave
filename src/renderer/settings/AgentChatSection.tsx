import React, { useEffect, useState } from 'react';
import Combobox from '../Combobox.jsx';
import { DEFAULT_PROVIDER_SLUG } from '../constants.js';
import { SettingsSection, SettingsGroup, SettingsDivider } from './SectionUI';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from '@/components/ui/input-group';

// Our generic OpenAI-compatible endpoint slug (Ollama, LM Studio, vLLM, gateways).
const COMPATIBLE_SLUG = 'openai-compatible';

// Human labels for the reasoning levels (pi's vocabulary, dropdown display).
const THINKING_LABELS: Record<string, string> = {
  off: 'Off',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
};

function ProviderModelKey({ idPrefix, provider, model, apiKey, baseUrl, contextWindow, thinkingLevel, onChange, onKeyChange }) {
  const [showKey, setShowKey] = useState(false);
  const [providers, setProviders] = useState<any[]>([]);
  const [models, setModels] = useState<any[]>([]);
  const [thinkingLevels, setThinkingLevels] = useState<string[]>([]);
  const [validateState, setValidateState] = useState<'idle' | 'loading' | 'ok' | 'error'>('idle');
  const [validateMsg, setValidateMsg] = useState('');

  const isCompatible = provider === COMPATIBLE_SLUG;

  // Providers come from pi-ai's registry plus our injected openai-compatible
  // (intersected with our supported set in main). Fetched once on mount.
  useEffect(() => {
    let active = true;
    window.api.agent.listProviders().then((list) => {
      if (active) setProviders(list ?? []);
    });
    return () => { active = false; };
  }, []);

  // Models are scoped to the current provider. openai-compatible has no static
  // catalog — its models come from the Test button (or are typed free-form) —
  // so skip the fetch for it, otherwise this would wipe a Test-populated list.
  useEffect(() => {
    if (!provider || provider === COMPATIBLE_SLUG) return;
    let active = true;
    window.api.agent.listModels(provider).then((list) => {
      if (active) setModels(list ?? []);
    });
    return () => { active = false; };
  }, [provider]);

  // Supported thinking levels for the chosen provider+model. Built-in models
  // carry per-model reasoning metadata; openai-compatible returns a static list.
  // A single-entry (['off']) result means the model has no reasoning — the
  // dropdown is then hidden.
  useEffect(() => {
    if (!provider) { setThinkingLevels([]); return; }
    let active = true;
    window.api.agent.listThinkingLevels({ provider, model }).then((list) => {
      if (active) setThinkingLevels(list ?? []);
    });
    return () => { active = false; };
  }, [provider, model]);

  // Reset the transient Test result whenever the inputs it validated change.
  useEffect(() => { setValidateState('idle'); setValidateMsg(''); }, [provider, baseUrl, apiKey]);

  const handleValidate = async () => {
    setValidateState('loading');
    setValidateMsg('');
    try {
      const result = await window.api.agent.validateConnection({ baseUrl, apiKey });
      if (result.ok) {
        setValidateState('ok');
        if (result.models?.length) {
          setModels(result.models);
          // Convenience: a single discovered model auto-selects.
          if (!model && result.models.length === 1) onChange({ model: result.models[0] });
          setValidateMsg(`Connection OK · ${result.models.length} model${result.models.length === 1 ? '' : 's'}`);
        } else {
          setValidateMsg('Connection OK');
        }
      } else {
        setValidateState('error');
        setValidateMsg(result.error ?? 'Connection failed');
      }
    } catch (err) {
      setValidateState('error');
      setValidateMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const validateLabel = validateState === 'loading' ? '…'
    : validateState === 'ok' ? '✓'
      : validateState === 'error' ? '✗'
        : 'Test';

  return (
    <>
      <Field>
        <FieldLabel htmlFor={`${idPrefix}-provider`}>Provider</FieldLabel>
        <Select
          value={provider}
          // Switching providers invalidates the model AND the endpoint — clear
          // both so a stale openai-compatible baseUrl doesn't bleed across.
          onValueChange={(next) => onChange({ provider: next, model: '', baseUrl: '' })}
        >
          <SelectTrigger id={`${idPrefix}-provider`} className="w-full">
            <SelectValue>{provider || undefined}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {providers.map((p) => (
              <SelectItem key={p} value={p}>{p}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      {isCompatible && (
        <Field>
          <FieldLabel htmlFor={`${idPrefix}-base-url`}>Base URL</FieldLabel>
          <Input
            id={`${idPrefix}-base-url`}
            className="font-mono"
            type="text"
            value={baseUrl ?? ''}
            placeholder="http://localhost:11434/v1"
            onChange={(e) => onChange({ baseUrl: e.target.value })}
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
          />
          <FieldDescription className="text-xs">
            Ollama: http://localhost:11434/v1<br />
            LM Studio: http://localhost:1234/v1
          </FieldDescription>
        </Field>
      )}

      <Field>
        <FieldLabel htmlFor={`${idPrefix}-model`}>Model</FieldLabel>
        {/* Built-in providers: validated dropdown — only a real catalog model
            can be committed, so a nonexistent id can't be saved.
            openai-compatible has no catalog (local/custom endpoints), so it
            stays a free-form combobox (type the id yourself; Test populates
            the suggestion list). */}
        {isCompatible ? (
          <Combobox
            id={`${idPrefix}-model`}
            options={models}
            value={model}
            onChange={(next) => onChange({ model: next })}
            freeForm
          />
        ) : (
          <Select value={model} onValueChange={(next) => onChange({ model: next })}>
            <SelectTrigger id={`${idPrefix}-model`} className="w-full">
              <SelectValue placeholder={model || undefined}>{model || undefined}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {models.map((m) => (
                <SelectItem key={m} value={m}>{m}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {/* Surface a saved model that isn't in the current catalog (e.g. a stale
            or mistyped id from before validation) so it's obvious it won't run. */}
        {!isCompatible && model && models.length > 0 && !models.includes(model) && (
          <p className="text-xs text-destructive">
            “{model}” isn’t in {provider}’s catalog — pick a model from the list.
          </p>
        )}
      </Field>

      {isCompatible && (
        <Field>
          <FieldLabel htmlFor={`${idPrefix}-ctx`}>Context window</FieldLabel>
          <Input
            id={`${idPrefix}-ctx`}
            type="number"
            min={1}
            value={contextWindow ?? ''}
            placeholder="128000"
            onChange={(e) => onChange({ contextWindow: e.target.value ? Number(e.target.value) : undefined })}
          />
          <FieldDescription className="text-xs">Tokens the model can hold. Leave blank for 128000.</FieldDescription>
        </Field>
      )}

      {thinkingLevels.length > 1 && (
        <Field>
          <FieldLabel htmlFor={`${idPrefix}-thinking`}>Reasoning</FieldLabel>
          <Select
            value={thinkingLevel ?? 'off'}
            onValueChange={(next) => onChange({ thinkingLevel: next })}
          >
            <SelectTrigger id={`${idPrefix}-thinking`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {thinkingLevels.map((l) => (
                <SelectItem key={l} value={l}>{THINKING_LABELS[l] ?? l}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FieldDescription className="text-xs">
            Extended thinking before each reply. Higher = more reasoning, more tokens and latency.
            Streamed live in the chat sidebar.
          </FieldDescription>
        </Field>
      )}

      <Field>
        <FieldLabel htmlFor={`${idPrefix}-key`}>
          API key{isCompatible ? ' (optional for local)' : ''}
        </FieldLabel>
        <InputGroup>
          <InputGroupInput
            id={`${idPrefix}-key`}
            className="font-mono"
            type={showKey ? 'text' : 'password'}
            value={apiKey}
            onChange={(e) => onKeyChange(e.target.value)}
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
          />
          <InputGroupAddon align="inline-end">
            <InputGroupButton onClick={() => setShowKey((v) => !v)}>
              {showKey ? 'Hide' : 'Show'}
            </InputGroupButton>
            {/* Test is openai-compatible only: it probes {baseUrl}/models, which is
                uniform for OpenAI-style endpoints. Cloud providers have non-uniform
                /models paths + auth, and pi already supplies their model lists, so
                their keys just validate on first message. */}
            {isCompatible && (
              <InputGroupButton
                onClick={handleValidate}
                disabled={validateState === 'loading' || !baseUrl}
                title="Test connection (GET /models)"
              >
                {validateLabel}
              </InputGroupButton>
            )}
          </InputGroupAddon>
        </InputGroup>
        {isCompatible && validateMsg && (
          <p className={validateState === 'error' ? 'text-xs text-destructive' : 'text-xs text-success'}>
            {validateMsg}
          </p>
        )}
      </Field>
    </>
  );
}

export default function AgentChatSection({ codingAgent, onCodingAgentChange }) {
  const caProvider = codingAgent?.provider ?? DEFAULT_PROVIDER_SLUG;
  const caModel = codingAgent?.model ?? '';
  const caProviderKeys = codingAgent?.providerKeys ?? {};
  // The active provider's key (each provider keeps its own — switching doesn't lose it).
  const caApiKey = caProviderKeys[caProvider] ?? '';
  const caBaseUrl = codingAgent?.baseUrl ?? '';
  const caContextWindow = codingAgent?.contextWindow;
  const caThinkingLevel = codingAgent?.thinkingLevel ?? 'medium';
  const updateCa = (patch) => onCodingAgentChange?.({
    provider: caProvider,
    model: caModel,
    providerKeys: caProviderKeys,
    baseUrl: caBaseUrl,
    contextWindow: caContextWindow,
    thinkingLevel: caThinkingLevel,
    ...patch,
  });
  // Key edits write into the active provider's slot, leaving other providers' keys intact.
  const updateKey = (value) => updateCa({ providerKeys: { ...caProviderKeys, [caProvider]: value } });

  return (
    <SettingsSection
      title="Agent Chat"
      description="The chat sidebar agent can read, edit, and run commands inside your active workspace. API keys are encrypted on this machine using your OS keychain."
    >
      <SettingsGroup title="LLM">
        <ProviderModelKey
          idPrefix="coding-agent"
          provider={caProvider}
          model={caModel}
          apiKey={caApiKey}
          baseUrl={caBaseUrl}
          contextWindow={caContextWindow}
          thinkingLevel={caThinkingLevel}
          onChange={updateCa}
          onKeyChange={updateKey}
        />
      </SettingsGroup>
    </SettingsSection>
  );
}
