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
//
// To support a new real tester program, add a profile here or push one via Chrome policy / Options page.
export const DEFAULT_PROFILES = [
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
