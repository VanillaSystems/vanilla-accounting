/**
 * Preloaded (`--import`) into each test file's process and each API server a test starts, so a run
 * killed partway (an agent's timeout, a SIGKILL) leaves nothing behind under launchd. The process
 * ends once its parent is gone. Under tools/test/run.sh it also ends once that script is gone
 * ($VANILLA_TEST_RUN), and takes its parent with it: the test runner loads no --import of its own.
 * It ends the way a test's stop() does, by SIGTERM, and exits outright if that hangs.
 */
const parentPid = process.ppid;
const runPid = Number(process.env.VANILLA_TEST_RUN) || 0;

function gone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

const watch = setInterval(() => {
  const orphaned = process.ppid !== parentPid;
  if (!orphaned && !(runPid && gone(runPid))) return;
  clearInterval(watch);
  if (!orphaned && parentPid > 1) process.kill(parentPid, 'SIGTERM');
  setTimeout(() => process.exit(1), 5000).unref();
  process.kill(process.pid, 'SIGTERM');
}, 1000).unref();
