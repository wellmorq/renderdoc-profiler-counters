import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCHEMA_VERSION = 3;
const METRICS_ENCODING = 'sparse-zero-omitted';

function durationScaleToMs(header) {
    const match = String(header || '').trim().match(/^(?:GPU )?Duration\s*\((s|ms|us|µs|μs|ns)\)$/i);
    if (!match) return null;
    const unit = match[1].toLowerCase().replace(/[µμ]/g, 'u');
    if (unit === 's') return 1000;
    if (unit === 'ms') return 1;
    if (unit === 'us') return 0.001;
    if (unit === 'ns') return 0.000001;
    return null;
}

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
    try {
        return (await fs.stat(file)).isFile();
    } catch (error) {
        if (error.code === 'ENOENT') return false;
        throw error;
    }
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
    const lines = text.split(/\r?\n/);
    if (lines.at(-1) === '') lines.pop();
    if (lines.some(line => line.trim() === '')) throw new Error(`${file}: empty NDJSON line is not allowed`);
    return lines.map((line, index) => {
        try {
            return JSON.parse(line);
        } catch (error) {
            throw new Error(`${file}:${index + 1}: ${error.message}`);
        }
    });
}

function hasOwn(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
}

function metricValue(record, header) {
    if (!isMeasured(record)) return null;
    if (!hasOwn(record.metrics, header)) return 0;
    const value = record.metrics[header];
    return value === null ? null : (Number.isFinite(value) ? value : null);
}

function aggregationMethod(record, header) {
    return record.aggregation.method || record.aggregation.methods[header];
}

function validateArtifactDescriptor(descriptor, expectedFile, label, requireRecordCount = false) {
    if (!descriptor || descriptor.file !== expectedFile || path.basename(descriptor.file) !== descriptor.file) {
        throw new Error(`${label}: invalid artifact file descriptor`);
    }
    if (!Number.isInteger(descriptor.sizeBytes) || descriptor.sizeBytes <= 0 || !/^[a-f0-9]{64}$/.test(descriptor.sha256 || '')) {
        throw new Error(`${label}: invalid artifact size or SHA-256 descriptor`);
    }
    if (requireRecordCount && (!Number.isInteger(descriptor.recordCount) || descriptor.recordCount < 1)) {
        throw new Error(`${label}: invalid artifact recordCount`);
    }
}

async function verifyArtifact(caseDir, descriptor, expectedFile, label, expectedRecordCount = null) {
    validateArtifactDescriptor(descriptor, expectedFile, label, expectedRecordCount !== null);
    const content = await fs.readFile(path.join(caseDir, descriptor.file));
    if (content.length !== descriptor.sizeBytes) throw new Error(`${label}: artifact size does not match manifest`);
    const sha256 = createHash('sha256').update(content).digest('hex');
    if (sha256 !== descriptor.sha256) throw new Error(`${label}: artifact SHA-256 does not match manifest`);
    if (expectedRecordCount === null) return null;
    if (descriptor.recordCount !== expectedRecordCount) throw new Error(`${label}: artifact recordCount does not match manifest summary`);
    const records = await readNdjson(path.join(caseDir, descriptor.file));
    if (records.length !== expectedRecordCount) throw new Error(`${label}: NDJSON record count does not match manifest summary`);
    return records;
}

