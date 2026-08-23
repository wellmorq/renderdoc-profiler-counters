import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOL_VERSION = '1.2.0';
const SCHEMA_VERSION = 3;
const METRICS_ENCODING = 'sparse-zero-omitted';
const KNOWN_ADDITIVE_COUNTERS = new Set([
    'Input Vertices Read',
    'Input Primitives',
    'GS Primitives',
    'Rasterizer Invocations',
    'Rasterized Primitives',
    'Samples Passed',
    'VS Invocations',
    'HS Invocations',
    'DS Invocations',
    'GS Invocations',
    'PS Invocations',
    'CS Invocations'
]);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(SCRIPT_DIR, '..');
const TEMPLATE_PATH = path.join(SKILL_DIR, 'assets', 'report-template.html');
const CATALOG_PATH = path.join(SKILL_DIR, 'references', 'nvidia-counters.json');

function parseArgs(argv) {
    let target = null;
    let output = null;
    let list = false;
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--output') {
            output = argv[++i];
            if (!output) throw new Error('--output requires a directory');
        } else if (arg === '--list') {
            list = true;
        } else if (arg.startsWith('-')) {
            throw new Error(`Unknown option: ${arg}`);
        } else if (target === null) {
            target = arg;
        } else {
            throw new Error(`Unexpected argument: ${arg}`);
        }
    }
    if (list && output) throw new Error('--list cannot be combined with --output');
    return {
        targetDir: path.resolve(target || process.cwd()),
        outputDir: output ? path.resolve(output) : null,
        list
    };
}

function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = '';
    let quoted = false;
    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        if (char === '"') {
            if (quoted && text[i + 1] === '"') {
                field += '"';
                i++;
            } else {
                quoted = !quoted;
            }
        } else if (char === ',' && !quoted) {
            row.push(field);
            field = '';
        } else if ((char === '\n' || char === '\r') && !quoted) {
            if (char === '\r' && text[i + 1] === '\n') i++;
            row.push(field);
            field = '';
            if (row.some(value => value.trim() !== '')) rows.push(row);
            row = [];
        } else {
            field += char;
        }
    }
    if (quoted) throw new Error('CSV contains an unterminated quoted field');
    row.push(field);
    if (row.some(value => value.trim() !== '')) rows.push(row);
    return rows;
}

function detectCounterKind(header) {
    const value = String(header || '').toLowerCase();
    if (durationScaleToMs(header) !== null || KNOWN_ADDITIVE_COUNTERS.has(String(header || '').trim())) return 'sum';
    if (value.includes('.sum')) return 'sum';
    if (value.includes('.max')) return 'max';
    if (value.includes('.min')) return 'min';
    if (value.includes('.avg') || value.includes('.pct') || value.includes('.ratio')) return 'mean';
    if (value.includes('(%)') || value.includes('hit_rate') || value.includes('hit rate') || value.includes('per_warp_active')) return 'mean';
    return 'unknown';
}

function findDurationHeader(headers, fileName = 'CSV') {
    const matches = headers.filter(header => durationScaleToMs(header) !== null);
    if (matches.length !== 1) {
        const found = matches.length ? matches.join(', ') : 'none';
        throw new Error(`${fileName}: CSV must contain exactly one GPU/Duration counter with an explicit supported unit (s, ms, us, µs, ns); found ${found}`);
    }
    return matches[0];
}

function durationScaleToMs(header) {
    const match = String(header || '').trim().match(/^(?:GPU )?Duration\s*\((s|ms|us|µs|μs|ns)\)$/i);
    if (!match) return null;
    const unit = (match[1] || 'ms').toLowerCase().replace(/[µμ]/g, 'u');
    if (unit === 's') return 1000;
    if (unit === 'ms') return 1;
    if (unit === 'us') return 0.001;
    if (unit === 'ns') return 0.000001;
    return null;
}

function parseCounters(text, fileName) {
    const rows = parseCsv(text);
    if (rows.length < 2) throw new Error(`${fileName}: CSV has no counter rows`);
    const allHeaders = rows[0].map((header, index) => (index === 0 ? header.replace(/^\uFEFF/, '') : header).trim());
    const eidIndex = allHeaders.findIndex(header => header.toUpperCase() === 'EID');
    if (eidIndex < 0) throw new Error(`${fileName}: CSV is missing the EID column`);
    if (new Set(allHeaders).size !== allHeaders.length) throw new Error(`${fileName}: CSV contains duplicate column names`);

    const headers = allHeaders.filter((_, index) => index !== eidIndex);
    if (headers.length === 0 || headers.some(header => !header)) throw new Error(`${fileName}: CSV contains an empty counter name`);
    const durationHeader = findDurationHeader(headers, fileName);
    const counters = new Map();

    for (let i = 1; i < rows.length; i++) {
        const values = rows[i];
        if (values.length !== allHeaders.length) {
            throw new Error(`${fileName}: row ${i + 1} has ${values.length} fields; expected ${allHeaders.length}`);
        }
        const eidText = values[eidIndex].trim();
        if (!/^\d+$/.test(eidText)) throw new Error(`${fileName}: row ${i + 1} has an invalid EID`);
        const eid = Number(eidText);
        if (counters.has(eid)) throw new Error(`${fileName}: duplicate EID ${eid}`);
        const metrics = {};
        values.forEach((value, index) => {
            if (index === eidIndex) return;
            const header = allHeaders[index];
            const normalized = value.trim().replace(/,/g, '');
            if (normalized === '') throw new Error(`${fileName}: row ${i + 1}, ${header}: empty counter value`);
            const number = Number(normalized);
            if (!Number.isFinite(number)) throw new Error(`${fileName}: row ${i + 1}, ${header}: expected a number`);
            if (header === durationHeader && number < 0) throw new Error(`${fileName}: row ${i + 1}, ${header}: duration must be non-negative`);
            metrics[header] = number;
        });
        counters.set(eid, metrics);
    }

    if (counters.size === 0) throw new Error(`${fileName}: CSV has no valid counter rows`);
    return {
        headers,
        counters,
        counterKinds: Object.fromEntries(headers.map(header => [header, detectCounterKind(header)])),
        durationHeader,
        durationToMs: durationScaleToMs(durationHeader),
        weightHeader: durationHeader
    };
}

