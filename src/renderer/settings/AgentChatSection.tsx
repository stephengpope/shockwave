import React, { useEffect, useState } from 'react';
import Combobox from '../Combobox.jsx';
import { DEFAULT_PROVIDER_SLUG } from '../constants.js';

// Our generic OpenAI-compatible endpoint slug (Ollama, LM Studio, vLLM, gateways).
const COMPATIBLE_SLUG = 'openai-compatible';

// Human labels for pi's thinking levels (dropdown display).
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
      <div className="settings-field">
        <label className="settings-field-label" htmlFor={`${idPrefix}-provider`}>Provider</label>
        <Combobox
          id={`${idPrefix}-provider`}
          options={providers}
          value={provider}
          // Switching providers invalidates the model AND the endpoint — clear
          // both so a stale openai-compatible baseUrl doesn't bleed across.
          onChange={(next) => onChange({ provider: next, model: '', baseUrl: '' })}
          freeForm={false}
        />
      </div>

      {isCompatible && (
        <div className="settings-field">
          <label className="settings-field-label" htmlFor={`${idPrefix}-base-url`}>Base URL</label>
          <input
            id={`${idPrefix}-base-url`}
            className="settings-input settings-input-mono"
            type="text"
            value={baseUrl ?? ''}
            placeholder="http://localhost:11434/v1"
            onChange={(e) => onChange({ baseUrl: e.target.value })}
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
          />
          <p className="settings-field-hint">
            Ollama: http://localhost:11434/v1<br />
            LM Studio: http://localhost:1234/v1
          </p>
        </div>
      )}

      <div className="settings-field">
        <label className="settings-field-label" htmlFor={`${idPrefix}-model`}>Model</label>
        <Combobox
          id={`${idPrefix}-model`}
          options={models}
          value={model}
          onChange={(next) => onChange({ model: next })}
          // Built-in providers: validated dropdown — you can filter by typing but
          // can only commit a real catalog model, so a nonexistent id can't be
          // saved. openai-compatible has no catalog (local/custom endpoints), so
          // it stays free-form (type the id yourself; Test populates the list).
          freeForm={isCompatible}
        />
        {/* Surface a saved model that isn't in the current catalog (e.g. a stale
            or mistyped id from before validation) so it's obvious it won't run. */}
        {!isCompatible && model && models.length > 0 && !models.includes(model) && (
          <p className="settings-field-hint" style={{ color: 'var(--fg-error)' }}>
            “{model}” isn’t in {provider}’s catalog — pick a model from the list.
          </p>
        )}
      </div>

      {isCompatible && (
        <div className="settings-field">
          <label className="settings-field-label" htmlFor={`${idPrefix}-ctx`}>Context window</label>
          <input
            id={`${idPrefix}-ctx`}
            className="settings-input"
            type="number"
            min={1}
            value={contextWindow ?? ''}
            placeholder="128000"
            onChange={(e) => onChange({ contextWindow: e.target.value ? Number(e.target.value) : undefined })}
          />
          <p className="settings-field-hint">Tokens the model can hold. Leave blank for 128000.</p>
        </div>
      )}

      {thinkingLevels.length > 1 && (
        <div className="settings-field">
          <label className="settings-field-label" htmlFor={`${idPrefix}-thinking`}>Reasoning</label>
          <select
            id={`${idPrefix}-thinking`}
            className="settings-input"
            value={thinkingLevel ?? 'off'}
            onChange={(e) => onChange({ thinkingLevel: e.target.value })}
          >
            {thinkingLevels.map((l) => (
              <option key={l} value={l}>{THINKING_LABELS[l] ?? l}</option>
            ))}
          </select>
          <p className="settings-field-hint">
            Extended thinking before each reply. Higher = more reasoning, more tokens and latency.
            Streamed live in the chat sidebar.
          </p>
        </div>
      )}

      <div className="settings-field">
        <label className="settings-field-label" htmlFor={`${idPrefix}-key`}>
          API key{isCompatible ? ' (optional for local)' : ''}
        </label>
        <div className="settings-input-row">
          <input
            id={`${idPrefix}-key`}
            className="settings-input"
            type={showKey ? 'text' : 'password'}
            value={apiKey}
            onChange={(e) => onKeyChange(e.target.value)}
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
          {/* Test is openai-compatible only: it probes {baseUrl}/models, which is
              uniform for OpenAI-style endpoints. Cloud providers have non-uniform
              /models paths + auth, and pi already supplies their model lists, so
              their keys just validate on first message. */}
          {isCompatible && (
            <button
              type="button"
              className="settings-input-toggle"
              onClick={handleValidate}
              disabled={validateState === 'loading' || !baseUrl}
              title="Test connection (GET /models)"
            >
              {validateLabel}
            </button>
          )}
        </div>
        {isCompatible && validateMsg && (
          <p
            className="settings-field-hint"
            style={{ color: validateState === 'error' ? 'var(--fg-error)' : 'var(--accent)' }}
          >
            {validateMsg}
          </p>
        )}
      </div>
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
    <div className="settings-section">
      <h2 className="settings-section-title">Agent Chat</h2>
      <p className="settings-section-desc">
        The chat sidebar agent can read, edit, and run commands inside your active workspace.
        API keys are encrypted on this machine using your OS keychain.
      </p>

      <h3 className="settings-subsection-title">LLM</h3>
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

      <h3 className="settings-subsection-title">System Prompt</h3>
      <p className="settings-tab-intro">
        The agent's instructions are assembled automatically from your workspace's{' '}
        <code>SOUL.md</code> (its role and voice — edit it like any file, or leave it out for the
        built-in default) plus Shockwave's internal helper. Per-project notes go in{' '}
        <code>AGENTS.md</code> at your workspace root.
      </p>
    </div>
  );
}
