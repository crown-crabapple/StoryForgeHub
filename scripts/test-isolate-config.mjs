// Loaded with `node --import` by every workspace's test script: points the per-user config folder (recent libraries, AI settings) at a temp folder,
// so no test - and no server or CLI a test starts, which inherit this environment - reads or writes the real one. Tests that need their own still set it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

if (!process.env.STORYFORGE_TEST_CONFIG) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-test-config-'));
  Object.assign(process.env, { STORYFORGE_TEST_CONFIG: dir, APPDATA: path.join(dir, 'AppData'), XDG_CONFIG_HOME: path.join(dir, 'xdg') });
}
