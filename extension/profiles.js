// Built-in tester page profiles.
//
// A profile tells the content script HOW to read one tester program's page:
//   url_pattern       RegExp (string) matched against the tab URL
//   station           station / program ID reported to the API (e.g. ICT-01)
//   status_selector   CSS selector of the element showing the machine state
//   status_source     "text" | "value" | "attr:<name>"   (where to read the state from)
//   serial_selector   CSS selector of the element containing the board serial number
//   serial_source     "text" | "value" | "attr:<name>"
//   serial_regex      optional RegExp; capture group 1 (or whole match) is the serial
//   pass_values       state values that mean PASSED   (case-insensitive, compared after trim)
//   fail_values       state values that mean FAILED
//   running_values    optional state values that mean "test in progress" (used for cycle time)
//   failed_selector   optional selector; text of every match is sent as failedSteps
//   failed_cells      optional 1-based cell indexes to join when failed_selector matches table rows
//   cells             optional multi-cell mapping; selectors are relative to each cell root
//   completion_mode   "cells" (all active cells terminal) | "indicator" (also wait for status_selector)
//   completion_values optional overall indicator words (e.g. COMPLETE), in addition to pass/fail
//
// To support a new real tester program, add a profile here or push one via Chrome policy / Options page.
export const DEFAULT_PROFILES = [
  {
    id: 'demo-image',
    url_pattern: '/testers/image\\.html',
    station: 'IMG-05', station_name: 'VisionInspect Eight-Cell', program: 'MBX200_AOI_v1',
    status_selector: '#imageOverall', status_source: 'attr:data-state',
    serial_selector: '.cell-serial', serial_source: 'value',
    pass_values: ['PASSED'], fail_values: ['FAILED'], running_values: ['TESTING'],
    completion_mode: 'indicator', completion_values: ['COMPLETE'],
    cells: {
      selector: '.image-cell', count: 8, id_source: 'attr:data-cell-id',
      status_selector: '.cell-status', status_source: 'text',
      serial_selector: '.cell-serial', serial_source: 'value',
      pass_values: ['PASSED'], fail_values: ['FAILED'],
      skip_values: ['MALFUNCTION', 'MULFUNCTION'],
      failed_selector: '.cell-failure',
    },
  },
  {
    id: 'demo-ict',
    url_pattern: '/testers/ict\\.html',
    station: 'ICT-01', station_name: 'TestMaster ICT 8800', program: 'MBX200_ICT_v3.4',
    status_selector: '#ictResult', status_source: 'text',
    serial_selector: '#ictSerial', serial_source: 'text', serial_regex: '^[A-Z0-9-]{6,}$',
    pass_values: ['PASSED'], fail_values: ['FAILED'], running_values: ['TESTING'],
    failed_selector: 'table.steps tr.fail', failed_cells: [2, 3],
  },
  {
    id: 'demo-fct',
    url_pattern: '/testers/fct\\.html',
    station: 'FCT-02', station_name: 'FuncTest Studio 5', program: 'MBX200_FCT_SEQ_2.1',
    status_selector: '.fct-verdict', status_source: 'attr:data-verdict',
    serial_selector: 'table.dut-info td[data-field="sn"]', serial_source: 'text', serial_regex: '^[A-Z0-9-]{6,}$',
    pass_values: ['PASSED'], fail_values: ['FAILED'], running_values: ['RUNNING'],
    failed_selector: 'table.steps tr.fail', failed_cells: [2, 3],
  },
  {
    id: 'demo-jtag',
    url_pattern: '/testers/jtag\\.html',
    station: 'BSC-03', station_name: 'ScanPro Boundary-Scan', program: 'MBX200_BSCAN.prj',
    status_selector: '#jtag-state', status_source: 'text',
    serial_selector: '#dutSn', serial_source: 'value', serial_regex: '^[A-Z0-9-]{6,}$',
    pass_values: ['PASS'], fail_values: ['FAIL'], running_values: ['RUN'],
    failed_selector: 'table.steps tr.fail', failed_cells: [2, 3],
  },
  {
    id: 'demo-fpt',
    url_pattern: '/testers/flying-probe\\.html',
    station: 'FPT-04', station_name: 'AeroProbe 4-Axis', program: 'MBX200_FPT_r7',
    status_selector: '.status-lamp .label', status_source: 'text',
    serial_selector: '#fp-board-id', serial_source: 'text', serial_regex: 'S/N:\\s*([A-Z0-9-]{6,})',
    pass_values: ['PASSED'], fail_values: ['FAILED'], running_values: ['TESTING'],
    failed_selector: 'table.steps tr.fail', failed_cells: [2, 3],
  },
  {
    // Generic convention any in-house tester page can adopt without a custom profile:
    // <el data-tester-status="PASSED"> and <el data-board-serial="SN123">
    id: 'generic-data-attributes',
    url_pattern: '.*',
    station: '', station_name: 'Generic tester page', program: '',
    status_selector: '[data-tester-status]', status_source: 'attr:data-tester-status',
    serial_selector: '[data-board-serial]', serial_source: 'attr:data-board-serial',
    pass_values: ['PASSED', 'PASS'], fail_values: ['FAILED', 'FAIL'], running_values: ['TESTING', 'RUNNING'],
    require_element: true,
  },
];

