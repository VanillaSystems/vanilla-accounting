/**
 * The only entry into src/workflows from outside it. tests/import-boundaries.test.ts fails on an
 * import of src/workflows/{engine,store,scheduler,actions,load}.ts from anywhere but this folder,
 * src/cli/workflow.ts and tools/check-processes.
 */
export { openAutomation, type Automation, type AutomationDeps } from './engine.js';
export * from './model.js';
