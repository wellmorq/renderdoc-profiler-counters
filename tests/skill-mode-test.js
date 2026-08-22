'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const skill = path.join(root, '.agents', 'skills', 'renderdoc-perf');
const prepareScript = path.join(skill, 'scripts', 'prepare.mjs');
const queryScript = path.join(skill, 'scripts', 'query.mjs');
const tempRoot = fs.mkdtempSync(path.join(root, '.tmp-skill-test-'));
const keepOutput = process.env.RENDERDOC_PERF_KEEP_TEST_OUTPUT === '1';

function scaleCsv(text) {
    const lines = text.trimEnd().split(/\r?\n/);
    const headers = lines[0].split(',');
    const durationIndex = headers.indexOf('GPU Duration (ms)');
    const instructionIndex = headers.indexOf('sm__inst_executed.sum');
    assert.ok(durationIndex > 0 && instructionIndex > 0);
    let addedZeroTransition = false;
    for (let i = 1; i < lines.length; i++) {
        const fields = lines[i].split(',');
        fields[durationIndex] = (Number(fields[durationIndex]) * 1.5).toFixed(5);
        const instructions = Number(fields[instructionIndex]);
        if (!addedZeroTransition && instructions === 0) {
            fields[instructionIndex] = '123.00';
            addedZeroTransition = true;
        } else {
            fields[instructionIndex] = (instructions * 2).toFixed(2);
        }
        lines[i] = fields.join(',');
    }
    assert.ok(addedZeroTransition, 'fixture needs a zero-valued instruction row');
    return `${lines.join('\n')}\n`;
}