function parseEvents(text, fileName) {
    const lines = text.split(/\r?\n/);
    const roots = [];
    const nodes = [];
    const stack = [];
    const seenEids = new Set();
    const separator = lines.findIndex(line => line.trim().startsWith('---'));
    const start = separator >= 0 ? separator + 1 : 0;

    for (let i = start; i < lines.length; i++) {
        const firstSeparator = lines[i].indexOf('|');
        if (firstSeparator < 0) continue;
        const lastSeparator = lines[i].lastIndexOf('|');
        const eidText = lines[i].slice(0, firstSeparator).trim();
        if (!/^\d+$/.test(eidText)) continue;
        const eventEnd = lastSeparator > firstSeparator ? lastSeparator : lines[i].length;
        const eventText = lines[i].slice(firstSeparator + 1, eventEnd);
        const actionText = lastSeparator > firstSeparator ? lines[i].slice(lastSeparator + 1).trim() : '';
        const match = eventText.match(/^(\s*)(?:\\)?[-=>]+\s*(.+?)\s*$/);
        if (!match) continue;
        const eid = Number(eidText);
        if (seenEids.has(eid)) throw new Error(`${fileName}: duplicate event EID ${eid}`);
        seenEids.add(eid);
        const node = {
            eid,
            name: match[2],
            actionNumber: actionText || null,
            level: Math.floor(match[1].length / 2),
            children: [],
            parent: null,
            order: nodes.length
        };
        while (stack.length && stack[stack.length - 1].level >= node.level) stack.pop();
        if (stack.length) {
            node.parent = stack[stack.length - 1];
            node.parent.children.push(node);
        } else {
            roots.push(node);
        }
        stack.push(node);
        nodes.push(node);
    }

    if (roots.length === 0) throw new Error(`${fileName}: no RenderDoc events were found`);
    return {
        captureTitle: lines.slice(0, Math.max(separator, 1)).find(line => line.trim())?.trim() || fileName,
        roots,
        nodes
    };
}

function findCounterAnomalies(counterData) {
    const anomalies = [];
    for (const header of counterData.headers) {
        if (!/(\.pct\b|\(%\)|hit[_ ]rate|per_warp_active)/i.test(header)) continue;
        let count = 0;
        let min = Infinity;
        let max = -Infinity;
        counterData.counters.forEach(metrics => {
            const value = metrics[header];
            if (!Number.isFinite(value) || (value >= -1 && value <= 101)) return;
            count++;
            min = Math.min(min, value);
            max = Math.max(max, value);
        });
        if (!count) continue;
        anomalies.push({
            type: 'percentage-range',
            header,
            count,
            min,
            max
        });
    }
    return anomalies;
}