function validateGraph(records, capture, label) {
    const expectedCount = capture.summary?.eventCount;
    if (!Number.isInteger(expectedCount) || expectedCount < 1 || records.length !== expectedCount) {
        throw new Error(`${label}: graph record count does not match capture summary`);
    }
    const headers = new Set(capture.headers);
    const byKey = new Map();
    const orders = new Set();
    const eids = new Set();
    records.forEach((record, index) => {
        if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error(`${label}: record ${index + 1} is not an object`);
        if (!Number.isInteger(record.eid) || record.eid < 0 || eids.has(record.eid)) throw new Error(`${label}: record ${index + 1} has an invalid or duplicate EID`);
        eids.add(record.eid);
        if (typeof record.stableKey !== 'string' || !record.stableKey || byKey.has(record.stableKey)) throw new Error(`${label}: record ${index + 1} has an invalid or duplicate stableKey`);
        byKey.set(record.stableKey, record);
        if (typeof record.name !== 'string' || typeof record.path !== 'string') throw new Error(`${label}: record ${index + 1} has invalid name/path`);
        if (record.parentKey !== null && typeof record.parentKey !== 'string') throw new Error(`${label}: record ${index + 1} has an invalid parentKey`);
        if (!Number.isInteger(record.depth) || record.depth < 0 || !Number.isInteger(record.order) || record.order < 0 || orders.has(record.order)) throw new Error(`${label}: record ${index + 1} has invalid or duplicate depth/order`);
        orders.add(record.order);
        if (!Number.isInteger(record.childCount) || record.childCount < 0 || !Number.isInteger(record.counterRowCount) || record.counterRowCount < 0) throw new Error(`${label}: record ${index + 1} has invalid child/counter row counts`);
        if (record.scope !== (record.childCount ? 'descendants' : 'self')) throw new Error(`${label}: record ${index + 1} has inconsistent scope`);
        if (!record.aggregation || !Number.isInteger(record.aggregation.rowCount) || record.aggregation.rowCount !== record.counterRowCount) throw new Error(`${label}: record ${index + 1} has invalid aggregation provenance`);
        if (record.counterRowCount === 0) {
            if (record.aggregation.source !== 'unavailable' || record.aggregation.method !== 'unavailable-no-rows' || record.aggregation.methods !== undefined) throw new Error(`${label}: unmeasured record ${index + 1} has invalid aggregation provenance`);
        } else if (record.scope === 'self') {
            if (record.counterRowCount !== 1 || record.aggregation.source !== 'self-row' || record.aggregation.method !== 'raw-self' || record.aggregation.methods !== undefined) throw new Error(`${label}: self record ${index + 1} has invalid aggregation provenance`);
        } else {
            if (record.aggregation.source !== 'descendant-rows' || record.aggregation.method !== undefined || !record.aggregation.methods || typeof record.aggregation.methods !== 'object' || Array.isArray(record.aggregation.methods)) throw new Error(`${label}: parent record ${index + 1} has invalid aggregation provenance`);
            const aggregationEntries = Object.entries(record.aggregation.methods);
            if (aggregationEntries.length !== headers.size) throw new Error(`${label}: record ${index + 1} is missing aggregation methods`);
            aggregationEntries.forEach(([header, method]) => {
                if (!headers.has(header) || typeof method !== 'string' || !method) throw new Error(`${label}: record ${index + 1} has invalid aggregation method metadata`);
            });
        }
        if (!record.metrics || typeof record.metrics !== 'object' || Array.isArray(record.metrics)) throw new Error(`${label}: record ${index + 1} has invalid metrics`);
        if (record.counterRowCount === 0 && Object.keys(record.metrics).length) throw new Error(`${label}: unmeasured record ${index + 1} contains metrics`);
        Object.entries(record.metrics).forEach(([header, value]) => {
            if (!headers.has(header)) throw new Error(`${label}: record ${index + 1} contains a metric not listed in headers`);
            if (value !== null && !Number.isFinite(value)) throw new Error(`${label}: record ${index + 1} contains a non-finite metric`);
            if (header === capture.durationHeader && (!Number.isFinite(value) || value < 0)) throw new Error(`${label}: record ${index + 1} contains an invalid duration metric`);
        });
        if (record.selfMetrics !== undefined) {
            if (!record.selfMetrics || typeof record.selfMetrics !== 'object' || Array.isArray(record.selfMetrics)) throw new Error(`${label}: record ${index + 1} has invalid selfMetrics`);
            Object.entries(record.selfMetrics).forEach(([header, value]) => {
                if (!headers.has(header) || !Number.isFinite(value)) throw new Error(`${label}: record ${index + 1} has invalid selfMetrics`);
                if (header === capture.durationHeader && value < 0) throw new Error(`${label}: record ${index + 1} contains an invalid self duration metric`);
            });
        }
    });
    const childCounts = new Map();
    records.forEach(record => {
        if (record.parentKey !== null) {
            const parent = byKey.get(record.parentKey);
            if (!parent || parent.stableKey === record.stableKey) throw new Error(`${label}: record ${record.stableKey} references a missing or self parent`);
            if (record.depth !== parent.depth + 1) throw new Error(`${label}: record ${record.stableKey} has inconsistent depth`);
            childCounts.set(record.parentKey, (childCounts.get(record.parentKey) || 0) + 1);
        } else if (record.depth !== 0) {
            throw new Error(`${label}: root record ${record.stableKey} has non-zero depth`);
        }
    });
    records.forEach(record => {
        if ((childCounts.get(record.stableKey) || 0) !== record.childCount) throw new Error(`${label}: childCount mismatch for ${record.stableKey}`);
        const seen = new Set();
        let parentKey = record.parentKey;
        while (parentKey !== null) {
            if (seen.has(parentKey)) throw new Error(`${label}: parent cycle involving ${record.stableKey}`);
            seen.add(parentKey);
            parentKey = byKey.get(parentKey).parentKey;
        }
    });
}

