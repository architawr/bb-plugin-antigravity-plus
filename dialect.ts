import {
  experimental_registerAcpDialect,
  type AcpDialect,
  type AcpToolCallUpdateEvent,
  type AcpToolIdentity,
  type AcpToolKind,
} from "@get-bb/plugin-sdk/provider-bridge/acp";

export type AcpToolUpdateEvent = AcpToolCallUpdateEvent;

export interface AcpDialectToolIdentity {
  name?: string;
  kind?: AcpToolKind;
}

export interface DialectPresentationBadge {
  label: string;
  tone: "destructive" | "neutral";
  glyph?: string;
  hint?: string;
}

export interface DialectPresentation {
  label: {
    pending: string;
    completed: string;
  };
  icon: {
    glyph: string;
  };
  title?: string;
  subtitle?: string;
  detail?: string;
  badge?: {
    glyph: string;
    label: string;
    hint: string;
    tone: "destructive" | "neutral";
  };
  badges?: DialectPresentationBadge[];
}

const PRESENTATION_DETAIL_MAX_LENGTH = 280;

function truncatePresentationDetail(text: string): string {
  return text.length > PRESENTATION_DETAIL_MAX_LENGTH
    ? `${text.slice(0, PRESENTATION_DETAIL_MAX_LENGTH - 3)}...`
    : text;
}

export type AcpDialectToolClassification =
  | {
      kind: "command";
      presentation: DialectPresentation;
      item?: Record<string, unknown>;
    }
  | {
      kind: "delegation";
      label: string;
      detail?: string | null;
      background: boolean;
      childRef?: string;
      presentation: DialectPresentation;
      item?: Record<string, unknown>;
    }
  | {
      kind: "tool_use";
      tool: string;
      detail?: string | null;
      presentation: DialectPresentation;
      item?: Record<string, unknown>;
    };

export const ANTIGRAVITY_ACP_DIALECT_ID = "antigravity-plus";

export const CANONICAL_ANTIGRAVITY_TOOLS: ReadonlySet<string> = new Set([
  // Execution
  "run_command",
  // File reading
  "read_file",
  "view_file",
  "view_file_outline",
  "view_code_item",
  "list_dir",
  "list_resources",
  "read_resource",
  // File editing
  "write_file",
  "edit_file",
  "replace_file_content",
  "multi_replace_file_content",
  // Search
  "grep_search",
  "code_search",
  "find_by_name",
  // Web / Fetch
  "search_web",
  "read_url_content",
  // Subagents
  "invoke_subagent",
  "define_subagent",
  "manage_subagents",
  "send_message",
  // Swarm
  "swarm",
  "post_message",
  "read_board",
  "swarm_wait",
  // Background tasks & scheduling
  "manage_task",
  "schedule",
  // User interaction
  "ask_question",
]);

// Configuration
let commandDescriptionsEnabled = true;

export function getCommandDescriptionsEnabled(): boolean {
  return commandDescriptionsEnabled;
}

export function setCommandDescriptionsEnabled(enabled: boolean): void {
  commandDescriptionsEnabled = enabled;
}

export function applyThreadCommandDescriptions(
  line: string,
  enabledByThread: ReadonlyMap<string, boolean>
): string {
  let message: any;
  try {
    message = JSON.parse(line);
  } catch {
    return line;
  }

  return applyThreadCommandDescriptionMessage(message, enabledByThread) ? JSON.stringify(message) : line;
}

export function applyThreadCommandDescriptionMessage(
  message: any,
  enabledByThread: ReadonlyMap<string, boolean>,
): boolean {
  const params = message?.params;
  if (
    message?.method !== "thread/delta" ||
    typeof params?.threadId !== "string" ||
    !Array.isArray(params.deltas)
  ) {
    return false;
  }

  const enabled = enabledByThread.get(params.threadId) ?? getCommandDescriptionsEnabled();
  let modified = false;

  for (const delta of params.deltas) {
    if (delta?.item?.type === "command" && delta?.presentation && typeof delta.presentation === "object") {
      if (
        !enabled &&
        typeof delta.item.command === "string" &&
        delta.item.command.length > 0 &&
        (delta.presentation.subtitle === delta.item.command ||
          delta.presentation.detail === truncatePresentationDetail(delta.item.command))
      ) {
        delta.presentation.title = delta.item.command;
        delete delta.presentation.subtitle;
        delete delta.presentation.detail;
        modified = true;
      }
    }
  }

  return modified;
}

export function extractEventOutputText(event: { content?: unknown; rawOutput?: unknown }): string {
  const parts: string[] = [];
  function collect(val: unknown) {
    if (typeof val === "string") {
      parts.push(val);
    } else if (Array.isArray(val)) {
      for (const item of val) collect(item);
    } else if (val && typeof val === "object") {
      const obj = val as Record<string, unknown>;
      if (typeof obj.text === "string") parts.push(obj.text);
      if (typeof obj.output === "string") parts.push(obj.output);
      if (typeof obj.content === "string") parts.push(obj.content);
      if (typeof obj.stdout === "string") parts.push(obj.stdout);
      if (typeof obj.stderr === "string") parts.push(obj.stderr);
      if (obj.content && typeof obj.content === "object" && obj.content !== null) {
        collect(obj.content);
      }
    }
  }
  if (event.content !== undefined) collect(event.content);
  if (event.rawOutput !== undefined) collect(event.rawOutput);
  return parts.join("\n");
}