function normalizeName(name) {
    return String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function assignPaths(roots) {
    const walk = (siblings, parentKey = '', parentPath = '') => {
        const totals = new Map();
        siblings.forEach(node => {
            const name = normalizeName(node.name);
            totals.set(name, (totals.get(name) || 0) + 1);
        });
        const seen = new Map();
        siblings.forEach(node => {
            const name = normalizeName(node.name);
            const occurrence = (seen.get(name) || 0) + 1;
            seen.set(name, occurrence);
            const part = `${encodeURIComponent(name)}#${occurrence}`;
            const displayPart = totals.get(name) > 1 ? `${node.name} [${occurrence}]` : node.name;
            node.stableKey = parentKey ? `${parentKey}/${part}` : part;
            node.parentKey = parentKey || null;
            node.path = parentPath ? `${parentPath} / ${displayPart}` : displayPart;
            walk(node.children, node.stableKey, node.path);
        });
    };
    walk(roots);
}

function stemTokens(fileName) {
    const generic = new Set(['event', 'events', 'eventbrowser', 'browser', 'counter', 'counters', 'performance', 'perf', 'metric', 'metrics', 'renderdoc', 'export', 'csv', 'txt']);
    return path.basename(fileName, path.extname(fileName))
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(token => token && !generic.has(token));
}

function stageHint(fileName) {
    const value = path.basename(fileName).toLowerCase().replace(/[_-]+/g, ' ');
    if (/\b(before|baseline|old|prev|previous)\b/.test(value)) return 'before';
    if (/\b(after|new|next|current)\b/.test(value)) return 'after';
    return null;
}

function pairScore(events, counters) {
    const eventEids = new Set(events.parsed.nodes.map(node => node.eid));
    let intersection = 0;
    counters.parsed.counters.forEach((_, eid) => { if (eventEids.has(eid)) intersection++; });
    const coverage = intersection / counters.parsed.counters.size;
    const eventTokens = new Set(stemTokens(events.name));
    const commonTokens = stemTokens(counters.name).filter(token => eventTokens.has(token)).length;
    const eventsStage = stageHint(events.name);
    const countersStage = stageHint(counters.name);
    const stage = eventsStage && countersStage ? (eventsStage === countersStage ? 1 : -1) : 0;
    return coverage * 1000 + commonTokens * 25 + stage * 200;
}

function pairCoverage(events, counters) {
    const eventEids = new Set(events.parsed.nodes.map(node => node.eid));
    const leafEids = new Set(events.parsed.nodes.filter(node => node.children.length === 0).map(node => node.eid));
    let matchedEidCount = 0;
    let matchedLeafEidCount = 0;
    counters.parsed.counters.forEach((_, eid) => {
        if (eventEids.has(eid)) matchedEidCount++;
        if (leafEids.has(eid)) matchedLeafEidCount++;
    });
    return { matchedEidCount, matchedLeafEidCount };
}

function validatePairs(pairs) {
    const disconnected = pairs.find(([events, counters]) => pairCoverage(events, counters).matchedLeafEidCount === 0);
    if (disconnected) {
        throw new Error(`${disconnected[0].name} and ${disconnected[1].name} share no measured leaf EIDs and cannot describe the same capture`);
    }
    return pairs;
}

function choosePairs(eventsFiles, counterFiles) {
    if (eventsFiles.length !== counterFiles.length) {
        throw new Error(`Expected the same number of events TXT and counters CSV files; found ${eventsFiles.length} TXT and ${counterFiles.length} CSV`);
    }
    if (eventsFiles.length < 1 || eventsFiles.length > 2) {
        throw new Error(`Expected one or two TXT+CSV pairs; found ${eventsFiles.length} candidate pairs`);
    }
    if (eventsFiles.length === 1) return validatePairs([[eventsFiles[0], counterFiles[0]]]);

    const direct = pairScore(eventsFiles[0], counterFiles[0]) + pairScore(eventsFiles[1], counterFiles[1]);
    const crossed = pairScore(eventsFiles[0], counterFiles[1]) + pairScore(eventsFiles[1], counterFiles[0]);
    if (Math.abs(direct - crossed) < 20) {
        throw new Error('TXT/CSV pairing is ambiguous. Rename files with matching before/after or other shared tokens, or place each intended pair in an unambiguous input set');
    }
    const pairs = direct >= crossed
        ? [[eventsFiles[0], counterFiles[0]], [eventsFiles[1], counterFiles[1]]]
        : [[eventsFiles[0], counterFiles[1]], [eventsFiles[1], counterFiles[0]]];
    return validatePairs(pairs);
}

function labelPair(eventsFile, countersFile, index, pairCount) {
    const stages = [stageHint(eventsFile.name), stageHint(countersFile.name)].filter(Boolean);
    if (stages.includes('before') && !stages.includes('after')) return 'before';
    if (stages.includes('after') && !stages.includes('before')) return 'after';
    const eventTokens = new Set(stemTokens(eventsFile.name));
    const common = stemTokens(countersFile.name).filter(token => eventTokens.has(token));
    if (common.length) return common.join('-');
    return pairCount === 1 ? 'capture' : (index === 0 ? 'a' : 'b');
}

function aggregateRowsDetailed(rows, headers, kinds, weightHeader, aggregate = rows.length > 1) {
    const result = {};
    const methods = {};
    for (const header of headers) {
        const values = rows.map(metrics => metrics[header]).filter(Number.isFinite);
        if (kinds[header] === 'unknown') {
            result[header] = aggregate && values.length > 1 ? null : (values.length ? values[0] : null);
            methods[header] = aggregate && values.length > 1 ? 'unavailable-unknown-kind' : 'raw-self';
            continue;
        }
        if (kinds[header] === 'max') {
            result[header] = values.length ? values.reduce((maximum, value) => Math.max(maximum, value), -Infinity) : null;
            methods[header] = aggregate ? 'max' : 'raw-self';
            continue;
        }
        if (kinds[header] === 'min') {
            result[header] = values.length ? values.reduce((minimum, value) => Math.min(minimum, value), Infinity) : null;
            methods[header] = aggregate ? 'min' : 'raw-self';
            continue;
        }
        if (!aggregate || values.length === 1) {
            result[header] = values.length ? values[0] : null;
            methods[header] = 'raw-self';
            continue;
        }
        let sum = 0;
        let count = 0;
        let weighted = 0;
        let weightSum = 0;
        let weightedCount = 0;
        for (const metrics of rows) {
            const value = metrics[header];
            if (!Number.isFinite(value)) continue;
            sum += value;
            count++;
            const weight = weightHeader ? metrics[weightHeader] : NaN;
            if (Number.isFinite(weight) && weight > 0) {
                weighted += value * weight;
                weightSum += weight;
                weightedCount++;
            }
        }
        if (kinds[header] === 'mean') {
            result[header] = weightSum > 0 ? weighted / weightSum : null;
            methods[header] = weightSum > 0
                ? `duration-weighted${weightedCount === count ? '' : '-partial'}`
                : 'unavailable-no-positive-duration';
        } else {
            result[header] = sum;
            methods[header] = 'sum';
        }
    }
    return { metrics: result, methods };
}

function aggregateRows(rows, headers, kinds, weightHeader, aggregate = rows.length > 1) {
    return aggregateRowsDetailed(rows, headers, kinds, weightHeader, aggregate).metrics;
}

function prepareCapture(label, eventsSource, countersSource) {
    const { roots, nodes, captureTitle } = eventsSource.parsed;
    const counterData = countersSource.parsed;
    const anomalies = findCounterAnomalies(counterData);
    assignPaths(roots);

    const allEventEids = new Set(nodes.map(node => node.eid));
    const unmatchedCounterEids = [];
    counterData.counters.forEach((_, eid) => { if (!allEventEids.has(eid)) unmatchedCounterEids.push(eid); });
    const leafEids = nodes.filter(node => node.children.length === 0).map(node => node.eid);
    const missingLeafEids = leafEids.filter(eid => !counterData.counters.has(eid));

    const records = [];
    const visit = node => {
        const descendantRows = [];
        node.children.forEach(child => {
            for (const row of visit(child)) descendantRows.push(row);
        });
        const ownMetrics = counterData.counters.get(node.eid) || null;
        const rows = node.children.length ? descendantRows : (ownMetrics ? [ownMetrics] : []);
        const effectiveRows = rows;
        const aggregateDetails = effectiveRows.length
            ? aggregateRowsDetailed(effectiveRows, counterData.headers, counterData.counterKinds, counterData.weightHeader, node.children.length > 0)
            : { metrics: {}, methods: {} };
        const metrics = aggregateDetails.metrics;
        const compactMetrics = Object.fromEntries(Object.entries(metrics).filter(([, value]) => value !== 0));
        records.push({
            eid: node.eid,
            name: node.name,
            path: node.path,
            stableKey: node.stableKey,
            parentKey: node.parentKey,
            depth: node.level,
            order: node.order,
            actionNumber: node.actionNumber,
            childCount: node.children.length,
            scope: node.children.length ? 'descendants' : 'self',
            counterRowCount: effectiveRows.length,
            metrics: compactMetrics,
            aggregation: !effectiveRows.length
                ? { source: 'unavailable', rowCount: 0, method: 'unavailable-no-rows' }
                : node.children.length
                    ? { source: 'descendant-rows', rowCount: effectiveRows.length, methods: aggregateDetails.methods }
                    : { source: 'self-row', rowCount: 1, method: 'raw-self' },
            selfMetrics: node.children.length && ownMetrics ? ownMetrics : undefined
        });
        return effectiveRows;
    };
    roots.forEach(visit);
    records.sort((a, b) => a.order - b.order);

    const durationHeader = counterData.durationHeader;
    const durationToMs = counterData.durationToMs;
    const rootKeys = new Set(roots.map(node => node.stableKey));
    const rootRecords = records.filter(record => rootKeys.has(record.stableKey));
    const measuredRootRecords = rootRecords.filter(record => record.counterRowCount > 0);
    const totalDurationMs = durationHeader && measuredRootRecords.length
        ? measuredRootRecords.reduce((sum, record) => sum + (Number.isFinite(record.metrics[durationHeader]) ? record.metrics[durationHeader] : 0), 0) * durationToMs
        : null;

    return {
        label,
        captureTitle,
        eventsFile: eventsSource.name,
        countersFile: countersSource.name,
        headers: counterData.headers,
        counterKinds: counterData.counterKinds,
        durationHeader,
        durationToMs,
        weightHeader: counterData.weightHeader,
        anomalies,
        records,
        summary: {
            eventCount: nodes.length,
            rootCount: roots.length,
            measuredRootCount: measuredRootRecords.length,
            unmeasuredRootCount: rootRecords.length - measuredRootRecords.length,
            leafCount: leafEids.length,
            counterRowCount: counterData.counters.size,
            matchedCounterRows: counterData.counters.size - unmatchedCounterEids.length,
            missingLeafCount: missingLeafEids.length,
            unmatchedCounterCount: unmatchedCounterEids.length,
            metricCount: counterData.headers.length,
            totalDurationMs,
            meanUnavailableCount: records.reduce((count, record) => count + Object.entries(record.aggregation?.methods || {}).filter(([header, method]) => counterData.counterKinds[header] === 'mean' && String(method).startsWith('unavailable')).length, 0),
            unknownAggregateCount: records.reduce((count, record) => count + Object.entries(record.aggregation?.methods || {}).filter(([header, method]) => counterData.counterKinds[header] === 'unknown' && String(method).startsWith('unavailable')).length, 0)
        },
        missingLeafEids,
        unmatchedCounterEids
    };
}

function resolveCatalog(header, catalog) {
    const normalized = String(header).replace(/\s+\([^)]*\)\s*$/, '').trim();
    const matches = catalog.entries.filter(entry => normalized.startsWith(entry.prefix));
    matches.sort((a, b) => b.prefix.length - a.prefix.length);
    return matches[0] || null;
}

