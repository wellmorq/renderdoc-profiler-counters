import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function parseArgs(argv) {
    let json = false;
    let depth = 0;
    let top = null;
    const metricSelectors = [];
    const positional = [];
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--json') {
            json = true;
        } else if (arg === '--depth') {
            const value = argv[++i];
            if (!/^\d+$/.test(value || '')) throw new Error('--depth requires a non-negative integer');
            depth = Number(value);
            if (depth > 64) throw new Error('--depth must not exceed 64');
        } else if (arg === '--metrics') {
            const value = argv[++i];
            if (!value) throw new Error('--metrics requires a comma-separated selector list');
            metricSelectors.push(value.trim());
        } else if (arg === '--top') {
            const value = argv[++i];
            if (!/^\d+$/.test(value || '') || Number(value) < 1) throw new Error('--top requires a positive integer');
            top = Number(value);
            if (top > 1000) throw new Error('--top must not exceed 1000');
        } else if (arg.startsWith('-')) {
            throw new Error(`Unknown option: ${arg}`);
        } else {
            positional.push(arg);
        }
    }
    if (positional.length < 2) {
        throw new Error('Usage: query.mjs <caseDir-or-analysisDir> <pass-or-marker-name|.|*> [--depth N] [--top N] [--metrics core|work|instructions|memory|stalls|NAME,...] [--json]');
    }
    return {
        inputDir: path.resolve(positional[0]),
        query: positional.slice(1).join(' '),
        json,
        depth,
        top,
        metricSelectors
    };
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

function isMeasured(record) {
    return Boolean(record && record.counterRowCount > 0);
}

function durationMetricValue(record, capture) {
    if (!isMeasured(record) || !capture.durationHeader) return null;
    const raw = record.metrics[capture.durationHeader] ?? 0;
    return Number.isFinite(raw) ? raw * (capture.durationToMs ?? 1) : null;
}

function durationValue(record, capture) {
    return durationMetricValue(record, capture) ?? 0;
}

