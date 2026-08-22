import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOL_VERSION = '1.0.0';
const SCHEMA_VERSION = 1;
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(SCRIPT_DIR, '..');
const TEMPLATE_PATH = path.join(SKILL_DIR, 'assets', 'report-template.html');
const CATALOG_PATH = path.join(SKILL_DIR, 'references', 'nvidia-counters.json');

function parseArgs(argv) {
    let target = null;
    let output = null;
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--output') {
            output = argv[++i];
            if (!output) throw new Error('--output requires a directory');
        } else if (arg.startsWith('-')) {
            throw new Error(`Unknown option: ${arg}`);
        } else if (target === null) {
            target = arg;
        } else {
            throw new Error(`Unexpected argument: ${arg}`);
        }
    }
    return {
        targetDir: path.resolve(target || process.cwd()),
        outputDir: output ? path.resolve(output) : null
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
    if (value.includes('.sum')) return 'sum';
    if (value.includes('.max')) return 'max';
    if (value.includes('.min')) return 'min';
    if (value.includes('.avg') || value.includes('.pct') || value.includes('.ratio')) return 'mean';
    if (value.includes('(%)') || value.includes('hit_rate') || value.includes('hit rate') || value.includes('per_warp_active')) return 'mean';
    return 'sum';
}

function findDurationHeader(headers) {
    const exact = ['GPU Duration (ms)', 'GPU Duration', 'Duration (ms)'];
    for (const candidate of exact) {
        const found = headers.find(header => header === candidate);
        if (found) return found;
    }
    return headers.find(header => /gpu duration.*ms|duration \(ms\)/i.test(header)) || null;
}

function findTimeWeightHeader(headers) {
    return findDurationHeader(headers)
        || headers.find(header => header === 'gpu__time_duration.sum')
        || headers.find(header => /gpu__time_duration/i.test(header))
        || null;
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
            const number = normalized === '' ? 0 : Number(normalized);
            if (!Number.isFinite(number)) throw new Error(`${fileName}: row ${i + 1}, ${header}: expected a number`);
            metrics[header] = number;
        });
        counters.set(eid, metrics);
    }

    if (counters.size === 0) throw new Error(`${fileName}: CSV has no valid counter rows`);
    return {
        headers,
        counters,
        counterKinds: Object.fromEntries(headers.map(header => [header, detectCounterKind(header)])),
        durationHeader: findDurationHeader(headers),
        weightHeader: findTimeWeightHeader(headers)
    };
}

