/**
 * The macOS menu bar shows the brand's short name, "Accounting" (21-accounting-devices), through a
 * localized CFBundleName in each language's InfoPlist.strings, as the brand's names table says.
 * Info.plist itself keeps the full name: Electron finds its helper apps by that CFBundleName.
 */
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const SHORT_NAME = 'Accounting';

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const resources = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources');
  for (const language of context.packager.config.electronLanguages) {
    mkdirSync(join(resources, `${language}.lproj`), { recursive: true });
    writeFileSync(join(resources, `${language}.lproj`, 'InfoPlist.strings'), `"CFBundleName" = "${SHORT_NAME}";\n`);
  }
};
