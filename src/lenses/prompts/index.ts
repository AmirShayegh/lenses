import type { z } from "zod";

import type { Severity } from "../../schema/index.js";

import {
  AccessibilityLensOptsSchema,
  accessibilityLensMetadata,
  renderAccessibilityBody,
} from "./accessibility.js";
import {
  ApiDesignLensOptsSchema,
  apiDesignLensMetadata,
  renderApiDesignBody,
} from "./api-design.js";
import {
  CleanCodeLensOptsSchema,
  cleanCodeLensMetadata,
  renderCleanCodeBody,
} from "./clean-code.js";
import {
  ConcurrencyLensOptsSchema,
  concurrencyLensMetadata,
  renderConcurrencyBody,
} from "./concurrency.js";
import {
  DataSafetyLensOptsSchema,
  dataSafetyLensMetadata,
  renderDataSafetyBody,
} from "./data-safety.js";
import {
  ErrorHandlingLensOptsSchema,
  errorHandlingLensMetadata,
  renderErrorHandlingBody,
} from "./error-handling.js";
import {
  PerformanceLensOptsSchema,
  performanceLensMetadata,
  renderPerformanceBody,
} from "./performance.js";
import {
  SecurityLensOptsSchema,
  securityLensMetadata,
  renderSecurityBody,
} from "./security.js";
import {
  TestQualityLensOptsSchema,
  testQualityLensMetadata,
  renderTestQualityBody,
} from "./test-quality.js";

export * from "./shared-preamble.js";
export {
  SECURITY_CANONICAL_CATEGORIES,
  type SecurityCategory,
} from "./security.js";

export interface LensDefinition {
  readonly id: string;
  readonly version: string;
  readonly defaultModel: "opus" | "sonnet";
  readonly maxSeverity: Severity;
  readonly type: "core" | "surface-activated";
  readonly optsSchema: z.ZodTypeAny;
  /**
   * Render the lens body. Validates raw opts via `optsSchema` before
   * dispatching so malformed runtime input cannot reach the prompt template.
   */
  readonly renderBody: (
    stage: "PLAN_REVIEW" | "CODE_REVIEW",
    opts: unknown,
  ) => string;
}

/**
 * `as const satisfies Record<string, LensDefinition>` preserves literal key
 * types so `keyof typeof LENSES` is the exact 8-id union (not `string`).
 * Declaring the type via `satisfies` -- instead of annotating as
 * `Record<string, LensDefinition>` -- keeps `LensId` narrow.
 */
export const LENSES = {
  security: {
    ...securityLensMetadata,
    optsSchema: SecurityLensOptsSchema,
    renderBody: (stage, opts) =>
      renderSecurityBody(stage, SecurityLensOptsSchema.parse(opts === undefined ? {} : opts)),
  },
  "error-handling": {
    ...errorHandlingLensMetadata,
    optsSchema: ErrorHandlingLensOptsSchema,
    renderBody: (stage, opts) =>
      renderErrorHandlingBody(
        stage,
        ErrorHandlingLensOptsSchema.parse(opts === undefined ? {} : opts),
      ),
  },
  "clean-code": {
    ...cleanCodeLensMetadata,
    optsSchema: CleanCodeLensOptsSchema,
    renderBody: (stage, opts) =>
      renderCleanCodeBody(stage, CleanCodeLensOptsSchema.parse(opts === undefined ? {} : opts)),
  },
  performance: {
    ...performanceLensMetadata,
    optsSchema: PerformanceLensOptsSchema,
    renderBody: (stage, opts) =>
      renderPerformanceBody(stage, PerformanceLensOptsSchema.parse(opts === undefined ? {} : opts)),
  },
  "api-design": {
    ...apiDesignLensMetadata,
    optsSchema: ApiDesignLensOptsSchema,
    renderBody: (stage, opts) =>
      renderApiDesignBody(stage, ApiDesignLensOptsSchema.parse(opts === undefined ? {} : opts)),
  },
  concurrency: {
    ...concurrencyLensMetadata,
    optsSchema: ConcurrencyLensOptsSchema,
    renderBody: (stage, opts) =>
      renderConcurrencyBody(stage, ConcurrencyLensOptsSchema.parse(opts === undefined ? {} : opts)),
  },
  "test-quality": {
    ...testQualityLensMetadata,
    optsSchema: TestQualityLensOptsSchema,
    renderBody: (stage, opts) =>
      renderTestQualityBody(stage, TestQualityLensOptsSchema.parse(opts === undefined ? {} : opts)),
  },
  accessibility: {
    ...accessibilityLensMetadata,
    optsSchema: AccessibilityLensOptsSchema,
    renderBody: (stage, opts) =>
      renderAccessibilityBody(
        stage,
        AccessibilityLensOptsSchema.parse(opts === undefined ? {} : opts),
      ),
  },
  "data-safety": {
    ...dataSafetyLensMetadata,
    optsSchema: DataSafetyLensOptsSchema,
    renderBody: (stage, opts) =>
      renderDataSafetyBody(
        stage,
        DataSafetyLensOptsSchema.parse(opts === undefined ? {} : opts),
      ),
  },
} as const satisfies Record<string, LensDefinition>;

export type LensId = keyof typeof LENSES;

/**
 * Render a lens body with runtime-validated opts.
 *
 * The explicit unknown-lensId guard is not hypothetical: T-007 is the dynamic
 * dispatch consumer, so invalid ids can reach this function at runtime (via
 * casts or JSON inputs). A clear error message beats the generic TypeError
 * you'd get from dereferencing `undefined`.
 */
export function renderLensBody(
  lensId: LensId,
  stage: "PLAN_REVIEW" | "CODE_REVIEW",
  rawOpts: unknown,
): string {
  const def = (LENSES as Record<string, LensDefinition | undefined>)[lensId];
  if (!def) {
    throw new Error(
      `Unknown lensId: ${JSON.stringify(lensId)}. Valid ids: ${Object.keys(LENSES).join(", ")}`,
    );
  }
  return def.renderBody(stage, rawOpts);
}
