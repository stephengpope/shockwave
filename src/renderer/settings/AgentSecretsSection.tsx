import React, { useEffect, useState } from 'react';
import { KeyRound, Link2, Pencil, Plus, RefreshCw, Trash2, Unplug } from 'lucide-react';
import Dialog from '../Dialog.jsx';
import ConfirmDialog from '../ConfirmDialog.jsx';
import ErrorMessage from '../ErrorMessage.jsx';
import { SettingsSection } from './SectionUI';
import { Field, FieldLabel, FieldDescription } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
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

function nameKey(s) {
  return (s ?? '').trim().toLowerCase();
}

function isOAuth(s) {
  return !!(s && s.oauth);
}

// ── Static-token dialog (Add / Edit) — unchanged behavior ────────────────────
function SecretFormDialog({ open, editing, secrets, onSubmit, onClose }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [token, setToken] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [error, setError] = useState<any>(null);

  useEffect(() => {
    if (!open) return;
    setName(editing?.name ?? '');
    setDescription(editing?.description ?? '');
    setToken(editing?.token ?? '');
    setShowToken(false);
    setError(null);
  }, [open, editing]);

  const trimmedName = name.trim().toUpperCase();
  const editingKey = editing ? nameKey(editing.name) : null;
  const duplicateName = !!trimmedName
    && (secrets ?? []).some((s) => nameKey(s.name) === nameKey(trimmedName) && nameKey(s.name) !== editingKey);
  const canSubmit = trimmedName && token && !duplicateName;

  const submit = (e) => {
    e.preventDefault();
    setError(null);
    if (!trimmedName) return setError('Name is required.');
    if (!token) return setError('Token is required.');
    if (duplicateName) return setError('A secret with this name already exists.');
    onSubmit({ name: trimmedName, description: description.trim(), token });
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={editing ? `Edit ${editing.name}` : 'Add token'}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} disabled={!canSubmit}>
            {editing ? 'Save' : 'Add'}
          </Button>
        </>
      }
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field>
          <FieldLabel htmlFor="secret-name">Name</FieldLabel>
          <Input
            id="secret-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value.toUpperCase())}
            placeholder="GITHUB_TOKEN"
            spellCheck={false}
            autoComplete="off"
            autoFocus
          />
          {duplicateName && (
            <p className="text-xs text-destructive">
              A secret with this name already exists.
            </p>
          )}
        </Field>

        <Field>
          <FieldLabel htmlFor="secret-description">Description</FieldLabel>
          <Input
            id="secret-description"
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Optional — what this token is for"
            autoComplete="off"
          />
        </Field>

        <Field>
          <FieldLabel htmlFor="secret-token">Token</FieldLabel>
          <InputGroup>
            <InputGroupInput
              id="secret-token"
              className="font-mono"
              type={showToken ? 'text' : 'password'}
              value={token}
              onChange={(e) => setToken(e.target.value)}
              spellCheck={false}
              autoComplete="off"
              autoCorrect="off"
            />
            <InputGroupAddon align="inline-end">
              <InputGroupButton onClick={() => setShowToken((v) => !v)}>
                {showToken ? 'Hide' : 'Show'}
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
        </Field>

        {error && <ErrorMessage>{error}</ErrorMessage>}

        <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
      </form>
    </Dialog>
  );
}