// Event hook & deduplication
type ToolUpdateListener = (event: AcpToolUpdateEvent) => void;
const toolUpdateListeners = new Set<ToolUpdateListener>();
const lastNotifiedSteps = new Map<string, { stepKey: string; hasInput: boolean; hasTitle: boolean; outputText: string }>();
const normalizedExitCodes = new WeakMap< object, number >();

export function onToolUpdate(listener: ToolUpdateListener): () => void {
  toolUpdateListeners.add(listener);
  return () => {
    toolUpdateListeners.delete(listener);
  };
}

export function setToolUpdateListener(listener: ToolUpdateListener | null): void {
  toolUpdateListeners.clear();
  if (listener) {
    toolUpdateListeners.add(listener);
  }
}

function notifyToolUpdate(event: AcpToolUpdateEvent): void {
  if (toolUpdateListeners.size === 0) return;
  const toolCallId = event.toolCallId;
  const status = event.status ?? "";
  const stepKey = `${toolCallId}:${status}`;
  const hasInput = Boolean(event.rawInput && typeof event.rawInput === "object" && Object.keys(event.rawInput).length > 0);
  const hasTitle = typeof event.title === "string" && event.title.length > 0;
  const outputText = extractEventOutputText(event);

  if (toolCallId) {
    const prev = lastNotifiedSteps.get(toolCallId);
    if (
      prev &&
      prev.stepKey === stepKey &&
      (prev.hasInput || !hasInput) &&
      (prev.hasTitle || !hasTitle) &&
      prev.outputText === outputText
    ) {
      return;
    }
    if (lastNotifiedSteps.size > 1000) {
      lastNotifiedSteps.clear();
    }
    lastNotifiedSteps.set(toolCallId, {
      stepKey,
      hasInput: Boolean(prev?.hasInput || hasInput),
      hasTitle: Boolean(prev?.hasTitle || hasTitle),
      outputText,
    });
  }

  for (const listener of toolUpdateListeners) {
    try {
      listener(event);
    } catch {
      // Ignore listener failures
    }
  }
}

// Tool name inference
function normalizeToolCandidate(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().toLowerCase();
  if (CANONICAL_ANTIGRAVITY_TOOLS.has(trimmed)) {
    return trimmed;
  }
  const underscored = trimmed.replace(/\s+/g, "_");
  if (CANONICAL_ANTIGRAVITY_TOOLS.has(underscored)) {
    return underscored;
  }
  return null;
}

export function inferAntigravityToolName(event: AcpToolUpdateEvent): string | null {
  if (!event || typeof event !== "object") return null;

  // 1. Check event._meta
  const meta = (event as Record<string, unknown>)._meta;
  if (meta && typeof meta === "object") {
    const metaObj = meta as Record<string, unknown>;
    const metaName =
      normalizeToolCandidate(metaObj.tool) ??
      normalizeToolCandidate(metaObj.name) ??
      normalizeToolCandidate(metaObj.toolName) ??
      normalizeToolCandidate(metaObj.tool_name) ??
      (metaObj["x.ai/tool"] && typeof metaObj["x.ai/tool"] === "object"
        ? normalizeToolCandidate((metaObj["x.ai/tool"] as Record<string, unknown>).name)
        : null);
    if (metaName) return metaName;
  }

  // Check event.name if present
  if (typeof event.name === "string") {
    const directName = normalizeToolCandidate(event.name);
    if (directName) return directName;
  }

  // Check event.title
  if (typeof event.title === "string") {
    const directTitle = normalizeToolCandidate(event.title);
    if (directTitle) return directTitle;

    // Check prefix before colon (e.g. "run_command: npm test" or "read_file: /path")
    const colonIndex = event.title.indexOf(":");
    if (colonIndex > 0) {
      const prefix = normalizeToolCandidate(event.title.slice(0, colonIndex));
      if (prefix) return prefix;
    }
  }

  // 2. Structural inference from event.rawInput
  const rawInput = event.rawInput as Record<string, unknown> | undefined;
  if (rawInput && typeof rawInput === "object" && !Array.isArray(rawInput)) {
    // Has CommandLine (string) -> "run_command"
    if (typeof rawInput.CommandLine === "string" || typeof rawInput.command === "string") {
      return "run_command";
    }

    // Has TypeName and Prompt (and Role) -> "invoke_subagent"
    if (typeof rawInput.TypeName === "string" && typeof rawInput.Prompt === "string") {
      return "invoke_subagent";
    }

    // Has SystemPrompt and Name and Description -> "define_subagent"
    if (
      typeof rawInput.SystemPrompt === "string" &&
      typeof rawInput.Name === "string" &&
      typeof rawInput.Description === "string"
    ) {
      return "define_subagent";
    }

    // Has Action and (ConversationIds or Action === "kill_all") -> "manage_subagents"
    if (
      typeof rawInput.Action === "string" &&
      (Array.isArray(rawInput.ConversationIds) || rawInput.Action === "kill_all")
    ) {
      return "manage_subagents";
    }

    // Has Recipient and Message -> "send_message"
    if (typeof rawInput.Recipient === "string" && typeof rawInput.Message === "string") {
      return "send_message";
    }

    // Has Action and (TaskId or Input or ["list", "kill", "status", "send_input"].includes(Action)) -> "manage_task"
    if (
      typeof rawInput.Action === "string" &&
      (typeof rawInput.TaskId === "string" ||
        rawInput.Input !== undefined ||
        ["list", "kill", "status", "send_input"].includes(rawInput.Action))
    ) {
      return "manage_task";
    }

    // Has Prompt and (DurationSeconds or CronExpression) -> "schedule"
    if (
      typeof rawInput.Prompt === "string" &&
      (typeof rawInput.DurationSeconds === "number" || typeof rawInput.CronExpression === "string")
    ) {
      return "schedule";
    }

    // Has questions (array) -> "ask_question"
    if (Array.isArray(rawInput.questions)) {
      return "ask_question";
    }

    // Has Path and (Target or Replacement) -> "edit_file"
    if (
      typeof rawInput.Path === "string" &&
      (rawInput.Target !== undefined || rawInput.Replacement !== undefined)
    ) {
      return "edit_file";
    }

    // Has Path and Content -> "write_file"
    if (typeof rawInput.Path === "string" && rawInput.Content !== undefined) {
      return "write_file";
    }

    // Has Path and (StartLine or EndLine or ByteOffset or event.kind === "read") -> "read_file"
    if (
      typeof rawInput.Path === "string" &&
      (rawInput.StartLine !== undefined ||
        rawInput.EndLine !== undefined ||
        rawInput.ByteOffset !== undefined ||
        event.kind === "read")
    ) {
      return "read_file";
    }
  }

  return null;
}