function safeLabel(label, index) {
    const value = String(label || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '');
    return value || `capture-${index + 1}`;
}

function makeComparison(captures) {
    if (captures.length !== 2) return null;
    const firstByKey = new Map(captures[0].records.map((record, index) => [record.stableKey, index]));
    const secondByKey = new Map(captures[1].records.map((record, index) => [record.stableKey, index]));
    const matches = [];
    firstByKey.forEach((firstIndex, key) => {
        const secondIndex = secondByKey.get(key);
        if (secondIndex !== undefined) matches.push([firstIndex, secondIndex]);
    });
    return {
        labels: [captures[0].label, captures[1].label],
        matches,
        matchedCount: matches.length,
        onlyFirstCount: firstByKey.size - matches.length,
        onlySecondCount: secondByKey.size - matches.length
    };
}

function renderGuide(targetDir, caseDir, captures, warnings) {
    const lines = [
        '# Prepared RenderDoc performance case',
        '',
        `Source directory: ${targetDir}`,
        `Case directory: ${caseDir}`,
        '',
        'The generated NDJSON files are the searchable event graph. Each line contains one event or marker, its full path, aggregation scope, counters, and provenance.',
        'Metric objects use sparse-zero encoding only for measured records: when counterRowCount is positive, a missing metric key listed in the capture headers means numeric zero. An explicit null means that the counter could not be aggregated. When counterRowCount is zero, the record was not measured and all of its metric values are unavailable. A counter absent from the headers was not exported.',
        'For parent markers, .avg/.pct/.ratio values are raw for one contributing row and duration-weighted estimates across multiple descendant rows. If no positive duration weight exists, the value is unavailable; there is no arithmetic or counter-row fallback. Exact ratios require their numerator and denominator counters; inspect leaf rows and ranges when that distinction matters.',
        ''
    ];
    captures.forEach(capture => {
        lines.push(`## ${capture.label}`, '');
        lines.push(`- Events: ${capture.summary.eventCount}`);
        lines.push(`- Counter rows: ${capture.summary.counterRowCount}`);
        lines.push(`- Metrics: ${capture.summary.metricCount}`);
        if (Number.isFinite(capture.summary.totalDurationMs)) lines.push(`- Measured-root GPU duration: ${capture.summary.totalDurationMs.toFixed(3)} ms`);
        lines.push(`- Sources: ${capture.eventsFile}, ${capture.countersFile}`);
        lines.push(`- GPU Duration: ${capture.durationHeader} -> ${capture.durationToMs} ms/unit`);
        lines.push(`- Mean aggregation: one row raw; multiple rows duration-weighted; no positive duration means unavailable`, '');
    });
    if (warnings.length) {
        lines.push('## Warnings', '');
        warnings.forEach(warning => lines.push(`- ${warning}`));
        lines.push('');
    }
    lines.push('## Investigation', '');
    lines.push('Use the skill query command with a pass or marker name before answering a focused question. Use `.` or `*` for capture roots, `--depth N --top N` for bounded hierarchy, and `--metrics core|work|instructions|memory|stalls` for focused counters. Expanded descendants are inclusive display rows and never change the non-overlapping aggregate. Compare more work, more work per item, and less efficient execution. Explain hardware counter names in plain workload terms and state missing evidence explicitly.', '');
    return lines.join('\n');
}