async function validateCase(caseDir, manifest) {
    if (manifest.schemaVersion !== SCHEMA_VERSION) throw new Error(`Unsupported case schema ${manifest.schemaVersion}; re-run prepare.mjs to rebuild schema ${SCHEMA_VERSION}`);
    if (manifest.metricsEncoding !== METRICS_ENCODING) throw new Error(`Unsupported metrics encoding; expected ${METRICS_ENCODING}`);
    if (manifest.metricAvailability !== 'counterRowCount-zero-means-unmeasured') throw new Error('Unsupported metric availability contract');
    if (typeof manifest.report !== 'string' || path.basename(manifest.report) !== manifest.report || typeof manifest.guide !== 'string' || path.basename(manifest.guide) !== manifest.guide) throw new Error('Manifest must declare exact report and guide artifact names');
    if (!Array.isArray(manifest.warnings) || manifest.warnings.some(warning => typeof warning !== 'string')) throw new Error('Manifest has invalid warnings metadata');
    if (!Array.isArray(manifest.captures) || manifest.captures.length < 1 || manifest.captures.length > 2) throw new Error('Manifest must contain one or two captures');
    const artifacts = manifest.artifacts;
    if (!artifacts || !Array.isArray(artifacts.graphs) || artifacts.graphs.length !== manifest.captures.length) throw new Error('Manifest is missing graph artifact descriptors');
    await verifyArtifact(caseDir, artifacts.report, manifest.report, 'report');
    await verifyArtifact(caseDir, artifacts.guide, manifest.guide, 'guide');
    const graphRecords = [];
    for (let index = 0; index < manifest.captures.length; index++) {
        const capture = manifest.captures[index];
        if (!capture || !Array.isArray(capture.headers) || capture.headers.some(header => typeof header !== 'string' || !header) || new Set(capture.headers).size !== capture.headers.length) throw new Error(`Capture ${index + 1}: invalid headers`);
        const durationHeaders = capture.headers.filter(header => durationScaleToMs(header) !== null);
        if (durationHeaders.length !== 1 || capture.durationHeader !== durationHeaders[0]) throw new Error(`Capture ${index + 1}: manifest must contain exactly one explicit GPU/Duration header`);
        const expectedScale = durationScaleToMs(capture.durationHeader);
        if (capture.durationToMs !== expectedScale || capture.weightHeader !== capture.durationHeader) throw new Error(`Capture ${index + 1}: invalid duration scale or mean weight header`);
        if (!capture.counterKinds || capture.headers.some(header => !['sum', 'max', 'min', 'mean', 'unknown'].includes(capture.counterKinds[header]))) throw new Error(`Capture ${index + 1}: invalid counter kind metadata`);
        if (capture.counterKinds[capture.durationHeader] !== 'sum') throw new Error(`Capture ${index + 1}: duration counter must be additive`);
        const summary = capture.summary;
        const validRootSummary = Number.isInteger(summary?.rootCount) && summary.rootCount >= 1
            && Number.isInteger(summary.measuredRootCount) && summary.measuredRootCount >= 0
            && Number.isInteger(summary.unmeasuredRootCount) && summary.unmeasuredRootCount >= 0
            && summary.measuredRootCount + summary.unmeasuredRootCount === summary.rootCount;
        const validTotal = summary?.measuredRootCount === 0
            ? summary.totalDurationMs === null
            : Number.isFinite(summary?.totalDurationMs) && summary.totalDurationMs >= 0;
        if (!summary || !Number.isInteger(summary.eventCount) || summary.eventCount < 1 || !validRootSummary || !Number.isInteger(summary.counterRowCount) || summary.counterRowCount < 0 || !Number.isInteger(summary.missingLeafCount) || summary.missingLeafCount < 0 || !Number.isInteger(summary.metricCount) || summary.metricCount !== capture.headers.length || !validTotal) throw new Error(`Capture ${index + 1}: invalid summary`);
        const descriptor = artifacts.graphs[index];
        if (descriptor.file !== capture.graphFile) throw new Error(`Capture ${index + 1}: graph artifact does not match capture graphFile`);
        const records = await verifyArtifact(caseDir, descriptor, capture.graphFile, `capture ${index + 1} graph`, capture.summary.eventCount);
        validateGraph(records, capture, `capture ${index + 1} graph`);
        graphRecords.push(records);
    }
    return graphRecords;
}

