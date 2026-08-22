import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function parseArgs(argv) {
    let json = false;
    const positional = [];
    for (const arg of argv) {
        if (arg === '--json') json = true;
        else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
        else positional.push(arg);
    }
    if (positional.length < 2) throw new Error('Usage: query.mjs <caseDir-or-analysisDir> <pass-or-marker-name> [--json]');
    return { inputDir: path.resolve(positional[0]), query: positional.slice(1).join(' '), json };
}

async function exists(file) {
    return fs.stat(file).then(value => value.isFile()).catch(() => false);
}

async function resolveCaseDir(inputDir) {
    if (await exists(path.join(inputDir, 'manifest.json'))) return inputDir;
    const latestPath = path.join(inputDir, 'latest.json');
    if (!(await exists(latestPath))) throw new Error(`No manifest.json or latest.json found under ${inputDir}`);
    const latest = JSON.parse(await fs.readFile(latestPath, 'utf8'));
    return path.resolve(latest.caseDir);
}

async function readNdjson(file) {
    const text = await fs.readFile(file, 'utf8');
    return text.split(/\r?\n/).filter(Boolean).map((line, index) => {
        try {
            return JSON.parse(line);
        } catch (error) {
            throw new Error(`${file}:${index + 1}: ${error.message}`);
        }
    });
}

function durationValue(record, capture) {
    return capture.durationHeader ? (record.metrics[capture.durationHeader] || 0) : 0;
}

function findFrontier(records, query) {
    const needle = query.toLowerCase();
    const matches = records.filter(record => record.name.toLowerCase().includes(needle) || record.path.toLowerCase().includes(needle));
    const keys = new Set(matches.map(record => record.stableKey));
    const byKey = new Map(records.map(record => [record.stableKey, record]));
    return matches.filter(record => {
        let parent = record.parentKey;
        while (parent) {
            if (keys.has(parent)) return false;
            parent = byKey.get(parent)?.parentKey || null;
        }
        return true;
    });
}

function aggregate(records, capture) {
    const result = {};
    for (const header of capture.headers) {
        if (capture.counterKinds[header] === 'max') {
            const values = records.map(record => record.metrics[header] ?? 0).filter(Number.isFinite);
            result[header] = values.length ? values.reduce((maximum, value) => Math.max(maximum, value), -Infinity) : 0;
            continue;
        }
        if (capture.counterKinds[header] === 'min') {
            const values = records.map(record => record.metrics[header] ?? 0).filter(Number.isFinite);
            result[header] = values.length ? values.reduce((minimum, value) => Math.min(minimum, value), Infinity) : 0;
            continue;
        }
        if (capture.counterKinds[header] !== 'mean') {
            result[header] = records.reduce((sum, record) => sum + (Number.isFinite(record.metrics[header]) ? record.metrics[header] : 0), 0);
            continue;
        }
        let weighted = 0;
        let weightSum = 0;
        let sum = 0;
        let count = 0;
        for (const record of records) {
            const value = record.metrics[header] ?? 0;
            if (!Number.isFinite(value)) continue;
            sum += value;
            count++;
            const weight = capture.weightHeader ? record.metrics[capture.weightHeader] : NaN;
            if (Number.isFinite(weight) && weight > 0) {
                weighted += value * weight;
                weightSum += weight;
            }
        }
        result[header] = weightSum > 0 ? weighted / weightSum : (count ? sum / count : 0);
    }
    return result;
}

function findHeader(headers, patterns) {
    for (const pattern of patterns) {
        const found = headers.find(header => typeof pattern === 'string' ? header === pattern : pattern.test(header));
        if (found) return found;
    }
    return null;
}