async function readCandidates(targetDir) {
    const entries = await fs.readdir(targetDir, { withFileTypes: true });
    const txt = entries.filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.txt')).sort((a, b) => a.name.localeCompare(b.name));
    const csv = entries.filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.csv')).sort((a, b) => a.name.localeCompare(b.name));
    const eventsFiles = [];
    const counterFiles = [];
    const rejected = [];
    const rejectedCandidates = [];
    const reject = (entry, error) => {
        const message = String(error.message || error);
        const reason = message.startsWith(`${entry.name}:`) ? message : `${entry.name}: ${message}`;
        rejected.push(reason);
        rejectedCandidates.push({
            name: entry.name,
            type: entry.name.toLowerCase().endsWith('.txt') ? 'events' : 'counters',
            sizeBytes: entry.sizeBytes,
            reason
        });
    };

    for (const entry of txt) {
        const filePath = path.join(targetDir, entry.name);
        const [content, stat] = await Promise.all([
            fs.readFile(filePath, 'utf8'),
            fs.stat(filePath)
        ]);
        entry.sizeBytes = stat.size;
        try {
            eventsFiles.push({ name: entry.name, sizeBytes: stat.size, content, parsed: parseEvents(content, entry.name) });
        } catch (error) {
            reject(entry, error);
        }
    }
    for (const entry of csv) {
        const filePath = path.join(targetDir, entry.name);
        const [content, stat] = await Promise.all([
            fs.readFile(filePath, 'utf8'),
            fs.stat(filePath)
        ]);
        entry.sizeBytes = stat.size;
        try {
            counterFiles.push({ name: entry.name, sizeBytes: stat.size, content, parsed: parseCounters(content, entry.name) });
        } catch (error) {
            reject(entry, error);
        }
    }
    return { eventsFiles, counterFiles, rejected, rejectedCandidates };
}

function percent(value, total) {
    return total > 0 ? (value / total) * 100 : null;
}

function describeEventCandidate(source) {
    const nodes = source.parsed.nodes;
    return {
        name: source.name,
        sizeBytes: source.sizeBytes,
        stageHint: stageHint(source.name),
        eventCount: nodes.length,
        rootCount: source.parsed.roots.length,
        leafCount: nodes.filter(node => node.children.length === 0).length
    };
}

function describeCounterCandidate(source) {
    const data = source.parsed;
    return {
        name: source.name,
        sizeBytes: source.sizeBytes,
        stageHint: stageHint(source.name),
        rowCount: data.counters.size,
        metricCount: data.headers.length,
        headers: data.headers,
        durationHeader: data.durationHeader,
        durationToMs: data.durationToMs
    };
}

function buildCoverageMatrix(eventsFiles, counterFiles) {
    return eventsFiles.map(eventsFile => {
        const eventEids = new Set(eventsFile.parsed.nodes.map(node => node.eid));
        const leafEids = new Set(eventsFile.parsed.nodes.filter(node => node.children.length === 0).map(node => node.eid));
        return {
            eventsFile: eventsFile.name,
            entries: counterFiles.map(counterFile => {
                let matchedEidCount = 0;
                let matchedLeafEidCount = 0;
                counterFile.parsed.counters.forEach((_, eid) => {
                    if (eventEids.has(eid)) matchedEidCount++;
                    if (leafEids.has(eid)) matchedLeafEidCount++;
                });
                return {
                    countersFile: counterFile.name,
                    matchedEidCount,
                    matchedLeafEidCount,
                    eventCount: eventEids.size,
                    leafCount: leafEids.size,
                    counterRowCount: counterFile.parsed.counters.size,
                    eventCoverage: percent(matchedEidCount, eventEids.size),
                    leafCoverage: percent(matchedLeafEidCount, leafEids.size),
                    counterCoverage: percent(matchedEidCount, counterFile.parsed.counters.size)
                };
            })
        };
    });
}

function compareCounterFiles(left, right) {
    const leftEids = left.parsed.counters;
    const rightEids = right.parsed.counters;
    const commonEids = [];
    leftEids.forEach((_, eid) => {
        if (rightEids.has(eid)) commonEids.push(eid);
    });
    commonEids.sort((a, b) => a - b);
    const rightHeaders = new Set(right.parsed.headers);
    const commonHeaders = left.parsed.headers.filter(header => rightHeaders.has(header));
    const comparable = commonEids.length > 0 && commonHeaders.length > 0;
    const maxAbsDeltaByHeader = {};
    const conflicts = [];
    for (const header of commonHeaders) {
        let maxAbsDelta = 0;
        let differingRowCount = 0;
        for (const eid of commonEids) {
            const leftValue = leftEids.get(eid)[header];
            const rightValue = rightEids.get(eid)[header];
            const delta = Math.abs(leftValue - rightValue);
            if (delta > maxAbsDelta) maxAbsDelta = delta;
            if (delta !== 0) differingRowCount++;
        }
        maxAbsDeltaByHeader[header] = maxAbsDelta;
        if (differingRowCount > 0) {
            conflicts.push({
                header,
                differingRowCount,
                maxAbsDelta
            });
        }
    }
    return {
        leftFile: left.name,
        rightFile: right.name,
        leftRowCount: leftEids.size,
        rightRowCount: rightEids.size,
        rowCountDelta: Math.abs(leftEids.size - rightEids.size),
        rowCountEqual: leftEids.size === rightEids.size,
        commonEidCount: commonEids.length,
        leftOnlyEidCount: leftEids.size - commonEids.length,
        rightOnlyEidCount: rightEids.size - commonEids.length,
        commonHeaderCount: commonHeaders.length,
        comparable,
        commonHeaders,
        maxAbsDeltaByHeader,
        conflicts
    };
}