export function mapAntigravityToolKind(toolName: string | null, fallbackKind?: AcpToolKind): AcpToolKind {
  if (!toolName) return fallbackKind ?? "other";
  switch (toolName) {
    case "run_command":
      return "execute";
    case "read_file":
    case "view_file":
    case "view_file_outline":
    case "view_code_item":
    case "list_dir":
    case "list_resources":
    case "read_resource":
      return "read";
    case "write_file":
    case "edit_file":
    case "replace_file_content":
    case "multi_replace_file_content":
      return "edit";
    case "grep_search":
    case "code_search":
    case "find_by_name":
      return "search";
    case "search_web":
    case "read_url_content":
      return "fetch";
    default:
      return fallbackKind ?? "other";
  }
}

export function toolIdentity(event: AcpToolUpdateEvent): AcpDialectToolIdentity | null {
  notifyToolUpdate(event);
  const toolName = inferAntigravityToolName(event);
  if (toolName) {
    return {
      name: toolName,
      kind: mapAntigravityToolKind(toolName, event.kind as AcpToolKind),
    };
  }
  if (typeof event.name === "string" && event.name.trim()) {
    return {
      name: event.name.trim(),
      kind: mapAntigravityToolKind(event.name.trim(), event.kind as AcpToolKind),
    };
  }
  if (event.kind) {
    return {
      kind: event.kind as AcpToolKind,
    };
  }
  return null;
}

