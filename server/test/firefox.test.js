import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildFirefox } from '../build-firefox.js';

test('Firefox build packages shared code with an event-page manifest without changing Chrome', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pcb-firefox-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const destination = pathToFileURL(directory + path.sep);
  const source = new URL('../../extension/', import.meta.url);
  const chromeManifest = await fs.readFile(new URL('manifest.json', source), 'utf8');
  const manifest = await buildFirefox(destination);
  assert.equal(await fs.readFile(new URL('manifest.json', source), 'utf8'), chromeManifest);
  assert.equal(manifest.background.service_worker, undefined);
  assert.equal(manifest.key, undefined);
  assert.equal(manifest.storage, undefined);
  const scripts = [
    ...manifest.background.scripts,
    ...manifest.content_scripts.flatMap((entry) => entry.js),
    'profiles.js', 'config.json', 'options.js', 'popup.js', 'ui.css',
    manifest.options_page, manifest.action.default_popup,
  ];
  for (const file of scripts) {
    assert.deepEqual(await fs.readFile(new URL(file, destination)), await fs.readFile(new URL(file, source)));
  }
  assert.deepEqual(JSON.parse(await fs.readFile(new URL('manifest.json', destination), 'utf8')), manifest);
});