function findFrontier(records, query) {
    if (query === '.' || query === '*') return records.filter(record => record.parentKey === null);
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

function metricGroupMatches(group, header) {
    const value = header.toLowerCase();
    const work = /^(input vertices read|input primitives|gs primitives|rasterizer invocations|rasterized primitives|samples passed|[a-z]+s invocations)$/i.test(header);
    const instructions = /(?:^|__)inst(?:ructions?)?[_a-z]*\.sum(?:\s|$)/i.test(header)
        || /^sm__inst_executed\.sum(?:\s|$)/i.test(header);
    const memory = /^dram__bytes_op_(?:read|write)\.sum(?:\s|$)/i.test(header)
        || /^(?:l1tex__|lts__).*hit.*\.pct/i.test(header);
    const stalls = value.includes('warp_issue_stalled') && /\.pct(?:\s|\.|$)|\(%\)/i.test(header);
    if (group === 'work') return work;
    if (group === 'instructions') return instructions;
    if (group === 'memory') return memory;
    if (group === 'stalls') return stalls;
    return group === 'core' && (work || instructions || memory);
}

function resolveMetricSelectors(captures, selectors) {
    if (!selectors.length) return [];
    const headers = [...new Set(captures.flatMap(capture => capture.headers))];
    const selected = new Set();
    const visit = selector => {
        selector = selector.trim();
        if (!selector) throw new Error('--metrics contains an empty selector');
        const normalized = selector.toLowerCase();
        if (['core', 'work', 'instructions', 'memory', 'stalls'].includes(normalized)) {
            const matches = headers.filter(header => metricGroupMatches(normalized, header));
            if (!matches.length) throw new Error(`Metric group "${selector}" has no exported counters`);
            matches.forEach(header => selected.add(header));
            return;
        }
        const exact = headers.filter(header => header.toLowerCase() === normalized);
        if (exact.length) {
            exact.forEach(header => selected.add(header));
            return;
        }
        const parts = selector.split(',').map(part => part.trim()).filter(Boolean);
        if (parts.length > 1) {
            parts.forEach(visit);
            return;
        }
        const partial = headers.filter(header => header.toLowerCase().includes(normalized));
        if (!partial.length) {
            throw new Error(`Metric selector "${selector}" did not match an exported counter. Use core, work, instructions, memory, stalls, or an exact manifest header.`);
        }
        throw new Error(`Metric selector "${selector}" is not an exact counter header. Candidates: ${partial.slice(0, 6).join('; ')}${partial.length > 6 ? '; ...' : ''}`);
    };
    selectors.forEach(visit);
    return headers.filter(header => selected.has(header));
}

function buildHierarchy(records, roots, capture, depth, top, selectedHeaders) {
    if (depth <= 0 || !roots.length) return [];
    const childrenByParent = new Map();
    records.forEach(record => {
        if (!record.parentKey) return;
        const children = childrenByParent.get(record.parentKey) || [];
        children.push(record);
        childrenByParent.set(record.parentKey, children);
    });
    childrenByParent.forEach(children => children.sort((a, b) => a.order - b.order));

    const byKey = new Map(records.map(record => [record.stableKey, record]));
    const exportedHeaders = new Set(capture.headers);
    const captureDuration = capture.summary?.totalDurationMs;
    const shownRoots = top === null ? roots : roots.slice(0, top);
    return shownRoots.map(root => {
        const nodes = [];
        const rootDuration = durationMetricValue(root, capture);
        const visit = (record, relativeDepth, parentDuration) => {
            const duration = durationMetricValue(record, capture);
            const measured = isMeasured(record);
            const node = {
                stableKey: record.stableKey,
                eid: record.eid,
                name: record.name,
                path: record.path,
                scope: record.scope,
                counterRowCount: record.counterRowCount,
                relativeDepth,
                duration,
                parentShare: Number.isFinite(duration) && parentDuration > 0 ? duration / parentDuration : null,
                rootShare: Number.isFinite(duration) && rootDuration > 0 ? duration / rootDuration : null,
                captureShare: Number.isFinite(duration) && captureDuration > 0 ? duration / captureDuration : null,
                metrics: Object.fromEntries(selectedHeaders.map(header => [
                    header,
                    exportedHeaders.has(header) && measured ? (record.metrics[header] ?? 0) : null
                ])),
                childCount: record.childCount,
                shownChildCount: relativeDepth >= depth ? null : 0
            };
            nodes.push(node);
            if (relativeDepth >= depth) return;
            const children = childrenByParent.get(record.stableKey) || [];
            const shownChildren = top === null
                ? children
                : [...children].sort((a, b) => durationValue(b, capture) - durationValue(a, capture) || a.order - b.order).slice(0, top);
            node.shownChildCount = shownChildren.length;
            for (const child of shownChildren) {
                visit(child, relativeDepth + 1, duration);
            }
        };
        const actualParent = root.parentKey ? byKey.get(root.parentKey) : null;
        visit(root, 0, actualParent ? durationValue(actualParent, capture) : NaN);
        return { rootKey: root.stableKey, nodes };
    });
}

function aggregate(records, capture) {
    const result = {};
    const measuredRecords = records.filter(isMeasured);
    for (const header of capture.headers) {
        if (!measuredRecords.length) {
            result[header] = null;
            continue;
        }
        if (capture.counterKinds[header] === 'max') {
            const values = measuredRecords.map(record => record.metrics[header] ?? 0).filter(Number.isFinite);
            result[header] = values.length ? values.reduce((maximum, value) => Math.max(maximum, value), -Infinity) : 0;
            continue;
        }
        if (capture.counterKinds[header] === 'min') {
            const values = measuredRecords.map(record => record.metrics[header] ?? 0).filter(Number.isFinite);
            result[header] = values.length ? values.reduce((minimum, value) => Math.min(minimum, value), Infinity) : 0;
            continue;
        }
        if (capture.counterKinds[header] !== 'mean') {
            result[header] = measuredRecords.reduce((sum, record) => sum + (Number.isFinite(record.metrics[header]) ? record.metrics[header] : 0), 0);
            continue;
        }
        let weighted = 0;
        let weightSum = 0;
        let fallbackWeighted = 0;
        let fallbackWeightSum = 0;
        for (const record of measuredRecords) {
            const value = record.metrics[header] ?? 0;
            if (!Number.isFinite(value)) continue;
            const fallbackWeight = Math.max(1, record.counterRowCount || 0);
            fallbackWeighted += value * fallbackWeight;
            fallbackWeightSum += fallbackWeight;
            const weight = capture.weightHeader ? record.metrics[capture.weightHeader] : NaN;
            if (Number.isFinite(weight) && weight > 0) {
                weighted += value * weight;
                weightSum += weight;
            }
        }
        result[header] = weightSum > 0 ? weighted / weightSum : (fallbackWeightSum > 0 ? fallbackWeighted / fallbackWeightSum : 0);
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
    const headers = allowedHeaders
        ? Array.from(allowedHeaders).filter(header => capture.headers.includes(header))
        : capture.headers;
    const resolve = patterns => {
        const header = findHeader(headers, patterns);
        return header ? {
            header,
            value: metrics[header],
            estimated: capture.counterKinds[header] === 'mean' && capture.aggregateMeanIsEstimate
        } : null;
    };
    const durationValue = capture.durationHeader && Number.isFinite(metrics[capture.durationHeader])
        ? metrics[capture.durationHeader] * (capture.durationToMs ?? 1)
        : null;
    const signals = {
        duration: Number.isFinite(durationValue) ? { header: capture.durationHeader, value: durationValue, estimated: false } : null,
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

function escapeCell(value) {
    return String(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function formatShare(value) {
    return Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : 'n/a';
}

function metricCells(record, headers, exportedHeaders) {
    const exported = new Set(exportedHeaders);
    return headers.map(header => {
        if (!exported.has(header)) return 'not exported';
        if (!isMeasured(record)) return 'not measured';
        return formatNumber(record.metrics[header] ?? 0);
    });
}

function comparisonRows(firstCapture, firstMetrics, secondCapture, secondMetrics) {
    const shared = firstCapture.headers.filter(header => secondCapture.headers.includes(header));
    return shared.map(header => {
        const first = firstMetrics[header];
        const second = secondMetrics[header];
        return {
            header,
            first,
            second,
            delta: second - first,
            relative: relativeDelta(first, second),
            estimated: firstCapture.counterKinds[header] === 'mean'
                && (firstCapture.aggregateMeanIsEstimate || secondCapture.aggregateMeanIsEstimate)
        };
    }).filter(row => {
        if (!Number.isFinite(row.first) || !Number.isFinite(row.second) || row.delta === 0) return false;
        return row.relative === null || Math.abs(row.relative) >= 0.005;
    }).sort((a, b) => {
        const score = row => row.relative === null ? (row.delta === 0 ? 0 : Infinity) : Math.abs(row.relative);
        return score(b) - score(a);
    });
}

function selectedComparisonRows(firstCapture, secondCapture, headers) {
    return headers.map(header => {
        const firstExported = firstCapture.headers.includes(header);
        const secondExported = secondCapture.headers.includes(header);
        const firstMeasured = firstExported && firstCapture.measuredMatchCount > 0;
        const secondMeasured = secondExported && secondCapture.measuredMatchCount > 0;
        const first = firstMeasured ? firstCapture.metrics[header] : null;
        const second = secondMeasured ? secondCapture.metrics[header] : null;
        return {
            header,
            first,
            second,
            firstExported,
            secondExported,
            firstMeasured,
            secondMeasured,
            estimated: (firstCapture.counterKinds[header] ?? secondCapture.counterKinds[header]) === 'mean'
                && (firstCapture.aggregateMeanIsEstimate || secondCapture.aggregateMeanIsEstimate),
            relative: firstMeasured && secondMeasured ? relativeDelta(first, second) : null
        };
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
        const matchCount = capture.matchCount ?? capture.matches.length;
        lines.push(`## ${capture.label}`, '');
        lines.push(result.query === '.' || result.query === '*'
            ? `Capture roots: ${matchCount}`
            : `Matched independent roots: ${matchCount} (matching descendants are included in their nearest matched ancestor and omitted here)`);
        if (!matchCount) {
            lines.push('', 'No matching marker or event was found.', '');
            continue;
        }
        if (capture.unmeasuredMatchCount) {
            lines.push('', `${capture.unmeasuredMatchCount} matched root${capture.unmeasuredMatchCount === 1 ? '' : 's'} have no counter row and are shown as not measured; they are excluded from aggregates.`);
        }
        const selectedHeaders = capture.selectedHeaders || [];
        const headers = ['GPU ms', 'EID', 'Scope', 'Path', ...selectedHeaders];
        const alignment = ['---:', '---:', '---', '---', ...selectedHeaders.map(() => '---:')];
        lines.push('', `| ${headers.map(escapeCell).join(' | ')} |`, `| ${alignment.join(' | ')} |`);
        const matchLimit = result.options.top ?? 20;
        capture.matches.slice(0, matchLimit).forEach(record => {
            const gpu = durationMetricValue(record, capture);
            const cells = [formatNumber(gpu), record.eid, record.scope, escapeCell(record.path), ...metricCells(record, selectedHeaders, capture.headers)];
            lines.push(`| ${cells.join(' | ')} |`);
        });
        if (matchCount > matchLimit) lines.push('', `Showing ${Math.min(matchLimit, capture.matches.length)} of ${matchCount} matched regions.`);
        if (capture.matchesTruncated) lines.push('', 'The match list is truncated by `--top`; aggregate metrics and before/after comparison still include every independent matched root.');
        lines.push('');
        const estimatedHeaders = selectedHeaders.filter(header => capture.counterKinds[header] === 'mean');
        if (estimatedHeaders.length && capture.matches.some(record => record.scope === 'descendants')) {
            lines.push('Selected `.avg`, `.pct`, and `.ratio` values on generated parent rows are duration-weighted estimates over descendant actions; leaf `self` rows retain raw CSV values.', '');
        }
        const selectedSet = new Set(selectedHeaders);
        const showInstructionRatio = capture.signals.instructions
            && selectedSet.has(capture.signals.instructions.header)
            && Number.isFinite(capture.signals.derived.instructionsPerInvocation);
        const showByteRatio = [capture.signals.dramRead, capture.signals.dramWrite]
            .some(signal => signal && selectedSet.has(signal.header))
            && Number.isFinite(capture.signals.derived.bytesPerInvocation);
        if (showInstructionRatio || showByteRatio) {
            lines.push('### Aggregate normalization', '', '| Derived signal | Value |', '| --- | ---: |');
            lines.push(`| Mixed VS + PS + CS invocations | ${formatNumber(capture.signals.derived.invocationCount)} |`);
            if (showInstructionRatio) lines.push(`| Hardware instructions / mixed shader invocation | ${formatNumber(capture.signals.derived.instructionsPerInvocation)} |`);
            if (showByteRatio) lines.push(`| DRAM bytes / mixed shader invocation | ${formatNumber(capture.signals.derived.bytesPerInvocation)} |`);
            lines.push('', 'These region-wide ratios are broad workload clues, not stage-specific cost. PerfWorks hardware instructions are not one-to-one source instructions.', '');
        }

        if (capture.hierarchy?.length) {
            lines.push(`### Descendants to depth ${result.options.depth}`, '');
            lines.push('Durations of marker rows are inclusive. Rows at different levels overlap; `% parent` and `% root` are local ratios, not additive shares.', '');
            if (capture.summary?.missingLeafCount) lines.push('`% capture` uses the total of measured roots only because this capture has missing leaf counter rows.', '');
            if (result.options.top !== null) lines.push(`At each expanded parent, only its ${result.options.top} longest immediate children are shown. Aggregates above still include every matched root.`, '');
            for (const tree of capture.hierarchy) {
                const root = tree.nodes[0];
                if (!root) continue;
                const treeHeaders = ['Level', 'GPU ms', '% parent', '% root', '% capture', 'Children', 'EID', 'Scope', 'Path', ...selectedHeaders];
                const treeAlignment = ['---:', '---:', '---:', '---:', '---:', '---:', '---:', '---', '---', ...selectedHeaders.map(() => '---:')];
                lines.push(`#### ${escapeCell(root.path)}`, '');
                lines.push(`| ${treeHeaders.map(escapeCell).join(' | ')} |`, `| ${treeAlignment.join(' | ')} |`);
                tree.nodes.forEach(node => {
                    const cells = [
                        node.relativeDepth,
                        node.counterRowCount > 0 ? formatNumber(node.duration) : 'not measured',
                        node.parentShare === null ? '—' : formatShare(node.parentShare),
                        formatShare(node.rootShare),
                        formatShare(node.captureShare),
                        node.shownChildCount === null ? '—' : `${node.shownChildCount}/${node.childCount}`,
                        node.eid,
                        node.scope,
                        escapeCell(node.path),
                        ...selectedHeaders.map(header => {
                            if (!capture.headers.includes(header)) return 'not exported';
                            if (node.counterRowCount === 0) return 'not measured';
                            return formatNumber(node.metrics[header]);
                        })
                    ];
                    lines.push(`| ${cells.join(' | ')} |`);
                });
                lines.push('');
            }
        }
    }

    if (result.comparison) {
        const { labels, rows, selectedRows, signals, topology } = result.comparison;
        lines.push(`## ${labels[0]} → ${labels[1]}`, '');
        if (topology) {
            lines.push(`Focused roots by stable path: ${topology.sharedCount} shared, ${topology.onlyFirstCount} only in ${labels[0]}, ${topology.onlySecondCount} only in ${labels[1]}.`, '');
        }
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
            const shownLabel = signals.first[key].estimated || signals.second[key].estimated
                ? `${label} (duration-weighted estimate)`
                : label;
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
        if (selectedRows?.length) {
            lines.push('', 'Selected metric comparison:', '', '| Counter | Before | After | Change |', '| --- | ---: | ---: | ---: |');
            selectedRows.forEach(row => {
                const first = !row.firstExported ? 'not exported' : (row.firstMeasured ? formatNumber(row.first) : 'not measured');
                const second = !row.secondExported ? 'not exported' : (row.secondMeasured ? formatNumber(row.second) : 'not measured');
                const change = row.firstMeasured && row.secondMeasured
                    ? (row.relative === null ? 'n/a' : `${row.relative >= 0 ? '+' : ''}${(row.relative * 100).toFixed(1)}%`)
                    : 'n/a';
                lines.push(`| ${row.estimated ? '≈ ' : ''}${escapeCell(row.header)} | ${first} | ${second} | ${change} |`);
            });
            if (selectedRows.some(row => row.estimated)) {
                lines.push('', '`≈` marks `.avg`, `.pct`, and `.ratio` summaries that were duration-weighted across multiple actions or generated parent regions; they are not exact recomputed marker-wide ratios.', '');
            }
        }
        if (rows.length) {
            lines.push('', 'Largest meaningful counter changes (at least 0.5%):', '', '| Counter | Before | After | Change |', '| --- | ---: | ---: | ---: |');
            rows.slice(0, 15).forEach(row => {
                lines.push(`| ${row.estimated ? '≈ ' : ''}${row.header.replace(/\|/g, '\\|')} | ${formatNumber(row.first)} | ${formatNumber(row.second)} | ${row.relative === null ? 'n/a' : `${row.relative >= 0 ? '+' : ''}${(row.relative * 100).toFixed(1)}%`} |`);
            });
            if (rows.some(row => row.estimated)) lines.push('', '`≈` marks a duration-weighted average/percentage summary, not an exact recomputed marker-wide ratio.');
        }
        lines.push('', 'Mixed invocation ratios divide region-wide totals by VS + PS + CS invocations. Use them as relative workload clues, not stage-specific cost. PerfWorks hardware instructions are not one-to-one source instructions.', '');
    }
    return `${lines.join('\n')}\n`;
}

export async function queryCase(inputDir, query, options = {}) {
    const depth = options.depth ?? 0;
    if (!Number.isInteger(depth) || depth < 0 || depth > 64) throw new Error('depth must be an integer from 0 to 64');
    const top = options.top ?? null;
    if (top !== null && (!Number.isInteger(top) || top < 1 || top > 1000)) throw new Error('top must be an integer from 1 to 1000');
    const metricSelectors = options.metricSelectors ?? options.metrics ?? [];
    if (!Array.isArray(metricSelectors)) throw new Error('metrics must be an array of selectors');
    const caseDir = await resolveCaseDir(inputDir);
    const manifest = JSON.parse(await fs.readFile(path.join(caseDir, 'manifest.json'), 'utf8'));
    const selectedMetricHeaders = resolveMetricSelectors(manifest.captures, metricSelectors);
    const warnings = [...(manifest.warnings || [])];
    const captures = [];
    const focusedKeySets = [];
    for (const capture of manifest.captures) {
        const records = await readNdjson(path.join(caseDir, capture.graphFile));
        const allMatches = findFrontier(records, query).sort((a, b) => durationValue(b, capture) - durationValue(a, capture));
        const measuredMatches = allMatches.filter(isMeasured);
        focusedKeySets.push(new Set(allMatches.map(record => record.stableKey)));
        const unmeasuredMatchCount = allMatches.length - measuredMatches.length;
        const matches = top === null ? allMatches : allMatches.slice(0, top);
        const metrics = aggregate(allMatches, capture);
        const selectedHeaders = selectedMetricHeaders;
        const hierarchy = buildHierarchy(records, allMatches, capture, depth, top, selectedHeaders);
        const preparedCapture = {
            ...capture,
            records: undefined,
            matches,
            matchCount: allMatches.length,
            measuredMatchCount: measuredMatches.length,
            unmeasuredMatchCount,
            matchesTruncated: matches.length < allMatches.length,
            hierarchy,
            selectedHeaders,
            metrics,
            aggregateMeanIsEstimate: measuredMatches.length > 1 || (measuredMatches.length === 1 && measuredMatches[0].scope !== 'self')
        };
        preparedCapture.signals = coreSignals(preparedCapture, metrics);
        captures.push(preparedCapture);
        if (unmeasuredMatchCount) {
            warnings.push(`${capture.label}: ${unmeasuredMatchCount} of ${allMatches.length} focused roots have no counter row; they are reported as not measured and excluded from aggregates.`);
        }
    }
    const result = {
        query,
        caseDir,
        options: { depth, top, metricSelectors, selectedMetricHeaders },
        warnings,
        captures
    };
    if (captures.length === 2 && captures.every(capture => capture.measuredMatchCount > 0)) {
        const sharedHeaders = captures[0].headers.filter(header => captures[1].headers.includes(header));
        const [firstKeys, secondKeys] = focusedKeySets;
        const sharedCount = [...firstKeys].filter(key => secondKeys.has(key)).length;
        const topology = {
            sharedCount,
            onlyFirstCount: firstKeys.size - sharedCount,
            onlySecondCount: secondKeys.size - sharedCount
        };
        if (topology.onlyFirstCount || topology.onlySecondCount) {
            warnings.push(`Focused match topology differs for "${query}": ${topology.onlyFirstCount} independent roots exist only in ${captures[0].label} and ${topology.onlySecondCount} only in ${captures[1].label}. Aggregate comparison spans different event sets; confirm that they are the intended regions.`);
        }
        result.comparison = {
            labels: captures.map(capture => capture.label),
            topology,
            selectedRows: selectedComparisonRows(captures[0], captures[1], selectedMetricHeaders),
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
        const result = await queryCase(args.inputDir, args.query, {
            depth: args.depth,
            top: args.top,
            metricSelectors: args.metricSelectors
        });
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
