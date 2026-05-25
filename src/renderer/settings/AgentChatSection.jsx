import React, { useEffect, useState } from 'react';
import Combobox from '../Combobox.jsx';
import { DEFAULT_PROVIDER_SLUG } from '../constants.js';

function ProviderModelKey({ idPrefix, provider, model, apiKey, onChange }) {
  const [showKey, setShowKey] = useState(false);
  const [providers, setProviders] = useState([]);
  const [models, setModels] = useState([]);

  // Providers come from pi-ai's registry (intersected with our supported set
  // in main). Fetched once on mount.
  useEffect(() => {
    let active = true;
    window.api.agent.listProviders().then((list) => {
      if (active) setProviders(list ?? []);
    });
    return () => { active = false; };
  }, []);

  // Models are scoped to the current provider. Re-fetch whenever it changes.
  useEffect(() => {
    if (!provider) { setModels([]); return; }
    let active = true;
    window.api.agent.listModels(provider).then((list) => {
      if (active) setModels(list ?? []);
    });
    return () => { active = false; };
  }, [provider]);

  return (
    <>
      <div className="settings-field">
        <label className="settings-field-label" htmlFor={`${idPrefix}-provider`}>Provider</label>
        <Combobox
          id={`${idPrefix}-provider`}
          options={providers}
          value={provider}
          // Switching providers invalidates the model — the old id won't be
          // in the new provider's catalog, so we clear it to force a fresh pick.
          onChange={(next) => onChange({ provider: next, model: '' })}
          freeForm={false}
        />
      </div>

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
        </div>
      </div>
    </>
  );
}

export default function AgentChatSection({ codingAgent, onCodingAgentChange }) {
  const caProvider = codingAgent?.provider ?? DEFAULT_PROVIDER_SLUG;
  const caModel = codingAgent?.model ?? '';
  const caApiKey = codingAgent?.apiKey ?? '';
  const caSystemPrompt = codingAgent?.systemPrompt ?? '';
  const caSkills = codingAgent?.skills ?? { global: {}, workspaces: {} };
  const updateCa = (patch) => onCodingAgentChange?.({
    provider: caProvider,
    model: caModel,
    apiKey: caApiKey,
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