// ── OAuth connection dialog (Add / Edit config) ──────────────────────────────
function ConnectionFormDialog({ open, editing, presets, secrets, onSubmit, onClose }) {
  const [providerId, setProviderId] = useState('google');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [authUrl, setAuthUrl] = useState('');
  const [tokenUrl, setTokenUrl] = useState('');
  const [scopes, setScopes] = useState('');
  // Which "popular setup" is selected in the second dropdown. 'custom' = the
  // scopes field is hand-managed. Purely UI — only the scopes field is saved.
  const [setupId, setSetupId] = useState('custom');
  const [showSecret, setShowSecret] = useState(false);
  const [error, setError] = useState<any>(null);

  const preset = (presets ?? []).find((p) => p.id === providerId);
  const isCustom = providerId === 'custom';
  const setups = preset?.setups ?? [];
  const selectedSetup = setups.find((x) => x.id === setupId);

  // The setup whose scope set matches `scopeStr` exactly, else 'custom'. Lets the
  // dropdown reflect hand-edited scopes and pre-select on Edit.
  const matchSetupId = (p, scopeStr) => {
    const want = scopeStr.split(/\s+/).filter(Boolean).slice().sort().join(' ');
    const hit = (p?.setups ?? []).find((s) => s.scopes.slice().sort().join(' ') === want);
    return hit?.id ?? 'custom';
  };

  // Seed on open. For Add, default to google's scopes; for Edit, load the row.
  useEffect(() => {
    if (!open) return;
    if (editing?.oauth) {
      const o = editing.oauth;
      const scopeStr = (o.scopes ?? []).join(' ');
      const p = (presets ?? []).find((x) => x.id === (o.provider ?? 'custom'));
      setProviderId(o.provider ?? 'custom');
      setName(editing.name ?? '');
      setDescription(editing.description ?? '');
      setClientId(o.clientId ?? '');
      setClientSecret(o.clientSecret ?? '');
      setAuthUrl(o.authUrl ?? '');
      setTokenUrl(o.tokenUrl ?? '');
      setScopes(scopeStr);
      setSetupId(matchSetupId(p, scopeStr));
    } else {
      const first = (presets ?? [])[0];
      setProviderId(first?.id ?? 'google');
      setName('');
      setDescription('');
      setClientId('');
      setClientSecret('');
      setAuthUrl('');
      setTokenUrl('');
      // Default to the provider's first popular setup, else its identity scopes.
      const firstSetup = first?.setups?.[0];
      setScopes((firstSetup?.scopes ?? first?.defaultScopes ?? []).join(' '));
      setSetupId(firstSetup?.id ?? 'custom');
    }
    setShowSecret(false);
    setError(null);
  }, [open, editing, presets]);

  // Changing the provider resets the setup + scopes to that provider's first
  // popular setup (or its default scopes when it has none).
  const onProviderChange = (id) => {
    setProviderId(id);
    const p = (presets ?? []).find((x) => x.id === id);
    const firstSetup = p?.setups?.[0];
    setScopes((firstSetup?.scopes ?? p?.defaultScopes ?? []).join(' '));
    setSetupId(firstSetup?.id ?? 'custom');
  };

  // Picking a popular setup fills the scopes field; 'Custom scopes…' clears it
  // to blank so the user starts from scratch.
  const onSetupChange = (id) => {
    setSetupId(id);
    if (id === 'custom') { setScopes(''); return; }
    const s = setups.find((x) => x.id === id);
    if (s) setScopes(s.scopes.join(' '));
  };

  // Hand-editing the scopes field flips the setup dropdown to 'Custom scopes…'
  // (unless the text happens to match a known setup again).
  const onScopesChange = (v) => {
    setScopes(v);
    setSetupId(matchSetupId(preset, v));
  };

  const trimmedName = name.trim().toUpperCase();
  const editingKey = editing ? nameKey(editing.name) : null;
  const duplicateName = !!trimmedName
    && (secrets ?? []).some((s) => nameKey(s.name) === nameKey(trimmedName) && nameKey(s.name) !== editingKey);
  const canSubmit = trimmedName && clientId && clientSecret && !duplicateName
    && (!isCustom || (authUrl.trim() && tokenUrl.trim()));

  const submit = (e) => {
    e.preventDefault();
    setError(null);
    if (!trimmedName) return setError('Name is required.');
    if (!clientId) return setError('Client ID is required.');
    if (!clientSecret) return setError('Client Secret is required.');
    if (isCustom && (!authUrl.trim() || !tokenUrl.trim())) return setError('Custom providers need both endpoint URLs.');
    if (duplicateName) return setError('A secret with this name already exists.');
    onSubmit({
      name: trimmedName,
      description: description.trim(),
      provider: providerId,
      clientId: clientId.trim(),
      clientSecret,
      authUrl: isCustom ? authUrl.trim() : undefined,
      tokenUrl: isCustom ? tokenUrl.trim() : undefined,
      scopes: scopes.split(/\s+/).map((x) => x.trim()).filter(Boolean),
    });
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={editing ? `Edit ${editing.name}` : 'Add OAuth'}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} disabled={!canSubmit}>
            {editing ? 'Save' : 'Add & connect'}
          </Button>
        </>
      }
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field>
          <FieldLabel>Provider</FieldLabel>
          <Select value={providerId} onValueChange={onProviderChange} disabled={!!editing}>
            <SelectTrigger>
              <SelectValue placeholder="Choose a provider" />
            </SelectTrigger>
            <SelectContent>
              {(presets ?? []).map((p) => (
                <SelectItem key={p.id} value={p.id}>{p.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          {preset?.hint && <FieldDescription>{preset.hint}</FieldDescription>}
        </Field>

        {/* Popular-setup picker — fills the scopes field. Hidden for Custom
            providers (no presets) and providers with no curated setups. */}
        {!isCustom && setups.length > 0 && (
          <Field>
            <FieldLabel>Setup</FieldLabel>
            <Select value={setupId} onValueChange={onSetupChange}>
              <SelectTrigger>
                <SelectValue placeholder="Choose what to access" />
              </SelectTrigger>
              <SelectContent>
                {setups.map((s) => (
                  <SelectItem key={s.id} value={s.id}>{s.label}</SelectItem>
                ))}
                <SelectItem value="custom">Custom scopes…</SelectItem>
              </SelectContent>
            </Select>
            {setupId !== 'custom' && selectedSetup?.description && (
              <FieldDescription>{selectedSetup.description}</FieldDescription>
            )}
          </Field>
        )}

        <Field>
          <FieldLabel htmlFor="oauth-name">Name</FieldLabel>
          <Input
            id="oauth-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value.toUpperCase())}
            placeholder="GOOGLE_DRIVE"
            spellCheck={false}
            autoComplete="off"
          />
          {duplicateName && <p className="text-xs text-destructive">A secret with this name already exists.</p>}
        </Field>

        <Field>
          <FieldLabel htmlFor="oauth-description">Description</FieldLabel>
          <Input
            id="oauth-description"
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Optional — what this connection is for"
            autoComplete="off"
          />
        </Field>

        <Field>
          <FieldLabel htmlFor="oauth-client-id">Client ID</FieldLabel>
          <Input
            id="oauth-client-id"
            className="font-mono"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            spellCheck={false}
            autoComplete="off"
          />
        </Field>

        <Field>
          <FieldLabel htmlFor="oauth-client-secret">Client Secret</FieldLabel>
          <InputGroup>
            <InputGroupInput
              id="oauth-client-secret"
              className="font-mono"
              type={showSecret ? 'text' : 'password'}
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
              spellCheck={false}
              autoComplete="off"
              autoCorrect="off"
            />
            <InputGroupAddon align="inline-end">
              <InputGroupButton onClick={() => setShowSecret((v) => !v)}>
                {showSecret ? 'Hide' : 'Show'}
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
        </Field>

        {isCustom && (
          <>
            <Field>
              <FieldLabel htmlFor="oauth-auth-url">Authorization URL</FieldLabel>
              <Input id="oauth-auth-url" className="font-mono" value={authUrl} onChange={(e) => setAuthUrl(e.target.value)} spellCheck={false} autoComplete="off" placeholder="https://provider.com/oauth/authorize" />
            </Field>
            <Field>
              <FieldLabel htmlFor="oauth-token-url">Token URL</FieldLabel>
              <Input id="oauth-token-url" className="font-mono" value={tokenUrl} onChange={(e) => setTokenUrl(e.target.value)} spellCheck={false} autoComplete="off" placeholder="https://provider.com/oauth/token" />
            </Field>
          </>
        )}

        <Field>
          <FieldLabel htmlFor="oauth-scopes">Scopes</FieldLabel>
          <Input
            id="oauth-scopes"
            className="font-mono"
            value={scopes}
            onChange={(e) => onScopesChange(e.target.value)}
            spellCheck={false}
            autoComplete="off"
            placeholder="space-separated"
          />
          <FieldDescription>Space-separated. Filled by the Setup you pick — edit for anything custom.</FieldDescription>
        </Field>

        {error && <ErrorMessage>{error}</ErrorMessage>}

        <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
      </form>
    </Dialog>
  );
}

function StatusBadge({ status }) {
  if (status === 'connected') return <Badge className="bg-success-soft text-success">Connected</Badge>;
  if (status === 'expired') return <Badge variant="destructive">Expired</Badge>;
  return <Badge variant="secondary">Not connected</Badge>;
}

export default function AgentSecretsSection({ secrets, onChange, onReload }) {
  // Static-token dialog target: null = closed, {} = add, {name,...} = edit.
  const [tokenTarget, setTokenTarget] = useState<any>(null);
  // OAuth dialog target: same convention.
  const [oauthTarget, setOauthTarget] = useState<any>(null);
  const [confirmDelete, setConfirmDelete] = useState<any>(null);
  const [presets, setPresets] = useState<any[]>([]);
  const [connectingName, setConnectingName] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);

  useEffect(() => {
    window.api.oauth.listPresets().then(setPresets).catch(() => setPresets([]));
  }, []);

  const tokenEditing = tokenTarget && tokenTarget.name ? tokenTarget : null;
  const oauthEditing = oauthTarget && oauthTarget.name ? oauthTarget : null;

  const onSubmitToken = ({ name, description, token }) => {
    const now = Date.now();
    const list = secrets ?? [];
    let next;
    if (tokenEditing) {
      next = list.map((s) =>
        nameKey(s.name) === nameKey(tokenEditing.name) ? { ...s, name, description, token, updatedAt: now } : s,
      );
    } else {
      next = [...list, { name, description, token, kind: 'static', createdAt: now, updatedAt: now }];
    }
    onChange(next);
    setTokenTarget(null);
  };

  // Persist an OAuth connection's config, then (for a fresh add) kick off the
  // browser authorization immediately. Edit only rewrites config fields and
  // preserves any live tokens/status.
  const onSubmitOAuth = async (form) => {
    const now = Date.now();
    const list = secrets ?? [];
    let next;
    if (oauthEditing) {
      next = list.map((s) => {
        if (nameKey(s.name) !== nameKey(oauthEditing.name)) return s;
        return {
          ...s,
          name: form.name,
          description: form.description,
          updatedAt: now,
          oauth: {
            ...(s.oauth ?? {}),
            provider: form.provider,
            clientId: form.clientId,
            clientSecret: form.clientSecret,
            authUrl: form.authUrl,
            tokenUrl: form.tokenUrl,
            scopes: form.scopes,
          },
        };
      });
    } else {
      next = [...list, {
        name: form.name,
        description: form.description,
        kind: 'oauth',
        token: '',
        createdAt: now,
        updatedAt: now,
        oauth: {
          provider: form.provider,
          clientId: form.clientId,
          clientSecret: form.clientSecret,
          authUrl: form.authUrl,
          tokenUrl: form.tokenUrl,
          scopes: form.scopes,
          status: 'disconnected',
        },
      }];
    }
    await onChange(next); // persists so main can read the connection
    const wasAdd = !oauthEditing;
    setOauthTarget(null);
    if (wasAdd) await doConnect(form.name);
  };

  const doConnect = async (name) => {
    setConnectError(null);
    setConnectingName(name);
    try {
      const res = await window.api.oauth.startConnect(name);
      if (!res?.ok) setConnectError(res?.error || 'Authorization failed.');
    } catch (e: any) {
      setConnectError(e?.message ?? 'Authorization failed.');
    } finally {
      setConnectingName(null);
      await onReload?.(); // pull fresh status/tokens that main wrote
    }
  };

  const doDisconnect = async (name) => {
    setConnectError(null);
    try {
      await window.api.oauth.disconnect(name);
    } catch (e: any) {
      setConnectError(e?.message ?? 'Disconnect failed.');
    } finally {
      await onReload?.();
    }
  };

  const onDelete = (n) => {
    onChange((secrets ?? []).filter((s) => s.name !== n));
    setConfirmDelete(null);
  };

  // Grouped for display: OAuth connections and static tokens in separate lists.
  const oauthSecrets = (secrets ?? []).filter(isOAuth);
  const tokenSecrets = (secrets ?? []).filter((s) => !isOAuth(s));

  return (
    <SettingsSection
      wide
      title="API Secrets"
      description="Store API tokens or connect accounts via OAuth for the coding agent. All credentials are encrypted on this machine using your OS keychain. Names must be unique."
    >
      <div className="flex w-fit gap-2">
        {/* One primary action; the OAuth path is secondary. */}
        <Button size="sm" onClick={() => setTokenTarget({})}>
          <Plus />
          Add token
        </Button>
        <Button size="sm" variant="outline" onClick={() => setOauthTarget({})}>
          <Link2 />
          Add OAuth
        </Button>
      </div>

      {connectError && <ErrorMessage>{connectError}</ErrorMessage>}

      {(!secrets || secrets.length === 0) ? (
        <div className="text-[13px] text-muted-foreground">No secrets yet.</div>
      ) : (
        <div className="flex flex-col gap-5">
          {oauthSecrets.length > 0 && (
            <div className="flex flex-col gap-2">
              <div className="text-xs font-medium text-muted-foreground">OAuth</div>
              <ul className="flex flex-col gap-2">
                {oauthSecrets.map((s) => (
                  <li
                    key={s.name}
                    className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2.5"
                  >
                    <div className="flex min-w-0 items-center gap-2.5">
                      <Link2 className="size-4 shrink-0 text-muted-foreground" />
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-[13px] font-medium text-foreground">{s.name}</span>
                          <StatusBadge status={s.oauth?.status} />
                        </div>
                        <div className="truncate text-xs text-muted-foreground">
                          {s.oauth?.accountEmail
                            || s.description
                            || (s.oauth?.scopes?.length ? s.oauth.scopes.join(' ') : `${s.oauth?.provider} — not yet authorized`)}
                        </div>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={connectingName === s.name}
                        onClick={() => doConnect(s.name)}
                      >
                        <RefreshCw className={connectingName === s.name ? 'size-3.5 animate-spin' : 'size-3.5'} />
                        {s.oauth?.status === 'disconnected' ? 'Connect' : 'Reconnect'}
                      </Button>
                      {s.oauth?.status === 'connected' && (
                        <Button variant="ghost" size="icon-sm" onClick={() => doDisconnect(s.name)} title={`Disconnect ${s.name}`} aria-label={`Disconnect ${s.name}`}>
                          <Unplug className="size-3.5" />
                        </Button>
                      )}
                      <Button variant="ghost" size="icon-sm" onClick={() => setOauthTarget(s)} title={`Edit ${s.name}`} aria-label={`Edit ${s.name}`}>
                        <Pencil className="size-3.5" />
                      </Button>
                      <Button variant="ghost" size="icon-sm" onClick={() => setConfirmDelete(s.name)} title={`Delete ${s.name}`} aria-label={`Delete ${s.name}`}>
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {tokenSecrets.length > 0 && (
            <div className="flex flex-col gap-2">
              <div className="text-xs font-medium text-muted-foreground">Tokens</div>
              <ul className="flex flex-col gap-2">
                {tokenSecrets.map((s) => (
                  <li
                    key={s.name}
                    className="flex cursor-pointer items-center justify-between gap-3 rounded-lg border border-border px-3 py-2.5 transition-colors hover:bg-muted/50"
                    role="button"
                    tabIndex={0}
                    onClick={() => setTokenTarget(s)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setTokenTarget(s);
                      }
                    }}
                  >
                    <div className="flex min-w-0 items-center gap-2.5">
                      <KeyRound className="size-4 shrink-0 text-muted-foreground" />
                      <div className="min-w-0">
                        <div className="text-[13px] font-medium text-foreground">{s.name}</div>
                        {s.description && (
                          <div className="truncate text-xs text-muted-foreground" title={s.description}>{s.description}</div>
                        )}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1" onClick={(e) => e.stopPropagation()}>
                      <Button variant="ghost" size="icon-sm" onClick={() => setTokenTarget(s)} title={`Edit ${s.name}`} aria-label={`Edit ${s.name}`}>
                        <Pencil className="size-3.5" />
                      </Button>
                      <Button variant="ghost" size="icon-sm" onClick={() => setConfirmDelete(s.name)} title={`Delete ${s.name}`} aria-label={`Delete ${s.name}`}>
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      <SecretFormDialog
        open={tokenTarget !== null}
        editing={tokenEditing}
        secrets={secrets ?? []}
        onSubmit={onSubmitToken}
        onClose={() => setTokenTarget(null)}
      />

      <ConnectionFormDialog
        open={oauthTarget !== null}
        editing={oauthEditing}
        presets={presets}
        secrets={secrets ?? []}
        onSubmit={onSubmitOAuth}
        onClose={() => setOauthTarget(null)}
      />

      <ConfirmDialog
        open={!!confirmDelete}
        title="Delete secret"
        message={confirmDelete ? `Delete "${confirmDelete}"? This cannot be undone.` : ''}
        confirmLabel="Delete"
        destructive
        onConfirm={() => onDelete(confirmDelete)}
        onClose={() => setConfirmDelete(null)}
      />
    </SettingsSection>
  );
}
