import { pgSequence } from "drizzle-orm/pg-core";

// drizzle-kit introspects sequences even outside tablesFilter. Preserve the
// sequence owned by the archived table; dropping it would affect legacy data.
export const legacyPatternSignalsSequence = pgSequence("pattern_signals_id_seq", {
  startWith: 1,
  minValue: 1,
  maxValue: 2147483647,
  increment: 1,
  cache: 1,
});