function buildGuidance(eventsFiles, counterFiles, rejectedCandidates, pairingError, comparisons) {
    const guidance = [];
    if (pairingError) {
        guidance.push('This candidate set is not ready. Select the intended exports or place only the intended pairs in a clean temporary input directory.');
        guidance.push('Prepare accepts one or two unambiguous TXT+CSV pairs; it does not merge or auto-select extra CSV files.');
    } else {
        guidance.push('The proposed pairs are the files that normal prepare will use.');
    }
    if (rejectedCandidates.length) {
        guidance.push('Rejected TXT/CSV files are ignored. Review them only if one was intended to be a RenderDoc export.');
    }
    if (comparisons.some(comparison => comparison.conflicts.length || comparison.rowCountDelta)) {
        guidance.push('CSV candidates contain differing values. Do not merge them or treat them as interchangeable; keep both when they are an explicit before/after pair.');
    }
    if (comparisons.some(comparison => !comparison.comparable)) {
        guidance.push('Some CSV candidates have no comparable EID/counter intersection; zero conflict counts for those pairs do not mean that their values agree.');
    }
    if (!eventsFiles.length || !counterFiles.length) {
        guidance.push('Add at least one valid RenderDoc Event Browser TXT and one valid counter CSV.');
    }
    return guidance;
}

/**
 * Inspect candidate exports without creating a perf-analysis directory or any other file.
 * The returned object is intentionally JSON-serializable for the CLI and tests.
 */
export async function inspectCandidates(targetDir) {
    const resolvedTargetDir = path.resolve(targetDir || process.cwd());
    const stat = await fs.stat(resolvedTargetDir).catch(() => null);
    if (!stat?.isDirectory()) throw new Error(`Directory does not exist: ${resolvedTargetDir}`);

    const { eventsFiles, counterFiles, rejectedCandidates } = await readCandidates(resolvedTargetDir);
    const comparisons = [];
    for (let i = 0; i < counterFiles.length; i++) {
        for (let j = i + 1; j < counterFiles.length; j++) {
            comparisons.push(compareCounterFiles(counterFiles[i], counterFiles[j]));
        }
    }

    let pairs = [];
    let pairingError = null;
    try {
        pairs = choosePairs(eventsFiles, counterFiles);
    } catch (error) {
        pairingError = error.message;
    }
    const proposedPairs = pairs.map(([eventsFile, counterFile], index) => ({
        eventsFile: eventsFile.name,
        countersFile: counterFile.name,
        label: labelPair(eventsFile, counterFile, index, pairs.length)
    }));
    const ready = !pairingError;
    const status = ready
        ? 'ready'
        : (eventsFiles.length > 0 && counterFiles.length > eventsFiles.length
            ? 'ambiguous-counter-alternatives'
            : (/pairing is ambiguous/i.test(pairingError || '') ? 'ambiguous-pairing' : 'not-ready'));
    return {
        targetDir: resolvedTargetDir,
        events: eventsFiles.map(describeEventCandidate),
        counters: counterFiles.map(describeCounterCandidate),
        rejected: rejectedCandidates,
        coverage: buildCoverageMatrix(eventsFiles, counterFiles),
        csvComparisons: comparisons,
        readiness: {
            ready,
            status,
            reason: pairingError,
            candidatePairCount: pairs.length
        },
        proposedPairs,
        guidance: buildGuidance(eventsFiles, counterFiles, rejectedCandidates, pairingError, comparisons)
    };
}

function artifactMetadata(file, content) {
    const bytes = Buffer.from(content, 'utf8');
    return {
        file,
        sizeBytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex')
    };
}

async function artifactMatches(caseDir, artifact, expectedFile = null) {
    if (!artifact || typeof artifact.file !== 'string' || path.basename(artifact.file) !== artifact.file) return false;
    if (expectedFile && artifact.file !== expectedFile) return false;
    if (!Number.isInteger(artifact.sizeBytes) || artifact.sizeBytes <= 0 || !/^[a-f0-9]{64}$/.test(artifact.sha256 || '')) return false;
    try {
        const content = await fs.readFile(path.join(caseDir, artifact.file));
        return content.length === artifact.sizeBytes
            && createHash('sha256').update(content).digest('hex') === artifact.sha256;
    } catch {
        return false;
    }
}

