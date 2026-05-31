import React, { useEffect, useState } from 'react';
import Combobox from '../Combobox.jsx';
import { DEFAULT_PROVIDER_SLUG } from '../constants.js';

// Our generic OpenAI-compatible endpoint slug (Ollama, LM Studio, vLLM, gateways).
const COMPATIBLE_SLUG = 'openai-compatible';

function ProviderModelKey({ idPrefix, provider, model, apiKey, baseUrl, contextWindow, onChange }) {
  const [showKey, setShowKey] = useState(false);
  const [providers, setProviders] = useState<any[]>([]);
  const [models, setModels] = useState<any[]>([]);
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
          freeForm
        />
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
  const caApiKey = codingAgent?.apiKey ?? '';
  const caBaseUrl = codingAgent?.baseUrl ?? '';
  const caContextWindow = codingAgent?.contextWindow;
  const caSystemPrompt = codingAgent?.systemPrompt ?? '';
  const caSkills = codingAgent?.skills ?? { global: {}, workspaces: {} };
  const updateCa = (patch) => onCodingAgentChange?.({
    provider: caProvider,
    model: caModel,
    apiKey: caApiKey,
    baseUrl: caBaseUrl,
    contextWindow: caContextWindow,
    systemPrompt: caSystemPrompt,
    skills: caSkills,
    ...patch,
  });

  // The "Reset to default" button pulls the current default from main
  // (electron/agentSystemPrompt.js) so the renderer doesn't keep its own copy.
  const [defaultPrompt, setDefaultPrompt] = useState('');
  useEffect(() => {
    let active = true;
    window.api.agent.getDefaultSystemPrompt().then((p) => {
      if (active) setDefaultPrompt(p ?? '');
    });
    return () => { active = false; };
  }, []);

  const isDefault = caSystemPrompt === defaultPrompt && defaultPrompt !== '';

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
        onChange={updateCa}
      />

      <h3 className="settings-subsection-title" style={{ marginTop: 24 }}>System Prompt</h3>
      <p className="settings-tab-intro">
        Pre-filled on install. Edit freely; takes effect on the next chat session (hit reset in the
        sidebar to apply now).
      </p>
      <div className="settings-prompt-block">
        <textarea
          id="coding-agent-system-prompt"
          className="settings-textarea"
          value={caSystemPrompt}
          onChange={(e) => updateCa({ systemPrompt: e.target.value })}
          spellCheck={false}
          rows={12}
        />
        <div className="settings-prompt-footer">
          <span className="settings-prompt-state" data-state={isDefault ? 'default' : 'custom'}>
            {isDefault ? 'Default' : 'Customized'}
          </span>
          <button
            type="button"
            className="settings-button"
            onClick={() => updateCa({ systemPrompt: defaultPrompt })}
            disabled={isDefault || !defaultPrompt}
          >
            Reset to default
          </button>
        </div>
      </div>
    </div>
  );
}
