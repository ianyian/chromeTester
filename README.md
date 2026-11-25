# PCB Tester Result Collector

A Chrome extension that watches several PCB tester program tabs at once. When a tab's test cycle
finishes with **PASSED** or **FAILED**, it reads the **board serial number** from the page and posts it
to a REST API that stores it in a database (SQLite for this demo). Multi-cell testers upload all active
serials together only after the full batch completes, excluding malfunction cells from pass/fail.

```
 Linux tester PC (PCB-TESTER-001)                                     Central server
┌──────────────────────────────────────────────────────┐          ┌──────────────────────────┐
│ Chrome                                               │          │ REST API (Node.js)       │
│  Tab 1  ICT-01  ─┐ content.js (MutationObserver)     │          │ POST /api/tester/completed│
│  Tab 2  FCT-02  ─┤   detects IDLE→TESTING→PASSED     │  HTTPS   │          │               │
│  Tab 3  BSC-03  ─┤   reads serial, failed steps      ├─────────▶│          ▼               │
│  Tab 4  FPT-04  ─┘                                   │  JSON    │ SQLite (demo) → MSSQL    │
│        background.js: config + persistent queue      │          └──────────────────────────┘
│        + retry, dedupe (eventId), badge, popup       │
└──────────────────────────────────────────────────────┘
```

| Folder | What it is |
|---|---|
| `extension/` | Chrome MV3 extension: content script, service worker, popup, options page, native-messaging host |
| `server/` | REST API plus static host for the demo pages. **No dependencies**: it uses Node's built-in `node:sqlite` |
| `public/testers/` | 5 simulated tester programs (ICT, FCT, JTAG boundary scan, flying probe, eight-cell image test), each with different markup |
| `public/dashboard.html` | Live view of what landed in the database |
| `deploy/` | Example per-machine config and Chrome policy file |

## Quick start (demo)

Requires **Node.js 22.13 or newer** (for the built-in SQLite) and Google Chrome or Chromium.

```bash
cd server
npm start
```

Then:

1. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and select the `extension/` folder.
2. Click the extension icon, then **Open demo testers**. Five tester tabs open and start cycling boards automatically.
3. Click **Dashboard**, or open http://localhost:3000/dashboard.html, to watch results arrive in SQLite (`server/data/test_results.db`).

Each tester page has its own controls: Start / Abort, auto cycle, **fail rate**, and **speed**.
You can stop the server for a while to see results queue up in the extension (red badge). They upload automatically once the API is back.

## How detection works

`extension/profiles.js` describes how to read each tester page. The demo pages are deliberately different from each other:

| Station | Status element | Status words | Serial |
|---|---|---|---|
| ICT-01 | `#ictResult` text | `PASSED` / `FAILED` | `#ictSerial` text |
| FCT-02 | `.fct-verdict` **attribute** `data-verdict` | `PASSED` / `FAILED` | `td[data-field=sn]` |
| BSC-03 | `#jtag-state` text | `PASS` / `FAIL` | `<input id=dutSn>` **value** |
| FPT-04 | `.status-lamp .label` text | `PASSED` / `FAILED` | `"S/N: …"` parsed with **regex** |
| IMG-05 | `#imageOverall` attribute `data-state` | `COMPLETE`; per-cell `PASSED` / `FAILED` | Each cell's `.cell-serial` input |

The content script observes the page with a `MutationObserver`, plus a 1-second poll for `<input>` values.
It reports **once per test cycle**. A verdict is only reported after a non-final state (TESTING, IDLE, …) has been seen first.
This means reloading a page that already shows PASSED does not create a duplicate, while re-testing the same serial still gets reported.
Each event gets a UUID `eventId`, and the API ignores repeats of the same ID (`INSERT OR IGNORE`). Network retries are therefore safe.

To support a real tester program, add a profile (Options page, policy, or `profiles.js`).
Alternatively, the tester page can follow the generic convention: `data-tester-status="PASSED"` and `data-board-serial="…"`.

### Multi-cell tester / image-test demo

Open http://localhost:3000/testers/image.html. Eight cells run independently with different serials.
By default, cell 2 demonstrates an early failure and cell 8 is malfunctioning. Disable **Auto cycle**
to enter serials manually; use each cell's **Cell malfunction** and **Force early failure** controls
between batches. Failed cells stop immediately while other cells continue.

The collector waits until **every active cell** is PASSED or FAILED. Malfunction cells are ignored
for completion and overall pass/fail, but retained as `MALFUNCTION` batch metadata. An all-malfunction
cycle uploads no board records. Any active FAILED result makes overall FAILED; otherwise overall
is PASSED. This does not prevent uploading a completed failed batch.