async function canReuseCase(reportPath, manifestPath, guidePath, fingerprint) {
    try {
        const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
        if (manifest.fingerprint !== fingerprint || manifest.schemaVersion !== SCHEMA_VERSION) return false;
        if (manifest.metricsEncoding !== METRICS_ENCODING || manifest.metricAvailability !== 'counterRowCount-zero-means-unmeasured') return false;
        if (manifest.report !== path.basename(reportPath) || manifest.guide !== path.basename(guidePath)) return false;
        if (!Array.isArray(manifest.captures) || manifest.captures.length < 1 || manifest.captures.length > 2) return false;
        const caseDir = path.dirname(manifestPath);
        const graphs = manifest.artifacts?.graphs;
        if (!Array.isArray(graphs) || graphs.length !== manifest.captures.length) return false;
        if (!await artifactMatches(caseDir, manifest.artifacts?.report, path.basename(reportPath))) return false;
        if (!await artifactMatches(caseDir, manifest.artifacts?.guide, path.basename(guidePath))) return false;
        for (let index = 0; index < manifest.captures.length; index++) {
            const capture = manifest.captures[index];
            const graph = graphs[index];
            if (!capture || !Array.isArray(capture.headers) || !capture.headers.length || new Set(capture.headers).size !== capture.headers.length) return false;
            const summary = capture.summary;
            const validRootSummary = Number.isInteger(summary?.rootCount) && summary.rootCount >= 1
                && Number.isInteger(summary.measuredRootCount) && summary.measuredRootCount >= 0
                && Number.isInteger(summary.unmeasuredRootCount) && summary.unmeasuredRootCount >= 0
                && summary.measuredRootCount + summary.unmeasuredRootCount === summary.rootCount;
            const validTotal = summary?.measuredRootCount === 0
                ? summary.totalDurationMs === null
                : Number.isFinite(summary?.totalDurationMs) && summary.totalDurationMs >= 0;
            if (!Number.isInteger(summary?.eventCount) || summary.eventCount < 1 || !validRootSummary || !Number.isInteger(summary.counterRowCount) || summary.counterRowCount < 0 || !Number.isInteger(summary.missingLeafCount) || summary.missingLeafCount < 0 || summary.metricCount !== capture.headers.length || !validTotal) return false;
            if (capture.durationHeader !== findDurationHeader(capture.headers) || capture.durationToMs !== durationScaleToMs(capture.durationHeader) || capture.weightHeader !== capture.durationHeader) return false;
            if (!capture.counterKinds || capture.headers.some(header => !['sum', 'max', 'min', 'mean', 'unknown'].includes(capture.counterKinds[header]))) return false;
            if (capture.counterKinds[capture.durationHeader] !== 'sum') return false;
            if (graph.file !== capture.graphFile || graph.recordCount !== capture.summary?.eventCount) return false;
            if (!await artifactMatches(caseDir, graph, capture.graphFile)) return false;
        }
        return true;
    } catch {
        return false;
    }
}