function isMeasured(record) {
    return Boolean(record && record.counterRowCount > 0);
}

function durationMetricValue(record, capture) {
    if (!isMeasured(record) || !capture.durationHeader) return null;
    const raw = metricValue(record, capture.durationHeader);
    return Number.isFinite(raw) && Number.isFinite(capture.durationToMs)
        ? raw * capture.durationToMs
        : null;
}

function compareDurationDescending(a, b, capture) {
    const aDuration = durationMetricValue(a, capture);
    const bDuration = durationMetricValue(b, capture);
    if (aDuration === null) return bDuration === null ? a.order - b.order : 1;
    if (bDuration === null) return -1;
    return bDuration - aDuration || a.order - b.order;
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
    const captureDuration = capture.summary.totalDurationMs;
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
                    exportedHeaders.has(header) ? metricValue(record, header) : null
                ])),
                childCount: record.childCount,
                shownChildCount: relativeDepth >= depth ? null : 0
            };
            nodes.push(node);
            if (relativeDepth >= depth) return;
            const children = childrenByParent.get(record.stableKey) || [];
            const shownChildren = top === null
                ? children
                : [...children].sort((a, b) => compareDurationDescending(a, b, capture)).slice(0, top);
            node.shownChildCount = shownChildren.length;
            for (const child of shownChildren) {
                visit(child, relativeDepth + 1, duration);
            }
        };
        const actualParent = root.parentKey ? byKey.get(root.parentKey) : null;
        visit(root, 0, actualParent ? durationMetricValue(actualParent, capture) : null);
        return { rootKey: root.stableKey, nodes };
    });
}