function coreSignals(capture, metrics, allowedHeaders = null) {
    const headers = allowedHeaders ? capture.headers.filter(header => allowedHeaders.has(header)) : capture.headers;
    const resolve = patterns => {
        const header = findHeader(headers, patterns);
        return header ? { header, value: metrics[header] } : null;
    };
    const signals = {
        duration: resolve(['GPU Duration (ms)', 'GPU Duration', /duration \(ms\)/i]),
        inputVertices: resolve(['Input Vertices Read']),
        inputPrimitives: resolve(['Input Primitives']),
        rasterizedPrimitives: resolve(['Rasterized Primitives']),
        samplesPassed: resolve(['Samples Passed']),
        vsInvocations: resolve(['VS Invocations']),
        psInvocations: resolve(['PS Invocations']),
        csInvocations: resolve(['CS Invocations']),
        instructions: resolve([/^sm__inst_executed\.sum/, /^sm__inst_executed(?:\s|$)/, /^sm__inst_executed\.avg/]),
        dramRead: resolve([/^dram__bytes_op_read\.sum/, /^dram__bytes_op_read(?:\s|$)/, /^dram__bytes_op_read\.avg/]),
        dramWrite: resolve([/^dram__bytes_op_write\.sum/, /^dram__bytes_op_write(?:\s|$)/, /^dram__bytes_op_write\.avg/]),
        l1Hit: resolve([/^l1tex__.*hit.*\.pct/i]),
        l2Hit: resolve([/^lts__.*hit.*\.pct/i]),
        longScoreboard: resolve([/^smsp__warp_issue_stalled_long_scoreboard_per_warp_active.*\.pct/i]),
        mathThrottle: resolve([/^smsp__warp_issue_stalled_math_pipe_throttle.*\.pct/i]),
        lgThrottle: resolve([/^smsp__warp_issue_stalled_lg_throttle.*\.pct/i]),
        texThrottle: resolve([/^smsp__warp_issue_stalled_tex_throttle.*\.pct/i])
    };
    const invocationCount = ['vsInvocations', 'psInvocations', 'csInvocations']
        .map(key => signals[key]?.value || 0)
        .reduce((sum, value) => sum + value, 0);
    const isAggregate = signal => signal && !/\.avg(?:\.|\s|$)/i.test(signal.header);
    const dramBytes = isAggregate(signals.dramRead) && isAggregate(signals.dramWrite)
        ? (signals.dramRead?.value || 0) + (signals.dramWrite?.value || 0)
        : null;
    signals.derived = {
        invocationCount,
        instructionsPerInvocation: invocationCount > 0 && isAggregate(signals.instructions) ? signals.instructions.value / invocationCount : null,
        bytesPerInvocation: invocationCount > 0 && Number.isFinite(dramBytes) ? dramBytes / invocationCount : null
    };
    return signals;
}

function relativeDelta(before, after) {
    if (!Number.isFinite(before) || !Number.isFinite(after)) return null;
    if (before === 0) return after === 0 ? 0 : null;
    return (after - before) / Math.abs(before);
}

function formatNumber(value) {
    if (!Number.isFinite(value)) return 'n/a';
    const abs = Math.abs(value);
    if (abs >= 1e9) return `${(value / 1e9).toFixed(3)}B`;
    if (abs >= 1e6) return `${(value / 1e6).toFixed(3)}M`;
    if (abs >= 1e3) return `${(value / 1e3).toFixed(3)}K`;
    if (abs !== 0 && abs < 0.001) return value.toExponential(3);
    return value.toLocaleString('en-US', { maximumFractionDigits: 4 });
}

function comparisonRows(firstCapture, firstMetrics, secondCapture, secondMetrics) {
    const shared = firstCapture.headers.filter(header => secondCapture.headers.includes(header));
    return shared.map(header => {
        const first = firstMetrics[header];
        const second = secondMetrics[header];
        return { header, first, second, delta: second - first, relative: relativeDelta(first, second) };
    }).filter(row => {
        if (!Number.isFinite(row.first) || !Number.isFinite(row.second) || row.delta === 0) return false;
        return row.relative === null || Math.abs(row.relative) >= 0.005;
    }).sort((a, b) => {
        const score = row => row.relative === null ? (row.delta === 0 ? 0 : Infinity) : Math.abs(row.relative);
        return score(b) - score(a);
    });
}

