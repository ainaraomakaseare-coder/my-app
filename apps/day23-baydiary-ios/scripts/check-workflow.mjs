import fs from 'node:fs/promises';import assert from 'node:assert/strict';import YAML from 'yaml';
const workflow=YAML.parse(await fs.readFile('../../.github/workflows/baydiary-ios-build.yml','utf8'));
assert.deepEqual(workflow.on.workflow_dispatch.inputs.destination.options,['simulator','testflight']);
assert.equal(workflow.permissions.contents,'read');
assert.ok(workflow.jobs.build.steps.some(step=>step.name==='Sign and upload to TestFlight'&&step.if==="inputs.destination == 'testflight'"));
console.log('Workflow YAML and explicit TestFlight dispatch verified.');
