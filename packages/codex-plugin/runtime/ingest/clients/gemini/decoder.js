import path from 'node:path';
const splitFlattenedName = (name) => {
    const match = /^mcp_(.+)$/.exec(name);
    if (!match) return null;
    const rest = match[1];
    const separator = rest.indexOf('_');
    if (separator === -1) return { server: rest, tool: rest };
    return { server: rest.slice(0, separator), tool: rest.slice(separator + 1) };
};
import { makeCorrelationKey, makeDeliveryId } from '../../identity.js';
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const usableString = (value) => typeof value === 'string' && value.length > 0;
function toolIdentity(input) {
    if (isObject(input.mcp_context)) {
        const serverName = input.mcp_context.server_name;
        const toolName = input.mcp_context.tool_name;
        if (usableString(serverName) && usableString(toolName))
            return { serverName, toolName };
    }
    if (!usableString(input.tool_name))
        return null;
    const split = splitFlattenedName(input.tool_name);
    return split == null ? null : { serverName: split.server, toolName: split.tool };
}
export const decodeGeminiHook = (input, receivedAt) => {
    if (!isObject(input))
        return { kind: 'invalid', code: 'invalid-json' };
    if (!usableString(input.session_id) ||
        !usableString(input.hook_event_name) ||
        !usableString(input.timestamp) ||
        typeof input.transcript_path !== 'string') {
        return { kind: 'invalid', code: 'missing-field' };
    }
    if (input.transcript_path !== '' && !path.isAbsolute(input.transcript_path)) {
        return { kind: 'invalid', code: 'unsafe-transcript-path' };
    }
    let phase;
    let serverName = null;
    let toolName = null;
    let isError = null;
    switch (input.hook_event_name) {
        case 'SessionStart':
            if (!usableString(input.source))
                return { kind: 'invalid', code: 'missing-field' };
            phase = 'session-start';
            break;
        case 'BeforeTool': {
            if (!isObject(input.tool_input) || !usableString(input.tool_name)) {
                return { kind: 'invalid', code: 'missing-field' };
            }
            const identity = toolIdentity(input);
            if (identity == null)
                return { kind: 'ignored', reason: 'non-mcp-tool' };
            phase = 'tool-before';
            serverName = identity.serverName;
            toolName = identity.toolName;
            break;
        }
        case 'AfterTool': {
            if (!isObject(input.tool_input) ||
                !isObject(input.tool_response) ||
                !usableString(input.tool_name)) {
                return { kind: 'invalid', code: 'missing-field' };
            }
            const identity = toolIdentity(input);
            if (identity == null)
                return { kind: 'ignored', reason: 'non-mcp-tool' };
            const failed = input.tool_response.error != null;
            phase = failed ? 'tool-failure' : 'tool-after';
            serverName = identity.serverName;
            toolName = identity.toolName;
            isError = failed;
            break;
        }
        case 'SessionEnd':
            if (!usableString(input.reason))
                return { kind: 'invalid', code: 'missing-field' };
            phase = 'session-end';
            break;
        default:
            return { kind: 'ignored', reason: 'unsupported-phase' };
    }
    const envelope = {
        schemaVersion: 1,
        deliveryId: '',
        client: 'gemini-cli',
        phase,
        receivedAt,
        externalSessionId: input.session_id,
        externalTurnId: null,
        externalCallId: null,
        transcriptPath: input.transcript_path === '' ? null : input.transcript_path,
        serverName,
        toolName,
        observedAt: input.timestamp,
        durationMs: null,
        isError,
        inputFingerprint: null,
    };
    const identity = {
        client: envelope.client,
        externalSessionId: envelope.externalSessionId,
        externalTurnId: envelope.externalTurnId,
        externalCallId: envelope.externalCallId,
        phase: envelope.phase,
        toolName: envelope.toolName,
        inputFingerprint: envelope.inputFingerprint,
    };
    envelope.deliveryId = makeDeliveryId(identity);
    return {
        kind: 'observation',
        observation: {
            ...envelope,
            source: 'hook',
            correlationKey: makeCorrelationKey(identity),
            correlationConfidence: 'low',
            responseTokens: null,
            loadedTokens: null,
        },
    };
};
//# sourceMappingURL=decoder.js.map