function renderMarkdown(result) {
    const lines = [`# RenderDoc evidence: ${result.query}`, ''];
    if (result.warnings?.length) {
        lines.push('## Warnings', '');
        result.warnings.forEach(warning => lines.push(`- ${warning}`));
        lines.push('');
    }
    for (const capture of result.captures) {
        lines.push(`## ${capture.label}`, '');
        lines.push(`Matched non-overlapping regions: ${capture.matches.length}`);
        if (!capture.matches.length) {
            lines.push('', 'No matching marker or event was found.', '');
            continue;
        }
        lines.push('', '| GPU ms | EID | Scope | Path |', '| ---: | ---: | --- | --- |');
        capture.matches.slice(0, 20).forEach(record => {
            const gpu = capture.durationHeader ? record.metrics[capture.durationHeader] : NaN;
            lines.push(`| ${formatNumber(gpu)} | ${record.eid} | ${record.scope} | ${record.path.replace(/\|/g, '\\|')} |`);
        });
        if (capture.matches.length > 20) lines.push('', `Showing 20 of ${capture.matches.length} matched regions.`);
        lines.push('');
    }

    if (result.comparison) {
        const { labels, rows, signals } = result.comparison;
        lines.push(`## ${labels[0]} → ${labels[1]}`, '');
        lines.push('| Signal | Before | After | Change |', '| --- | ---: | ---: | ---: |');
        for (const [key, label] of [
            ['duration', 'GPU duration'],
            ['inputVertices', 'Input vertices'],
            ['inputPrimitives', 'Input primitives'],
            ['rasterizedPrimitives', 'Rasterized primitives'],
            ['samplesPassed', 'Samples passed'],
            ['vsInvocations', 'VS invocations'],
            ['psInvocations', 'PS invocations'],
            ['csInvocations', 'CS invocations'],
            ['instructions', 'SM instructions'],
            ['dramRead', 'DRAM read bytes'],
            ['dramWrite', 'DRAM write bytes'],
            ['l1Hit', 'L1/TEX hit rate'],
            ['l2Hit', 'L2 hit rate'],
            ['longScoreboard', 'Long-scoreboard stalls'],
            ['mathThrottle', 'Math-pipe throttle'],
            ['lgThrottle', 'LG throttle'],
            ['texThrottle', 'Texture throttle']
        ]) {
            const first = signals.first[key]?.value;
            const second = signals.second[key]?.value;
            if (!Number.isFinite(first) || !Number.isFinite(second)) continue;
            const relative = relativeDelta(first, second);
            const shownLabel = /\.avg(?:\.|\s|$)/i.test(signals.second[key].header) ? `${label} (average counter)` : label;
            lines.push(`| ${shownLabel} | ${formatNumber(first)} | ${formatNumber(second)} | ${relative === null ? 'n/a' : `${relative >= 0 ? '+' : ''}${(relative * 100).toFixed(1)}%`} |`);
        }
        for (const [key, label] of [
            ['instructionsPerInvocation', 'Instructions / mixed shader invocation'],
            ['bytesPerInvocation', 'DRAM bytes / mixed shader invocation']
        ]) {
            const first = signals.first.derived[key];
            const second = signals.second.derived[key];
            if (!Number.isFinite(first) || !Number.isFinite(second)) continue;
            const relative = relativeDelta(first, second);
            lines.push(`| ${label} | ${formatNumber(first)} | ${formatNumber(second)} | ${relative === null ? 'n/a' : `${relative >= 0 ? '+' : ''}${(relative * 100).toFixed(1)}%`} |`);
        }
        if (rows.length) {
            lines.push('', 'Largest meaningful counter changes (at least 0.5%):', '', '| Counter | Before | After | Change |', '| --- | ---: | ---: | ---: |');
            rows.slice(0, 15).forEach(row => {
                lines.push(`| ${row.header.replace(/\|/g, '\\|')} | ${formatNumber(row.first)} | ${formatNumber(row.second)} | ${row.relative === null ? 'n/a' : `${row.relative >= 0 ? '+' : ''}${(row.relative * 100).toFixed(1)}%`} |`);
            });
        }
        lines.push('', 'Mixed invocation ratios divide region-wide totals by VS + PS + CS invocations. Use them as relative workload clues, not stage-specific cost. PerfWorks hardware instructions are not one-to-one source instructions.', '');
    }
    return `${lines.join('\n')}\n`;
}

export async function queryCase(inputDir, query) {
    const caseDir = await resolveCaseDir(inputDir);
    const manifest = JSON.parse(await fs.readFile(path.join(caseDir, 'manifest.json'), 'utf8'));
    const captures = [];
    for (const capture of manifest.captures) {
        const records = await readNdjson(path.join(caseDir, capture.graphFile));
        const matches = findFrontier(records, query).sort((a, b) => durationValue(b, capture) - durationValue(a, capture));
        const metrics = aggregate(matches, capture);
        captures.push({ ...capture, records: undefined, matches, metrics, signals: coreSignals(capture, metrics) });
    }
    const result = { query, caseDir, warnings: manifest.warnings, captures };
    if (captures.length === 2 && captures.every(capture => capture.matches.length)) {
        const sharedHeaders = new Set(captures[0].headers.filter(header => captures[1].headers.includes(header)));
        result.comparison = {
            labels: captures.map(capture => capture.label),
            signals: {
                first: coreSignals(captures[0], captures[0].metrics, sharedHeaders),
                second: coreSignals(captures[1], captures[1].metrics, sharedHeaders)
            },
            rows: comparisonRows(captures[0], captures[0].metrics, captures[1], captures[1].metrics)
        };
    }
    return result;
}

async function main() {
    try {
        const args = parseArgs(process.argv.slice(2));
        const result = await queryCase(args.inputDir, args.query);
        process.stdout.write(args.json ? `${JSON.stringify(result, null, 2)}\n` : renderMarkdown(result));
    } catch (error) {
        process.stderr.write(`renderdoc-perf query: ${error.message}\n`);
        process.exitCode = 1;
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    await main();
}

export { renderMarkdown };
