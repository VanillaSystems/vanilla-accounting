/**
 * Which build macOS's answers about a folder are kept for (#373). macOS knows an app by its code
 * signature: a build signed ad hoc (no Developer ID) is a new app after every build, even one of
 * the same package version (0.4.2-rc.56 and rc.57 both say 0.4.2), and macOS asks again. So the
 * answers of such a build hold for that build only: its version string and when it was built. A
 * build signed with a Developer ID keeps macOS's answers across updates; its answers are kept per
 * package version, so an update says the words once more at most, and never needlessly per build.
 */
import { execFile } from 'node:child_process';

export interface BuildIdentity {
  /** package.json's version (Electron's app.getVersion()). */
  packageVersion: string;
  /** The build's own string (src/version.ts appVersion(): 0.4.2-rc.56+g36b66d6). */
  build: string;
  /** When the packed bundle was built (VANILLA_BUILT_AT): two builds of one commit differ in it. Absent under desktop:dev, whose rebuilds keep one key. */
  builtAt?: string;
  /** Signed with a Developer ID (codesign's Authority line). */
  developerId: boolean;
}

export const answerKey = (b: BuildIdentity): string =>
  (b.developerId ? b.packageVersion : `${b.build}@${b.builtAt ?? ''}`);

/** codesign -dv prints its lines on stderr; a Developer ID signature names its authority so. */
export const signedByDeveloperId = (codesignOutput: string): boolean => /^Authority=Developer ID Application:/m.test(codesignOutput);

/** Whether the app bundle at `app` is signed with a Developer ID; false when codesign cannot tell. */
export function developerIdOf(app: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('/usr/bin/codesign', ['-dv', '--verbose=2', app], { timeout: 2000 }, (err, stdout, stderr) => {
      resolve(!err && signedByDeveloperId(`${stdout}\n${stderr}`));
    });
  });
}
