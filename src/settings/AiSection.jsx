import React, { useState } from 'react';
import { AI_PROVIDERS } from '../constants.js';

const PROVIDER_OPTIONS = [
  { value: AI_PROVIDERS.ANTHROPIC, label: 'Anthropic' },
  { value: AI_PROVIDERS.OPENAI, label: 'OpenAI' },
];

export default function AiSection({ ai, onChange }) {
  const [showKey, setShowKey] = useState(false);
  const provider = ai?.provider ?? AI_PROVIDERS.ANTHROPIC;
  const model = ai?.model ?? '';
  const apiKey = ai?.apiKey ?? '';
  const includeContextByDefault = !!ai?.includeContextByDefault;

  const update = (patch) => onChange({
    provider, model, apiKey, includeContextByDefault, ...patch,
  });

  return (
    <div className="settings-section">
      <h2 className="settings-section-title">AI / Coding Agent</h2>
      <p className="settings-section-desc">
        Configure the model and how AI features behave in the editor. Your API key is stored
        locally on this machine.
      </p>

      <h3 className="settings-subsection-title">LLM</h3>

      <div className="settings-field">
        <label className="settings-field-label" htmlFor="ai-provider">Provider</label>
        <select
          id="ai-provider"
          className="settings-select"
          value={provider}
          onChange={(e) => update({ provider: e.target.value })}
        >
          {PROVIDER_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>

      <div className="settings-field">
        <label className="settings-field-label" htmlFor="ai-model">Model</label>
        <input
          id="ai-model"
          className="settings-input"
          type="text"
          value={model}
          placeholder={provider === AI_PROVIDERS.OPENAI ? 'gpt-4o' : 'claude-sonnet-4-5'}
          onChange={(e) => update({ model: e.target.value })}
          spellCheck={false}
          autoComplete="off"
        />
      </div>

      <div className="settings-field">
        <label className="settings-field-label" htmlFor="ai-key">API key</label>
        <div className="settings-input-row">
          <input
            id="ai-key"
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

      <h3 className="settings-subsection-title">Inline AI Editing</h3>

      <div className="settings-field">
        <label className="settings-checkbox-row">
          <input
            type="checkbox"
            checked={includeContextByDefault}
            onChange={(e) => update({ includeContextByDefault: e.target.checked })}
          />
          <span>Include the rest of the document as context by default</span>
        </label>
        <p className="settings-field-hint">
          When checked, AI editing requests include the full document for context. You can still
          toggle this per request in the prompt window.
        </p>
      </div>
    </div>
  );
}