function parseEvents(text, fileName) {
    const lines = text.split(/\r?\n/);
    const roots = [];
    const nodes = [];
    const stack = [];
    const separator = lines.findIndex(line => line.trim().startsWith('---'));
    const start = separator >= 0 ? separator + 1 : 0;

    for (let i = start; i < lines.length; i++) {
        const parts = lines[i].split('|');
        if (parts.length < 2) continue;
        const eidText = parts[0].trim();
        if (!/^\d+$/.test(eidText)) continue;
        const match = parts[1].match(/^(\s*)(?:\\)?[-=>]+\s*(.+?)\s*$/);
        if (!match) continue;
        const node = {
            eid: Number(eidText),
            name: match[2],
            actionNumber: parts[2]?.trim() || null,
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
            const part = `${name}#${occurrence}`;
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

function choosePairs(eventsFiles, counterFiles, warnings) {
    if (eventsFiles.length !== counterFiles.length) {
        throw new Error(`Expected the same number of events TXT and counters CSV files; found ${eventsFiles.length} TXT and ${counterFiles.length} CSV`);
    }
    if (eventsFiles.length < 1 || eventsFiles.length > 2) {
        throw new Error(`Expected one or two TXT+CSV pairs; found ${eventsFiles.length} candidate pairs`);
    }
    if (eventsFiles.length === 1) return [[eventsFiles[0], counterFiles[0]]];

    const direct = pairScore(eventsFiles[0], counterFiles[0]) + pairScore(eventsFiles[1], counterFiles[1]);
    const crossed = pairScore(eventsFiles[0], counterFiles[1]) + pairScore(eventsFiles[1], counterFiles[0]);
    if (Math.abs(direct - crossed) < 20) {
        warnings.push('TXT/CSV pairing was ambiguous; files were paired by sorted filename order. Use matching before/after tokens for deterministic pairing.');
    }
    return direct >= crossed
        ? [[eventsFiles[0], counterFiles[0]], [eventsFiles[1], counterFiles[1]]]
        : [[eventsFiles[0], counterFiles[1]], [eventsFiles[1], counterFiles[0]]];
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

function aggregateRows(rows, headers, kinds, weightHeader) {
    const result = {};
    for (const header of headers) {
        const values = rows.map(metrics => metrics[header]).filter(Number.isFinite);
        if (kinds[header] === 'max') {
            result[header] = values.length ? values.reduce((maximum, value) => Math.max(maximum, value), -Infinity) : 0;
            continue;
        }
        if (kinds[header] === 'min') {
            result[header] = values.length ? values.reduce((minimum, value) => Math.min(minimum, value), Infinity) : 0;
            continue;
        }
        let sum = 0;
        let count = 0;
        let weighted = 0;
        let weightSum = 0;
        for (const metrics of rows) {
            const value = metrics[header];
            if (!Number.isFinite(value)) continue;
            sum += value;
            count++;
            const weight = weightHeader ? metrics[weightHeader] : NaN;
            if (Number.isFinite(weight) && weight > 0) {
                weighted += value * weight;
                weightSum += weight;
            }
        }
        if (kinds[header] === 'mean') result[header] = weightSum > 0 ? weighted / weightSum : (count ? sum / count : 0);
        else result[header] = sum;
    }
    return result;
}

function prepareCapture(label, eventsSource, countersSource) {
    const { roots, nodes, captureTitle } = eventsSource.parsed;
    const counterData = countersSource.parsed;
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
        const effectiveRows = rows.length ? rows : (ownMetrics ? [ownMetrics] : []);
        const metrics = effectiveRows.length
            ? aggregateRows(effectiveRows, counterData.headers, counterData.counterKinds, counterData.weightHeader)
            : {};
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
            selfMetrics: node.children.length && ownMetrics ? ownMetrics : undefined
        });
        return effectiveRows;
    };
    roots.forEach(visit);
    records.sort((a, b) => a.order - b.order);

    const durationHeader = counterData.durationHeader;
    const rootKeys = new Set(roots.map(node => node.stableKey));
    const totalDurationMs = durationHeader
        ? records.filter(record => rootKeys.has(record.stableKey)).reduce((sum, record) => sum + (record.metrics[durationHeader] || 0), 0)
        : null;

    return {
        label,
        captureTitle,
        eventsFile: eventsSource.name,
        countersFile: countersSource.name,
        headers: counterData.headers,
        counterKinds: counterData.counterKinds,
        durationHeader,
        weightHeader: counterData.weightHeader,
        records,
        summary: {
            eventCount: nodes.length,
            rootCount: roots.length,
            leafCount: leafEids.length,
            counterRowCount: counterData.counters.size,
            matchedCounterRows: counterData.counters.size - unmatchedCounterEids.length,
            missingLeafCount: missingLeafEids.length,
            unmatchedCounterCount: unmatchedCounterEids.length,
            metricCount: counterData.headers.length,
            totalDurationMs
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
        'Metric objects use sparse-zero encoding: a missing metric key listed in the capture headers means numeric zero; a counter absent from the headers was not exported.',
        ''
    ];
    captures.forEach(capture => {
        lines.push(`## ${capture.label}`, '');
        lines.push(`- Events: ${capture.summary.eventCount}`);
        lines.push(`- Counter rows: ${capture.summary.counterRowCount}`);
        lines.push(`- Metrics: ${capture.summary.metricCount}`);
        if (Number.isFinite(capture.summary.totalDurationMs)) lines.push(`- Aggregated GPU duration: ${capture.summary.totalDurationMs.toFixed(3)} ms`);
        lines.push(`- Sources: ${capture.eventsFile}, ${capture.countersFile}`, '');
    });
    if (warnings.length) {
        lines.push('## Warnings', '');
        warnings.forEach(warning => lines.push(`- ${warning}`));
        lines.push('');
    }
    lines.push('## Investigation', '');
    lines.push('Use the skill query command with a pass or marker name before answering a focused question. Compare more work, more work per item, and less efficient execution. Explain hardware counter names in plain workload terms and state missing evidence explicitly.', '');
    return lines.join('\n');
}

async function readCandidates(targetDir) {
    const entries = await fs.readdir(targetDir, { withFileTypes: true });
    const txt = entries.filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.txt')).sort((a, b) => a.name.localeCompare(b.name));
    const csv = entries.filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.csv')).sort((a, b) => a.name.localeCompare(b.name));
    const eventsFiles = [];
    const counterFiles = [];

    for (const entry of txt) {
        const content = await fs.readFile(path.join(targetDir, entry.name), 'utf8');
        try {
            eventsFiles.push({ name: entry.name, content, parsed: parseEvents(content, entry.name) });
        } catch {
            // Unrelated TXT files are ignored.
        }
    }
    for (const entry of csv) {
        const content = await fs.readFile(path.join(targetDir, entry.name), 'utf8');
        try {
            counterFiles.push({ name: entry.name, content, parsed: parseCounters(content, entry.name) });
        } catch {
            // Unrelated CSV files are ignored.
        }
    }
    return { eventsFiles, counterFiles };
}

async function canReuseCase(reportPath, manifestPath, guidePath, fingerprint) {
    try {
        const [reportStat, manifestStat, guideStat, manifestText] = await Promise.all([
            fs.stat(reportPath),
            fs.stat(manifestPath),
            fs.stat(guidePath),
            fs.readFile(manifestPath, 'utf8')
        ]);
        if (![reportStat, manifestStat, guideStat].every(stat => stat.isFile() && stat.size > 0)) return false;
        const manifest = JSON.parse(manifestText);
        if (manifest.fingerprint !== fingerprint) return false;
        const tailSize = Math.min(reportStat.size, 256);
        const tail = Buffer.alloc(tailSize);
        const handle = await fs.open(reportPath, 'r');
        try {
            await handle.read(tail, 0, tailSize, reportStat.size - tailSize);
        } finally {
            await handle.close();
        }
        return tail.toString('utf8').includes('</html>');
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
    const { eventsFiles, counterFiles } = await readCandidates(targetDir);
    const warnings = [];
    const pairs = choosePairs(eventsFiles, counterFiles, warnings);
    const captures = pairs.map(([eventsFile, countersFile], index) => {
        const label = labelPair(eventsFile, countersFile, index, pairs.length);
        return prepareCapture(label, eventsFile, countersFile);
    });
    captures.sort((a, b) => {
        const rank = label => label === 'before' ? 0 : label === 'after' ? 1 : 2;
        return rank(a.label) - rank(b.label) || a.label.localeCompare(b.label);
    });
    const labelCounts = new Map();
    captures.forEach((capture, index) => {
        const baseLabel = capture.label;
        const occurrence = (labelCounts.get(baseLabel) || 0) + 1;
        labelCounts.set(baseLabel, occurrence);
        if (occurrence > 1) {
            capture.label = `${baseLabel}-${occurrence}`;
            warnings.push(`Duplicate capture label "${baseLabel}" was renamed to "${capture.label}". Use distinct filename tokens to make comparison labels explicit.`);
        }
        capture.fileLabel = safeLabel(capture.label, index);
    });

    captures.forEach(capture => {
        if (capture.summary.missingLeafCount) warnings.push(`${capture.label}: ${capture.summary.missingLeafCount} leaf events have no counter row.`);
        if (capture.summary.unmatchedCounterCount) warnings.push(`${capture.label}: ${capture.summary.unmatchedCounterCount} counter rows do not match an exported event EID.`);
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
    hash.update(template);
    hash.update(catalogText);
    hash.update(analyzerText);
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
        await fs.writeFile(path.join(caseDir, fileName), `${capture.records.map(record => JSON.stringify(record)).join('\n')}\n`, 'utf8');
        captureFiles.push(fileName);
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
            durationHeader: capture.durationHeader,
            summary: capture.summary,
            records: capture.records
        }))
    };
    const payload = JSON.stringify(reportData).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
    const report = template.replace('__REPORT_DATA__', payload);
    if (report === template) throw new Error('Report template is missing __REPORT_DATA__ placeholder');

    const manifest = {
        schemaVersion: SCHEMA_VERSION,
        toolVersion: TOOL_VERSION,
        metricsEncoding: 'sparse-zero-omitted',
        fingerprint,
        generatedAt: reportData.generatedAt,
        sourceDirectory: targetDir,
        report: 'report.html',
        guide: 'model-guide.md',
        captures: captures.map((capture, index) => ({
            label: capture.label,
            eventsFile: capture.eventsFile,
            countersFile: capture.countersFile,
            graphFile: captureFiles[index],
            headers: capture.headers,
            counterKinds: capture.counterKinds,
            durationHeader: capture.durationHeader,
            weightHeader: capture.weightHeader,
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
        warnings
    };

    await Promise.all([
        fs.writeFile(reportPath, report, 'utf8'),
        fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8'),
        fs.writeFile(guidePath, renderGuide(targetDir, caseDir, captures, warnings), 'utf8')
    ]);
    await fs.mkdir(analysisRoot, { recursive: true });
    await fs.writeFile(path.join(analysisRoot, 'latest.json'), `${JSON.stringify({ fingerprint, caseDir }, null, 2)}\n`, 'utf8');
    return { status: 'prepared', targetDir, caseDir, report: reportPath, manifest: manifestPath, guide: guidePath, warnings };
}

async function main() {
    try {
        const args = parseArgs(process.argv.slice(2));
        const result = await prepare(args.targetDir, args.outputDir);
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