The extension sends **one request for the complete batch**, and SQLite inserts **one row per active
serial in a single transaction**. Each row keeps its own result, `batch_id`, and `cell_id`. API queries
also return `overall_status` and `skipped_cells`; malfunction cells are not counted as tested boards.
The dashboard shows cell IDs, overall results, and malfunction cells. Hover over a cell ID to see its
batch ID, or over a batch in extension history to see its individual results.

### Configuring API URL and result indicators

Open the extension's **Settings**:

- **API URL** is the full POST endpoint. Query parameters such as `?line=SMT-3` are preserved.
  Save it and use **Test API** (this demo's health check is `/api/health` on that endpoint's origin;
  external APIs must expose that route for this button to work). Managed-policy URLs stay locked.
- Under **Per-tester result detection**, select a profile or **Add tester profile**. Set the URL
  regex, overall status CSS selector/source, serial mapping, and status words. First matching URL wins;
  put specific profiles before the generic catch-all.
- For single-board testers, choose **Single-board overall PASSED / FAILED** and point the status
  selector at the *overall verdict*, never at an individual step's result.
- For multi-cell testers, choose **all active cells PASSED / FAILED**, or additionally require
  an **overall indicator complete**. The latter recognizes overall pass/fail words plus any
  additional completion words (such as `COMPLETE`). Even an early overall FAILED indicator never
  bypasses unfinished active cells.
- Set the expected total cell count (including malfunction cells), cell-container selector, and
  selectors **relative to each container** for status, serial, and optional failed steps. Cell IDs
  can come from a container attribute such as `attr:data-cell-id`; otherwise positions are used.
  Missing containers, missing active serials, and unknown cell statuses block upload, rather than
  being treated as skipped. Cell IDs must be unique and stable through a cycle.
- Configure explicit malfunction words (`MALFUNCTION` and the legacy spelling `MULFUNCTION` are
  supported in the image demo). Map only actual disabled/bad cells as skipped, not pending cells.
- Multi-cell cycle detection requires observing an overall running word (e.g. TESTING), followed
  by completion. The page must reset its overall indicator between cycles; an aborted cycle should
  return to IDLE, not COMPLETE. Reloading a completed page does not report the old batch.

Click **Save tester settings** and **reload tester tabs**. Advanced JSON profiles remain available.
The built-in `demo-image` profile in `extension/profiles.js` is a complete eight-cell mapping example.

If IMG-05 runs but does not appear on the dashboard:

1. Reload the unpacked extension on `chrome://extensions` after updating its code, then reload tester tabs.
   Reloading only a tester page does not refresh Chrome's loaded extension code.
2. Check **Settings → Tester profile** for IMG-05. A saved profiles array overrides the entire built-in
   list, so an older saved list will not automatically gain new demo profiles. Add the missing image
   profile before the generic catch-all, preserving custom profiles, or use **Use built-in profiles**
   if you do not need your saved customizations.
3. Check the extension popup for IMG-05 under **Monitored tabs**, upload errors, and API connectivity.
   Start the demo server if it is offline. After a complete batch, the dashboard shows each cell's own
   **Result**, the batch's **Overall** result, and the malfunction-cell metadata.

## Per-machine configuration (one extension, many testers)

Every Linux tester runs the **same extension code**. Only its config differs:

```json
{
  "tester_id": "PCB-TESTER-001",
  "machine_name": "PCB-LINUX-001",
  "api_endpoint": "https://mes.company.com/api/tester/completed",
  "enabled": true
}
```

Settings are merged in this order, from lowest to highest priority:

1. Built-in defaults
2. `extension/config.json` (bundled; good for the demo)
3. `/etc/pcb-tester/tester.json`, read by the **native messaging host**. Optional; only used when `use_native_hostname` is true.
4. Values saved on the extension **Options** page
5. **Chrome managed policy** (recommended for production; it cannot be changed by operators)

Notes:

- **Managed policy (recommended).** Copy `deploy/chrome-policy-PCB-TESTER-001.json` to `/etc/opt/chrome/policies/managed/` on each tester, with that machine's values. Use `/etc/chromium/policies/managed/` for Chromium. Chrome passes the `3rdparty.extensions.<id>` section to the extension through `chrome.storage.managed`. The same file can also force-install the extension (`ExtensionSettings`) from your own update URL.
- **Hostname via Native Messaging.** A browser extension can't run `hostname` or read files on its own. Run `sudo extension/native-host/install.sh`, then enable *use_native_hostname*. The host returns the Linux hostname and the optional `/etc/pcb-tester/tester.json`. If no `tester_id` is configured anywhere, the hostname is used as the tester ID.
- **Stable extension ID.** The manifest contains a public `key`, so the extension ID is always `ekhaanoedcoajbabpjfmhjmkjpkhppka`. The policy file and the native host both refer to the extension by this ID.
- **No secrets in the extension.** Do **not** put API keys in config files or the extension. Anyone can read them. Protect the API at the network level, or with mTLS / a gateway, or issue per-machine tokens from a separate service.

