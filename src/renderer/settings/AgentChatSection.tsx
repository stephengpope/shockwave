import React, { useEffect, useState } from 'react';
import Combobox from '../Combobox.jsx';
import { DEFAULT_PROVIDER_SLUG } from '../constants.js';

const LOCAL_PROVIDERS = new Set(['ollama', 'lm-studio', 'openai-compatible']);
const LOCAL_DEFAULT_BASE_URLS = {
  ollama: 'http://localhost:11434',
  'lm-studio': 'http://localhost:1234',
};

function ProviderModelKey({ idPrefix, provider, model, apiKey, baseUrl, contextWindow, onChange }) {
  const [showKey, setShowKey] = useState(false);
  const [providers, setProviders] = useState<any[]>([]);
  const [models, setModels] = useState<any[]>([]);

  const isLocal = LOCAL_PROVIDERS.has(provider);

  useEffect(() => {
    let active = true;
    window.api.agent.listProviders().then((list) => {
      if (active) setProviders(list ?? []);
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!provider || isLocal) return;
    let active = true;
    window.api.agent.listModels(provider).then((list) => {
      if (active) setModels(list ?? []);
    });
    return () => { active = false; };
  }, [provider]);

  const [validateState, setValidateState] = useState<'idle' | 'loading' | 'ok' | 'error'>('idle');
  const [validateMsg, setValidateMsg] = useState('');

  useEffect(() => { setValidateState('idle'); setValidateMsg(''); }, [provider, baseUrl, apiKey]);

  const handleProviderChange = (next) => {
    const patch: any = { provider: next, model: '' };
    if (LOCAL_DEFAULT_BASE_URLS[next]) {
      patch.baseUrl = LOCAL_DEFAULT_BASE_URLS[next];
    } else if (!LOCAL_PROVIDERS.has(next)) {
      patch.baseUrl = '';
    }
    onChange(patch);
  };

  const handleValidate = async () => {
    setValidateState('loading');
    setValidateMsg('');
    try {
      const result = await window.api.agent.validateConnection({ provider, baseUrl, apiKey });
      if (result.ok) {
        setValidateState('ok');
        if (result.models?.length) {
          setModels(result.models);
          if (!model && result.models.length === 1) onChange({ model: result.models[0] });
          setValidateMsg(`Connection OK \u00b7 ${result.models.length} model${result.models.length === 1 ? '' : 's'}`);
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

  const validateLabel = validateState === 'loading' ? '\u2026'
    : validateState === 'ok' ? '\u2713'
      : validateState === 'error' ? '\u2717'
        : 'Test';

  return (
    <>
      <div className="settings-field">
        <label className="settings-field-label" htmlFor={`${idPrefix}-provider`}>Provider</label>
        <Combobox
          id={`${idPrefix}-provider`}
          options={providers}
          value={provider}
          onChange={handleProviderChange}
          freeForm={false}
        />
      </div>

      {isLocal && (
        <div className="settings-field">
          <label className="settings-field-label" htmlFor={`${idPrefix}-base-url`}>Base URL</label>
          <div className="settings-input-row">
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
            <button
              type="button"
              className="settings-input-toggle"
              onClick={handleValidate}
              disabled={validateState === 'loading' || !baseUrl}
              title="Test connection"
            >
              {validateLabel}
            </button>
          </div>
          {validateMsg && (
            <p className="settings-field-hint" style={{ color: validateState === 'error' ? 'var(--fg-error)' : 'var(--accent)' }}>
              {validateMsg}
            </p>
          )}
          <p className="settings-field-hint">
            Ollama: http://localhost:11434{provider === 'openai-compatible' ? '/v1' : ''}<br />
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
          freeForm
        />
      </div>

      {provider === 'openai-compatible' && (
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

      {!isLocal && (
        <div className="settings-field">
          <label className="settings-field-label" htmlFor={`${idPrefix}-key`}>API key</label>
          <div className="settings-input-row">
            <input
              id={`${idPrefix}-key`}
              className="settings-input"
              type={showKey ? 'text' : 'password'}
              value={apiKey}
              onChange={(e) => onChange({ apiKey: e.target.value })}
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
            <button
              type="button"
              className="settings-input-toggle"
              onClick={handleValidate}
              disabled={validateState === 'loading'}
              title="Test connection"
            >
              {validateLabel}
            </button>
          </div>
          {validateMsg && (
            <p className="settings-field-hint" style={{ color: validateState === 'error' ? 'var(--fg-error)' : 'var(--accent)' }}>
              {validateMsg}
            </p>
          )}
        </div>
      )}
    </>
  );
}

export default function AgentChatSection({ codingAgent, onCodingAgentChange }) {
  const caProvider = codingAgent?.provider ?? DEFAULT_PROVIDER_SLUG;
  const caModel = codingAgent?.model ?? '';
  const caApiKey = codingAgent?.apiKey ?? '';
  const caBaseUrl = codingAgent?.baseUrl ?? '';
  const caContextWindow = codingAgent?.contextWindow ?? undefined;
  const caSystemPrompt = codingAgent?.systemPrompt ?? '';

  return (
    <div className="settings-section">
      <h2 className="settings-section-title">Agent</h2>
      <p className="settings-section-desc">Coding agent LLM configuration.</p>

      <ProviderModelKey
        idPrefix="ca"
        provider={caProvider}
        model={caModel}
        apiKey={caApiKey}
        baseUrl={caBaseUrl}
        contextWindow={caContextWindow}
        onChange={(patch) => onCodingAgentChange({ ...codingAgent, ...patch })}
      />

      <div className="settings-field">
        <label className="settings-field-label" htmlFor="ca-system-prompt">System prompt</label>
        <textarea
          id="ca-system-prompt"
          className="settings-textarea"
          rows={10}
          value={caSystemPrompt}
          onChange={(e) => onCodingAgentChange({ systemPrompt: e.target.value })}
        />
        <p className="settings-field-hint">
          Leave empty for the default. Changing the prompt mid-conversation won't take effect until the session resets.
        </p>
      </div>
    </div>
  );
}
