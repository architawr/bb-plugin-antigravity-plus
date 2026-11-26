import { useEffect, useMemo, useRef, useState } from "react";
import {
  Markdown,
  definePluginApp,
  experimental_useAppPanel,
  experimental_useRpcQuery,
  experimental_useTabVisible,
  useSettings,
  type ExperimentalThreadContextSegmentInput,
  type ExperimentalThreadContextSegmentProps,
  type ExperimentalThreadTabProps,
} from "@get-bb/plugin-sdk/app";
import {
  swarmRpcContract,
  swarmMentionPattern,
  type SwarmMember,
  type SwarmMessage,
} from "./swarm-contract.ts";

const POLL_INTERVAL_MS = 2500;
const RECENT_SWARM_AUTO_OPEN_WINDOW_MS = 2 * 60 * 1000;
const autoOpenedSwarms = new Set<string>();

function SwarmGlyph({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <circle cx="8" cy="3.5" r="2" />
      <circle cx="3.5" cy="12" r="2" />
      <circle cx="12.5" cy="12" r="2" />
      <path d="M6.9 5.2 4.6 10.2M9.1 5.2l2.3 5M5.5 12h5" />
    </svg>
  );
}

function RefreshGlyph({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M13.5 8a5.5 5.5 0 1 1-1.4-3.7" />
      <path d="M13.5 3v2.8h-2.8" />
    </svg>
  );
}

function isRecentSwarm(createdAt: string | null): boolean {
  if (!createdAt) return false;
  const parsed = Date.parse(createdAt);
  if (!Number.isFinite(parsed)) return false;
  return Date.now() - parsed <= RECENT_SWARM_AUTO_OPEN_WINDOW_MS;
}

function useSwarmTabVisible({ threadId }: ExperimentalThreadTabProps): boolean {
  const { values } = useSettings();
  const panel = experimental_useAppPanel();
  const query = experimental_useRpcQuery({
    contract: swarmRpcContract,
    method: "getSwarmBoard",
    input: { threadId },
  });

  const hasData = query.data !== undefined;
  const exists = Boolean(query.data?.exists);
  const swarmId = query.data?.swarmId ?? query.data?.providerThreadId ?? null;
  const createdAt = query.data?.createdAt ?? null;
  const autoOpenEnabled = values?.autoOpenSwarmBoard !== false;

  const prevStateRef = useRef<{ threadId: string; exists: boolean } | null>(null);

  useEffect(() => {
    if (!hasData) return;

    const prev = prevStateRef.current;
    const transitionedToLive = prev !== null && prev.threadId === threadId && !prev.exists && exists;
    prevStateRef.current = { threadId, exists };

    if (!exists || !autoOpenEnabled) return;
    const key = `${threadId}:${swarmId ?? "default"}`;
    if (autoOpenedSwarms.has(key)) return;

    if (!transitionedToLive && !isRecentSwarm(createdAt)) {
      return;
    }

    try {
      const opened = panel.openTab({
        tab: { id: "swarm", context: { kind: "thread" }, availability: "fixed" },
      });
      if (opened) {
        autoOpenedSwarms.add(key);
      }
    } catch {
      // Ignore surfaces without a side panel.
    }
  }, [autoOpenEnabled, createdAt, exists, hasData, panel, swarmId, threadId]);

  return exists;
}

function memberStatusLabel(member: SwarmMember): string {
  if (member.killed) return "stopped";
  const phase = member.phase.toLowerCase();
  if (phase === "running") return "active";
  if (phase === "waiting" || phase === "idle") return phase;
  return phase || "active";
}

function memberStatusTone(member: SwarmMember): string {
  if (member.killed) return "bg-muted-foreground/40";
  const phase = member.phase.toLowerCase();
  if (phase === "running") return "bg-emerald-500";
  if (phase === "waiting") return "bg-amber-500";
  return "bg-muted-foreground/60";
}

