'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const skill = path.join(root, '.agents', 'skills', 'renderdoc-perf');
const prepareScript = path.join(skill, 'scripts', 'prepare.mjs');
const queryScript = path.join(skill, 'scripts', 'query.mjs');
const tempRoot = fs.mkdtempSync(path.join(root, '.tmp-skill-test-'));
const keepOutput = process.env.RENDERDOC_PERF_KEEP_TEST_OUTPUT === '1';

function assertFiniteNumbers(value, location = 'root') {
    if (typeof value === 'number') {
        assert.ok(Number.isFinite(value), `${location} must be finite, got ${value}`);
        return;
    }
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
        value.forEach((entry, index) => assertFiniteNumbers(entry, `${location}[${index}]`));
        return;
    }
    Object.entries(value).forEach(([key, entry]) => assertFiniteNumbers(entry, `${location}.${key}`));
}

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
    const { aggregateRows, detectCounterKind, inspectCandidates, parseCounters, parseEvents, prepare } = await import(pathToFileURL(prepareScript).href);
    const { queryCase, renderMarkdown } = await import(pathToFileURL(queryScript).href);
    const singleOutput = path.join(tempRoot, 'single-output');
    const single = await prepare(root, singleOutput);
    assert.equal(single.status, 'prepared');
    const singleManifest = JSON.parse(fs.readFileSync(single.manifest, 'utf8'));
    assert.equal(singleManifest.captures.length, 1);
    assert.equal(singleManifest.captures[0].summary.eventCount, 3704);
    assert.equal(singleManifest.captures[0].summary.counterRowCount, 3491);
    assert.equal(singleManifest.captures[0].summary.metricCount, 41);
    assert.equal(singleManifest.schemaVersion, 2);
    assert.equal(singleManifest.metricsEncoding, 'sparse-zero-omitted');
    assert.equal(singleManifest.metricAvailability, 'counterRowCount-zero-means-unmeasured');
    assert.ok(fs.statSync(single.report).size < 12_000_000, 'single report should stay compact enough for local use');
    assert.equal(detectCounterKind('counter.max'), 'max');
    assert.equal(detectCounterKind('counter.min'), 'min');
    assert.equal(aggregateRows([{ peak: 2 }, { peak: 5 }], ['peak'], { peak: 'max' }, null).peak, 5);
    assert.equal(aggregateRows([{ low: 2 }, { low: 5 }], ['low'], { low: 'min' }, null).low, 2);
    assert.equal(aggregateRows([{ pct: 10, time: 1 }, { pct: 30, time: 3 }], ['pct'], { pct: 'mean' }, 'time').pct, 25);
    assert.equal(parseCounters('\uFEFFEID,"counter,value"\n1,"1,234.5"\n', 'quoted.csv').counters.get(1)['counter,value'], 1234.5);
    assert.equal(parseCounters('EID,GPU Duration (µs)\n1,2500\n', 'microseconds.csv').durationToMs, 0.001);
    assert.throws(() => parseCounters('EID,GPU Duration (ms)\n1,\n', 'blank.csv'), /empty counter value/);
    assert.throws(() => parseEvents('Fixture\n---\n1 | - First |\n1 | - Duplicate |\n', 'duplicate.txt'), /duplicate event EID 1/);
    assert.equal(parseEvents('Fixture\n---\n1 | - Pass | Variant | 7\n', 'pipe.txt').nodes[0].name, 'Pass | Variant');

    const reused = await prepare(root, singleOutput);
    assert.equal(reused.status, 'reused');
    assert.equal(reused.caseDir, single.caseDir);

    fs.writeFileSync(single.report, '<!doctype html><title>truncated');
    const recovered = await prepare(root, singleOutput);
    assert.equal(recovered.status, 'prepared');
    assert.match(fs.readFileSync(recovered.report, 'utf8'), /<\/html>\s*$/);
    const recoveredManifest = JSON.parse(fs.readFileSync(recovered.manifest, 'utf8'));
    const recoveredGraph = path.join(recovered.caseDir, recoveredManifest.captures[0].graphFile);
    fs.unlinkSync(recoveredGraph);
    const repairedGraph = await prepare(root, singleOutput);
    assert.equal(repairedGraph.status, 'prepared');
    assert.ok(fs.statSync(recoveredGraph).size > 0, 'prepare must rebuild a missing cached graph');

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
    assert.ok(manifest.warnings.some(warning => warning.includes('Ignored 2 invalid TXT/CSV candidates')));
    fs.unlinkSync(path.join(compareInput, 'notes.txt'));
    fs.unlinkSync(path.join(compareInput, 'unrelated.csv'));
    const withoutRejected = await prepare(compareInput, compareOutput);
    assert.notEqual(withoutRejected.caseDir, compared.caseDir, 'rejected candidates that affect warnings must affect the case fingerprint');
    assert.ok(!JSON.parse(fs.readFileSync(withoutRejected.manifest, 'utf8')).warnings.some(warning => warning.includes('Ignored')));

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
    assert.match(report, /Relative event timeline/);
    assert.match(report, /id="timeline-grid"/);
    assert.match(report, /not GPU start\/end timestamps/);
    assert.match(report, /function recordShares/);
    assert.match(report, /function descendantRange/);
    assert.doesNotMatch(report, /ASK AI|PluginManager|add-plugin/i);
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

    const treeInput = path.join(tempRoot, 'tree-input');
    fs.mkdirSync(treeInput);
    const treeEvents = [
        'Tree fixture',
        '---',
        '1 | - MainMarker |',
        '2 |   - ChildA |',
        '3 |     - Grandchild |',
        '4 |   - ChildB |',
        '5 | - ZeroMarker |',
        '6 |   - ZeroChild |',
        ''
    ].join('\n');
    const treeCounters = [
        'EID,GPU Duration (ms),PS Invocations,sm__inst_executed.sum,"counter,value"',
        '3,4,40,400,7',
        '4,6,60,600,8',
        '6,0,0,0,0',
        ''
    ].join('\n');
    fs.writeFileSync(path.join(treeInput, 'events.txt'), treeEvents);
    fs.writeFileSync(path.join(treeInput, 'counters.csv'), treeCounters);
    const treeCase = await prepare(treeInput, path.join(tempRoot, 'tree-output'));
    const listCli = spawnSync(process.execPath, [prepareScript, treeInput, '--list'], { encoding: 'utf8' });
    if (listCli.error) {
        assert.equal(listCli.error.code, 'EPERM', `unexpected CLI spawn failure: ${listCli.error}`);
    } else {
        assert.equal(listCli.status, 0, listCli.stderr);
        assert.equal(JSON.parse(listCli.stdout).readiness.ready, true);
        const prepareCliOutput = path.join(tempRoot, 'tree-cli-output');
        const prepareCli = spawnSync(process.execPath, [prepareScript, treeInput, '--output', prepareCliOutput], { encoding: 'utf8' });
        assert.equal(prepareCli.status, 0, prepareCli.stderr || prepareCli.error);
        assert.ok(fs.existsSync(JSON.parse(prepareCli.stdout).report));
        const queryCli = spawnSync(process.execPath, [queryScript, treeCase.caseDir, 'MainMarker', '--depth', '1', '--top', '1', '--metrics', 'work'], { encoding: 'utf8' });
        assert.equal(queryCli.status, 0, queryCli.stderr || queryCli.error);
        assert.match(queryCli.stdout, /Descendants to depth 1/);
        assert.match(queryCli.stdout, /PS Invocations/);
    }
    const treeBase = await queryCase(treeCase.caseDir, 'MainMarker');
    const treeDepth = await queryCase(treeCase.caseDir, 'MainMarker', { depth: 1, metrics: ['work,instructions', 'ps invocations'] });
    assert.deepEqual(treeDepth.captures[0].metrics, treeBase.captures[0].metrics, 'depth must not change frontier aggregation');
    assert.equal(treeDepth.captures[0].metrics['GPU Duration (ms)'], 10);
    assert.deepEqual(treeDepth.options.selectedMetricHeaders, ['PS Invocations', 'sm__inst_executed.sum']);
    const depthNodes = treeDepth.captures[0].hierarchy[0].nodes;
    assert.equal(depthNodes.length, 3);
    assert.equal(depthNodes[1].name, 'ChildA');
    assert.equal(depthNodes[1].parentShare, 0.4);
    assert.equal(depthNodes[2].name, 'ChildB');
    assert.equal(depthNodes[2].parentShare, 0.6);
    const treeMarkdown = renderMarkdown(treeDepth);
    assert.match(treeMarkdown, /Aggregate normalization/);
    assert.match(treeMarkdown, /Hardware instructions \/ mixed shader invocation \| 10/);
    const treeDepthTwo = await queryCase(treeCase.caseDir, 'MainMarker', { depth: 2 });
    assert.equal(treeDepthTwo.captures[0].hierarchy[0].nodes.find(node => node.name === 'Grandchild').relativeDepth, 2);
    const childRoot = await queryCase(treeCase.caseDir, 'ChildA', { depth: 1 });
    assert.equal(childRoot.captures[0].hierarchy[0].nodes[0].parentShare, 0.4);
    const treeTop = await queryCase(treeCase.caseDir, 'MainMarker', { depth: 1, top: 1 });
    assert.deepEqual(treeTop.captures[0].hierarchy[0].nodes.map(node => node.name), ['MainMarker', 'ChildB']);
    assert.equal(treeTop.captures[0].hierarchy[0].nodes[0].shownChildCount, 1);
    const zeroDepth = await queryCase(treeCase.caseDir, 'ZeroMarker', { depth: 1 });
    assert.equal(zeroDepth.captures[0].hierarchy[0].nodes[1].parentShare, null);
    assertFiniteNumbers(zeroDepth);
    const dotOverview = await queryCase(treeCase.caseDir, '.');
    const starOverview = await queryCase(treeCase.caseDir, '*');
    assert.deepEqual(dotOverview.captures[0].matches.map(record => record.stableKey), starOverview.captures[0].matches.map(record => record.stableKey));
    assert.equal(dotOverview.captures[0].matches.length, 2);
    const topOverview = await queryCase(treeCase.caseDir, '.', { top: 1 });
    assert.equal(topOverview.captures[0].matches.length, 1);
    assert.equal(topOverview.captures[0].matchCount, 2);
    assert.equal(topOverview.captures[0].matchesTruncated, true);
    assert.match(renderMarkdown(topOverview), /match list is truncated by `--top`/);
    const commaMetric = await queryCase(treeCase.caseDir, 'MainMarker', { metrics: ['counter,value'] });
    assert.deepEqual(commaMetric.options.selectedMetricHeaders, ['counter,value']);
    await assert.rejects(() => queryCase(treeCase.caseDir, 'MainMarker', { metrics: ['Invocations'] }), /not an exact counter header/);
    await assert.rejects(() => queryCase(treeCase.caseDir, 'MainMarker', { metrics: ['missing-counter'] }), /did not match an exported counter/);

    const listInput = path.join(tempRoot, 'list-input');
    fs.mkdirSync(listInput);
    fs.writeFileSync(path.join(listInput, 'events.txt'), treeEvents);
    fs.writeFileSync(path.join(listInput, 'counters-a.csv'), treeCounters);
    fs.writeFileSync(path.join(listInput, 'counters-b.csv'), treeCounters.replace('3,4,40,400', '3,5,40,400'));
    fs.writeFileSync(path.join(listInput, 'catalog.csv'), 'name,value\nfoo,bar\n');
    const beforeList = fs.readdirSync(listInput).sort();
    const listed = await inspectCandidates(listInput);
    assert.deepEqual(fs.readdirSync(listInput).sort(), beforeList, '--list inspection must not write files');
    assert.equal(listed.events.length, 1);
    assert.equal(listed.counters.length, 2);
    assert.equal(listed.rejected.length, 1);
    assert.equal(listed.readiness.status, 'ambiguous-counter-alternatives');
    assert.equal(listed.coverage[0].entries[0].leafCoverage, 100);
    const durationConflict = listed.csvComparisons[0].conflicts.find(conflict => conflict.header === 'GPU Duration (ms)');
    assert.equal(durationConflict.differingRowCount, 1);
    assert.equal(durationConflict.maxAbsDelta, 1);
    await assert.rejects(() => prepare(listInput, path.join(tempRoot, 'list-output')), /--list.*no CSVs are merged or auto-selected/);

    const ambiguousInput = path.join(tempRoot, 'ambiguous-pairing-input');
    fs.mkdirSync(ambiguousInput);
    fs.writeFileSync(path.join(ambiguousInput, 'first.txt'), treeEvents);
    fs.writeFileSync(path.join(ambiguousInput, 'second.txt'), treeEvents);
    fs.writeFileSync(path.join(ambiguousInput, 'one.csv'), treeCounters);
    fs.writeFileSync(path.join(ambiguousInput, 'two.csv'), treeCounters);
    const ambiguous = await inspectCandidates(ambiguousInput);
    assert.equal(ambiguous.readiness.ready, false);
    assert.equal(ambiguous.readiness.status, 'ambiguous-pairing');
    await assert.rejects(() => prepare(ambiguousInput, path.join(tempRoot, 'ambiguous-output')), /pairing is ambiguous/);

    const disconnectedInput = path.join(tempRoot, 'disconnected-input');
    fs.mkdirSync(disconnectedInput);
    fs.writeFileSync(path.join(disconnectedInput, 'events.txt'), treeEvents);
    fs.writeFileSync(path.join(disconnectedInput, 'counters.csv'), 'EID,GPU Duration (ms)\n999,1\n');
    const disconnected = await inspectCandidates(disconnectedInput);
    assert.equal(disconnected.readiness.ready, false);
    assert.match(disconnected.readiness.reason, /share no measured leaf EIDs/);
    await assert.rejects(() => prepare(disconnectedInput, path.join(tempRoot, 'disconnected-output')), /share no measured leaf EIDs/);

    const disjointListInput = path.join(tempRoot, 'disjoint-list-input');
    fs.mkdirSync(disjointListInput);
    fs.writeFileSync(path.join(disjointListInput, 'events.txt'), treeEvents);
    fs.writeFileSync(path.join(disjointListInput, 'counters-a.csv'), treeCounters);
    fs.writeFileSync(path.join(disjointListInput, 'counters-b.csv'), 'EID,GPU Duration (ms),PS Invocations,sm__inst_executed.sum,"counter,value"\n999,1,1,1,1\n');
    const disjointList = await inspectCandidates(disjointListInput);
    assert.equal(disjointList.csvComparisons[0].comparable, false);
    assert.equal(disjointList.csvComparisons[0].leftOnlyEidCount, 3);
    assert.equal(disjointList.csvComparisons[0].rightOnlyEidCount, 1);
    assert.ok(disjointList.guidance.some(message => message.includes('no comparable EID/counter intersection')));

    const collisionInput = path.join(tempRoot, 'stable-key-input');
    fs.mkdirSync(collisionInput);
    fs.writeFileSync(path.join(collisionInput, 'events.txt'), 'Stable key fixture\n---\n1 | - a |\n2 |   - b |\n3 | - a#1/b |\n');
    fs.writeFileSync(path.join(collisionInput, 'counters.csv'), 'EID,GPU Duration (ms)\n2,1\n3,1\n');
    const collisionCase = await prepare(collisionInput, path.join(tempRoot, 'stable-key-output'));
    const collisionManifest = JSON.parse(fs.readFileSync(collisionCase.manifest, 'utf8'));
    const collisionRecords = fs.readFileSync(path.join(collisionCase.caseDir, collisionManifest.captures[0].graphFile), 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line));
    assert.equal(new Set(collisionRecords.map(record => record.stableKey)).size, collisionRecords.length);

    const provenanceA = path.join(tempRoot, 'provenance-a');
    const provenanceB = path.join(tempRoot, 'provenance-b');
    const provenanceOutput = path.join(tempRoot, 'provenance-output');
    fs.mkdirSync(provenanceA);
    fs.mkdirSync(provenanceB);
    for (const directory of [provenanceA, provenanceB]) {
        fs.writeFileSync(path.join(directory, 'events.txt'), treeEvents);
        fs.writeFileSync(path.join(directory, 'counters.csv'), treeCounters);
    }
    const provenanceFirst = await prepare(provenanceA, provenanceOutput);
    const provenanceSecond = await prepare(provenanceB, provenanceOutput);
    assert.notEqual(provenanceFirst.caseDir, provenanceSecond.caseDir);
    assert.equal(JSON.parse(fs.readFileSync(provenanceSecond.manifest, 'utf8')).sourceDirectory, provenanceB);

    const metricCompareInput = path.join(tempRoot, 'metric-compare-input');
    fs.mkdirSync(metricCompareInput);
    fs.writeFileSync(path.join(metricCompareInput, 'before-events.txt'), treeEvents);
    fs.writeFileSync(path.join(metricCompareInput, 'after-events.txt'), treeEvents);
    fs.writeFileSync(path.join(metricCompareInput, 'before-counters.csv'), 'EID,GPU Duration (ms),PS Invocations,demo.avg.pct (%)\n3,4,40,10\n4,6,60,20\n6,0,0,0\n');
    fs.writeFileSync(path.join(metricCompareInput, 'after-counters.csv'), 'EID,GPU Duration (ms),VS Invocations,demo.avg.pct (%)\n3,4,20,30\n4,6,30,40\n6,0,0,0\n');
    const metricCompare = await prepare(metricCompareInput, path.join(tempRoot, 'metric-compare-output'));
    const selectedCompare = await queryCase(metricCompare.caseDir, 'MainMarker', { metrics: ['PS Invocations', 'VS Invocations'] });
    assert.equal(selectedCompare.comparison.selectedRows[0].secondExported, false);
    assert.equal(selectedCompare.comparison.selectedRows[1].firstExported, false);
    assert.match(renderMarkdown(selectedCompare), /not exported/);
    const estimatedRow = selectedCompare.comparison.rows.find(row => row.header === 'demo.avg.pct (%)');
    assert.equal(estimatedRow.estimated, true);
    assert.match(renderMarkdown(selectedCompare), /≈ demo\.avg\.pct/);

    const topologyInput = path.join(tempRoot, 'topology-input');
    fs.mkdirSync(topologyInput);
    fs.writeFileSync(path.join(topologyInput, 'before-events.txt'), treeEvents);
    fs.writeFileSync(path.join(topologyInput, 'after-events.txt'), treeEvents.replace('ChildB', 'ChildB changed'));
    fs.writeFileSync(path.join(topologyInput, 'before-counters.csv'), treeCounters);
    fs.writeFileSync(path.join(topologyInput, 'after-counters.csv'), treeCounters);
    const topologyCase = await prepare(topologyInput, path.join(tempRoot, 'topology-output'));
    const topologyQuery = await queryCase(topologyCase.caseDir, 'ChildB');
    assert.deepEqual(topologyQuery.comparison.topology, { sharedCount: 0, onlyFirstCount: 1, onlySecondCount: 1 });
    assert.ok(topologyQuery.warnings.some(warning => warning.includes('Focused match topology differs')));
    const topologyTop = await queryCase(topologyCase.caseDir, 'ChildB', { top: 1 });
    assert.deepEqual(topologyTop.comparison.topology, topologyQuery.comparison.topology, '--top must not change focused topology evidence');

    const unitsInput = path.join(tempRoot, 'duration-units-input');
    fs.mkdirSync(unitsInput);
    fs.writeFileSync(path.join(unitsInput, 'before-events.txt'), treeEvents);
    fs.writeFileSync(path.join(unitsInput, 'after-events.txt'), treeEvents);
    fs.writeFileSync(path.join(unitsInput, 'before-counters.csv'), 'EID,GPU Duration (ms),lts__first_hit_rate.pct,lts__second_hit_rate.pct\n3,4,20,80\n4,6,30,70\n6,0,0,0\n');
    fs.writeFileSync(path.join(unitsInput, 'after-counters.csv'), 'EID,GPU Duration (µs),lts__second_hit_rate.pct,lts__first_hit_rate.pct\n3,4000,80,20\n4,6000,70,30\n6,0,0,0\n');
    const unitsCase = await prepare(unitsInput, path.join(tempRoot, 'duration-units-output'));
    const unitsManifest = JSON.parse(fs.readFileSync(unitsCase.manifest, 'utf8'));
    assert.deepEqual(unitsManifest.captures.map(capture => capture.durationToMs), [1, 0.001]);
    assert.deepEqual(unitsManifest.captures.map(capture => capture.summary.totalDurationMs), [10, 10]);
    const unitsQuery = await queryCase(unitsCase.caseDir, 'MainMarker');
    assert.equal(unitsQuery.comparison.signals.first.duration.value, 10);
    assert.equal(unitsQuery.comparison.signals.second.duration.value, 10);
    assert.equal(unitsQuery.comparison.signals.first.l2Hit.header, unitsQuery.comparison.signals.second.l2Hit.header);

    const incompleteInput = path.join(tempRoot, 'incomplete-input');
    fs.mkdirSync(incompleteInput);
    fs.writeFileSync(path.join(incompleteInput, 'events.txt'), events);
    await assert.rejects(() => prepare(incompleteInput, path.join(tempRoot, 'incomplete-output')), /same number of events TXT and counters CSV/);

    const malformedInput = path.join(tempRoot, 'malformed-input');
    fs.mkdirSync(malformedInput);
    fs.writeFileSync(path.join(malformedInput, 'events.txt'), 'Malformed fixture\n---\n1 | - Root |\n');
    fs.writeFileSync(path.join(malformedInput, 'counters.csv'), 'EID,GPU Duration (ms)\n1,\n');
    await assert.rejects(() => prepare(malformedInput, path.join(tempRoot, 'malformed-output')), /Rejected candidates: counters\.csv: row 2, GPU Duration \(ms\): empty counter value/);

    const sparseInput = path.join(tempRoot, 'sparse-input');
    fs.mkdirSync(sparseInput);
    fs.writeFileSync(path.join(sparseInput, 'events.txt'), 'Sparse fixture\n---\n1 | - RootA |\n2 | - RootB |\n');
    fs.writeFileSync(path.join(sparseInput, 'counters.csv'), 'EID,GPU Duration (ms),demo.min,demo.avg\n1,1,0,0\n2,1,5,10\n');
    const sparse = await prepare(sparseInput, path.join(tempRoot, 'sparse-output'));
    const sparseQuery = await queryCase(sparse.caseDir, 'Root');
    assert.equal(sparseQuery.captures[0].metrics['demo.min'], 0);
    assert.equal(sparseQuery.captures[0].metrics['demo.avg'], 5);

    const unmeasuredInput = path.join(tempRoot, 'unmeasured-input');
    fs.mkdirSync(unmeasuredInput);
    fs.writeFileSync(path.join(unmeasuredInput, 'events.txt'), 'Unmeasured fixture\n---\n1 | - RootA |\n2 | - RootB |\n');
    fs.writeFileSync(path.join(unmeasuredInput, 'counters.csv'), 'EID,GPU Duration (ms),demo.min,demo.avg\n2,2,5,10\n');
    const unmeasuredCase = await prepare(unmeasuredInput, path.join(tempRoot, 'unmeasured-output'));
    const unmeasuredQuery = await queryCase(unmeasuredCase.caseDir, 'Root', { metrics: ['demo.min', 'demo.avg'] });
    assert.equal(unmeasuredQuery.captures[0].unmeasuredMatchCount, 1);
    assert.equal(unmeasuredQuery.captures[0].metrics['demo.min'], 5);
    assert.equal(unmeasuredQuery.captures[0].metrics['demo.avg'], 10);
    assert.match(renderMarkdown(unmeasuredQuery), /not measured/);
    assert.ok(unmeasuredQuery.warnings.some(warning => warning.includes('excluded from aggregates')));
    const onlyUnmeasured = await queryCase(unmeasuredCase.caseDir, 'RootA', { metrics: ['demo.min'] });
    assert.equal(onlyUnmeasured.captures[0].metrics['demo.min'], null);

    const unweightedMeanInput = path.join(tempRoot, 'unweighted-mean-input');
    fs.mkdirSync(unweightedMeanInput);
    fs.writeFileSync(path.join(unweightedMeanInput, 'events.txt'), 'Mean fixture\n---\n1 | - RootA |\n2 |   - LeafA1 |\n3 |   - LeafA2 |\n4 | - RootB |\n5 |   - LeafB |\n');
    fs.writeFileSync(path.join(unweightedMeanInput, 'counters.csv'), 'EID,demo.avg\n2,10\n3,10\n5,100\n');
    const unweightedMeanCase = await prepare(unweightedMeanInput, path.join(tempRoot, 'unweighted-mean-output'));
    const unweightedMean = await queryCase(unweightedMeanCase.caseDir, 'Root');
    assert.equal(unweightedMean.captures[0].metrics['demo.avg'], 40);

    const anomalyInput = path.join(tempRoot, 'anomaly-input');
    fs.mkdirSync(anomalyInput);
    fs.writeFileSync(path.join(anomalyInput, 'events.txt'), 'Anomaly fixture\n---\n1 | - Root |\n');
    fs.writeFileSync(path.join(anomalyInput, 'counters.csv'), 'EID,GPU Duration (ms),demo.avg.pct (%)\n1,1,150\n');
    const anomaly = await prepare(anomalyInput, path.join(tempRoot, 'anomaly-output'));
    const anomalyManifest = JSON.parse(fs.readFileSync(anomaly.manifest, 'utf8'));
    assert.equal(anomalyManifest.captures[0].anomalies[0].max, 150);
    assert.ok(anomalyManifest.warnings.some(warning => warning.includes('Values were preserved, not clamped')));

    const catalog = JSON.parse(fs.readFileSync(path.join(skill, 'references', 'nvidia-counters.json'), 'utf8'));
    assert.ok(catalog.entries.length >= 30);
    assert.ok(catalog.entries.some(entry => entry.prefix.includes('long_scoreboard')));

    console.log('Skill mode test passed: strict parsing, candidate diagnostics, cache integrity, single and before/after graphs, duration units, unmeasured rows, timeline HTML, hierarchy query, metric selection, topology warnings, anomaly warnings, zero transitions, NVIDIA catalog.');
    if (keepOutput) console.log(`Manual test output: ${tempRoot}`);
} finally {
    if (!keepOutput) fs.rmSync(tempRoot, { recursive: true, force: true });
}
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