export function validateProfiles(profiles) {
  if (!Array.isArray(profiles)) throw new Error('Profiles must be an array');
  const source = (value) => value === undefined || value === 'text' || value === 'value'
    || (typeof value === 'string' && /^attr:.+$/.test(value));
  function mapping(p, label, cell = false) {
    for (const key of ['status_selector', 'serial_selector']) {
      if (typeof p[key] !== 'string' || !p[key].trim()) throw new Error(`${label}: ${key} is required`);
    }
    for (const key of ['status_source', 'serial_source']) {
      if (!source(p[key])) throw new Error(`${label}: invalid ${key}`);
    }
    if (p.serial_regex) new RegExp(p.serial_regex);
    for (const key of ['pass_values', 'fail_values', 'running_values', 'skip_values', 'completion_values']) {
      if (p[key] !== undefined && (!Array.isArray(p[key]) || p[key].some((v) => typeof v !== 'string' || !v.trim()))) {
        throw new Error(`${label}: ${key} must be an array of nonempty words`);
      }
    }
    const normalize = (values) => values.map((v) => v.trim().toUpperCase());
    const pass = normalize(p.pass_values || ['PASSED']);
    const fail = normalize(p.fail_values || ['FAILED']);
    const skip = normalize(p.skip_values || (cell ? ['MALFUNCTION', 'MULFUNCTION'] : []));
    if (pass.some((v) => fail.includes(v) || skip.includes(v)) || fail.some((v) => skip.includes(v))) {
      throw new Error(`${label}: pass, fail and skip words must not overlap`);
    }
    const running = normalize(p.running_values || []);
    if (running.some((v) => pass.includes(v) || fail.includes(v) || normalize(p.completion_values || []).includes(v))) {
      throw new Error(`${label}: running words must not overlap final or completion words`);
    }
  }
  for (const p of profiles) {
    if (!p || typeof p.url_pattern !== 'string' || !p.url_pattern) throw new Error('Each profile needs url_pattern');
    new RegExp(p.url_pattern);
    mapping(p, p.id || p.url_pattern);
    if (p.completion_mode !== undefined && !['cells', 'indicator'].includes(p.completion_mode)) {
      throw new Error('completion_mode must be cells or indicator');
    }
    if (p.cells) {
      if (typeof p.cells.selector !== 'string' || !p.cells.selector.trim() || !Number.isInteger(p.cells.count) || p.cells.count < 1 || p.cells.count > 64) {
        throw new Error('cells needs a selector and count between 1 and 64');
      }
      if (!source(p.cells.id_source)) throw new Error('Invalid cell id_source');
      mapping(p.cells, `${p.id || p.url_pattern} cells`, true);
      if (!p.running_values?.length) throw new Error('Multi-cell profiles need overall running_values');
    }
  }
}
