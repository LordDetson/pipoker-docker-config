// Prints a short report of the last run from results.json: each test with its outcome, failures and what it logged.
// node summary.mjs screenshots prints the small screenshots the phone tests logged instead.
import {readFileSync} from 'node:fs';

const report = JSON.parse(readFileSync('results.json', 'utf8'));
const screenshots = process.argv[2] === 'screenshots';
const strip = text => text.replace(/\u001b\[[0-9;]*m/g, '');

function* tests(suite, path = []) {
  for (const spec of suite.specs ?? []) {
    for (const test of spec.tests) {
      yield {title: [...path, spec.title].join(' › '), test};
    }
  }
  for (const child of suite.suites ?? []) {
    yield* tests(child, suite.title && !suite.title.endsWith('.ts') ? [...path, suite.title] : path);
  }
}

for (const suite of report.suites) {
  for (const {title, test} of tests(suite)) {
    const result = test.results.at(-1);
    const output = (result?.stdout ?? []).map(entry => entry.text ?? '').join('').split('\n').filter(Boolean);
    if (screenshots) {
      output.filter(line => line.startsWith('SCREENSHOT')).forEach(line => console.log(line));
      continue;
    }
    console.log(`\n[${test.projectName}] ${result?.status?.toUpperCase()} ${title} (${result?.duration} ms)`);
    output.filter(line => !line.startsWith('SCREENSHOT')).forEach(line => console.log(`  | ${line}`));
    for (const error of result?.errors ?? []) {
      console.log(`  ! ${strip(error.message ?? '').split('\n').filter(Boolean).slice(0, 6).join('\n    ')}`);
      if (error.location) {
        console.log(`    at ${error.location.file.split('/').pop()}:${error.location.line}`);
      }
    }
  }
}