function aggregate(records, capture) {
    const result = {};
    const meanMethods = {};
    const measuredRecords = records.filter(isMeasured);
    for (const header of capture.headers) {
        if (!measuredRecords.length) {
            result[header] = null;
            if (capture.counterKinds[header] === 'mean') meanMethods[header] = 'unavailable-no-measured-rows';
            continue;
        }
        const values = measuredRecords.map(record => metricValue(record, header));
        if (capture.counterKinds[header] === 'unknown') {
            result[header] = measuredRecords.length === 1 && Number.isFinite(values[0]) ? values[0] : null;
            if (measuredRecords.length > 1) meanMethods[header] = 'unavailable-unknown-kind';
            continue;
        }
        if (capture.counterKinds[header] === 'max') {
            const finiteValues = values.filter(Number.isFinite);
            result[header] = finiteValues.length ? finiteValues.reduce((maximum, value) => Math.max(maximum, value), -Infinity) : null;
            continue;
        }
        if (capture.counterKinds[header] === 'min') {
            const finiteValues = values.filter(Number.isFinite);
            result[header] = finiteValues.length ? finiteValues.reduce((minimum, value) => Math.min(minimum, value), Infinity) : null;
            continue;
        }
        if (capture.counterKinds[header] !== 'mean') {
            result[header] = values.every(Number.isFinite) ? values.reduce((sum, value) => sum + value, 0) : null;
            continue;
        }
        if (measuredRecords.length === 1) {
            result[header] = Number.isFinite(values[0]) ? values[0] : null;
            meanMethods[header] = aggregationMethod(measuredRecords[0], header);
            continue;
        }
        const weightedRows = measuredRecords.map((record, index) => ({ value: values[index], weight: durationMetricValue(record, capture) }));
        const weightsAreValid = weightedRows.every(row => Number.isFinite(row.weight) && row.weight >= 0 && (row.weight === 0 || Number.isFinite(row.value)));
        if (weightsAreValid && weightedRows.some(row => row.weight > 0)) {
            const weightSum = weightedRows.reduce((sum, row) => sum + row.weight, 0);
            result[header] = weightedRows.reduce((sum, row) => sum + (row.weight > 0 ? row.value * row.weight : 0), 0) / weightSum;
            meanMethods[header] = weightedRows.every(row => row.weight > 0) ? 'duration-weighted' : 'duration-weighted-partial';
        } else {
            result[header] = null;
            meanMethods[header] = 'unavailable-no-positive-duration';
        }
    }
    return { metrics: result, meanMethods };
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
    const durationValue = capture.durationHeader && Number.isFinite(metrics[capture.durationHeader]) && Number.isFinite(capture.durationToMs)
        ? metrics[capture.durationHeader] * capture.durationToMs
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
    const invocationSignals = ['vsInvocations', 'psInvocations', 'csInvocations'].map(key => signals[key]);
    const invocationCount = invocationSignals.every(signal => signal && Number.isFinite(signal.value))
        ? invocationSignals.reduce((sum, signal) => sum + signal.value, 0)
        : null;
    const isAggregate = signal => signal && capture.counterKinds[signal.header] === 'sum';
    const dramBytes = isAggregate(signals.dramRead) && isAggregate(signals.dramWrite)
        && Number.isFinite(signals.dramRead.value) && Number.isFinite(signals.dramWrite.value)
        ? signals.dramRead.value + signals.dramWrite.value
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
        const value = metricValue(record, header);
        return formatNumber(value);
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
        if (estimatedHeaders.length) {
            lines.push('Mean counters are raw for one contributing row and duration-weighted for multiple rows. If no positive GPU-duration weight exists, the aggregate is unavailable; arithmetic and counter-row fallbacks are not used.', '');
            const unavailableMeans = estimatedHeaders.filter(header => String(capture.aggregateMeanMethods?.[header] || '').startsWith('unavailable'));
            if (unavailableMeans.length) lines.push(`Unavailable mean aggregates: ${unavailableMeans.join(', ')}.`, '');
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
    const graphRecords = await validateCase(caseDir, manifest);
    const selectedMetricHeaders = resolveMetricSelectors(manifest.captures, metricSelectors);
    const warnings = [...manifest.warnings];
    const captures = [];
    const focusedKeySets = [];
    for (let index = 0; index < manifest.captures.length; index++) {
        const capture = manifest.captures[index];
        const records = graphRecords[index];
        const allMatches = findFrontier(records, query).sort((a, b) => compareDurationDescending(a, b, capture));
        const measuredMatches = allMatches.filter(isMeasured);
        focusedKeySets.push(new Set(allMatches.map(record => record.stableKey)));
        const unmeasuredMatchCount = allMatches.length - measuredMatches.length;
        const matches = top === null ? allMatches : allMatches.slice(0, top);
        const aggregateResult = aggregate(allMatches, capture);
        const metrics = aggregateResult.metrics;
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
            aggregateMeanMethods: aggregateResult.meanMethods,
            aggregateMeanIsEstimate: Object.values(aggregateResult.meanMethods).some(method => method !== 'raw-self')
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
