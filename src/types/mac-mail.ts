/**
 * Why the Mail app of this Mac could not be read (src/platform/sources/mac-mail.ts). `unavailable`:
 * no macOS or no osascript; `not-permitted`: the person said no to «… möchte Mail steuern» (System
 * Settings › Privacy › Automation); `not-running`: Mail is not open; `no-account` / `no-mailbox`:
 * Mail has no account or mailbox of that name (none set up, or renamed); `timeout`: Mail did not
 * answer in time. Here, not beside the source, because an API refusal names it too.
 */
export type MacMailProblem = 'unavailable' | 'not-permitted' | 'not-running' | 'no-account' | 'no-mailbox' | 'timeout' | 'failed';
