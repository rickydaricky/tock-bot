import React, { useEffect, useState } from 'react';
import { saveServerConfig, loadServerConfig, ServerConfig } from '../../utils/storage';

/** Read every opentable.com cookie (incl. HttpOnly) via chrome.cookies. */
async function readOpenTableCookies(): Promise<any[]> {
  const jars = await chrome.cookies.getAll({ domain: 'opentable.com' });
  return jars.map((c) => ({
    name: c.name, value: c.value, domain: c.domain, path: c.path,
    secure: c.secure, httpOnly: c.httpOnly,
    sameSite: c.sameSite === 'no_restriction' ? 'None' : c.sameSite === 'lax' ? 'Lax' : c.sameSite === 'strict' ? 'Strict' : undefined,
    expires: c.expirationDate ? Math.floor(c.expirationDate) : undefined,
  }));
}

export function OpenTableSession(): JSX.Element {
  const [cfg, setCfg] = useState<ServerConfig>({ url: '', key: '' });
  const [status, setStatus] = useState('');

  useEffect(() => { loadServerConfig().then((c) => c && setCfg(c)); }, []);

  const persist = (next: ServerConfig) => { setCfg(next); saveServerConfig(next); };

  const push = async () => {
    try {
      const cookies = await readOpenTableCookies();
      if (cookies.length === 0) { setStatus('No opentable.com cookies found — are you logged in?'); return; }
      if (!cfg.url) { setStatus('Set the server URL first.'); return; }
      if (!/^https:\/\//i.test(cfg.url.trim())) { setStatus('Server URL must start with https://'); return; }
      const res = await fetch(`${cfg.url.replace(/\/$/, '')}/api/cookies/push?platform=opentable`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Auth-Key': cfg.key },
        body: JSON.stringify({ cookies }),
      });
      const j = await res.json();
      setStatus(res.ok ? `Pushed ${j.count} OpenTable cookies ✓` : `Push failed: ${j.error || res.status}`);
    } catch (e) { setStatus(`Error: ${e instanceof Error ? e.message : String(e)}`); }
  };

  const copy = async () => {
    try {
      const cookies = await readOpenTableCookies();
      await navigator.clipboard.writeText(JSON.stringify(cookies));
      setStatus(`Copied ${cookies.length} OpenTable cookies to clipboard`);
    } catch (e) { setStatus(`Error: ${e instanceof Error ? e.message : String(e)}`); }
  };

  return (
    <div style={{ marginTop: 12, padding: 8, border: '1px solid #333', borderRadius: 6 }}>
      <div style={{ fontWeight: 600, marginBottom: 6 }}>OpenTable session</div>
      <input placeholder="Server URL (https://…railway.app)" value={cfg.url}
        onChange={(e) => persist({ ...cfg, url: e.target.value })} style={{ width: '100%', marginBottom: 4 }} />
      <input placeholder="Server API key" type="password" value={cfg.key}
        onChange={(e) => persist({ ...cfg, key: e.target.value })} style={{ width: '100%', marginBottom: 6 }} />
      <button onClick={push} style={{ marginRight: 6 }}>Push OpenTable session</button>
      <button onClick={copy}>Copy JSON</button>
      {status && <div style={{ marginTop: 6, fontSize: 12 }}>{status}</div>}
    </div>
  );
}