// Output and exit code parsing
const BACKGROUND_TASK_ID_LINE = /^(?:Tool is running as a background task with task id|Background command ID):[ \t]*([A-Za-z0-9][A-Za-z0-9._:/-]{0,199})[ \t]*$/;
const WRAPPER_TIMESTAMP_LINE = /^(?:Created|Completed) At:[ \t]*\d{4}-\d{2}-\d{2}T\S+[ \t]*$/;
export function normalizeFileUri(value: string): string {
  return value.trim().replace(/^file:\/\/\/([A-Za-z]:\/)/i, '$1').replace(/^file:\/\/\//i, '/');
}
export function structuredCommandExitCode(rawOutput: unknown): number | null {
  if (!rawOutput || typeof rawOutput !== "object") return null;
  for (const key of ["exit_code", "exitCode"]) {
    const value: unknown = Reflect.get(rawOutput, key);
    if (typeof value === "number") return value;
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  }
  return null;
}

const SAFE_OUTPUT_FILE_PATH = /^(?:file:\/\/\/|\/|[A-Za-z]:[\\/])[^\r\n"'`<>|?*]+$/;

export function parseBackgroundCommandOutput(
  event: { rawOutput?: unknown },
  text: string,
): { taskId: string; description?: string; outputFile?: string } | null {
  if (structuredCommandExitCode(event.rawOutput) !== null) return null;
  const lines = text.split(/\r?\n/);
  let index = 0;
  while (index < lines.length) {
    const trimmed = lines[index].trim();
    if (!trimmed || WRAPPER_TIMESTAMP_LINE.test(trimmed)) {
      index += 1;
      continue;
    }
    break;
  }
  if (index >= lines.length) return null;
  const idMatch = BACKGROUND_TASK_ID_LINE.exec(lines[index].trim());
  if (!idMatch) return null;
  const taskId = idMatch[1];
  let description: string | undefined;
  let outputFile: string | undefined;
  for (let i = index + 1; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (!trimmed || /^Log output:/i.test(trimmed)) break;
    if (!description) {
      const descMatch = /^Task Description:[ \t]*([^\r\n]+)$/.exec(trimmed);
      if (descMatch) {
        description = descMatch[1].trim();
        continue;
      }
    }
    if (!outputFile) {
      const fileMatch = /^Task logs are available at:[ \t]*([^\r\n]+)$/.exec(trimmed);
      if (fileMatch) {
        const candidate = fileMatch[1].trim();
        if (SAFE_OUTPUT_FILE_PATH.test(candidate)) outputFile = normalizeFileUri(candidate);
      }
    }
  }
  return {
    taskId,
    ...(description ? { description } : {}),
    ...(outputFile ? { outputFile } : {}),
  };
}

export function parseAntigravityCommandOutput(rawText: string): {
  cleanOutput: string;
  exitCode: number | null;
  isBackgrounded: boolean;
  backgroundTaskId: string | null;
} {
  if (typeof rawText !== "string") {
    return { cleanOutput: "", exitCode: null, isBackgrounded: false, backgroundTaskId: null };
  }

  const backgroundTaskId = parseBackgroundCommandOutput({}, rawText)?.taskId ?? null;

  // Diagnostic headers (e.g. "There were sandbox errors...") carry the reason a
  // command failed, and are often the only information when the output section
  // is empty. Extract them before header stripping so they survive normalization.
  const diagnosticLines: string[] = [];
  const body = rawText.replace(/^There were sandbox errors[^\r\n]*(?:\r?\n)?/gm, (line) => {
    diagnosticLines.push(line.replace(/\r?\n$/, ""));
    return "";
  });

  // Strict check for Antigravity wrapper header before "Command output:\n" or "Output:\n"
  const headerSplitMatch = body.match(
    /^(?:(?:Created At:[^\r\n]*|Completed At:[^\r\n]*|(?:The c|C)ommand exited with code -?\d+\b[^\r\n]*|The user changed the command to be run to:[^\r\n]*|This command includes call\(s\) to[^\r\n]*|[ \t]*)\r?\n)*(?:Command output|Output):\r?\n/i
  );
  const exitCodeMatch = (headerSplitMatch?.[0] ?? rawText).match(/^(?:The c|C)ommand exited with code (-?\d+)\b\.?/m);
  const exitCode = exitCodeMatch ? parseInt(exitCodeMatch[1], 10) : null;

  let cleanOutput: string;
  if (headerSplitMatch) {
    cleanOutput = body.slice(headerSplitMatch[0].length);
  } else {
    cleanOutput = body
      .replace(/^Created At:[^\r\n]*(?:\r?\n)?/gm, "")
      .replace(/^Completed At:[^\r\n]*(?:\r?\n)?/gm, "")
      .replace(/^(?:The c|C)ommand exited with code -?\d+\b\.?[^\r\n]*(?:\r?\n)?/gm, "")
      .replace(/^\r?\n+/, "");
  }

  // A failed command must never normalize to an empty string: when the output
  // section is empty, surface the diagnostic text (or the exit-code line it came
  // from) so the failure reason reaches BB and the model.
  if (cleanOutput.trim() === "" && (diagnosticLines.length > 0 || (exitCode !== null && exitCode !== 0))) {
    cleanOutput =
      diagnosticLines.length > 0
        ? diagnosticLines.join("\n")
        : exitCodeMatch?.[0].trim() ?? "";
  } else if (diagnosticLines.length > 0) {
    cleanOutput = `${diagnosticLines.join("\n")}\n${cleanOutput}`;
  }

  return {
    cleanOutput,
    exitCode,
    isBackgrounded: backgroundTaskId !== null,
    backgroundTaskId,
  };
}

// Normalization & Command Result
export function normalizeCommandEvent(event: AcpToolUpdateEvent): AcpToolUpdateEvent {
  if (!event || typeof event !== "object") return event;

  let normalized: AcpToolUpdateEvent = { ...event };
  const rawInput = event.rawInput as Record<string, unknown> | undefined;

  if (rawInput && typeof rawInput === "object" && !Array.isArray(rawInput)) {
    const updatedInput = { ...rawInput };
    if (typeof updatedInput.CommandLine === "string" && !updatedInput.command) {
      updatedInput.command = updatedInput.CommandLine;
    }
    normalized.rawInput = updatedInput;

    const cmd =
      typeof updatedInput.CommandLine === "string"
        ? updatedInput.CommandLine
        : typeof updatedInput.command === "string"
          ? updatedInput.command
          : undefined;

    if (cmd && (!normalized.title || normalized.title.trim().toLowerCase() === "run_command")) {
      normalized.title = cmd;
    }
  }

  // Normalize rawOutput if string or object
  let detectedExitCode: number | null = null;
  if (typeof normalized.rawOutput === "string") {
    const parsed = parseAntigravityCommandOutput(normalized.rawOutput);
    if (parsed.exitCode !== null) detectedExitCode = parsed.exitCode;
    normalized.rawOutput = parsed.cleanOutput;
  } else if (normalized.rawOutput && typeof normalized.rawOutput === "object") {
    const obj = { ...(normalized.rawOutput as Record<string, unknown>) };
    if (typeof obj.output === "string") {
      const parsed = parseAntigravityCommandOutput(obj.output);
      if (parsed.exitCode !== null) detectedExitCode = parsed.exitCode;
      obj.output = parsed.cleanOutput;
    }
    if (typeof obj.stdout === "string") {
      const parsed = parseAntigravityCommandOutput(obj.stdout);
      if (parsed.exitCode !== null) detectedExitCode = parsed.exitCode;
      obj.stdout = parsed.cleanOutput;
    }
    normalized.rawOutput = obj;
  }

  // Normalize content blocks if present
  if (Array.isArray(normalized.content)) {
    normalized.content = normalized.content.map((block: any) => {
      if (!block || typeof block !== "object") return block;
      if (block.type === "content" && block.content && typeof block.content === "object" && typeof block.content.text === "string") {
        const parsed = parseAntigravityCommandOutput(block.content.text);
        if (parsed.exitCode !== null) detectedExitCode = parsed.exitCode;
        return {
          ...block,
          content: {
            ...block.content,
            text: parsed.cleanOutput,
          },
        };
      }
      if (block.type === "text" && typeof block.text === "string") {
        const parsed = parseAntigravityCommandOutput(block.text);
        if (parsed.exitCode !== null) detectedExitCode = parsed.exitCode;
        return {
          ...block,
          text: parsed.cleanOutput,
        };
      }
      return block;
    });
  }

  if (detectedExitCode !== null) {
    normalizedExitCodes.set(normalized, detectedExitCode);
  }

  return normalized;
}

export function commandResult(event: AcpToolUpdateEvent): { exitCode?: number | null } | null {
  if (!event || typeof event !== "object") return null;

  const cachedExitCode = normalizedExitCodes.get(event);
  if (cachedExitCode !== undefined) {
    return { exitCode: cachedExitCode };
  }

  if (event.rawOutput && typeof event.rawOutput === "object") {
    const raw = event.rawOutput as Record<string, unknown>;
    const code =
      typeof raw.exitCode === "number"
        ? raw.exitCode
        : typeof raw.exit_code === "number"
          ? raw.exit_code
          : null;
    if (code !== null) {
      return { exitCode: code };
    }
  }

  const outputText = extractEventOutputText(event);
  if (outputText) {
    const parsed = parseAntigravityCommandOutput(outputText);
    if (parsed.exitCode !== null) {
      return { exitCode: parsed.exitCode };
    }
  }

  return null;
}

// Tool Classification
export function classifyToolCall(event: AcpToolUpdateEvent): AcpDialectToolClassification | null {
  notifyToolUpdate(event);
  const toolName = inferAntigravityToolName(event);
  if (!toolName) return null;

  const rawInput = (event.rawInput && typeof event.rawInput === "object" && !Array.isArray(event.rawInput)
    ? (event.rawInput as Record<string, unknown>)
    : {}) as Record<string, unknown>;

  switch (toolName) {
    case "run_command": {
      const commandLine =
        typeof rawInput.CommandLine === "string"
          ? rawInput.CommandLine
          : typeof rawInput.command === "string"
            ? rawInput.command
            : undefined;
      const toolSummary =
        typeof rawInput.toolSummary === "string"
          ? rawInput.toolSummary
          : typeof rawInput.description === "string"
            ? rawInput.description
            : undefined;
      const bypassSandbox = rawInput.BypassSandbox === true;

      const outputText = extractEventOutputText(event);
      const isBackgrounded = parseBackgroundCommandOutput(event, outputText) !== null;

      const useToolSummary =
        getCommandDescriptionsEnabled() &&
        typeof toolSummary === "string" &&
        toolSummary.trim().length > 0 &&
        toolSummary.trim() !== commandLine?.trim();

      const presentation: DialectPresentation = {
        label: {
          pending: "Running command",
          completed: isBackgrounded ? "Started background command" : "Ran command",
        },
        icon: { glyph: "Terminal" },
        ...(useToolSummary
          ? {
              title: toolSummary!.trim(),
              ...(commandLine
                ? {
                    detail: truncatePresentationDetail(commandLine),
                    subtitle: commandLine,
                  }
                : {}),
            }
          : {
              title: commandLine || event.title || "Command",
            }),
        ...(bypassSandbox
          ? {
              badge: {
                glyph: "ShieldAlert",
                label: "Outside of sandbox",
                hint: "Command runs outside the sandbox",
                tone: "destructive",
              },
              badges: [{ label: "Outside of sandbox", tone: "destructive" }],
            }
          : {}),
      };

      return {
        kind: "command",
        presentation,
        item: {
          type: "command",
          command: commandLine ?? "",
          cwd: "",
        },
      };
    }

    case "invoke_subagent": {
      const role =
        typeof rawInput.Role === "string" && rawInput.Role.trim() ? rawInput.Role.trim() : undefined;
      const typeName =
        typeof rawInput.TypeName === "string" && rawInput.TypeName.trim()
          ? rawInput.TypeName.trim()
          : undefined;
      const model =
        typeof rawInput.Model === "string" && rawInput.Model.trim() ? rawInput.Model.trim() : undefined;
      const workspace =
        typeof rawInput.Workspace === "string" && rawInput.Workspace.trim()
          ? rawInput.Workspace.trim()
          : undefined;
      const prompt =
        typeof rawInput.Prompt === "string" && rawInput.Prompt.trim()
          ? rawInput.Prompt.trim()
          : undefined;

      const outputText = extractEventOutputText(event);
      const convMatch =
        outputText.match(/"conversationId"\s*:\s*"([^"]+)"/) ??
        (/\bSubagent spawned\b/i.test(outputText)
          ? outputText.match(/\bconversationId:[ \t]*([^\s,]+)/i)
          : null);
      const conversationId =
        convMatch?.[1] ??
        (event.rawOutput && typeof event.rawOutput === "object" && typeof (event.rawOutput as Record<string, unknown>).conversationId === "string"
          ? ((event.rawOutput as Record<string, unknown>).conversationId as string)
          : undefined);

      const label = role || typeName || "Subagent";

      const parts: string[] = [];
      if (role && typeName && typeName !== role) {
        parts.push(typeName);
      }
      if (model && model !== "inherit") {
        parts.push(model);
      }
      if (workspace && workspace !== "inherit") {
        parts.push(workspace);
      }
      const detailParts =
        parts.length > 0
          ? parts.join(" · ")
          : (prompt ? (prompt.length > 120 ? `${prompt.slice(0, 117)}...` : prompt) : null);

      const presentation: DialectPresentation = {
        label: { pending: "Running subagent", completed: "Subagent launched" },
        icon: { glyph: "Bot" },
        title: label,
        ...(detailParts
          ? {
              detail: truncatePresentationDetail(detailParts),
              subtitle: detailParts,
            }
          : {}),
      };

      return {
        kind: "delegation",
        label,
        detail: detailParts || null,
        background: true,
        ...(conversationId ? { childRef: conversationId } : {}),
        presentation,
        item: {
          type: "delegation",
          childRef: conversationId ?? event.toolCallId,
          label,
          summary: detailParts || undefined,
          background: true,
        },
      };
    }

    case "define_subagent": {
      const name =
        typeof rawInput.Name === "string" && rawInput.Name.trim() ? rawInput.Name.trim() : undefined;
      const description =
        typeof rawInput.Description === "string" && rawInput.Description.trim()
          ? rawInput.Description.trim()
          : undefined;

      const presentation: DialectPresentation = {
        label: { pending: "Defining subagent", completed: "Defined subagent" },
        icon: { glyph: "Bot" },
        title: name ? `Define subagent ${name}` : "Define subagent",
        ...(description
          ? {
              detail: truncatePresentationDetail(description),
              subtitle: description,
            }
          : {}),
      };

      return {
        kind: "tool_use",
        tool: "define_subagent",
        detail: description || name || null,
        presentation,
        item: {
          type: "tool",
          tool: "define_subagent",
          args: event.rawInput,
        },
      };
    }

    case "manage_subagents": {
      const action =
        typeof rawInput.Action === "string" ? rawInput.Action.trim() : undefined;
      const ids = Array.isArray(rawInput.ConversationIds)
        ? rawInput.ConversationIds.filter((x): x is string => typeof x === "string" && x.trim().length > 0).join(", ")
        : undefined;

      let pending = "Managing subagents";
      let completed = "Managed subagents";
      if (action === "list") {
        pending = "Listing subagents";
        completed = "Listed subagents";
      } else if (action === "kill" || action === "kill_all") {
        pending = "Stopping subagents";
        completed = "Stopped subagents";
      }

      const presentation: DialectPresentation = {
        label: { pending, completed },
        icon: { glyph: "Bot" },
        title:
          action === "list"
            ? "List subagents"
            : action === "kill" || action === "kill_all"
              ? "Stop subagents"
              : "Manage subagents",
        ...(ids
          ? {
              detail: truncatePresentationDetail(ids),
              subtitle: ids,
            }
          : {}),
      };

      return {
        kind: "tool_use",
        tool: "manage_subagents",
        detail: ids || action || null,
        presentation,
        item: {
          type: "tool",
          tool: "manage_subagents",
          args: event.rawInput,
        },
      };
    }

    case "send_message": {
      const recipient =
        typeof rawInput.Recipient === "string" && rawInput.Recipient.trim()
          ? rawInput.Recipient.trim()
          : undefined;
      const message =
        typeof rawInput.Message === "string" && rawInput.Message.trim()
          ? rawInput.Message.trim()
          : undefined;

      const presentation: DialectPresentation = {
        label: { pending: "Messaging subagent", completed: "Messaged subagent" },
        icon: { glyph: "Bot" },
        title: recipient ? `Message ${recipient}` : "Message subagent",
        ...(message
          ? {
              detail: truncatePresentationDetail(message.slice(0, 120)),
              subtitle: message.slice(0, 120),
            }
          : {}),
      };

      return {
        kind: "tool_use",
        tool: "send_message",
        detail: recipient || null,
        presentation,
        item: {
          type: "tool",
          tool: "send_message",
          args: event.rawInput,
        },
      };
    }

    case "manage_task": {
      const action =
        typeof rawInput.Action === "string" ? rawInput.Action.trim() : undefined;
      const taskId =
        typeof rawInput.TaskId === "string" && rawInput.TaskId.trim()
          ? rawInput.TaskId.trim()
          : undefined;

      let pending = "Managing background task";
      let completed = "Managed background task";
      if (action === "list") {
        pending = "Listing background tasks";
        completed = "Listed background tasks";
      } else if (action === "status") {
        pending = "Checking background task";
        completed = "Checked background task";
      } else if (action === "kill") {
        pending = "Stopping background task";
        completed = "Stopped background task";
      } else if (action === "send_input") {
        pending = "Sending input to task";
        completed = "Sent input to task";
      }

      const presentation: DialectPresentation = {
        label: { pending, completed },
        icon: { glyph: "Terminal" },
        title: taskId
          ? `${action || "Task"}: ${taskId}`
          : action
            ? `Task ${action}`
            : "Manage task",
      };

      return {
        kind: "tool_use",
        tool: "manage_task",
        detail: taskId || action || null,
        presentation,
        item: {
          type: "tool",
          tool: "manage_task",
          args: event.rawInput,
        },
      };
    }

    case "schedule": {
      const duration =
        typeof rawInput.DurationSeconds === "number" ? rawInput.DurationSeconds : undefined;
      const cron =
        typeof rawInput.CronExpression === "string" && rawInput.CronExpression.trim()
          ? rawInput.CronExpression.trim()
          : undefined;
      const prompt =
        typeof rawInput.Prompt === "string" && rawInput.Prompt.trim()
          ? rawInput.Prompt.trim()
          : undefined;

      const scheduleDesc =
        typeof cron === "string"
          ? `cron: ${cron}`
          : typeof duration === "number"
            ? `${duration}s timer`
            : undefined;

      const presentation: DialectPresentation = {
        label: { pending: "Scheduling task", completed: "Scheduled task" },
        icon: { glyph: "Clock" },
        title: scheduleDesc ? `Schedule (${scheduleDesc})` : "Schedule task",
        ...(prompt
          ? {
              detail: truncatePresentationDetail(prompt.slice(0, 120)),
              subtitle: prompt.slice(0, 120),
            }
          : {}),
      };

      return {
        kind: "tool_use",
        tool: "schedule",
        detail: scheduleDesc || prompt || null,
        presentation,
        item: {
          type: "tool",
          tool: "schedule",
          args: event.rawInput,
        },
      };
    }

    case "ask_question": {
      const presentation: DialectPresentation = {
        label: { pending: "Asking question", completed: "Asked question" },
        icon: { glyph: "HelpCircle" },
        title: "Ask question",
      };

      return {
        kind: "tool_use",
        tool: "ask_question",
        presentation,
        item: {
          type: "tool",
          tool: "ask_question",
          args: event.rawInput,
        },
      };
    }

    case "swarm": {
      const action =
        typeof rawInput.action === "string" && rawInput.action.trim()
          ? rawInput.action.trim().toLowerCase()
          : undefined;
      const name =
        typeof rawInput.name === "string" && rawInput.name.trim() ? rawInput.name.trim() : undefined;
      const titleText =
        typeof rawInput.title === "string" && rawInput.title.trim() ? rawInput.title.trim() : undefined;
      const model =
        typeof rawInput.model === "string" && rawInput.model.trim() ? rawInput.model.trim() : undefined;
      const workspace =
        typeof rawInput.workspace === "string" && rawInput.workspace.trim()
          ? rawInput.workspace.trim()
          : undefined;
      const brief =
        typeof rawInput.brief === "string" && rawInput.brief.trim() ? rawInput.brief.trim() : undefined;
      const count = typeof rawInput.n === "number" && Number.isFinite(rawInput.n) ? rawInput.n : undefined;
      const tasksCount = Array.isArray(rawInput.tasks) ? rawInput.tasks.length : undefined;

      let pending = "Updating swarm";
      let completed = "Updated swarm";
      let cardTitle = "Swarm";
      let detailParts: string | undefined;
      let glyph = "Users";

      if (action === "title") {
        pending = "Naming swarm";
        completed = "Named swarm";
        cardTitle = titleText ?? "Name swarm";
      } else if (action === "add") {
        pending = "Adding swarm worker";
        completed = "Added swarm worker";
        glyph = "Bot";
        const shardCount = tasksCount ?? (count && count > 1 ? count : undefined);
        cardTitle = name
          ? shardCount
            ? `${name} (${shardCount} workers)`
            : name
          : "Add swarm worker";
        const meta: string[] = [];
        if (model) meta.push(model);
        if (workspace && workspace !== "inherit") meta.push(workspace);
        if (brief) meta.push(brief.slice(0, 140));
        if (meta.length > 0) detailParts = meta.join(" · ");
      } else if (action === "kill") {
        pending = "Stopping swarm worker";
        completed = "Stopped swarm worker";
        glyph = "Bot";
        cardTitle = name ? `Stop ${name}` : "Stop swarm worker";
      } else if (action === "status") {
        pending = "Checking swarm status";
        completed = "Checked swarm status";
        cardTitle = "Swarm status";
      } else if (action === "models") {
        pending = "Listing swarm models";
        completed = "Listed swarm models";
        cardTitle = "Swarm models";
      } else if (action === "model") {
        pending = "Switching swarm model";
        completed = "Switched swarm model";
        glyph = "Bot";
        cardTitle = name && model ? `${name} -> ${model}` : model ? `Switch model to ${model}` : "Switch swarm model";
      } else if (action) {
        cardTitle = `Swarm ${action}`;
      }

      const presentation: DialectPresentation = {
        label: { pending, completed },
        icon: { glyph },
        title: cardTitle,
        ...(detailParts
          ? {
              detail: truncatePresentationDetail(detailParts),
              subtitle: detailParts,
            }
          : {}),
      };

      return {
        kind: "tool_use",
        tool: "swarm",
        detail: detailParts ?? cardTitle,
        presentation,
        item: {
          type: "tool",
          tool: "swarm",
          args: event.rawInput,
        },
      };
    }

    case "post_message": {
      const text =
        typeof rawInput.text === "string" && rawInput.text.trim()
          ? rawInput.text.trim()
          : typeof rawInput.message === "string" && rawInput.message.trim()
            ? rawInput.message.trim()
            : undefined;
      const channel =
        typeof rawInput.channel === "string" && rawInput.channel.trim()
          ? rawInput.channel.trim()
          : undefined;
      const firstLine = text ? text.split(/\r?\n/, 1)[0].trim() : undefined;
      const cardTitle = firstLine
        ? firstLine.length > 88
          ? `${firstLine.slice(0, 85)}...`
          : firstLine
        : channel
          ? `Post to #${channel}`
          : "Post to swarm board";

      const presentation: DialectPresentation = {
        label: { pending: "Posting to swarm board", completed: "Posted to swarm board" },
        icon: { glyph: "MessageSquare" },
        title: cardTitle,
        ...(text && text !== firstLine
          ? {
              detail: truncatePresentationDetail(text),
              subtitle: text.slice(0, 140),
            }
          : {}),
      };

      return {
        kind: "tool_use",
        tool: "post_message",
        detail: text ? truncatePresentationDetail(text) : channel ?? null,
        presentation,
        item: {
          type: "tool",
          tool: "post_message",
          args: event.rawInput,
        },
      };
    }

    case "read_board": {
      const sinceSeq =
        typeof rawInput.since_seq === "number" && Number.isInteger(rawInput.since_seq)
          ? rawInput.since_seq
          : undefined;
      const channel =
        typeof rawInput.channel === "string" && rawInput.channel.trim()
          ? rawInput.channel.trim()
          : undefined;
      const suffixParts: string[] = [];
      if (channel) suffixParts.push(`#${channel}`);
      if (sinceSeq !== undefined) suffixParts.push(`since #${sinceSeq}`);
      const cardTitle = suffixParts.length > 0 ? `Read swarm board (${suffixParts.join(", ")})` : "Read swarm board";

      const presentation: DialectPresentation = {
        label: { pending: "Reading swarm board", completed: "Read swarm board" },
        icon: { glyph: "MessageSquare" },
        title: cardTitle,
      };

      return {
        kind: "tool_use",
        tool: "read_board",
        detail: suffixParts.length > 0 ? suffixParts.join(", ") : null,
        presentation,
        item: {
          type: "tool",
          tool: "read_board",
          args: event.rawInput,
        },
      };
    }

    case "swarm_wait": {
      const presentation: DialectPresentation = {
        label: { pending: "Waiting on swarm board", completed: "Resumed from swarm board" },
        icon: { glyph: "Clock" },
        title: "Wait for swarm updates",
      };

      return {
        kind: "tool_use",
        tool: "swarm_wait",
        presentation,
        item: {
          type: "tool",
          tool: "swarm_wait",
          args: event.rawInput,
        },
      };
    }

    default:
      return null;
  }
}

// Dialect registration
export const antigravityAcpDialect: AcpDialect = {
  id: ANTIGRAVITY_ACP_DIALECT_ID,
  toolIdentity: ((event: AcpToolUpdateEvent) => toolIdentity(event) ?? undefined) as any,
  classifyToolCall: ((event: AcpToolUpdateEvent) => classifyToolCall(event) ?? undefined) as any,
  normalizeCommandEvent,
  commandResult: ((event: AcpToolUpdateEvent) => {
    const res = commandResult(event);
    if (!res) return undefined;
    const text = extractEventOutputText(event);
    const clean = text ? parseAntigravityCommandOutput(text).cleanOutput : undefined;
    return {
      ...res,
      ...(clean ? { output: clean } : {}),
    };
  }) as any,
};

let dialectRegistered = false;

export function registerAntigravityAcpDialect(): AcpDialect {
  if (!dialectRegistered) {
    try {
      experimental_registerAcpDialect(antigravityAcpDialect);
    } catch {
      // Idempotent: catch in case already registered in this or parent context
    }
    dialectRegistered = true;
  }
  return antigravityAcpDialect;
}
