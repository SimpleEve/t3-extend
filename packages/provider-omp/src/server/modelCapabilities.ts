import {
  type ModelCapabilities,
  type ProviderOptionChoice,
  type ProviderOptionDescriptor,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as Predicate from "effect/Predicate";

const OMP_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

type OmpThinkingLevel = (typeof OMP_THINKING_LEVELS)[number];

const LABELS: Record<OmpThinkingLevel, string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
};

export const EMPTY_OMP_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const isOmpThinkingLevel = (value: unknown): value is OmpThinkingLevel =>
  OMP_THINKING_LEVELS.some((level) => level === value);

const field = (input: unknown, key: string): unknown =>
  Predicate.isObject(input) ? input[key] : undefined;

/** omp lists each reasoning model's efforts under `thinking.efforts`; "off" is always accepted. */
export function ompModelCapabilities(
  model: unknown,
  currentThinkingLevel: unknown,
): ModelCapabilities {
  if (field(model, "reasoning") !== true) return EMPTY_OMP_MODEL_CAPABILITIES;
  const efforts = field(field(model, "thinking"), "efforts");
  if (!Array.isArray(efforts)) return EMPTY_OMP_MODEL_CAPABILITIES;
  const supported = new Set<OmpThinkingLevel>(["off", ...efforts.filter(isOmpThinkingLevel)]);
  const levels = OMP_THINKING_LEVELS.filter((level) => supported.has(level));
  if (levels.length <= 1) return EMPTY_OMP_MODEL_CAPABILITIES;
  const defaultLevel = levels.find((level) => level === currentThinkingLevel);
  const descriptor: ProviderOptionDescriptor = {
    id: "thinking",
    label: "Thinking",
    type: "select",
    options: levels.map((level): ProviderOptionChoice => ({
      id: level,
      label: LABELS[level],
      ...(level === defaultLevel ? { isDefault: true } : {}),
    })),
  };
  return createModelCapabilities({ optionDescriptors: [descriptor] });
}
