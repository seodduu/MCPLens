import { makeCorrelationKey, makeDeliveryId } from '../../identity.js';
const phaseByEvent = {
    SessionStart: 'session-start',
    PreToolUse: 'tool-before',
    PostToolUse: 'tool-after',
    PostToolUseFailure: 'tool-failure',
    SessionEnd: 'session-end',
};
const isRecord = (value) => (typeof value === 'object' && value !== null && !Array.isArray(value));
const nonEmptyString = (value) => (typeof value === 'string' && value.trim().length > 0 ? value : null);
const supportedEvent = (value) => (typeof value === 'string' && Object.hasOwn(phaseByEvent, value)
    ? value
    : null);
const parseMcpToolName = (value) => {
    if (typeof value !== 'string' || !value.startsWith('mcp__'))
        return null;
    const serverStart = 'mcp__'.length;
    const toolSeparator = value.indexOf('__', serverStart);
    if (toolSeparator < 0)
        return null;
    const serverName = value.slice(serverStart, toolSeparator);
    const toolName = value.slice(toolSeparator + 2);
    return serverName.trim().length > 0 && toolName.trim().length > 0
        ? { serverName, toolName }
        : null;
};
export const decodeClaudeHook = (input, receivedAt) => {
    const payload = isRecord(input) ? input : {};
    const externalSessionId = nonEmptyString(payload.session_id);
    if (externalSessionId === null)
        return { kind: 'invalid', code: 'missing-field' };
    const event = supportedEvent(payload.hook_event_name);
    if (event === null)
        return { kind: 'ignored', reason: 'unsupported-phase' };
    const isToolEvent = event === 'PreToolUse'
        || event === 'PostToolUse'
        || event === 'PostToolUseFailure';
    const parsedTool = isToolEvent ? parseMcpToolName(payload.tool_name) : null;
    if (isToolEvent && parsedTool === null)
        return { kind: 'ignored', reason: 'non-mcp-tool' };
    const phase = phaseByEvent[event];
    const externalCallId = isToolEvent ? nonEmptyString(payload.tool_use_id) : null;
    const durationMs = typeof payload.duration_ms === 'number'
        && Number.isFinite(payload.duration_ms)
        && payload.duration_ms >= 0
        ? payload.duration_ms
        : null;
    const identity = {
        client: 'claude-code',
        externalSessionId,
        externalTurnId: null,
        externalCallId,
        phase,
        toolName: parsedTool?.toolName ?? null,
        inputFingerprint: null,
    };
    const envelope = {
        schemaVersion: 1,
        deliveryId: makeDeliveryId(identity),
        client: 'claude-code',
        phase,
        receivedAt,
        externalSessionId,
        externalTurnId: null,
        externalCallId,
        transcriptPath: typeof payload.transcript_path === 'string' ? payload.transcript_path : null,
        serverName: parsedTool?.serverName ?? null,
        toolName: parsedTool?.toolName ?? null,
        observedAt: receivedAt,
        durationMs,
        isError: event === 'PostToolUse'
            ? false
            : event === 'PostToolUseFailure'
                ? true
                : null,
        inputFingerprint: null,
    };
    return {
        kind: 'observation',
        observation: {
            ...envelope,
            source: 'hook',
            correlationKey: makeCorrelationKey(identity),
            correlationConfidence: externalCallId === null ? 'medium' : 'high',
            responseTokens: null,
            loadedTokens: null,
        },
    };
};
//# sourceMappingURL=decoder.js.map