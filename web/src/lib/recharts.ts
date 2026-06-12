/**
 * Typed re-exports of the Recharts 2.x components we use.
 *
 * Recharts 2.x ships class components whose static/instance types don't satisfy
 * @types/react 19's stricter JSX element-type check (TS2786/TS2607) — even
 * though the components render correctly at runtime (recharts 2.15 lists React
 * 19 as a supported peer). We re-export them through a cast that keeps each
 * component's own prop types but presents it as a plain function component, so
 * JSX usage type-checks again. This is purely a type-level shim: it changes no
 * runtime behavior, so the charts render exactly as before.
 *
 * When we later move to recharts 3 (first-class React 19 types) this file can be
 * deleted and imports pointed back at 'recharts'.
 */
import type { ComponentType } from 'react';
import * as RC from 'recharts';

// Present each recharts component as a plain function component so JSX usage
// type-checks under @types/react 19. Props are intentionally widened to `any`:
// recharts 2.x's generic/forwardRef prop types don't survive a precise
// re-cast, and these are stable presentational charts. Runtime is unchanged.
const fc = (c: unknown): ComponentType<any> => c as ComponentType<any>;

export const Area = fc(RC.Area);
export const Bar = fc(RC.Bar);
export const CartesianGrid = fc(RC.CartesianGrid);
export const ComposedChart = fc(RC.ComposedChart);
export const Customized = fc(RC.Customized);
export const Line = fc(RC.Line);
export const LineChart = fc(RC.LineChart);
export const ReferenceLine = fc(RC.ReferenceLine);
export const ResponsiveContainer = fc(RC.ResponsiveContainer);
export const Tooltip = fc(RC.Tooltip);
export const XAxis = fc(RC.XAxis);
export const YAxis = fc(RC.YAxis);
