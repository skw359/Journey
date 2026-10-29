import { useState, useRef, useCallback, useMemo } from 'react';
import './ApiDocs.css';

const ENDPOINTS = [
  {
    method: 'GET',
    path: '/api/routes',
    desc: 'List all journeys',
    params: [],
    requestHeaders: { 'Accept': 'application/json' },
    requestBody: null,
    responseStatus: 200,
    responseHeaders: {
      'Content-Type': 'application/json',
      'X-Request-Id': 'req_7f3a2c91e4b8',
      'X-RateLimit-Remaining': '148',
      'Cache-Control': 'no-store',
    },
    responseBody: {
      _comment: '// Array<RouteSummary>',
      data: [
        {
          id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
          name: 'Morning Ride to Campus',
          date: '2025-02-10',
          startTime: '2025-02-10T08:12:33.000Z',
          distance: '3.72',
          duration: '0h 22m',
          watchRecorded: true,
          waypointCount: 487,
          photoCount: 3,
          travelMode: 'scooter',
          avgSpeed: '10.14',
        },
        {
          id: 'f9e8d7c6-b5a4-3210-fedc-ba0987654321',
          name: 'Frederick Trail Loop',
          date: '2025-02-08',
          startTime: '2025-02-08T14:45:00.000Z',
          distance: '8.91',
          duration: '1h 47m',
          watchRecorded: false,
          waypointCount: 1203,
          photoCount: 0,
          travelMode: 'foot',
          avgSpeed: '4.98',
        },
      ],
    },
    timing: { dns: 2, connect: 8, tls: 12, wait: 23, download: 4 },
    assertions: [
      { status: 'pass', label: 'Status code is 200' },
      { status: 'pass', label: 'Response is valid JSON array' },
      { status: 'pass', label: 'Each item has required fields: id, name, date, distance' },
      { status: 'pass', label: 'Items sorted by startTime descending' },
      { status: 'pass', label: 'Response excludes coordinate arrays' },
      { status: 'pass', label: 'travelMode \u2208 { foot, scooter, drive, train, metro, flight }' },
    ],
  },
  {
    method: 'GET',
    path: '/api/routes/:id',
    desc: 'Get journey detail with coordinates',
    params: [{ name: ':id', type: 'string', required: true, desc: 'UUID of the journey' }],
    requestHeaders: { 'Accept': 'application/json' },
    requestBody: null,
    responseStatus: 200,
    responseHeaders: {
      'Content-Type': 'application/json',
      'X-Request-Id': 'req_a4e7c2d19f83',
      'X-Response-Time': '47ms',
    },
    responseBody: {
      id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      name: 'Morning Ride to Campus',
      date: '2025-02-10',
      startTime: '2025-02-10T08:12:33.000Z',
      endTime: '2025-02-10T08:34:51.000Z',
      distance: '3.72',
      duration: '0h 22m',
      avgSpeed: '10.14',
      travelMode: 'scooter',
      watchRecorded: true,
      startCoord: [38.9897, -76.9378],
      endCoord: [38.9869, -76.9426],
      coordinates: ['[...487 waypoints]'],
      profileSpeedMph: ['[...speed profile]'],
      photos: [],
    },
    timing: { dns: 1, connect: 4, tls: 11, wait: 47, download: 18 },
    assertions: [
      { status: 'pass', label: 'Status code is 200' },
      { status: 'pass', label: 'Response contains full coordinate array' },
      { status: 'pass', label: 'startCoord and endCoord are [lat, lng] tuples' },
      { status: 'pass', label: 'travelMode is auto-detected when missing' },
      { status: 'pass', label: 'photos array is present' },
    ],
  },
  {
    method: 'PATCH',
    path: '/api/routes/:id/name',
    desc: 'Rename a journey',
    params: [{ name: ':id', type: 'string', required: true, desc: 'UUID of the journey' }],
    requestHeaders: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    requestBody: { newName: 'Evening Ride Home' },
    responseStatus: 200,
    responseHeaders: {
      'Content-Type': 'application/json',
      'X-Request-Id': 'req_d2f0b8c3e571',
    },
    responseBody: {
      message: 'Name updated',
      route: {
        id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
        name: 'Evening Ride Home',
        _truncated: '...full route object',
      },
    },
    timing: { dns: 1, connect: 3, tls: 10, wait: 31, download: 2 },
    assertions: [
      { status: 'pass', label: 'Status code is 200' },
      { status: 'pass', label: 'Response.message === "Name updated"' },
      { status: 'pass', label: 'route.name matches request body' },
      { status: 'pass', label: 'Whitespace is trimmed from name' },
      { status: 'fail', label: 'Rejects empty string body \u2192 400' },
    ],
  },
  {
    method: 'PATCH',
    path: '/api/routes/:id/travel-mode',
    desc: 'Override travel mode',
    params: [{ name: ':id', type: 'string', required: true, desc: 'UUID of the journey' }],
    requestHeaders: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    requestBody: { travelMode: 'foot' },
    responseStatus: 200,
    responseHeaders: {
      'Content-Type': 'application/json',
      'X-Request-Id': 'req_e1a4b9c7d382',
    },
    responseBody: {
      message: 'Travel mode updated',
      route: {
        id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
        travelMode: 'foot',
        _truncated: '...full route object',
      },
    },
    timing: { dns: 1, connect: 3, tls: 9, wait: 18, download: 1 },
    assertions: [
      { status: 'pass', label: 'Status code is 200' },
      { status: 'pass', label: 'travelMode persisted to database' },
      { status: 'pass', label: 'Rejects invalid mode \u2192 400' },
      { status: 'pass', label: 'Valid modes: foot | scooter | drive | train | metro | flight' },
    ],
  },
  {
    method: 'POST',
    path: '/api/routes/:id/photos',
    desc: 'Upload photos and videos to a journey',
    params: [
      { name: ':id', type: 'string', required: true, desc: 'UUID of the journey' },
      { name: 'photos', type: 'File[]', required: true, desc: 'JPG or HEIC images (50MB each) and/or MOV/MP4 videos. HEIC is converted to JPG and video to MP4 in the background; those items have status "processing" until ready' },
    ],
    requestHeaders: { 'Content-Type': 'multipart/form-data', 'Accept': 'application/json' },
    requestBody: {
      _comment: '// multipart/form-data',
      photos: '[Binary: IMG_2451.heic, IMG_2452.jpg]',
    },
    responseStatus: 200,
    responseHeaders: {
      'Content-Type': 'application/json',
      'X-Request-Id': 'req_c8f2a3e0d194',
      'X-Upload-Count': '2',
    },
    responseBody: {
      message: '2 photos uploaded successfully',
      photos: [
        {
          filename: 'a3e8c1f902b4d7\u20266e9a.jpg',
          originalName: 'IMG_2451.heic',
          url: '/photos/a3e8c1f902b4d7\u20266e9a.jpg',
        },
      ],
    },
    timing: { dns: 1, connect: 5, tls: 11, wait: 340, download: 3 },
    assertions: [
      { status: 'pass', label: 'Status code is 200' },
      { status: 'pass', label: 'HEIC files converted to JPG' },
      { status: 'pass', label: 'Response includes filename and URL' },
      { status: 'pass', label: 'Rejects non-HEIC/JPG files \u2192 error' },
      { status: 'skip', label: 'Verify 50MB limit enforcement' },
    ],
  },
  {
    method: 'DELETE',
    path: '/api/routes/:id',
    desc: 'Delete a journey and its photos',
    params: [{ name: ':id', type: 'string', required: true, desc: 'UUID of the journey' }],
    requestHeaders: { 'Accept': 'application/json' },
    requestBody: null,
    responseStatus: 200,
    responseHeaders: {
      'Content-Type': 'application/json',
      'X-Request-Id': 'req_f5d9a2b1c803',
    },
    responseBody: { message: 'Journey deleted successfully' },
    timing: { dns: 1, connect: 3, tls: 10, wait: 56, download: 1 },
    assertions: [
      { status: 'pass', label: 'Status code is 200' },
      { status: 'pass', label: 'Response confirms deletion' },
      { status: 'pass', label: 'Associated photos removed from disk' },
      { status: 'pass', label: 'GET /api/routes/:id returns 404 after delete' },
      { status: 'fail', label: 'DELETE nonexistent id \u2192 404' },
    ],
  },
];

function escHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function syntaxHighlight(obj, indent = 0) {
  const pad = '  '.repeat(indent);
  const pad1 = '  '.repeat(indent + 1);

  if (obj === null) return '<span class="j-null">null</span>';
  if (typeof obj === 'boolean') return `<span class="j-bool">${obj}</span>`;
  if (typeof obj === 'number') return `<span class="j-num">${obj}</span>`;
  if (typeof obj === 'string') {
    if (obj.startsWith('//')) return `<span class="j-cmt">${escHtml(obj)}</span>`;
    return `<span class="j-str">"${escHtml(obj)}"</span>`;
  }

  if (Array.isArray(obj)) {
    if (obj.length === 0) return '<span class="j-br">[]</span>';
    const items = obj.map(item => `${pad1}${syntaxHighlight(item, indent + 1)}`);
    return `<span class="j-br">[</span>\n${items.join(',\n')}\n${pad}<span class="j-br">]</span>`;
  }

  const keys = Object.keys(obj);
  if (keys.length === 0) return '<span class="j-br">{}</span>';

  const entries = keys.map(key => {
    if (key === '_comment') return `${pad1}<span class="j-cmt">${escHtml(obj[key])}</span>`;
    if (key === '_truncated') return `${pad1}<span class="j-cmt">// ${escHtml(obj[key])}</span>`;
    const val = syntaxHighlight(obj[key], indent + 1);
    return `${pad1}<span class="j-key">"${escHtml(key)}"</span>: ${val}`;
  });
  return `<span class="j-br">{</span>\n${entries.join(',\n')}\n${pad}<span class="j-br">}</span>`;
}