async function main() {
try {
    const { aggregateRows, detectCounterKind, prepare } = await import(pathToFileURL(prepareScript).href);
    const { queryCase, renderMarkdown } = await import(pathToFileURL(queryScript).href);
    const singleOutput = path.join(tempRoot, 'single-output');
    const single = await prepare(root, singleOutput);
    assert.equal(single.status, 'prepared');
    const singleManifest = JSON.parse(fs.readFileSync(single.manifest, 'utf8'));
    assert.equal(singleManifest.captures.length, 1);
    assert.equal(singleManifest.captures[0].summary.eventCount, 3704);
    assert.equal(singleManifest.captures[0].summary.counterRowCount, 3491);
    assert.equal(singleManifest.captures[0].summary.metricCount, 41);
    assert.equal(singleManifest.metricsEncoding, 'sparse-zero-omitted');
    assert.ok(fs.statSync(single.report).size < 12_000_000, 'single report should stay compact enough for local use');
    assert.equal(detectCounterKind('counter.max'), 'max');
    assert.equal(detectCounterKind('counter.min'), 'min');
    assert.equal(aggregateRows([{ peak: 2 }, { peak: 5 }], ['peak'], { peak: 'max' }, null).peak, 5);
    assert.equal(aggregateRows([{ low: 2 }, { low: 5 }], ['low'], { low: 'min' }, null).low, 2);

    const reused = await prepare(root, singleOutput);
    assert.equal(reused.status, 'reused');
    assert.equal(reused.caseDir, single.caseDir);

    fs.writeFileSync(single.report, '<!doctype html><title>truncated');
    const recovered = await prepare(root, singleOutput);
    assert.equal(recovered.status, 'prepared');
    assert.match(fs.readFileSync(recovered.report, 'utf8'), /<\/html>\s*$/);

    const compareInput = path.join(tempRoot, 'compare-input');
    const compareOutput = path.join(tempRoot, 'compare-output');
    fs.mkdirSync(compareInput);
    const events = fs.readFileSync(path.join(root, 'example-events.txt'), 'utf8');
    const counters = fs.readFileSync(path.join(root, 'example-counters.csv'), 'utf8');
    const afterEvents = events.replace('ReflectionProbes.Update', 'ReflectionProbes.Update.AfterOnly');
    assert.notEqual(afterEvents, events);
    fs.writeFileSync(path.join(compareInput, 'before-events.txt'), events);
    fs.writeFileSync(path.join(compareInput, 'before-counters.csv'), counters);
    fs.writeFileSync(path.join(compareInput, 'after-events.txt'), afterEvents);
    fs.writeFileSync(path.join(compareInput, 'after-counters.csv'), scaleCsv(counters));
    fs.writeFileSync(path.join(compareInput, 'notes.txt'), 'not a RenderDoc export');
    fs.writeFileSync(path.join(compareInput, 'unrelated.csv'), 'name,value\nfoo,bar\n');

    const compared = await prepare(compareInput, compareOutput);
    const manifest = JSON.parse(fs.readFileSync(compared.manifest, 'utf8'));
    assert.deepEqual(manifest.captures.map(capture => capture.label), ['before', 'after']);
    assert.equal(manifest.comparison.matchedCount, 3703);
    assert.equal(manifest.comparison.onlyFirstCount, 1);
    assert.equal(manifest.comparison.onlySecondCount, 1);
    assert.ok(manifest.warnings.some(warning => warning.includes('Marker topology differs')));

    const beforeGraph = fs.readFileSync(path.join(compared.caseDir, manifest.captures[0].graphFile), 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line));
    const afterGraph = fs.readFileSync(path.join(compared.caseDir, manifest.captures[1].graphFile), 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line));
    const beforeByKey = new Map(beforeGraph.map(record => [record.stableKey, record]));
    const zeroTransition = afterGraph.find(record => record.scope === 'self' && record.metrics['sm__inst_executed.sum'] === 123);
    assert.ok(zeroTransition, 'after graph should retain a metric that changed from zero');
    assert.equal(beforeByKey.get(zeroTransition.stableKey).metrics['sm__inst_executed.sum'] ?? 0, 0);

    const report = fs.readFileSync(compared.report, 'utf8');
    assert.doesNotMatch(report, /__REPORT_DATA__/);
    assert.doesNotMatch(report, /<script[^>]+src=|<link[^>]+href=/i);
    assert.match(report, /Matched event graph/);
    assert.match(report, /record\.stableKey/);
    assert.doesNotMatch(report, /record\.key/);
    const scripts = Array.from(report.matchAll(/<script>([\s\S]*?)<\/script>/g), match => match[1]);
    assert.equal(scripts.length, 1);
    new vm.Script(scripts[0], { filename: 'generated-report:inline' });

    const query = renderMarkdown(await queryCase(compared.caseDir, 'Deferred Lighting'));
    assert.match(query, /## Warnings/);
    assert.match(query, /Marker topology differs/);
    assert.match(query, /before → after/);
    assert.match(query, /GPU duration/);
    assert.match(query, /\+50\.0%/);
    assert.match(query, /SM instructions/);
    assert.match(query, /\+100\.0%/);
    assert.match(query, /Largest meaningful counter changes/);

    const incompleteInput = path.join(tempRoot, 'incomplete-input');
    fs.mkdirSync(incompleteInput);
    fs.writeFileSync(path.join(incompleteInput, 'events.txt'), events);
    await assert.rejects(() => prepare(incompleteInput, path.join(tempRoot, 'incomplete-output')), /same number of events TXT and counters CSV/);

    const catalog = JSON.parse(fs.readFileSync(path.join(skill, 'references', 'nvidia-counters.json'), 'utf8'));
    assert.ok(catalog.entries.length >= 30);
    assert.ok(catalog.entries.some(entry => entry.prefix.includes('long_scoreboard')));

    console.log('Skill mode test passed: single capture, cache reuse, before/after graph, topology warnings, zero transitions, query evidence, generated HTML, NVIDIA catalog.');
    if (keepOutput) console.log(`Manual test output: ${tempRoot}`);
} finally {
    if (!keepOutput) fs.rmSync(tempRoot, { recursive: true, force: true });
}
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