## REST API

| Method & path | Purpose |
|---|---|
| `POST /api/tester/completed` | Save a result or complete cell batch (alias: `POST /api/test-results`). Returns 201 when created, 200 `{duplicate:true}` for a repeated `eventId`, 400 on validation errors, 409 for conflicting cell event IDs |
| `GET /api/test-results?status=&tester=&station=&serial=&limit=` | Query results (newest first) |
| `GET /api/test-results/:id` | Fetch one result |
| `GET /api/stats` | Totals and yield per tester and station |
| `DELETE /api/test-results` | Clear the demo database |
| `GET /api/health` | Health check (used by the popup) |

Example payload sent by the extension:

```json
{
  "eventId": "1972bbd1-4c08-4afd-8b5b-1764307b5ebb",
  "testerId": "PCB-TESTER-001",
  "machineName": "PCB-LINUX-001",
  "tabId": 1879551383,
  "station": "FCT-02",
  "stationName": "FuncTest Studio 5",
  "program": "MBX200_FCT_SEQ_2.1",
  "serialNumber": "MBX200-2647-008020",
  "status": "PASSED",
  "completed": true,
  "failedSteps": [],
  "cycleTimeMs": 18600,
  "startTime": "2026-11-24T13:37:56.269Z",
  "endTime": "2026-11-24T13:38:14.869Z",
  "pageUrl": "http://localhost:3000/testers/fct.html",
  "timestamp": "2026-11-24T13:38:14.870Z"
}
```

`curl` example:

```bash
curl -X POST http://localhost:3000/api/tester/completed -H 'Content-Type: application/json' -d '{"serialNumber":"SN-TEST-1","status":"PASSED","testerId":"PCB-TESTER-001","station":"MANUAL"}'
```

Multi-cell request (same endpoint; each active cell needs a stable event ID for retries):

```json
{
  "eventId": "batch-uuid",
  "testerId": "PCB-TESTER-001",
  "station": "IMG-05",
  "completed": true,
  "overallStatus": "FAILED",
  "results": [
    { "eventId": "cell-uuid-1", "cellId": "1", "serialNumber": "IMG-001", "status": "PASSED" },
    { "eventId": "cell-uuid-2", "cellId": "2", "serialNumber": "IMG-002", "status": "FAILED", "failedSteps": ["Image alignment"] }
  ],
  "skippedCells": [
    { "cellId": "3", "status": "MALFUNCTION", "rawStatus": "MULFUNCTION", "serialNumber": null }
  ]
}
```

The batch API accepts up to 64 total cells, validates the entire batch before inserting, and rejects
incomplete active results or duplicate cell IDs/serials. Retrying the same batch ID returns the already
saved rows. Existing databases are upgraded additively on startup; single-board requests keep working.
Custom API endpoints must support this batch shape to receive multi-cell results.

## Tests

```bash
cd server
npm test
```

Uses Node's built-in test runner with no dependencies. Tests cover cell completion/skip gating,
single-board detection, concurrent uploads, batch atomicity, retry deduplication, and SQLite migration.
API tests use a temporary database and an ephemeral port, leaving the demo database untouched.

### Moving to Microsoft SQL Server

All SQL lives in `server/server.js`, in the `db` and `stmt` section. To move to MSSQL, replace that section with the `mssql` package and an equivalent table:

- `INSERT OR IGNORE` becomes `MERGE`, or `IF NOT EXISTS … INSERT`.
- Keep a unique index on `event_id`.
- Preserve the batch table, cell/batch IDs, and transaction around all active cell inserts so a batch
  cannot be saved partially.

The extension doesn't need any change.

## Production notes

- **MV3 service workers sleep.** Nothing important is kept in memory. The queue and history live in `chrome.storage.local`, and a `chrome.alarms` timer retries every 30 s or more. Results survive browser restarts.
- **Background tabs.** Chrome throttles timers in hidden tabs. `MutationObserver` still fires whenever the tester page updates its DOM, so detection works in background tabs. On kiosk testers you can also turn off `IntensiveWakeUpThrottlingEnabled` through policy.
- **Permissions.** The content script is registered for `<all_urls>`, but it exits immediately on pages that match no profile. In production you can narrow `matches` and `host_permissions` to your tester hosts.
