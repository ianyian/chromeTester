import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const source = new URL('../extension/', import.meta.url);
const assets = [
  'background.js', 'content.js', 'profiles.js', 'config.json',
  'popup.html', 'popup.js', 'options.html', 'options.js', 'ui.css',
];

export async function buildFirefox(destination = new URL('./firefox-addon/', import.meta.url)) {
  const manifest = JSON.parse(await fs.readFile(new URL('manifest.json', source), 'utf8'));
  delete manifest.key;
  delete manifest.storage;
  manifest.background = { scripts: ['background.js'], type: 'module' };
  manifest.browser_specific_settings = {
    gecko: {
      id: 'pcb-tester-collector@chrome-tester',
      strict_min_version: '140.0',
      data_collection_permissions: {
        required: ['websiteContent', 'browsingActivity'],
      },
    },
  };
  await fs.mkdir(destination, { recursive: true });
  await Promise.all(assets.map((file) => fs.copyFile(new URL(file, source), new URL(file, destination))));
  await fs.writeFile(new URL('manifest.json', destination), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await buildFirefox();
  console.log('Firefox add-on prepared in server/firefox-addon.');
}