function ChevronDown({ className }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M4 6l4 4 4-4" />
    </svg>
  );
}

function ChevronRight({ className }) {
  return (
    <svg className={className} viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M4.5 2.5l3.5 3.5-3.5 3.5" />
    </svg>
  );
}

function AssertionIcon({ status }) {
  if (status === 'pass') {
    return (
      <svg className="a-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M3.5 8.5l3 3 6-7" />
      </svg>
    );
  }
  if (status === 'fail') {
    return (
      <svg className="a-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M4 4l8 8M12 4l-8 8" />
      </svg>
    );
  }
  return (
    <svg className="a-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M3 8h10" />
    </svg>
  );
}

function CollapsibleHeaders({ headers }) {
  const [open, setOpen] = useState(false);
  const entries = Object.entries(headers);
  return (
    <>
      <div className={`collapsible-trigger${open ? ' open' : ''}`} onClick={() => setOpen(o => !o)}>
        <ChevronRight className="chev" />
        Headers
        <span style={{ color: 'var(--text-ghost)', marginLeft: 'auto' }}>{entries.length}</span>
      </div>
      {open && (
        <div className="collapsible-content" style={{ display: 'block', padding: '4px 0 4px 12px' }}>
          {entries.map(([k, v]) => (
            <div key={k} className="header-row">
              <span className="h-name">{k}</span>
              <span className="h-val">{v}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function CodeBlock({ label, obj }) {
  const copyBtnRef = useRef(null);
  const preRef = useRef(null);

  const handleCopy = useCallback(() => {
    if (!preRef.current) return;
    navigator.clipboard.writeText(preRef.current.textContent).then(() => {
      if (copyBtnRef.current) {
        copyBtnRef.current.textContent = 'Copied';
        setTimeout(() => { if (copyBtnRef.current) copyBtnRef.current.textContent = 'Copy'; }, 1500);
      }
    });
  }, []);

  const html = useMemo(() => syntaxHighlight(obj), [obj]);

  return (
    <div className="code-block" style={{ marginTop: 10 }}>
      <div className="code-bar">
        <span className="code-bar-label">{label}</span>
        <div className="code-bar-actions">
          <button className="code-copy" ref={copyBtnRef} onClick={handleCopy}>Copy</button>
        </div>
      </div>
      <pre className="code-pre" ref={preRef} dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}

function TimingSection({ timing }) {
  const total = timing.dns + timing.connect + timing.tls + timing.wait + timing.download;
  const pct = v => ((v / total) * 100).toFixed(1);
  const segments = [
    { cls: 'dns', label: 'DNS', val: timing.dns, color: 'var(--timing-dns)' },
    { cls: 'connect', label: 'Connect', val: timing.connect, color: 'var(--timing-connect)' },
    { cls: 'tls', label: 'TLS', val: timing.tls, color: 'var(--timing-tls)' },
    { cls: 'wait', label: 'Waiting', val: timing.wait, color: 'var(--timing-wait)' },
    { cls: 'download', label: 'Download', val: timing.download, color: 'var(--timing-download)' },
  ];

  return (
    <div className="ep-section">
      <div className="ep-section-title">
        <span className="dot" style={{ background: 'var(--timing-tls)' }} />
        Timing
        <span style={{
          fontFamily: "'IBM Plex Mono', monospace",
          color: 'var(--text-tertiary)',
          fontSize: '0.68rem',
          textTransform: 'none',
          letterSpacing: 0,
        }}>{total}ms total</span>
      </div>
      <div className="timing-bar-container">
        <div className="timing-bar">
          {segments.map(s => (
            <div key={s.cls} className={`seg ${s.cls}`} style={{ width: `${pct(s.val)}%` }} title={`${s.label}: ${s.val}ms`} />
          ))}
        </div>
        <div className="timing-legend">
          {segments.map(s => (
            <div key={s.cls} className="timing-legend-item">
              <span className="swatch" style={{ background: s.color }} />
              <span className="label">{s.label}</span>
              <span className="val">{s.val}ms</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function AssertionsSection({ assertions }) {
  const counts = { pass: 0, fail: 0, skip: 0 };
  assertions.forEach(a => counts[a.status]++);

  const times = useMemo(() =>
    assertions.map(a => a.status === 'skip' ? '\u2014' : `${(Math.random() * 4 + 0.5).toFixed(1)}ms`),
    [assertions]
  );

  return (
    <div className="ep-section">
      <div className="ep-section-title">
        <span className="dot" style={{ background: 'var(--pass)' }} /> Test Assertions
      </div>
      <div className="assertion-summary">
        <div className="count">
          <span className="dot" style={{ background: 'var(--pass)' }} />
          <span style={{ color: 'var(--pass)' }}>{counts.pass} passed</span>
        </div>
        {counts.fail > 0 && (
          <div className="count">
            <span className="dot" style={{ background: 'var(--fail)' }} />
            <span style={{ color: 'var(--fail)' }}>{counts.fail} failed</span>
          </div>
        )}
        {counts.skip > 0 && (
          <div className="count">
            <span className="dot" style={{ background: 'var(--skip)' }} />
            <span style={{ color: 'var(--skip)' }}>{counts.skip} skipped</span>
          </div>
        )}
        <span className="total">{assertions.length} assertions</span>
      </div>
      <div className="assertion-list">
        {assertions.map((a, i) => (
          <div key={i} className={`assertion ${a.status}`}>
            <AssertionIcon status={a.status} />
            <span className="a-label">{a.label}</span>
            <span className="a-time">{times[i]}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function EndpointCard({ ep, index, defaultOpen }) {
  const [open, setOpen] = useState(defaultOpen);
  const mid = ep.method.toLowerCase();
  const pathHtml = ep.path.replace(/:(\w+)/g, '<span class="param">:$1</span>');

  return (
    <div className={`endpoint-card${open ? ' open' : ''}`} id={`ep-${index}`}>
      <div className="endpoint-header" onClick={() => setOpen(o => !o)}>
        <span className={`method-badge ${mid}`}>{ep.method}</span>
        <span className="endpoint-path" dangerouslySetInnerHTML={{ __html: pathHtml }} />
        <span className="endpoint-desc">{ep.desc}</span>
        <ChevronDown className="endpoint-chevron" />
      </div>
      {open && (
        <div className="endpoint-body" style={{ display: 'block' }}>
          {ep.params.length > 0 && (
            <div className="ep-section">
              <div className="ep-section-title">
                <span className="dot" style={{ background: 'var(--syn-key)' }} /> Parameters
              </div>
              <table className="param-table">
                <thead>
                  <tr><th>Name</th><th>Type</th><th></th><th>Description</th></tr>
                </thead>
                <tbody>
                  {ep.params.map(p => (
                    <tr key={p.name}>
                      <td className="p-name">{p.name}</td>
                      <td className="p-type">{p.type}</td>
                      <td><span className={`p-req ${p.required ? 'required' : 'optional'}`}>{p.required ? 'required' : 'optional'}</span></td>
                      <td className="p-desc">{p.desc}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="ep-section">
            <div className="ep-section-title">
              <span className="dot" style={{ background: 'var(--post)' }} /> Request
            </div>
            <CollapsibleHeaders headers={ep.requestHeaders} />
            {ep.requestBody && <CodeBlock label="BODY" obj={ep.requestBody} />}
          </div>

          <div className="ep-section">
            <div className="ep-section-title">
              <span className="dot" style={{ background: 'var(--get)' }} /> Response
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
              <span className={`status-badge ${ep.responseStatus < 400 ? 's2xx' : 's4xx'}`}>
                {ep.responseStatus} {ep.responseStatus === 200 ? 'OK' : ''}
              </span>
            </div>
            <CollapsibleHeaders headers={ep.responseHeaders} />
            <CodeBlock label="RESPONSE BODY" obj={ep.responseBody} />
          </div>

          <TimingSection timing={ep.timing} />
          <AssertionsSection assertions={ep.assertions} />
        </div>
      )}
    </div>
  );
}

export default function ApiDocs() {
  const handleNavClick = useCallback((e, index) => {
    e.preventDefault();
    const el = document.getElementById(`ep-${index}`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  return (
    <div className="api-docs-page">
      <div className="api-page">
        <header className="api-page-header">
          <h1>Journey API <span>v1.0</span></h1>
          <code className="base-url">http://localhost:3003</code>
        </header>

        <div className="api-layout">
          <aside className="api-sidebar">
            <div className="api-sidebar-label">Endpoints</div>
            <ul className="api-sidebar-nav">
              {ENDPOINTS.map((ep, i) => {
                const mid = ep.method.toLowerCase();
                return (
                  <li key={i}>
                    <a href={`#ep-${i}`} onClick={e => handleNavClick(e, i)}>
                      <span
                        className="nav-method"
                        style={{
                          color: `var(--${mid})`,
                          background: `var(--${mid}-bg)`,
                          border: `1px solid var(--${mid}-border)`,
                        }}
                      >
                        {ep.method}
                      </span>
                      <span>{ep.path.replace('/api', '')}</span>
                    </a>
                  </li>
                );
              })}
            </ul>
          </aside>

          <main>
            {ENDPOINTS.map((ep, i) => (
              <EndpointCard key={i} ep={ep} index={i} defaultOpen={i === 0} />
            ))}
          </main>
        </div>
      </div>
    </div>
  );
}