export async function prepare(targetDir, outputDir = null) {
    const stat = await fs.stat(targetDir).catch(() => null);
    if (!stat?.isDirectory()) throw new Error(`Directory does not exist: ${targetDir}`);

    const [template, catalogText, analyzerText] = await Promise.all([
        fs.readFile(TEMPLATE_PATH, 'utf8'),
        fs.readFile(CATALOG_PATH, 'utf8'),
        fs.readFile(fileURLToPath(import.meta.url), 'utf8')
    ]);
    const catalog = JSON.parse(catalogText);
    const { eventsFiles, counterFiles, rejected } = await readCandidates(targetDir);
    const warnings = [];
    if (rejected.length) {
        warnings.push(`Ignored ${rejected.length} invalid TXT/CSV candidate${rejected.length === 1 ? '' : 's'}: ${rejected.slice(0, 4).join('; ')}${rejected.length > 4 ? '; ...' : ''}`);
    }
    let pairs;
    try {
        pairs = choosePairs(eventsFiles, counterFiles);
    } catch (error) {
        const details = rejected.slice(0, 4);
        if (details.length) error.message += ` Rejected candidates: ${details.join('; ')}`;
        error.message += ' Run `node prepare.mjs <directory> --list` to inspect candidates; no CSVs are merged or auto-selected.';
        throw error;
    }
    const captures = pairs.map(([eventsFile, countersFile], index) => {
        const label = labelPair(eventsFile, countersFile, index, pairs.length);
        return prepareCapture(label, eventsFile, countersFile);
    });
    captures.sort((a, b) => {
        const rank = label => label === 'before' ? 0 : label === 'after' ? 1 : 2;
        return rank(a.label) - rank(b.label) || a.label.localeCompare(b.label);
    });
    const labelCounts = new Map();
    captures.forEach(capture => {
        const baseLabel = capture.label;
        const occurrence = (labelCounts.get(baseLabel) || 0) + 1;
        labelCounts.set(baseLabel, occurrence);
    });
    const duplicateLabels = [...labelCounts.entries()].filter(([, count]) => count > 1).map(([label]) => label);
    if (duplicateLabels.length) {
        throw new Error(`Duplicate capture labels: ${duplicateLabels.join(', ')}. Rename before/after files so each capture has a distinct label before preparing a comparison.`);
    }
    captures.forEach((capture, index) => { capture.fileLabel = safeLabel(capture.label, index); });

    captures.forEach(capture => {
        if (capture.summary.missingLeafCount) warnings.push(`${capture.label}: ${capture.summary.missingLeafCount} leaf events have no counter row.`);
        if (capture.summary.unmatchedCounterCount) warnings.push(`${capture.label}: ${capture.summary.unmatchedCounterCount} counter rows do not match an exported event EID.`);
        if (capture.summary.meanUnavailableCount) warnings.push(`${capture.label}: ${capture.summary.meanUnavailableCount} mean counter aggregates are unavailable because multiple rows have no positive GPU-duration weight; no arithmetic fallback was used.`);
        if (capture.summary.unknownAggregateCount) warnings.push(`${capture.label}: ${capture.summary.unknownAggregateCount} unknown counter aggregates are unavailable; unknown counters are not summed across descendants.`);
        if (capture.anomalies.length) {
            const count = capture.anomalies.reduce((sum, anomaly) => sum + anomaly.count, 0);
            const example = capture.anomalies[0];
            warnings.push(`${capture.label}: raw CSV contains ${count} percentage values outside -1..101 across ${capture.anomalies.length} counters (for example ${example.header}: ${example.min}..${example.max}). Values were preserved, not clamped.`);
        }
    });
    if (captures.length === 2) {
        const firstHeaders = new Set(captures[0].headers);
        const shared = captures[1].headers.filter(header => firstHeaders.has(header));
        if (shared.length !== captures[0].headers.length || shared.length !== captures[1].headers.length) {
            warnings.push(`Counter sets differ; ${shared.length} metrics are shared and only shared metrics should be compared directly.`);
        }
    }

    const hash = createHash('sha256');
    hash.update(`${TOOL_VERSION}:${SCHEMA_VERSION}\n`);
    hash.update(`${path.resolve(targetDir)}\n`);
    hash.update(template);
    hash.update(catalogText);
    hash.update(analyzerText);
    hash.update(`${JSON.stringify(rejected)}\n`);
    pairs.flat().forEach(source => { hash.update(source.name); hash.update(source.content); });
    const fingerprint = hash.digest('hex');
    const analysisRoot = outputDir || path.join(targetDir, 'perf-analysis');
    const caseDir = path.join(analysisRoot, fingerprint.slice(0, 12));
    const reportPath = path.join(caseDir, 'report.html');
    const manifestPath = path.join(caseDir, 'manifest.json');
    const guidePath = path.join(caseDir, 'model-guide.md');

    if (await canReuseCase(reportPath, manifestPath, guidePath, fingerprint)) {
        await fs.mkdir(analysisRoot, { recursive: true });
        await fs.writeFile(path.join(analysisRoot, 'latest.json'), `${JSON.stringify({ fingerprint, caseDir }, null, 2)}\n`, 'utf8');
        return { status: 'reused', targetDir, caseDir, report: reportPath, manifest: manifestPath, guide: guidePath, warnings };
    }

    await fs.mkdir(caseDir, { recursive: true });
    const captureFiles = [];
    for (const capture of captures) {
        const fileName = `capture-${capture.fileLabel}.ndjson`;
        const content = `${capture.records.map(record => JSON.stringify(record)).join('\n')}\n`;
        await fs.writeFile(path.join(caseDir, fileName), content, 'utf8');
        captureFiles.push({ ...artifactMetadata(fileName, content), recordCount: capture.records.length });
    }

    const comparison = makeComparison(captures);
    if (comparison && (comparison.onlyFirstCount || comparison.onlySecondCount)) {
        warnings.push(`Marker topology differs: ${comparison.onlyFirstCount} nodes exist only in ${comparison.labels[0]} and ${comparison.onlySecondCount} only in ${comparison.labels[1]}. Path-based matches near inserted, removed, or reordered markers require manual confirmation.`);
    }
    const metricDocs = {};
    new Set(captures.flatMap(capture => capture.headers)).forEach(header => {
        const entry = resolveCatalog(header, catalog);
        if (entry) metricDocs[header] = entry;
    });
    const reportData = {
        schemaVersion: SCHEMA_VERSION,
        metricsEncoding: METRICS_ENCODING,
        fingerprint,
        generatedAt: new Date().toISOString(),
        sourceDirectory: targetDir,
        warnings,
        metricDocs,
        comparison,
        captures: captures.map(capture => ({
            label: capture.label,
            title: capture.captureTitle,
            headers: capture.headers,
            counterKinds: capture.counterKinds,
            durationHeader: capture.durationHeader,
            durationToMs: capture.durationToMs,
            weightHeader: capture.weightHeader,
            anomalies: capture.anomalies,
            summary: capture.summary,
            records: capture.records
        }))
    };
    const payload = JSON.stringify(reportData).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
    const report = template.replace('__REPORT_DATA__', payload);
    if (report === template) throw new Error('Report template is missing __REPORT_DATA__ placeholder');
    const guide = renderGuide(targetDir, caseDir, captures, warnings);

    const manifest = {
        schemaVersion: SCHEMA_VERSION,
        toolVersion: TOOL_VERSION,
        metricsEncoding: METRICS_ENCODING,
        metricAvailability: 'counterRowCount-zero-means-unmeasured',
        fingerprint,
        generatedAt: reportData.generatedAt,
        sourceDirectory: targetDir,
        report: 'report.html',
        guide: 'model-guide.md',
        captures: captures.map((capture, index) => ({
            label: capture.label,
            eventsFile: capture.eventsFile,
            countersFile: capture.countersFile,
            graphFile: captureFiles[index].file,
            headers: capture.headers,
            counterKinds: capture.counterKinds,
            durationHeader: capture.durationHeader,
            durationToMs: capture.durationToMs,
            weightHeader: capture.weightHeader,
            anomalies: capture.anomalies,
            summary: capture.summary,
            missingLeafEids: capture.missingLeafEids,
            unmatchedCounterEids: capture.unmatchedCounterEids
        })),
        comparison: comparison ? {
            labels: comparison.labels,
            matchedCount: comparison.matchedCount,
            onlyFirstCount: comparison.onlyFirstCount,
            onlySecondCount: comparison.onlySecondCount
        } : null,
        warnings,
        artifacts: {
            report: artifactMetadata('report.html', report),
            guide: artifactMetadata('model-guide.md', guide),
            graphs: captureFiles
        }
    };

    await Promise.all([
        fs.writeFile(reportPath, report, 'utf8'),
        fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8'),
        fs.writeFile(guidePath, guide, 'utf8')
    ]);
    await fs.mkdir(analysisRoot, { recursive: true });
    await fs.writeFile(path.join(analysisRoot, 'latest.json'), `${JSON.stringify({ fingerprint, caseDir }, null, 2)}\n`, 'utf8');
    return { status: 'prepared', targetDir, caseDir, report: reportPath, manifest: manifestPath, guide: guidePath, warnings };
}

async function main() {
    try {
        const args = parseArgs(process.argv.slice(2));
        const result = args.list
            ? await inspectCandidates(args.targetDir)
            : await prepare(args.targetDir, args.outputDir);
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } catch (error) {
        process.stderr.write(`renderdoc-perf: ${error.message}\n`);
        process.exitCode = 1;
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    await main();
}

export { aggregateRows, detectCounterKind, parseCounters, parseCsv, parseEvents };