function classifyMessageTag(message: SwarmMessage): { label: string; tone: string } | null {
  if (message.kind === "brief") {
    return { label: "brief", tone: "bg-accent text-accent-foreground border-border" };
  }
  if (/\[done\]/i.test(message.text)) {
    return { label: "done", tone: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30" };
  }
  if (/\bblocked\b/i.test(message.text)) {
    return { label: "blocked", tone: "bg-destructive/15 text-destructive border-destructive/30" };
  }
  return null;
}

function formatShortTime(time: string | null): string | null {
  if (!time) return null;
  const match = time.match(/(\d{2}:\d{2}:\d{2})/);
  return match ? match[1] : time;
}

function SwarmBoardTab({ threadId }: ExperimentalThreadTabProps) {
  const isVisible = experimental_useTabVisible();
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [newestFirst, setNewestFirst] = useState(false);

  const query = experimental_useRpcQuery({
    contract: swarmRpcContract,
    method: "getSwarmBoard",
    input: { threadId },
  });

  const refetchRef = useRef(query.refetch);
  refetchRef.current = query.refetch;

  useEffect(() => {
    setSelectedAgent(null);
  }, [threadId]);

  useEffect(() => {
    if (!isVisible) return;
    void refetchRef.current();
    const timer = window.setInterval(() => {
      void refetchRef.current();
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [isVisible, threadId]);

  const data = query.data;
  const activeMembers = useMemo(
    () => (data?.members ?? []).filter((member) => !member.killed),
    [data?.members],
  );

  const visibleMessages = useMemo(() => {
    const raw = data?.messages ?? [];
    const mention = selectedAgent ? swarmMentionPattern(selectedAgent) : null;
    const filtered = mention
      ? raw.filter((msg) => msg.agent === selectedAgent || mention.test(msg.text))
      : raw;
    return newestFirst ? [...filtered].reverse() : filtered;
  }, [data?.messages, selectedAgent, newestFirst]);

  if (query.isLoading && !data) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-xs text-muted-foreground">
        Loading swarm board...
      </div>
    );
  }

  if (!data || !data.exists) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-xs text-muted-foreground">
        <SwarmGlyph className="h-5 w-5 opacity-60" />
        <p className="font-medium text-foreground">No active swarm on this thread</p>
        <p className="max-w-xs">
          Start a swarm with <code className="rounded bg-muted px-1 py-0.5 text-[11px]">/swarm</code> to inspect its roster and message board here.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      {/* Header */}
      <div className="flex items-start justify-between gap-2 border-b border-border px-3 py-2.5">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <SwarmGlyph className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <h2 className="truncate text-xs font-semibold text-foreground">
              {data.title ?? "Swarm Board"}
            </h2>
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
            <span>
              {activeMembers.length} active{data.members.length > activeMembers.length ? ` / ${data.members.length} total` : ""}
            </span>
            <span>·</span>
            <span>{data.totalMessages} {data.totalMessages === 1 ? "post" : "posts"}</span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => setNewestFirst((prev) => !prev)}
            className="rounded border border-border bg-card px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            title={newestFirst ? "Show oldest posts first" : "Show newest posts first"}
          >
            {newestFirst ? "Newest" : "Oldest"}
          </button>
          <button
            type="button"
            onClick={() => void query.refetch()}
            disabled={query.isFetching}
            className="inline-flex items-center gap-1 rounded border border-border bg-card px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
            title="Refresh swarm board"
          >
            <RefreshGlyph className={`h-3 w-3 ${query.isFetching ? "animate-spin" : ""}`} />
            <span>Refresh</span>
          </button>
        </div>
      </div>

      {/* Scrollable body */}
      <div className="flex-1 space-y-3 overflow-y-auto p-3">
        {/* Optional coordinator plan.json overview */}
        {data.plan && (
          <section className="rounded-md border border-border bg-card p-2.5">
            {data.plan.goalTitle && (
              <div className="text-xs font-semibold text-foreground">{data.plan.goalTitle}</div>
            )}
            {data.plan.goalLine && (
              <p className="mt-0.5 text-[11px] text-muted-foreground">{data.plan.goalLine}</p>
            )}
            {data.plan.threads.length > 0 && (
              <div className="mt-2 space-y-1.5">
                {data.plan.threads.map((group) => (
                  <div key={group.id} className="rounded border border-border/70 bg-background/60 px-2 py-1.5">
                    <div className="text-[11px] font-medium text-foreground">{group.title}</div>
                    {group.goal && (
                      <div className="text-[11px] text-muted-foreground">{group.goal}</div>
                    )}
                    {group.tasks.length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {group.tasks.map((taskAgent) => (
                          <span
                            key={taskAgent}
                            className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
                            title={data.plan?.tasks[taskAgent]}
                          >
                            @{taskAgent}
                            {data.plan?.tasks[taskAgent] ? ` · ${data.plan.tasks[taskAgent]}` : ""}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>
        )}

        {/* Roster */}
        {data.members.length > 0 && (
          <section className="space-y-1.5">
            <div className="flex items-center justify-between text-[11px] font-medium text-muted-foreground">
              <span>Roster</span>
              {selectedAgent && (
                <button
                  type="button"
                  onClick={() => setSelectedAgent(null)}
                  className="text-[11px] text-foreground underline underline-offset-2"
                >
                  Clear filter (@{selectedAgent})
                </button>
              )}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {data.members.map((member) => {
                const isSelected = selectedAgent === member.name;
                return (
                  <button
                    key={member.name}
                    type="button"
                    onClick={() => setSelectedAgent(isSelected ? null : member.name)}
                    className={`flex items-center gap-1.5 rounded-md border px-2 py-1 text-left text-[11px] transition-colors ${
                      isSelected
                        ? "border-foreground/40 bg-accent text-foreground"
                        : "border-border bg-card text-foreground hover:bg-accent/60"
                    } ${member.killed ? "opacity-60" : ""}`}
                    title={[
                      `${member.name} (${member.role})`,
                      `status: ${memberStatusLabel(member)}`,
                      member.model ? `model: ${member.model}` : null,
                      member.workspaceMode && member.workspaceMode !== "inherit"
                        ? `workspace: ${member.workspaceMode}`
                        : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  >
                    <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${memberStatusTone(member)}`} />
                    <span className="font-medium">@{member.name}</span>
                    {member.role === "coordinator" && (
                      <span className="rounded bg-muted px-1 py-0.2 text-[10px] text-muted-foreground">
                        coord
                      </span>
                    )}
                    {member.workspaceMode && member.workspaceMode !== "inherit" && (
                      <span className="rounded bg-muted px-1 py-0.2 text-[10px] text-muted-foreground">
                        {member.workspaceMode}
                      </span>
                    )}
                    {member.model && (
                      <span className="max-w-[110px] truncate text-[10px] text-muted-foreground">
                        {member.model}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </section>
        )}

        {/* Board feed */}
        <section className="space-y-2">
          <div className="flex items-center justify-between text-[11px] font-medium text-muted-foreground">
            <span>Board</span>
            {data.truncated && (
              <span className="text-[10px]">
                Showing latest {data.messages.length} of {data.totalMessages}
              </span>
            )}
          </div>

          {visibleMessages.length === 0 ? (
            <div className="rounded-md border border-dashed border-border p-4 text-center text-xs text-muted-foreground">
              {selectedAgent
                ? `No posts involving @${selectedAgent} yet.`
                : "No board posts yet."}
            </div>
          ) : (
            <div className="space-y-2">
              {visibleMessages.map((msg, idx) => {
                const tag = classifyMessageTag(msg);
                const shortTime = formatShortTime(msg.time);
                return (
                  <article
                    key={`${msg.seq}-${msg.agent}-${idx}`}
                    className="rounded-md border border-border bg-card p-2.5 text-xs"
                  >
                    <div className="mb-1.5 flex flex-wrap items-center justify-between gap-1.5">
                      <div className="flex items-center gap-1.5">
                        <span className="font-mono text-[10px] text-muted-foreground">
                          #{msg.seq}
                        </span>
                        <button
                          type="button"
                          onClick={() =>
                            setSelectedAgent(selectedAgent === msg.agent ? null : msg.agent)
                          }
                          className="font-medium text-foreground hover:underline"
                        >
                          @{msg.agent}
                        </button>
                        {tag && (
                          <span
                            className={`rounded border px-1.5 py-0.5 text-[10px] font-medium ${tag.tone}`}
                          >
                            {tag.label}
                          </span>
                        )}
                        {msg.channel && (
                          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                            #{msg.channel}
                          </span>
                        )}
                      </div>
                      {shortTime && (
                        <span className="font-mono text-[10px] text-muted-foreground">
                          {shortTime}
                        </span>
                      )}
                    </div>
                    <div className="prose-sm max-w-none break-words text-xs leading-relaxed text-foreground">
                      <Markdown content={msg.text} />
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function useSwarmContextSegmentVisible({ threadId }: ExperimentalThreadContextSegmentInput): boolean {
  const query = experimental_useRpcQuery({
    contract: swarmRpcContract,
    method: "getSwarmBoard",
    input: { threadId },
  });
  return Boolean(query.data?.exists);
}

function SwarmContextSummary({ threadId }: ExperimentalThreadContextSegmentProps) {
  const panel = experimental_useAppPanel();
  const query = experimental_useRpcQuery({
    contract: swarmRpcContract,
    method: "getSwarmBoard",
    input: { threadId },
  });

  const data = query.data;
  if (!data?.exists) return null;

  const activeCount = data.members.filter((member) => !member.killed).length;
  const postLabel = data.totalMessages === 1 ? "1 post" : `${data.totalMessages} posts`;

  return (
    <button
      type="button"
      onClick={() => {
        try {
          panel.toggleTab({
            tab: { id: "swarm", context: { kind: "thread" }, availability: "fixed" },
          });
        } catch {
          // Ignore surfaces without a side panel.
        }
      }}
      className="inline-flex min-w-0 items-center gap-1.5 rounded px-1 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      title={data.title ? `Toggle Swarm board: ${data.title}` : "Toggle Swarm board"}
    >
      <SwarmGlyph className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate font-medium text-foreground">
        {data.title ?? "Swarm"}
      </span>
      <span className="shrink-0 text-muted-foreground">
        · {activeCount} active · {postLabel}
      </span>
    </button>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_tab({
    id: "swarm",
    title: "Swarm",
    icon: "Users",
    tooltip: "Antigravity Swarm Board",
    layout: "flush",
    context: { kind: "thread" },
    availability: "fixed",
    useVisible: useSwarmTabVisible,
    component: SwarmBoardTab,
  });

  app.slots.experimental_threadContextSegment({
    id: "swarm",
    title: "Antigravity Swarm",
    group: "2_swarm",
    useVisible: useSwarmContextSegmentVisible,
    summary: SwarmContextSummary,
  });
});
