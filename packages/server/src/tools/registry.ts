import type { ToolDescriptor } from '@sup/shared';
import type { Tool } from './types.js';
import { communicationTools } from './builtin/communication.js';
import { taskTools } from './builtin/tasks.js';
import { memoryTools } from './builtin/memory.js';
import { fileTools } from './builtin/files.js';
import { externalTools } from './builtin/external.js';

/**
 * The tool catalogue.
 *
 * Registration is open: `register()` accepts any tool that satisfies the
 * interface, so a deployment can add a Git tool or a database tool without
 * touching the runtime. Nothing downstream branches on a specific tool name
 * except `return_result`, which the runtime treats as the terminator.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  constructor(initial: Tool[] = BUILTIN_TOOLS) {
    for (const tool of initial) this.register(tool);
  }

  register(tool: Tool): void {
    if (this.tools.has(tool.descriptor.name)) {
      throw new Error(`Tool "${tool.descriptor.name}" is already registered`);
    }
    this.tools.set(tool.descriptor.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }

  descriptors(): ToolDescriptor[] {
    return this.list().map((t) => t.descriptor);
  }

  /** The descriptors an agent is actually allowed to call. */
  descriptorsFor(capabilities: string[], isOrchestrator: boolean): ToolDescriptor[] {
    return this.descriptors().filter(
      (d) => capabilities.includes(d.name) && (!d.orchestratorOnly || isOrchestrator),
    );
  }

  /** Capability names that do not correspond to a registered tool. */
  unknownCapabilities(capabilities: string[]): string[] {
    return capabilities.filter((name) => !this.tools.has(name));
  }
}

export const BUILTIN_TOOLS: Tool[] = [
  ...communicationTools,
  ...taskTools,
  ...memoryTools,
  ...fileTools,
  ...externalTools,
];
